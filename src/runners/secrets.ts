/** Secret detection — delegates to gitleaks when available; otherwise scans with
 *  secretlint's recommended ruleset (broad coverage) PLUS our own patterns (which
 *  add LLM keys — OpenAI/Anthropic — that secretlint's preset doesn't cover). */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { lintSource } from "@secretlint/core";
import { creator as secretlintPreset } from "@secretlint/secretlint-rule-preset-recommend";
import { type FileInventory, inventoryAllFiles } from "../file-inventory.js";
import { collectAllFiles, isIgnoredPath } from "../fs-utils.js";
import type { CheckResult, Issue } from "../types.js";
import { gradeFromScore } from "../types.js";
import { run } from "./exec.js";

const SECRETLINT_CONFIG = { rules: [{ id: "@secretlint/secretlint-rule-preset-recommend", rule: secretlintPreset }] };

function isFixtureOrDocsPath(file: string): boolean {
	return /(?:^|[/\\])(?:__tests__|__fixtures__|fixtures|mocks|__mocks__|test|tests|spec|docs|documentation|examples?)(?:[/\\]|$)|(?:\.test|\.spec)\.[^.]+$|(?:^|[/\\])(?:README|CHANGELOG|CONTRIBUTING)\.md$/i.test(
		file,
	);
}

function hasFixtureContext(file: string, value: string): boolean {
	if (!isFixtureOrDocsPath(file)) return false;
	return /\b(?:assert|ciphertext|credential|decrypt|encrypt|example|exportKey|fake|fixture|generated|hardcoded|mask|mock|not\.toContain|placeholder|redact|redacted|roundtrip|round-trip|shape|stub|test|trace|validation)\b/i.test(
		`${file} ${value}`,
	);
}

function isDeterministicFixtureValue(normalized: string): boolean {
	if (
		/\b(?:not-a-real|plaintext-value|secretsecret|supersecret|should-never-appear|example|sample|dummy|fake|fixture|placeholder|roundtrip|round-trip|owner-scoped|owner-only|status-example|test-only)\b/i.test(
			normalized,
		)
	) {
		return true;
	}
	if (/-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/.test(normalized)) return true;
	if (/[Xx]{8,}/.test(normalized)) return true;
	if (/(?:0123456789abcdef|abcdef0123456789|abcdefghijklmnopqrst|ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij)/.test(normalized)) {
		return true;
	}
	if (/AKIA[0-9A-Z]*EXAMPLE\b/.test(normalized)) return true;
	if (/\b(?:ghp|ghs|gho)_[a-z]{16,}[a-z0-9]*\b/.test(normalized)) return true;
	if (/\bsk-[a-z]{12,}[a-z0-9_-]*\b/i.test(normalized) && /(?:abc|test|example|secret|plaintext|not-a-real|x{6,})/i.test(normalized)) {
		return true;
	}
	if (
		/\b(?:sk|sk-live|sk-proj)-[A-Za-z0-9_-]{16,}\b/.test(normalized) &&
		/\b(?:hardcoded|redact|redacted|trace|not\.toContain|security-no-hardcoded-secrets)\b/i.test(normalized)
	) {
		return true;
	}
	return false;
}

function isLikelyPlaceholderSecret(value: string, file = ""): boolean {
	const normalized = value.replace(/['"`]/g, "").trim();
	if (!normalized) return false;
	if (/\bAuthorization:\s*Bearer\s+(?:YOUR_TOKEN|EXAMPLE_TOKEN|DUMMY_TOKEN|FAKE_TOKEN|TEST_TOKEN)\b/i.test(normalized)) return true;
	if (/\b(?:YOUR|MY|EXAMPLE|SAMPLE|DUMMY|FAKE|TEST|PLACEHOLDER)[_-]?(?:TOKEN|SECRET|KEY|PASSWORD|API_KEY|AUTH)\b/i.test(normalized)) {
		return true;
	}
	if (/\b(?:example|sample|dummy|fake|fixture|placeholder|round-trip|owner-only|test-only)\b/i.test(normalized)) {
		return true;
	}
	if (/\b(?:token|secret|api[_-]?key|password|auth)\s*[:=]\s*(?:abc123|abcdef|1234567890)[a-z0-9_-]{0,28}\b/i.test(normalized)) return true;
	if (/^sk-[a-z0-9_-]{6,32}$/i.test(normalized) && /(?:abc|123|000|test|round|owner|fixture|sample|x\d)/i.test(normalized)) {
		return true;
	}
	if (/\bsk-(?:round-trip|owner-only|test|fixture|dummy|fake|sample|x\d)[a-z0-9_-]{3,32}\b/i.test(normalized)) return true;
	if (/^(?:token=)?(?:abc|abcdef)[a-z0-9]{8,28}$/i.test(normalized)) return true;
	if (/\btoken=(?:abc|abcdef)[a-z0-9]{8,28}\b/i.test(normalized)) return true;
	if (hasFixtureContext(file, normalized) && isDeterministicFixtureValue(normalized)) return true;
	return false;
}

function contextualizeSecret(issue: Issue, sample = ""): Issue {
	const context = `${sample} ${issue.message}`;
	if (!isLikelyPlaceholderSecret(context, issue.file ?? "")) return issue;
	const severity = isFixtureOrDocsPath(issue.file ?? "") ? "warning" : "info";
	return {
		...issue,
		severity,
		message: `${issue.message} — likely test/docs placeholder; verify it cannot be used as a real credential`,
		rule: issue.rule ?? "secret-placeholder",
	};
}

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
			if (isIgnoredPath(file)) continue;
			let sourceLine = "";
			try {
				const sourceLines = readFileSync(join(cwd, file), "utf-8").split("\n");
				sourceLine = lineWindow(sourceLines, Math.max(0, Number(f.StartLine ?? 1) - 1));
			} catch {
				sourceLine = "";
			}
			issues.push(
				contextualizeSecret(
					{
						severity: "error",
						message: `${f.Description || f.RuleID || "Secret detected"} (${f.Match?.slice(0, 8)}...)`,
						file: f.File,
						line: f.StartLine,
						rule: f.RuleID || "secret-detected",
					},
					`${String(f.Match ?? "")} ${String(f.Secret ?? "")} ${sourceLine}`,
				),
			);
		}
		return true;
	} catch {
		return false;
	}
}

const SECRET_PATTERNS: { name: string; pattern: RegExp }[] = [
	{
		name: "Credential Placeholder",
		pattern:
			/(?:Authorization:\s*Bearer\s+(?:YOUR_TOKEN|EXAMPLE_TOKEN|DUMMY_TOKEN|FAKE_TOKEN|TEST_TOKEN)\b|\btoken=(?:abc|abcdef)[a-z0-9]{8,28}\b|\bsk-(?:round-trip|owner-only|test|fixture|dummy|fake|sample|x\d)[a-z0-9_-]{3,32}\b)/i,
	},
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

function lineWindow(lines: string[], index: number): string {
	return lines.slice(Math.max(0, index - 3), Math.min(lines.length, index + 4)).join("\n");
}

function scanPatterns(files: ScanFile[], add: (iss: Issue) => void): void {
	for (const sf of files) {
		const lines = sf.content.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (line.trim().startsWith("//") || line.trim().startsWith("*")) continue;
			for (const { name, pattern } of SECRET_PATTERNS) {
				if (pattern.test(line))
					add(
						contextualizeSecret(
							{ severity: "error", message: `Possible ${name}`, file: sf.path, line: i + 1, rule: "secret-detected" },
							lineWindow(lines, i),
						),
					);
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
				add(
					contextualizeSecret(
						{
							severity: "error",
							message: `Possible ${secretlintKind(m)} — remove and rotate`,
							file: sf.path,
							line: m.loc?.start?.line ?? 1,
							rule: "secret-detected",
						},
						lineWindow(sf.content.split("\n"), Math.max(0, (m.loc?.start?.line ?? 1) - 1)),
					),
				);
			}
		} catch {
			/* unparseable file — skip */
		}
	}
}

/** Built-in scan: curated patterns always run because they cover LLM/service key
 *  formats that a local gitleaks version may not know yet. secretlint is only
 *  needed when gitleaks is unavailable. */
async function scanBuiltIn(
	cwd: string,
	includeSecretlint: boolean,
	alreadyFound: Issue[] = [],
	inventory?: FileInventory,
): Promise<Issue[]> {
	// The scan-wide inventory when there is one; the legacy walk only for direct
	// callers. The .env audit below deliberately reads outside both — a committed
	// .env is the finding, and the policy's security override exists to allow it.
	const files = (inventory ? inventoryAllFiles(inventory, { extraExts: true }) : collectAllFiles(cwd, { extraExts: true })).filter(
		(sf) => !sf.path.includes("__mock"),
	);
	const issues: Issue[] = [];
	// Seed the dedup set with what gitleaks already reported so a secret found by
	// both tools at the same location isn't counted twice (built-in patterns now
	// always run alongside gitleaks, not just as a fallback).
	const seen = new Set<string>(alreadyFound.filter((i) => i.file).map((i) => `${i.file}:${i.line}`));
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

export async function runSecrets(cwd: string, inventory?: FileInventory): Promise<CheckResult> {
	const start = Date.now();
	const issues: Issue[] = [];

	// Try gitleaks first (industry standard, 800+ patterns)
	const gitleaksResult = tryGitleaks(cwd, issues);
	const tool = gitleaksResult ? "gitleaks" : "secretlint";

	issues.push(...(await scanBuiltIn(cwd, !gitleaksResult, issues, inventory)));

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

	const errorCount = issues.filter((i) => i.severity === "error").length;
	const warningCount = issues.filter((i) => i.severity === "warning").length;
	const infoCount = issues.filter((i) => i.severity === "info").length;
	const penalty = Math.min(errorCount, 5) * 15 + Math.min(warningCount, 5) * 5 + Math.min(infoCount, 5);
	const score = issues.length === 0 ? 100 : Math.max(0, Math.round(100 - penalty));

	return {
		name: "secrets",
		score,
		grade: gradeFromScore(score),
		details: {
			secretsFound: issues.length,
			probableLeaks: errorCount,
			placeholderOrFixtureFindings: warningCount + infoCount,
			tool,
			suggestion: gitleaksResult
				? "gitleaks scan ran; built-in LLM/service key patterns also checked"
				: "Install gitleaks for deeper secret detection (800+ patterns): brew install gitleaks",
		},
		issues,
		duration: Date.now() - start,
	};
}
