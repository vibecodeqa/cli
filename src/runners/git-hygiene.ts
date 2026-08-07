/** Git hygiene — checks commit quality, large files, and repo health. */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FileInventory } from "../file-inventory.js";
import { inventorySourceFiles } from "../file-inventory.js";
import { getProductionFiles } from "../fs-utils.js";
import type { CheckResult, Issue } from "../types.js";
import { gradeFromScore } from "../types.js";
import { run } from "./exec.js";

export function runGitHygiene(cwd: string, inventory?: FileInventory): CheckResult {
	const start = Date.now();
	const issues: Issue[] = [];

	if (!existsSync(join(cwd, ".git"))) {
		return {
			name: "git-hygiene",
			score: 0,
			grade: "F",
			details: { skipped: true, reason: "not a git repository" },
			issues: [],
			duration: Date.now() - start,
		};
	}

	// 1. Check for merge conflict markers in source files
	const files = inventory ? inventorySourceFiles(inventory) : getProductionFiles(cwd);
	for (const f of files) {
		const lines = f.content.split("\n");
		for (let i = 0; i < lines.length; i++) {
			if (/^<{7}\s|^={7}$|^>{7}\s/.test(lines[i])) {
				issues.push({
					severity: "error",
					message: "Merge conflict marker found",
					file: f.path,
					line: i + 1,
					rule: "merge-conflict",
				});
				break; // one per file is enough
			}
		}
	}

	// 2. Check recent commit message quality (last 20 commits)
	const { stdout: logOutput, ok: logOk } = run("git log --oneline -20 --format='%s' 2>/dev/null", cwd, 10_000);
	if (logOk && logOutput.trim()) {
		const messages = logOutput.trim().split("\n").filter(Boolean);
		let poorMessages = 0;

		for (const msg of messages) {
			const trimmed = msg.trim().replace(/^'|'$/g, "");
			// Flag very short or generic commit messages
			if (trimmed.length < 5 || /^(fix|update|change|wip|test|stuff|asdf|temp|\.+)$/i.test(trimmed)) {
				poorMessages++;
			}
		}

		if (messages.length > 0) {
			const poorRatio = poorMessages / messages.length;
			if (poorRatio > 0.5) {
				issues.push({
					severity: "warning",
					message: `${poorMessages}/${messages.length} recent commits have low-quality messages`,
					rule: "poor-commit-messages",
				});
			}
		}
	}

	// 3. Check for large files tracked in git
	const { stdout: lsOutput, ok: lsOk } = run(
		'git ls-files -z 2>/dev/null | xargs -0 -I{} sh -c \'wc -c < "{}" | tr -d " " | xargs -I@ echo @\\t{}\' 2>/dev/null | sort -rn | head -5',
		cwd,
		15_000,
	);
	if (lsOk && lsOutput.trim()) {
		for (const line of lsOutput.trim().split("\n")) {
			const parts = line.split("\t");
			if (parts.length < 2) continue;
			const size = parseInt(parts[0], 10);
			const file = parts[1];
			if (size > 5_000_000) {
				// 5MB
				issues.push({
					severity: "warning",
					message: `Large file tracked in git: ${file} (${(size / 1_000_000).toFixed(1)}MB) — consider Git LFS`,
					file,
					rule: "large-file",
				});
			}
		}
	}

	// 4. Check for committed binary files
	const binaryExts = new Set([".zip", ".tar", ".gz", ".jar", ".war", ".exe", ".dll", ".so", ".dylib", ".bin", ".dat", ".sqlite", ".db"]);
	const { stdout: allFiles } = run("git ls-files 2>/dev/null", cwd, 10_000);
	if (allFiles) {
		for (const file of allFiles.trim().split("\n")) {
			const ext = file.slice(file.lastIndexOf(".")).toLowerCase();
			if (binaryExts.has(ext)) {
				issues.push({
					severity: "warning",
					message: `Binary file tracked in git: ${file} — use .gitignore or Git LFS`,
					file,
					rule: "binary-in-git",
				});
			}
		}
	}

	// 5. Check .gitignore completeness
	if (existsSync(join(cwd, ".gitignore"))) {
		const gitignore = readFileSync(join(cwd, ".gitignore"), "utf-8");
		const missing: string[] = [];
		if (!gitignore.includes("node_modules") && existsSync(join(cwd, "package.json"))) missing.push("node_modules");
		if (!gitignore.includes(".env") && existsSync(join(cwd, ".env"))) missing.push(".env");
		if (!gitignore.includes("dist") && !gitignore.includes("build")) missing.push("dist/build");

		if (missing.length > 0) {
			issues.push({
				severity: "warning",
				message: `.gitignore missing common entries: ${missing.join(", ")}`,
				file: ".gitignore",
				rule: "gitignore-incomplete",
			});
		}
	}

	const errorCount = issues.filter((i) => i.severity === "error").length;
	const warnCount = issues.filter((i) => i.severity === "warning").length;
	const score = Math.max(0, 100 - errorCount * 30 - warnCount * 10);

	return {
		name: "git-hygiene",
		score,
		grade: gradeFromScore(score),
		details: { commitCount: logOutput?.trim().split("\n").length || 0 },
		issues,
		duration: Date.now() - start,
	};
}
