/** Environment validation — checks .env hygiene, .env.example drift, and unsafe patterns. */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { CheckResult, Issue } from "../types.js";
import { gradeFromScore } from "../types.js";

export function runEnvValidation(cwd: string): CheckResult {
	const start = Date.now();
	const issues: Issue[] = [];

	const envFiles = readdirSync(cwd).filter((f) => f.startsWith(".env"));
	const hasEnv = envFiles.some((f) => f === ".env" || f === ".env.local");
	const hasExample = envFiles.some((f) => f === ".env.example" || f === ".env.template");

	// Check .gitignore includes .env
	if (hasEnv) {
		const gitignore = existsSync(join(cwd, ".gitignore")) ? readFileSync(join(cwd, ".gitignore"), "utf-8") : "";
		if (!gitignore.includes(".env")) {
			issues.push({ severity: "error", message: ".env not in .gitignore — secrets may be committed", file: ".gitignore", rule: "env-not-ignored" });
		}
	}

	// Check .env.example exists when .env does
	if (hasEnv && !hasExample) {
		issues.push({ severity: "warning", message: "No .env.example — other developers won't know which vars are needed", rule: "no-env-example" });
	}

	// Check .env.example drift — vars in .env.example should match .env
	if (hasEnv && hasExample) {
		const exampleFile = envFiles.find((f) => f === ".env.example" || f === ".env.template")!;
		const envVars = parseEnvKeys(readFileSync(join(cwd, ".env"), "utf-8"));
		const exampleVars = parseEnvKeys(readFileSync(join(cwd, exampleFile), "utf-8"));

		for (const key of exampleVars) {
			if (!envVars.has(key)) {
				issues.push({ severity: "info", message: `${exampleFile} has ${key} but .env doesn't — may be missing`, file: exampleFile, rule: "env-example-drift" });
			}
		}
		for (const key of envVars) {
			if (!exampleVars.has(key)) {
				issues.push({ severity: "warning", message: `${key} in .env but not in ${exampleFile} — won't be documented for other developers`, file: exampleFile, rule: "env-example-drift" });
			}
		}
	}

	// Scan .env files for unsafe patterns
	for (const f of envFiles) {
		if (f === ".env.example" || f === ".env.template") continue;
		const content = readFileSync(join(cwd, f), "utf-8");
		const lines = content.split("\n");

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i].trim();
			if (!line || line.startsWith("#")) continue;

			// Check for values that look like they should be secret but have defaults
			if (/^(DATABASE_URL|DB_PASSWORD|SECRET_KEY|JWT_SECRET|API_KEY|PRIVATE_KEY)=/i.test(line)) {
				const value = line.split("=").slice(1).join("=").trim().replace(/^["']|["']$/g, "");
				if (value && !value.startsWith("$") && !value.includes("${") && value.length < 20 && !/^(changeme|replace|todo|xxx|your[-_])/i.test(value)) {
					issues.push({
						severity: "warning",
						message: `${line.split("=")[0]} appears to have a hardcoded value — use a placeholder in committed files`,
						file: f,
						line: i + 1,
						rule: "env-hardcoded-secret",
					});
				}
			}

			// Check for empty required-looking vars
			if (/^[A-Z_]+=\s*$/.test(line)) {
				const key = line.split("=")[0];
				if (/KEY|SECRET|TOKEN|PASSWORD|URL/i.test(key)) {
					issues.push({
						severity: "info",
						message: `${key} is empty — may cause runtime errors`,
						file: f,
						line: i + 1,
						rule: "env-empty-var",
					});
				}
			}
		}
	}

	// Check for env vars used in code but not in .env.example
	if (hasExample) {
		const exampleFile = envFiles.find((f) => f === ".env.example" || f === ".env.template")!;
		const exampleVars = parseEnvKeys(readFileSync(join(cwd, exampleFile), "utf-8"));

		// Quick scan of package.json for referenced env vars
		if (existsSync(join(cwd, "package.json"))) {
			try {
				const pkg = readFileSync(join(cwd, "package.json"), "utf-8");
				const envRefs = pkg.match(/process\.env\.([A-Z_]+)/g) || [];
				for (const ref of new Set(envRefs)) {
					const varName = ref.replace("process.env.", "");
					if (!exampleVars.has(varName) && !["NODE_ENV", "CI", "HOME", "PATH", "PWD"].includes(varName)) {
						issues.push({
							severity: "info",
							message: `${varName} used in code but not in ${exampleFile}`,
							rule: "env-undocumented",
						});
					}
				}
			} catch { /* ignore */ }
		}
	}

	const errorCount = issues.filter((i) => i.severity === "error").length;
	const warnCount = issues.filter((i) => i.severity === "warning").length;
	const score = Math.max(0, 100 - errorCount * 25 - warnCount * 10);

	return {
		name: "env-validation",
		score,
		grade: gradeFromScore(score),
		details: { envFiles, hasExample },
		issues,
		duration: Date.now() - start,
	};
}

function parseEnvKeys(content: string): Set<string> {
	const keys = new Set<string>();
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eq = trimmed.indexOf("=");
		if (eq > 0) keys.add(trimmed.slice(0, eq).trim());
	}
	return keys;
}
