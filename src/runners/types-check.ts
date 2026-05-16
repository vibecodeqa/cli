/** TypeScript type checking runner. */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CheckResult, Issue } from "../types.js";
import { gradeFromScore } from "../types.js";
import { run } from "./exec.js";

export function runTypeCheck(cwd: string, isDart = false): CheckResult {
	const start = Date.now();
	const issues: Issue[] = [];

	if (isDart) {
		// Dart uses dart analyze for type checking — errors are type errors
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
		if (!existsSync(join(cwd, "tsconfig.json")) && !existsSync(join(cwd, "tsconfig.app.json"))) {
			return {
				name: "types",
				score: 0,
				grade: "F",
				details: { skipped: true, reason: "no tsconfig.json" },
				issues: [],
				duration: Date.now() - start,
			};
		}

		const { stdout } = run("npx tsc --noEmit 2>&1 || true", cwd, 30_000);
		const lines = stdout.split("\n");
		for (const line of lines) {
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
