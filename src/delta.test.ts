import { describe, expect, it } from "vitest";
import { checkRunState, computeDelta, formatCheckChangeBullets, formatDeltaMarkdown, formatTransition } from "./delta.js";
import type { VibeReport } from "./types.js";

function makeReport(overrides: Partial<VibeReport> = {}): VibeReport {
	return {
		version: "1.0.0",
		timestamp: "2026-06-07T00:00:00.000Z",
		score: 80,
		grade: "B",
		checks: [],
		meta: {
			cwd: "/tmp",
			node: "22",
			duration: 100,
			stack: { language: "typescript", framework: "none", bundler: "none", testRunner: "none", linter: "none", packageManager: "npm" },
			repoUrl: null,
			branch: "main",
		},
		...overrides,
	};
}

describe("computeDelta", () => {
	it("detects fixed issues", () => {
		const before = makeReport({
			score: 70,
			grade: "C",
			checks: [
				{
					name: "lint",
					score: 50,
					grade: "D",
					details: {},
					issues: [
						{ severity: "error", message: "unused var", file: "src/a.ts", rule: "no-unused" },
						{ severity: "error", message: "missing semi", file: "src/b.ts", rule: "semi" },
					],
					duration: 10,
				},
			],
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
		const after = makeReport({
			checks: [
				{
					name: "security",
					score: 80,
					grade: "B",
					details: {},
					issues: [{ severity: "warning", message: "innerHTML usage", file: "src/x.ts", rule: "CWE-79" }],
					duration: 10,
				},
			],
		});

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
		const before = makeReport({
			score: 70,
			grade: "C",
			checks: [
				{
					name: "lint",
					score: 50,
					grade: "D",
					details: {},
					issues: [{ severity: "error", message: "unused var", file: "src/a.ts", rule: "no-unused" }],
					duration: 10,
				},
			],
		});
		const after = makeReport({
			score: 80,
			grade: "B",
			checks: [{ name: "lint", score: 100, grade: "A", details: {}, issues: [], duration: 10 }],
		});

		const delta = computeDelta(before, after);
		const md = formatDeltaMarkdown(delta);
		expect(md).toContain("# VibeCode QA");
		expect(md).toContain("Fixed");
		expect(md).toContain("lint");
		expect(md).toContain("+10");
	});
});

describe("not-run checks (#107)", () => {
	const lintUnavailable = {
		name: "lint",
		status: "unavailable",
		score: 100,
		grade: "A" as const,
		details: { skipped: true, unavailable: true, status: "unavailable", reason: "Dart SDK not installed" },
		issues: [],
		duration: 1,
	};
	const lintScored = {
		name: "lint",
		status: "failed",
		score: 72,
		grade: "C" as const,
		details: { status: "failed" },
		issues: [],
		duration: 1,
	};

	it("reports a status transition, not a 100 → 72 delta, when lint was unavailable before", () => {
		const delta = computeDelta(makeReport({ checks: [lintUnavailable] }), makeReport({ checks: [lintScored] }));
		const lint = delta.checks.find((c) => c.name === "lint")!;
		expect(lint.delta).toBe(0);
		expect(lint.transition).toEqual({ before: { state: "unavailable" }, after: { state: "ran", score: 72 } });
		expect(formatTransition(lint.transition!)).toBe("unavailable → 72");

		const bullets = formatCheckChangeBullets(delta, 8);
		expect(bullets).toContain("lint: unavailable → 72");
		expect(bullets).not.toContain("100 → 72");
		expect(bullets).not.toMatch(/\(-28\)/);

		const md = formatDeltaMarkdown(delta);
		expect(md).toContain("## Status Changes");
		expect(md).toContain("| lint | unavailable | 72 |");
		expect(md).not.toContain("## Check Changes");
		expect(md).not.toContain("100");
	});

	it("does not report removing a tool as an improvement", () => {
		const scored64 = { ...lintScored, score: 64, grade: "D" as const };
		const delta = computeDelta(makeReport({ checks: [scored64] }), makeReport({ checks: [lintUnavailable] }));
		const bullets = formatCheckChangeBullets(delta, 8);
		expect(bullets).toContain("lint: 64 → unavailable");
		expect(bullets).not.toMatch(/\+\d/);
		expect(bullets).not.toContain("✅");
		expect(formatDeltaMarkdown(delta)).not.toMatch(/\+36/);
	});

	it("falls back to details flags for reports without a status field", () => {
		const legacyComingSoon = { name: "ai-review", score: 100, grade: "A" as const, details: { comingSoon: true }, issues: [], duration: 1 };
		const legacySkipped = { name: "lint", score: 100, grade: "A" as const, details: { skipped: true }, issues: [], duration: 1 };
		const legacyRunnerError = {
			name: "types",
			score: 0,
			grade: "F" as const,
			details: { skipped: true, reason: "runner error: boom" },
			issues: [],
			duration: 1,
		};
		expect(checkRunState(legacyComingSoon)).toBe("unavailable");
		expect(checkRunState(legacySkipped)).toBe("skipped");
		expect(checkRunState(legacyRunnerError)).toBe("ran");
		expect(checkRunState(undefined)).toBe("absent");

		const delta = computeDelta(makeReport({ checks: [legacySkipped] }), makeReport({ checks: [lintScored] }));
		expect(delta.checks[0]).toMatchObject({ delta: 0, transition: { before: { state: "skipped" }, after: { state: "ran", score: 72 } } });
	});

	it("reports nothing when a check stays skipped", () => {
		const skipped = { ...lintUnavailable, status: "skipped", details: { skipped: true, status: "skipped" } };
		const delta = computeDelta(makeReport({ checks: [skipped] }), makeReport({ checks: [skipped] }));
		expect(delta.checks).toHaveLength(0);
	});

	it("keeps numeric deltas when both sides ran", () => {
		const delta = computeDelta(makeReport({ checks: [{ ...lintScored, score: 60 }] }), makeReport({ checks: [lintScored] }));
		expect(delta.checks[0]).toMatchObject({ delta: 12 });
		expect(delta.checks[0].transition).toBeUndefined();
		expect(formatCheckChangeBullets(delta, 8)).toContain("✅ lint: 60 → 72 (+12)");
	});
});
