/** Secret detection — scans for hardcoded keys/tokens in source files and .env audit. */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { collectAllFiles } from "../fs-utils.js";
import type { CheckResult, Issue } from "../types.js";
import { gradeFromScore } from "../types.js";

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
		pattern: /sk-[A-Za-z0-9]{20,}T3BlbkFJ[A-Za-z0-9]{20,}/,
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

export function runSecrets(cwd: string): CheckResult {
	const start = Date.now();
	const issues: Issue[] = [];

	const sourceFiles = collectAllFiles(cwd, { extraExts: true });

	for (const sf of sourceFiles) {
		// Skip test files and mock data
		if (sf.isTest || sf.path.includes("__mock")) continue;
		const lines = sf.content.split("\n");

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			// Skip comments
			if (line.trim().startsWith("//") || line.trim().startsWith("*")) continue;

			for (const { name, pattern } of SECRET_PATTERNS) {
				if (pattern.test(line)) {
					issues.push({
						severity: "error",
						message: `Possible ${name}`,
						file: sf.path,
						line: i + 1,
						rule: "secret-detected",
					});
				}
			}
		}
	}

	// ── .env file audit ──
	const envFiles = [".env", ".env.local", ".env.production", ".env.development"];
	const gitignore = existsSync(join(cwd, ".gitignore"))
		? readFileSync(join(cwd, ".gitignore"), "utf-8")
		: "";

	for (const envFile of envFiles) {
		if (!existsSync(join(cwd, envFile))) continue;
		// Check if .env is in .gitignore
		const isIgnored = gitignore.split("\n").some((line) => {
			const trimmed = line.trim();
			return trimmed === envFile || trimmed === ".env" || trimmed === ".env*";
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
			const value = valueParts.join("=").trim().replace(/^["']|["']$/g, "");
			if (value.length > 20 && /(?:KEY|SECRET|TOKEN|PASSWORD|PRIVATE)/i.test(key || "")) {
				issues.push({
					severity: "warning",
					message: `${envFile} contains ${key?.trim()} with a long value — ensure this is not committed`,
					file: envFile,
					rule: "env-secret-value",
				});
			}
		}
	}

	// Proportional: 1 secret in 100 files is minor; 1 secret in 3 files is critical
	const totalFiles = sourceFiles.length || 1;
	const secretPct = (issues.length / totalFiles) * 100;
	const score = issues.length === 0 ? 100 : Math.max(0, Math.round(100 - secretPct * 20 - Math.min(issues.length, 3) * 10));

	return {
		name: "secrets",
		score,
		grade: gradeFromScore(score),
		details: { secretsFound: issues.length },
		issues,
		duration: Date.now() - start,
	};
}
