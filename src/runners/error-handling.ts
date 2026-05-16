/** Error handling check — detects poor error handling patterns. */

import { getProductionFiles } from "../fs-utils.js";
import type { CheckResult, Issue, StackInfo } from "../types.js";
import { gradeFromScore } from "../types.js";

export function runErrorHandling(cwd: string, stack: StackInfo): CheckResult {
	const start = Date.now();
	const issues: Issue[] = [];
	const files = getProductionFiles(cwd);

	if (files.length === 0) {
		return {
			name: "error-handling",
			score: 100,
			grade: "A",
			details: { skipped: true, reason: "no source files" },
			issues: [],
			duration: Date.now() - start,
		};
	}

	let emptyCatch = 0;
	let throwString = 0;

	for (const f of files) {
		const lines = f.content.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i].trim();

			if (/catch\s*\([^)]*\)\s*\{\s*\}/.test(line) || /catch\s*\{\s*\}/.test(line)) {
				emptyCatch++;
				issues.push({ severity: "error", message: "Empty catch block", file: f.path, line: i + 1, rule: "empty-catch" });
			}

			if (/\bthrow\s+["'`]/.test(line)) {
				throwString++;
				issues.push({
					severity: "warning",
					message: "throw string literal — use throw new Error()",
					file: f.path,
					line: i + 1,
					rule: "throw-string",
				});
			}
		}
	}

	let hasErrorBoundary = false;
	if (stack.framework === "react") {
		for (const f of files) {
			if (f.content.includes("componentDidCatch") || f.content.includes("ErrorBoundary")) {
				hasErrorBoundary = true;
				break;
			}
		}
		if (!hasErrorBoundary && files.some((f) => f.ext === ".tsx")) {
			issues.push({ severity: "warning", message: "React project with no Error Boundary", rule: "no-error-boundary" });
		}
	}

	const score = Math.max(
		0,
		Math.min(100, 100 - emptyCatch * 5 - throwString * 2 - (stack.framework === "react" && !hasErrorBoundary ? 3 : 0)),
	);

	return {
		name: "error-handling",
		score,
		grade: gradeFromScore(score),
		details: { emptyCatch, throwString, hasErrorBoundary: stack.framework === "react" ? hasErrorBoundary : "n/a" },
		issues,
		duration: Date.now() - start,
	};
}
