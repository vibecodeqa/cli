/** TypeScript type checking runner.
 *
 * Monorepo-aware: if tsconfig.json references project references or a build tsconfig,
 * uses `tsc -b --noEmit`. Also accepts tsconfig.base.json.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckResult, Issue, WorkspaceInfo } from "../types.js";
import { gradeFromScore } from "../types.js";
import { run } from "./exec.js";

export function runTypeCheck(cwd: string, isDart = false, workspace?: WorkspaceInfo): CheckResult {
	const start = Date.now();
	const issues: Issue[] = [];

	if (isDart) {
		const { stdout } = run("dart analyze --format=machine 2>/dev/null || true", cwd, 30_000);
		for (const line of stdout.split("\n")) {
			const parts = line.split("|");
			if (parts.length < 8 || parts[0] !== "ERROR") continue;
			issues.push({
				severity: "error",
				file: parts[3],
				line: parseInt(parts[4], 10) || undefined,
				rule: parts[2],
				message: parts[7],
			});
		}
	} else {
		const hasTsconfig =
			existsSync(join(cwd, "tsconfig.json")) ||
			existsSync(join(cwd, "tsconfig.app.json")) ||
			existsSync(join(cwd, "tsconfig.base.json"));

		if (!hasTsconfig) {
			return {
				name: "types",
				score: 0,
				grade: "F",
				details: { skipped: true, reason: "no tsconfig.json" },
				issues: [],
				duration: Date.now() - start,
			};
		}

		// Monorepo: use `tsc -b` (project references) if available, else run per-package
		if (workspace?.isMonorepo) {
			const rootTsconfig = readTsconfig(cwd, "tsconfig.json");
			const hasProjectRefs = (rootTsconfig?.references?.length ?? 0) > 0;

			if (hasProjectRefs) {
				// Project references — `tsc -b` will check all referenced projects
				parseTscOutput(run("npx tsc -b --noEmit 2>&1 || true", cwd, 60_000).stdout, issues);
			} else {
				// No project refs — run tsc per-package that has a tsconfig
				for (const pkg of workspace.packages) {
					const pkgDir = join(cwd, pkg.path);
					if (!existsSync(join(pkgDir, "tsconfig.json"))) continue;
					parseTscOutput(run("npx tsc --noEmit 2>&1 || true", pkgDir, 30_000).stdout, issues);
				}
			}
		} else {
			parseTscOutput(run("npx tsc --noEmit 2>&1 || true", cwd, 30_000).stdout, issues);
		}
	}

	const errorCount = issues.length;
	const score = errorCount === 0 ? 100 : Math.max(0, 100 - errorCount * 5);

	return {
		name: "types",
		score,
		grade: gradeFromScore(score),
		details: { errors: errorCount, ok: errorCount === 0 },
		issues,
		duration: Date.now() - start,
	};
}

function parseTscOutput(stdout: string, issues: Issue[]): void {
	for (const line of stdout.split("\n")) {
		const match = line.match(/^(.+)\((\d+),\d+\): error (TS\d+): (.+)/);
		if (match) {
			issues.push({
				severity: "error",
				file: match[1],
				line: parseInt(match[2], 10),
				rule: match[3],
				message: match[4],
			});
		}
	}
}

function readTsconfig(cwd: string, name: string): { references?: { path: string }[] } | null {
	try {
		// Strip comments from tsconfig before parsing
		const raw = readFileSync(join(cwd, name), "utf-8");
		const stripped = raw.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
		return JSON.parse(stripped);
	} catch {
		return null;
	}
}
