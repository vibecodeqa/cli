import { describe, expect, it } from "vitest";
import { collectFixableIssues } from "./ai-fix.js";
import type { CheckResult } from "./types.js";

function suggestFix(_check: string, rule: string, _message: string): string | null {
	if (rule === "empty-catch") return "Add error logging";
	return null;
}

describe("collectFixableIssues", () => {
	it("collects issues with file and line", () => {
		const checks: CheckResult[] = [
			{
				name: "error-handling",
				score: 50,
				grade: "C",
				details: {},
				issues: [
					{ severity: "warning", message: "Empty catch block", file: "src/app.ts", line: 10, rule: "empty-catch" },
					{ severity: "error", message: "No file", rule: "no-tests" },
					{ severity: "info", message: "Info only", file: "src/app.ts", line: 5, rule: "info-rule" },
				],
				duration: 10,
			},
		];
		const result = collectFixableIssues(checks, suggestFix);
		expect(result).toHaveLength(1);
		expect(result[0].file).toBe("src/app.ts");
		expect(result[0].line).toBe(10);
		expect(result[0].suggestion).toBe("Add error logging");
	});

	it("filters by check name", () => {
		const checks: CheckResult[] = [
			{
				name: "security",
				score: 50,
				grade: "C",
				details: {},
				issues: [{ severity: "error", message: "innerHTML", file: "src/a.ts", line: 1, rule: "xss" }],
				duration: 10,
			},
			{
				name: "error-handling",
				score: 50,
				grade: "C",
				details: {},
				issues: [{ severity: "warning", message: "Empty catch", file: "src/b.ts", line: 5, rule: "empty-catch" }],
				duration: 10,
			},
		];
		const result = collectFixableIssues(checks, suggestFix, "security");
		expect(result).toHaveLength(1);
		expect(result[0].check).toBe("security");
	});

	it("returns empty for no fixable issues", () => {
		const checks: CheckResult[] = [
			{
				name: "structure",
				score: 100,
				grade: "A",
				details: {},
				issues: [{ severity: "error", message: "No lockfile" }],
				duration: 10,
			},
		];
		const result = collectFixableIssues(checks, suggestFix);
		expect(result).toHaveLength(0);
	});

	it("skips info severity issues", () => {
		const checks: CheckResult[] = [
			{
				name: "docs",
				score: 80,
				grade: "B",
				details: {},
				issues: [{ severity: "info", message: "Consider adding docs", file: "src/x.ts", line: 1, rule: "no-docs" }],
				duration: 10,
			},
		];
		const result = collectFixableIssues(checks, suggestFix);
		expect(result).toHaveLength(0);
	});
});
