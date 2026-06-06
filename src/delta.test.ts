import { describe, expect, it } from "vitest";
import { computeDelta, formatDeltaMarkdown } from "./delta.js";
import type { VibeReport } from "./types.js";

function makeReport(overrides: Partial<VibeReport> = {}): VibeReport {
	return {
		version: "1.0.0",
		timestamp: "2026-06-07T00:00:00.000Z",
		score: 80,
		grade: "B",
		checks: [],
		meta: { cwd: "/tmp", node: "22", duration: 100, stack: { language: "typescript", framework: "none", bundler: "none", testRunner: "none", linter: "none", packageManager: "npm" }, repoUrl: null, branch: "main" },
		...overrides,
	};
}

describe("computeDelta", () => {
	it("detects fixed issues", () => {
		const before = makeReport({
			score: 70,
			grade: "C",
			checks: [{ name: "lint", score: 50, grade: "D", details: {}, issues: [
				{ severity: "error", message: "unused var", file: "src/a.ts", rule: "no-unused" },
				{ severity: "error", message: "missing semi", file: "src/b.ts", rule: "semi" },
			], duration: 10 }],
		});
		const after = makeReport({
			score: 90,
			grade: "A",
			checks: [{ name: "lint", score: 100, grade: "A", details: {}, issues: [], duration: 10 }],
		});

		const delta = computeDelta(before, after);
		expect(delta.scoreDelta).toBe(20);
		expect(delta.fixed).toHaveLength(2);
		expect(delta.introduced).toHaveLength(0);
		expect(delta.fixed[0].check).toBe("lint");
	});

	it("detects introduced issues", () => {
		const before = makeReport({ checks: [{ name: "security", score: 100, grade: "A", details: {}, issues: [], duration: 10 }] });
		const after = makeReport({ checks: [{ name: "security", score: 80, grade: "B", details: {}, issues: [
			{ severity: "warning", message: "innerHTML usage", file: "src/x.ts", rule: "CWE-79" },
		], duration: 10 }] });

		const delta = computeDelta(before, after);
		expect(delta.introduced).toHaveLength(1);
		expect(delta.introduced[0].rule).toBe("CWE-79");
	});

	it("handles same issue in both (unchanged)", () => {
		const issue = { severity: "warning" as const, message: "large file", file: "src/big.ts", rule: "large-file" };
		const before = makeReport({ checks: [{ name: "standards", score: 60, grade: "C", details: {}, issues: [issue], duration: 10 }] });
		const after = makeReport({ checks: [{ name: "standards", score: 60, grade: "C", details: {}, issues: [issue], duration: 10 }] });

		const delta = computeDelta(before, after);
		expect(delta.fixed).toHaveLength(0);
		expect(delta.introduced).toHaveLength(0);
	});
});

describe("formatDeltaMarkdown", () => {
	it("produces valid markdown", () => {
		const before = makeReport({ score: 70, grade: "C", checks: [{ name: "lint", score: 50, grade: "D", details: {}, issues: [
			{ severity: "error", message: "unused var", file: "src/a.ts", rule: "no-unused" },
		], duration: 10 }] });
		const after = makeReport({ score: 80, grade: "B", checks: [{ name: "lint", score: 100, grade: "A", details: {}, issues: [], duration: 10 }] });

		const delta = computeDelta(before, after);
		const md = formatDeltaMarkdown(delta);
		expect(md).toContain("# VibeCode QA");
		expect(md).toContain("Fixed");
		expect(md).toContain("lint");
		expect(md).toContain("+10");
	});
});
