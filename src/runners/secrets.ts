/** Secret detection — delegates to gitleaks when available; otherwise scans with
 *  secretlint's recommended ruleset (broad coverage) PLUS our own patterns (which
 *  add LLM keys — OpenAI/Anthropic — that secretlint's preset doesn't cover). */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { lintSource } from "@secretlint/core";
import { creator as secretlintPreset } from "@secretlint/secretlint-rule-preset-recommend";
import { collectAllFiles } from "../fs-utils.js";
import type { CheckResult, Issue } from "../types.js";
import { gradeFromScore } from "../types.js";
import { run } from "./exec.js";

const SECRETLINT_CONFIG = { rules: [{ id: "@secretlint/secretlint-rule-preset-recommend", rule: secretlintPreset }] };

/** Human-readable kind from a secretlint message, without leaking the secret value. */
function secretlintKind(msg: { messageId?: string; ruleId?: string }): string {
	if (msg.messageId) return msg.messageId.replace(/_/g, " ").toLowerCase();
	return (msg.ruleId ?? "secret").replace(/.*secretlint-rule-/, "");
}

/** Try running gitleaks for secret detection. Returns true if gitleaks ran. */
function tryGitleaks(cwd: string, issues: Issue[]): boolean {
	const { stdout, ok } = run("gitleaks detect --no-git --report-format json --report-path /dev/stdout 2>/dev/null", cwd, 30_000);
	if (!ok && !stdout.startsWith("[")) return false; // gitleaks not installed or errored

	try {
		const findings = JSON.parse(stdout);
		if (!Array.isArray(findings)) return false;
		for (const f of findings) {
			// Skip our own generated report artifacts — the HTML/JSON we write under
			// .vibe-check/ embeds sample keys and trips gitleaks on every scan.
			const file = String(f.File ?? "");
			if (/(?:^|[/\\])\.vibe-check[/\\]/.test(file)) continue;
			issues.push({
				severity: "error",
				message: `${f.Description || f.RuleID || "Secret detected"} (${f.Match?.slice(0, 8)}...)`,
				file: f.File,
				line: f.StartLine,
				rule: f.RuleID || "secret-detected",
			});
		}
		return true;
	} catch {
		return false;
	}
}

const SECRET_PATTERNS: { name: string; pattern: RegExp }[] = [
	{ name: "AWS Access Key", pattern: /AKIA[0-9A-Z]{16}/ },
	{
		name: "AWS Secret Key",
		pattern: /(?:aws_secret|AWS_SECRET)[^=]*=\s*['"][A-Za-z0-9/+=]{40}['"]/,
	},
	{ name: "GitHub Token (classic)", pattern: /ghp_[A-Za-z0-9]{36}/ },
	{
		name: "GitHub Token (fine-grained)",
		pattern: /github_pat_[A-Za-z0-9_]{22,}/,
	},
	{ name: "GitHub OAuth", pattern: /gho_[A-Za-z0-9]{36}/ },
	{ name: "Slack Token", pattern: /xox[bpors]-[0-9a-zA-Z-]{10,}/ },
	{ name: "Stripe Secret Key", pattern: /sk_live_[0-9a-zA-Z]{24,}/ },
	{ name: "Stripe Publishable Key", pattern: /pk_live_[0-9a-zA-Z]{24,}/ },
	{
		name: "OpenAI API Key",
		pattern: /sk-(?:proj-|svc-|[A-Za-z0-9]{2,})[A-Za-z0-9_-]{20,}/,
	},
	{ name: "Anthropic API Key", pattern: /sk-ant-api\d{2}-[A-Za-z0-9-]{80,}/ },
	{ name: "Google API Key", pattern: /AIza[0-9A-Za-z_-]{35}/ },
	{
		name: "Private Key",
		pattern: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/,
	},
	{
		name: "Generic Secret Assignment",
		pattern: /(?:password|secret|api_key|apikey|token|auth)\s*[:=]\s*['"][A-Za-z0-9+/=]{20,}['"]/,
	},
];

type ScanFile = { path: string; content: string };

function scanPatterns(files: ScanFile[], add: (iss: Issue) => void): void {
	for (const sf of files) {
		const lines = sf.content.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (line.trim().startsWith("//") || line.trim().startsWith("*")) continue;
			for (const { name, pattern } of SECRET_PATTERNS) {
				if (pattern.test(line))
					add({ severity: "error", message: `Possible ${name}`, file: sf.path, line: i + 1, rule: "secret-detected" });
			}
		}
	}
}

async function scanSecretlint(files: ScanFile[], add: (iss: Issue) => void): Promise<void> {
	for (const sf of files) {
		try {
			const result = await lintSource({
				source: { filePath: sf.path, content: sf.content, contentType: "text" },
				options: { config: SECRETLINT_CONFIG },
			});
			for (const m of result.messages) {
				add({
					severity: "error",
					message: `Possible ${secretlintKind(m)} — remove and rotate`,
					file: sf.path,
					line: m.loc?.start?.line ?? 1,
					rule: "secret-detected",
				});
			}
		} catch {
			/* unparseable file — skip */
		}
	}
}

/** Built-in scan: curated patterns always run because they cover LLM/service key
 *  formats that a local gitleaks version may not know yet. secretlint is only
 *  needed when gitleaks is unavailable. */
async function scanBuiltIn(cwd: string, includeSecretlint: boolean): Promise<Issue[]> {
	const files = collectAllFiles(cwd, { extraExts: true }).filter((sf) => !sf.isTest && !sf.path.includes("__mock"));
	const issues: Issue[] = [];
	const seen = new Set<string>();
	const add = (iss: Issue) => {
		const key = `${iss.file}:${iss.line}`;
		if (!seen.has(key)) {
			seen.add(key);
			issues.push(iss);
		}
	};
	scanPatterns(files, add);
	if (includeSecretlint) await scanSecretlint(files, add);
	return issues;
}

export async function runSecrets(cwd: string): Promise<CheckResult> {
	const start = Date.now();
	const issues: Issue[] = [];

	// Try gitleaks first (industry standard, 800+ patterns)
	const gitleaksResult = tryGitleaks(cwd, issues);
	const tool = gitleaksResult ? "gitleaks" : "secretlint";

	issues.push(...(await scanBuiltIn(cwd, !gitleaksResult)));

	// ── .env file audit ──
	const envFiles = [".env", ".env.local", ".env.production", ".env.development"];
	const gitignore = existsSync(join(cwd, ".gitignore")) ? readFileSync(join(cwd, ".gitignore"), "utf-8") : "";

	for (const envFile of envFiles) {
		if (!existsSync(join(cwd, envFile))) continue;
		// Check if .env is in .gitignore (handles glob patterns like .env* or .env.*)
		const isIgnored = gitignore.split("\n").some((line) => {
			const trimmed = line.trim();
			if (trimmed === envFile || trimmed === ".env") return true;
			// Simple glob: .env* matches .env.local, .env.production etc
			if (trimmed.includes("*")) {
				const pattern = trimmed.replace(/\./g, "\\.").replace(/\*/g, ".*");
				try {
					return new RegExp(`^${pattern}$`).test(envFile);
				} catch {
					return false;
				}
			}
			return false;
		});
		if (!isIgnored) {
			issues.push({
				severity: "error",
				message: `${envFile} exists but is not in .gitignore — secrets may be committed`,
				file: envFile,
				rule: "env-not-ignored",
			});
		}

		// Check for actual secrets in .env files
		const content = readFileSync(join(cwd, envFile), "utf-8");
		for (const line of content.split("\n")) {
			if (line.startsWith("#") || !line.includes("=")) continue;
			const [key, ...valueParts] = line.split("=");
			const value = valueParts
				.join("=")
				.trim()
				.replace(/^["']|["']$/g, "");
			const keyName = key?.trim() || "";
			// Flag if key name suggests a secret OR value contains a password/credential pattern
			const keyIsSensitive = /(?:KEY|SECRET|TOKEN|PASSWORD|PRIVATE|CREDENTIAL|AUTH)/i.test(keyName);
			const valueHasCredential = /[:@].*[:@]/.test(value) || /^(?:sk-|ghp_|gho_|xox[bpors]-|AKIA)/.test(value);
			if (value.length > 15 && (keyIsSensitive || valueHasCredential)) {
				issues.push({
					severity: "warning",
					message: `${envFile} contains ${keyName} with a credential value — ensure this is not committed`,
					file: envFile,
					rule: "env-secret-value",
				});
			}
		}
	}

	// Score based on issue count (secrets are always critical)
	const score = issues.length === 0 ? 100 : Math.max(0, Math.round(100 - Math.min(issues.length, 5) * 15));

	return {
		name: "secrets",
		score,
		grade: gradeFromScore(score),
		details: {
			secretsFound: issues.length,
			tool,
			suggestion: gitleaksResult
				? "gitleaks scan ran; built-in LLM/service key patterns also checked"
				: "Install gitleaks for deeper secret detection (800+ patterns): brew install gitleaks",
		},
		issues,
		duration: Date.now() - start,
	};
}
