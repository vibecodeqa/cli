/** Lint check — auto-detects biome or eslint.
 *
 * Monorepo-aware: if root linter config exists, lint the whole repo (biome check .).
 * If linter is "none" at root, checks if CI workflows run lint or if packages have configs.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckResult, Issue, StackInfo, WorkspaceInfo } from "../types.js";
import { gradeFromScore } from "../types.js";
import { run } from "./exec.js";

export function runLint(cwd: string, stack: StackInfo, workspace?: WorkspaceInfo): CheckResult {
	const start = Date.now();
	const issues: Issue[] = [];

	// Determine the target path for linting
	// Monorepos with root config: lint "." (biome/eslint will find all files)
	// Single-package: lint "src/"
	const lintTarget = workspace?.isMonorepo ? "." : existsSync(join(cwd, "src")) ? "src/" : ".";

	if (stack.linter === "biome") {
		const { stdout } = run(`npx biome check ${lintTarget} --reporter=json 2>/dev/null || true`, cwd);
		try {
			const data = JSON.parse(stdout);
			const diagnostics = data.diagnostics || [];
			for (const d of diagnostics) {
				// biome path can be string or {file: "..."} depending on version
				const rawPath = d.location?.path;
				const file = typeof rawPath === "string" ? rawPath : rawPath?.file || undefined;
				// Skip generated output files
				if (file && (file.includes(".vibe-check/") || file.includes("node_modules/"))) continue;
				issues.push({
					severity: d.severity === "error" ? "error" : d.severity === "warning" ? "warning" : "info",
					message: d.description || d.message || "lint issue",
					file,
					rule: d.category,
				});
			}
		} catch {
			const errors = stdout.match(/Found (\d+) error/)?.[1] || "0";
			const warnings = stdout.match(/Found (\d+) warning/)?.[1] || "0";
			for (let i = 0; i < parseInt(errors, 10); i++) issues.push({ severity: "error", message: "lint error" });
			for (let i = 0; i < parseInt(warnings, 10); i++) issues.push({ severity: "warning", message: "lint warning" });
		}
	} else if (stack.linter === "eslint") {
		const { stdout } = run(`npx eslint ${lintTarget} --format json 2>/dev/null || true`, cwd);
		try {
			const files = JSON.parse(stdout);
			for (const file of files) {
				for (const msg of file.messages || []) {
					issues.push({
						severity: msg.severity === 2 ? "error" : "warning",
						message: msg.message,
						file: file.filePath,
						line: msg.line,
						rule: msg.ruleId,
					});
				}
			}
		} catch {
			/* eslint output parse failed */
		}
	} else if (stack.linter === "dart_analyze") {
		const { stdout } = run("dart analyze --format=machine 2>/dev/null || true", cwd);
		for (const line of stdout.split("\n")) {
			const parts = line.split("|");
			if (parts.length < 8) continue;
			const severity = parts[0] === "ERROR" ? "error" : parts[0] === "WARNING" ? "warning" : "info";
			// dart analyze returns absolute paths — strip cwd prefix
			// macOS: /var/folders may resolve to /private/var/folders
			let filePath = parts[3];
			if (filePath.startsWith(cwd)) filePath = filePath.slice(cwd.length + 1);
			else if (filePath.startsWith(`/private${cwd}`)) filePath = filePath.slice(`/private${cwd}`.length + 1);
			else if (filePath.includes(cwd.split("/").pop()!)) {
				// Last resort: find the cwd basename in the path
				const idx = filePath.indexOf(cwd.split("/").pop()!);
				if (idx >= 0) filePath = filePath.slice(idx + cwd.split("/").pop()!.length + 1);
			}
			issues.push({
				severity,
				message: parts[7],
				file: filePath,
				line: parseInt(parts[4], 10) || undefined,
				rule: parts[2],
			});
		}
	} else {
		// No root linter detected — check if linting is happening elsewhere
		const lintInCI = detectLintInCI(cwd);
		const pkgLinters = workspace?.isMonorepo ? workspace.packages.filter((p) => p.hasLinter).length : 0;

		if (lintInCI || pkgLinters > 0) {
			// Linting IS happening, just not via a root config we can invoke
			const reason = lintInCI ? "Linting runs in CI workflows" : `${pkgLinters} workspace packages have linter configs`;
			return {
				name: "lint",
				score: 70, // Partial credit — linting exists but we can't run it from root
				grade: "B",
				details: { linter: "detected-in-pipeline", reason, lintInCI, pkgLinters },
				issues: [{ severity: "info", message: `No root linter config, but: ${reason}`, rule: "lint-not-root" }],
				duration: Date.now() - start,
			};
		}

		return {
			name: "lint",
			score: 0,
			grade: "F",
			details: { skipped: true, reason: "no linter detected" },
			issues: [],
			duration: Date.now() - start,
		};
	}

	const errors = issues.filter((i) => i.severity === "error").length;
	const warnings = issues.filter((i) => i.severity === "warning").length;
	// Scale with issue count — diminishing penalty for large counts
	const errorPenalty = Math.min(70, errors * Math.min(10, 40 / Math.max(errors, 1)));
	const warnPenalty = Math.min(25, warnings * Math.min(2, 15 / Math.max(warnings, 1)));
	const score = Math.max(0, Math.min(100, Math.round(100 - errorPenalty - warnPenalty)));

	return {
		name: "lint",
		score,
		grade: gradeFromScore(score),
		details: { errors, warnings, linter: stack.linter },
		issues,
		duration: Date.now() - start,
	};
}

/** Check if CI workflows contain lint/check commands. */
function detectLintInCI(cwd: string): boolean {
	const workflowDir = join(cwd, ".github", "workflows");
	if (!existsSync(workflowDir)) return false;
	try {
		for (const f of readdirSync(workflowDir)) {
			if (!f.endsWith(".yml") && !f.endsWith(".yaml")) continue;
			const content = readFileSync(join(workflowDir, f), "utf-8");
			if (/\b(biome|eslint|lint|check)\b/i.test(content)) return true;
		}
	} catch {
		/* can't read workflows */
	}
	return false;
}
