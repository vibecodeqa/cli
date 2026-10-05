import { describe, expect, it } from "vitest";
import { checkRunState, computeDelta, formatCheckChangeBullets, formatCheckState, formatDeltaMarkdown, formatTransition } from "./delta.js";
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
		expect(checkRunState(legacyRunnerError)).toBe("runner-error");
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

	it("reports a check that disappeared as a transition and does not count its issues as fixed", () => {
		const lintWithIssues = {
			...lintScored,
			issues: [
				{ severity: "error" as const, message: "unused var", file: "src/a.ts", rule: "no-unused" },
				{ severity: "warning" as const, message: "prefer const", file: "src/b.ts", rule: "prefer-const" },
			],
		};
		const delta = computeDelta(makeReport({ checks: [lintWithIssues] }), makeReport({ checks: [] }));
		const lint = delta.checks.find((c) => c.name === "lint")!;
		expect(lint).toMatchObject({ before: 72, after: null, delta: 0 });
		expect(lint.transition).toEqual({ before: { state: "ran", score: 72 }, after: { state: "absent" } });
		expect(lint.fixed).toHaveLength(0);
		expect(delta.fixed).toHaveLength(0);
		expect(formatCheckChangeBullets(delta, 8)).toContain("lint: 72 → not present");
		expect(formatDeltaMarkdown(delta)).not.toContain("## Fixed");
	});

	it("carries null, not the placeholder 100, for a side that did not run", () => {
		const delta = computeDelta(makeReport({ checks: [lintUnavailable] }), makeReport({ checks: [lintScored] }));
		expect(delta.checks[0]).toMatchObject({ before: null, after: 72 });
		const back = computeDelta(makeReport({ checks: [lintScored] }), makeReport({ checks: [lintUnavailable] }));
		expect(back.checks[0]).toMatchObject({ before: 72, after: null });
		expect(JSON.stringify(back)).not.toContain('"after":100');
	});
});

describe("crashed runner (#107)", () => {
	// core.ts's stub for a runner that threw: status failed, a placeholder 0/F.
	const lintCrashed = {
		name: "lint",
		status: "failed",
		score: 0,
		grade: "F" as const,
		details: { skipped: true, status: "failed", reason: "runner error: eslint exited 2" },
		issues: [],
		duration: 0,
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

	it("reports 72 → runner error as a transition, with no numeric delta", () => {
		const delta = computeDelta(makeReport({ checks: [lintScored] }), makeReport({ checks: [lintCrashed] }));
		const lint = delta.checks.find((c) => c.name === "lint")!;
		expect(lint).toMatchObject({ before: 72, after: null, delta: 0 });
		expect(lint.transition).toEqual({ before: { state: "ran", score: 72 }, after: { state: "runner-error" } });
		expect(formatTransition(lint.transition!)).toBe("72 → failed (runner error)");

		const bullets = formatCheckChangeBullets(delta, 8);
		expect(bullets).toContain("- lint: 72 → failed (runner error)");
		expect(bullets).not.toContain("-72");
		expect(bullets).not.toContain("72 → 0");

		const md = formatDeltaMarkdown(delta);
		expect(md).toContain("| lint | 72 | failed (runner error) |");
		expect(md).not.toContain("## Check Changes");
		expect(md).not.toContain("-72");
	});

	it("reports runner error → 72 as a transition, not +72", () => {
		const delta = computeDelta(makeReport({ checks: [lintCrashed] }), makeReport({ checks: [lintScored] }));
		const lint = delta.checks.find((c) => c.name === "lint")!;
		expect(lint).toMatchObject({ before: null, after: 72, delta: 0 });
		expect(formatTransition(lint.transition!)).toBe("failed (runner error) → 72");
		expect(formatCheckChangeBullets(delta, 8)).not.toContain("+72");
		expect(formatDeltaMarkdown(delta)).not.toContain("+72");

		// Crashed in both scans: nothing changed, nothing to report.
		expect(computeDelta(makeReport({ checks: [lintCrashed] }), makeReport({ checks: [lintCrashed] })).checks).toHaveLength(0);
	});

	it("detects a crash from details alone (history snapshots, older reports)", () => {
		const { status: _status, ...noTopStatus } = lintCrashed;
		expect(checkRunState(noTopStatus)).toBe("runner-error");
		expect(checkRunState({ ...noTopStatus, details: { skipped: true, reason: "runner error: boom" } })).toBe("runner-error");
		// An explicit skipped/unavailable status still wins over the reason.
		expect(checkRunState({ ...lintCrashed, status: "unavailable" })).toBe("unavailable");
		// `status` is an open vocabulary (schema 0.6.0): an unknown value counts as ran.
		expect(checkRunState({ ...lintScored, status: "timeout" })).toBe("ran");
		expect(checkRunState({ ...lintScored, status: "timeout", details: { status: "timeout" } })).toBe("ran");
	});
});

describe("issues of a check that did not run on one side are not diffed (#107)", () => {
	const threeIssues = [
		{ severity: "error" as const, message: "unused var", file: "src/a.ts", rule: "no-unused" },
		{ severity: "warning" as const, message: "prefer const", file: "src/b.ts", rule: "prefer-const" },
		{ severity: "warning" as const, message: "no any", file: "src/c.ts", rule: "no-any" },
	];
	const lintRan = {
		name: "lint",
		status: "failed",
		score: 72,
		grade: "C" as const,
		details: { status: "failed" },
		issues: threeIssues,
		duration: 1,
	};
	const notRun = {
		crashed: {
			name: "lint",
			status: "failed",
			score: 0,
			grade: "F" as const,
			details: { skipped: true, status: "failed", reason: "runner error: boom" },
			issues: [],
			duration: 0,
		},
		unavailable: {
			name: "lint",
			status: "unavailable",
			score: 100,
			grade: "A" as const,
			details: { skipped: true, unavailable: true, status: "unavailable" },
			issues: [],
			duration: 1,
		},
		dropped: undefined,
	};
	const cases = Object.entries(notRun).flatMap(([kind, other]) => [
		{ title: `ran (3 issues) → ${kind}`, before: [lintRan], after: other ? [other] : [] },
		{ title: `${kind} → ran (3 issues)`, before: other ? [other] : [], after: [lintRan] },
	]);

	it.each(cases)("$title: 0 fixed, 0 new; only the status transition", ({ before, after }) => {
		const delta = computeDelta(makeReport({ checks: before }), makeReport({ checks: after }));
		expect(delta.fixed).toHaveLength(0);
		expect(delta.introduced).toHaveLength(0);
		const lint = delta.checks.find((c) => c.name === "lint")!;
		expect(lint.transition).toBeDefined();
		expect(lint.fixed).toHaveLength(0);
		expect(lint.introduced).toHaveLength(0);

		const md = formatDeltaMarkdown(delta);
		expect(md).toContain("| 0 fixed, 0 new |");
		expect(md).not.toContain("## Fixed");
		expect(md).not.toContain("## New Issues");
		expect(md).not.toMatch(/\b3 (fixed|new)\b/);
		expect(formatCheckChangeBullets(delta, 8)).not.toMatch(/fixed|new/);
	});

	it("still diffs issues when the check ran on both sides", () => {
		const delta = computeDelta(makeReport({ checks: [lintRan] }), makeReport({ checks: [{ ...lintRan, issues: threeIssues.slice(1) }] }));
		expect(delta.fixed).toHaveLength(1);
		expect(delta.introduced).toHaveLength(0);
	});
});

describe("formatCheckState (#107)", () => {
	it("shows the full crash reason for a single check, truncated to 80 chars", () => {
		expect(formatCheckState({ state: "runner-error" }, "runner error: eslint exited 2")).toBe("failed (runner error: eslint exited 2)");
		const long = `runner error: ${"x".repeat(200)}`;
		const out = formatCheckState({ state: "runner-error" }, long);
		expect(out).toBe(`failed (${long.slice(0, 79)}…)`);
	});

	it("falls back to the short token without a reason, and for other states", () => {
		expect(formatCheckState({ state: "runner-error" })).toBe("failed (runner error)");
		expect(formatCheckState({ state: "unavailable" }, "Dart SDK not installed")).toBe("unavailable");
		expect(formatCheckState({ state: "ran", score: 72 })).toBe("72");
	});
});
