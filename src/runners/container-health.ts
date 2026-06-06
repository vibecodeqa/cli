/** Container health — Dockerfile best practices, .dockerignore, base image hygiene. */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { CheckResult, Issue } from "../types.js";
import { gradeFromScore } from "../types.js";

export function runContainerHealth(cwd: string): CheckResult {
	const start = Date.now();
	const issues: Issue[] = [];

	// Find Dockerfiles
	const dockerfiles: string[] = [];
	try {
		for (const f of readdirSync(cwd)) {
			if (f === "Dockerfile" || f.startsWith("Dockerfile.") || f === "dockerfile") {
				dockerfiles.push(f);
			}
		}
	} catch { /* not readable */ }

	if (dockerfiles.length === 0) {
		return {
			name: "container-health",
			score: 0,
			grade: "F",
			details: { skipped: true, reason: "no Dockerfile found" },
			issues: [],
			duration: Date.now() - start,
		};
	}

	// Check .dockerignore exists
	if (!existsSync(join(cwd, ".dockerignore"))) {
		issues.push({
			severity: "warning",
			message: "No .dockerignore — node_modules, .git, and secrets may be included in the image",
			rule: "no-dockerignore",
		});
	} else {
		const dockerignore = readFileSync(join(cwd, ".dockerignore"), "utf-8");
		const missing: string[] = [];
		if (!dockerignore.includes("node_modules")) missing.push("node_modules");
		if (!dockerignore.includes(".git")) missing.push(".git");
		if (!dockerignore.includes(".env")) missing.push(".env");
		if (missing.length > 0) {
			issues.push({
				severity: "warning",
				message: `.dockerignore missing: ${missing.join(", ")}`,
				file: ".dockerignore",
				rule: "dockerignore-incomplete",
			});
		}
	}

	for (const df of dockerfiles) {
		const content = readFileSync(join(cwd, df), "utf-8");
		const lines = content.split("\n");

		// Check for unpinned base images (FROM node, FROM ubuntu — no tag)
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i].trim();
			if (/^FROM\s+\S+$/i.test(line) && !line.includes(":") && !line.includes("@") && !line.toLowerCase().includes("scratch")) {
				issues.push({
					severity: "error",
					message: `Unpinned base image: ${line} — use a specific tag (e.g., node:22-slim)`,
					file: df,
					line: i + 1,
					rule: "unpinned-base",
				});
			}

			// Check for :latest tag
			if (/^FROM\s+\S+:latest/i.test(line)) {
				issues.push({
					severity: "warning",
					message: `Using :latest tag: ${line} — pin to a specific version for reproducible builds`,
					file: df,
					line: i + 1,
					rule: "latest-tag",
				});
			}
		}

		// Check for running as root (no USER instruction)
		if (!content.match(/^USER\s+/m)) {
			issues.push({
				severity: "warning",
				message: "No USER instruction — container runs as root by default",
				file: df,
				rule: "runs-as-root",
			});
		}

		// Check for multi-stage build (good practice for smaller images)
		const fromCount = (content.match(/^FROM\s+/gim) || []).length;
		if (fromCount === 1 && existsSync(join(cwd, "package.json"))) {
			issues.push({
				severity: "info",
				message: "Single-stage build — multi-stage builds produce smaller images",
				file: df,
				rule: "no-multi-stage",
			});
		}

		// Check for COPY before npm install (cache busting)
		const copyAllIdx = lines.findIndex((l) => /^COPY\s+\.\s+/i.test(l.trim()));
		const npmInstallIdx = lines.findIndex((l) => /npm install|pnpm install|yarn install/i.test(l));
		if (copyAllIdx !== -1 && npmInstallIdx !== -1 && copyAllIdx < npmInstallIdx) {
			issues.push({
				severity: "warning",
				message: "COPY . before npm install — copy package.json first to leverage Docker cache",
				file: df,
				line: copyAllIdx + 1,
				rule: "cache-bust",
			});
		}

		// Check for apt-get without cleanup
		if (content.includes("apt-get install") && !content.includes("apt-get clean") && !content.includes("rm -rf /var/lib/apt")) {
			issues.push({
				severity: "info",
				message: "apt-get install without cleanup — add 'apt-get clean && rm -rf /var/lib/apt/lists/*'",
				file: df,
				rule: "apt-no-clean",
			});
		}

		// Check for EXPOSE
		if (!content.match(/^EXPOSE\s+/m) && (content.includes("node") || content.includes("npm start"))) {
			issues.push({
				severity: "info",
				message: "No EXPOSE instruction — document which port the app listens on",
				file: df,
				rule: "no-expose",
			});
		}
	}

	const errorCount = issues.filter((i) => i.severity === "error").length;
	const warnCount = issues.filter((i) => i.severity === "warning").length;
	const score = Math.max(0, 100 - errorCount * 25 - warnCount * 10);

	return {
		name: "container-health",
		score,
		grade: gradeFromScore(score),
		details: { dockerfiles, hasDockerignore: existsSync(join(cwd, ".dockerignore")) },
		issues,
		duration: Date.now() - start,
	};
}
