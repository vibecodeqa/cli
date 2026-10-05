import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatTransition } from "./delta.js";
import { computeTrend, formatTrend } from "./trend.js";
import type { VibeReport } from "./types.js";

function makeReport(score: number, checks: { name: string; score: number; issues: number }[]): VibeReport {
	return {
		version: "0.1.0",
		timestamp: "2026-05-30T12:00:00Z",
		score,
		grade: score >= 90 ? "A" : score >= 75 ? "B" : "C",
		checks: checks.map((c) => ({
			name: c.name,
			score: c.score,
			grade: c.score >= 90 ? "A" : "B",
			details: {},
			issues: Array.from({ length: c.issues }, (_, i) => ({
				severity: "warning" as const,
				message: `issue ${i}`,
			})),
			duration: 10,
		})),
		meta: { cwd: "/tmp", node: "v22", duration: 100, stack: {} as VibeReport["meta"]["stack"], repoUrl: null, branch: "main" },
	};
}

describe("computeTrend", () => {
	it("returns null when no previous report", () => {
		const dir = mkdtempSync(join(tmpdir(), "vcqa-trend-"));
		const report = makeReport(80, [{ name: "lint", score: 80, issues: 2 }]);
		expect(computeTrend(report, dir)).toBeNull();
	});

	it("computes score delta correctly", () => {
		const dir = mkdtempSync(join(tmpdir(), "vcqa-trend-"));
		const prev = makeReport(70, [{ name: "lint", score: 70, issues: 5 }]);
		writeFileSync(join(dir, "report.json"), JSON.stringify(prev));

		const curr = makeReport(85, [{ name: "lint", score: 85, issues: 2 }]);
		const trend = computeTrend(curr, dir);
		expect(trend).not.toBeNull();
		expect(trend!.scoreDelta).toBe(15);
		expect(trend!.fixedIssues).toBe(3);
		expect(trend!.newIssues).toBe(0);
	});

	it("tracks concrete introduced and fixed findings by fingerprint", () => {
		const dir = mkdtempSync(join(tmpdir(), "vcqa-trend-"));
		const prev = makeReport(80, [{ name: "lint", score: 80, issues: 0 }]);
		prev.checks[0].issues = [
			{ severity: "warning", rule: "old", message: "Old issue", file: "src/a.ts" },
			{ severity: "warning", rule: "same", message: "Same issue", file: "src/b.ts", line: 1 },
		];
		writeFileSync(join(dir, "report.json"), JSON.stringify(prev));

		const curr = makeReport(81, [{ name: "lint", score: 81, issues: 0 }]);
		curr.checks[0].issues = [
			{ severity: "warning", rule: "same", message: "Same issue", file: "src/b.ts", line: 99 },
			{ severity: "warning", rule: "new", message: "New issue", file: "src/c.ts" },
		];

		const trend = computeTrend(curr, dir)!;
		expect(trend.newIssues).toBe(1);
		expect(trend.fixedIssues).toBe(1);
		expect(trend.introduced?.[0]).toMatchObject({ rule: "new", file: "src/c.ts" });
		expect(trend.fixed?.[0]).toMatchObject({ rule: "old", file: "src/a.ts" });
	});

	it("detects regressions", () => {
		const dir = mkdtempSync(join(tmpdir(), "vcqa-trend-"));
		const prev = makeReport(90, [{ name: "lint", score: 90, issues: 1 }]);
		writeFileSync(join(dir, "report.json"), JSON.stringify(prev));

		const curr = makeReport(75, [{ name: "lint", score: 75, issues: 4 }]);
		const trend = computeTrend(curr, dir);
		expect(trend!.scoreDelta).toBe(-15);
		expect(trend!.newIssues).toBe(3);
		expect(trend!.fixedIssues).toBe(0);
	});

	it("handles corrupt previous report", () => {
		const dir = mkdtempSync(join(tmpdir(), "vcqa-trend-"));
		writeFileSync(join(dir, "report.json"), "not json");
		const report = makeReport(80, []);
		expect(computeTrend(report, dir)).toBeNull();
	});

	it("computes per-check deltas", () => {
		const dir = mkdtempSync(join(tmpdir(), "vcqa-trend-"));
		const prev = makeReport(70, [
			{ name: "lint", score: 60, issues: 3 },
			{ name: "types", score: 80, issues: 1 },
		]);
		writeFileSync(join(dir, "report.json"), JSON.stringify(prev));

		const curr = makeReport(85, [
			{ name: "lint", score: 90, issues: 0 },
			{ name: "types", score: 80, issues: 1 },
		]);
		const trend = computeTrend(curr, dir)!;
		expect(trend.checkDeltas).toHaveLength(2);
		expect(trend.checkDeltas.find((d) => d.name === "lint")!.delta).toBe(30);
		expect(trend.checkDeltas.find((d) => d.name === "types")!.delta).toBe(0);
	});
});

describe("computeTrend not-run checks (#107)", () => {
	it("emits a status transition instead of a numeric delta when either side did not run", () => {
		const dir = mkdtempSync(join(tmpdir(), "vcqa-trend-"));
		const prev = makeReport(70, [{ name: "lint", score: 100, issues: 0 }]);
		prev.checks[0].details = { skipped: true, unavailable: true, status: "unavailable" };
		writeFileSync(join(dir, "report.json"), JSON.stringify(prev));
		const curr = makeReport(70, [{ name: "lint", score: 72, issues: 0 }]);
		curr.checks[0].details = { status: "failed" };

		const trend = computeTrend(curr, dir)!;
		const lint = trend.checkDeltas.find((d) => d.name === "lint")!;
		expect(lint.delta).toBe(0);
		expect(lint.transition).toEqual({ before: { state: "unavailable" }, after: { state: "ran", score: 72 } });

		expect(lint).toMatchObject({ prev: null, curr: 72 });
		expect(formatTransition(lint.transition!)).toBe("unavailable → 72");
	});

	it("does not report a removed tool as +N", () => {
		const dir = mkdtempSync(join(tmpdir(), "vcqa-trend-"));
		const prev = makeReport(70, [{ name: "lint", score: 64, issues: 0 }]);
		writeFileSync(join(dir, "report.json"), JSON.stringify(prev));
		const curr = makeReport(70, [{ name: "lint", score: 100, issues: 0 }]);
		curr.checks[0].details = { skipped: true, comingSoon: true };

		const trend = computeTrend(curr, dir)!;
		expect(trend.checkDeltas[0]).toMatchObject({ prev: 64, curr: null, delta: 0 });
		expect(formatTransition(trend.checkDeltas[0].transition!)).toBe("64 → unavailable");
	});

	it("reports a check that disappeared as a transition", () => {
		const dir = mkdtempSync(join(tmpdir(), "vcqa-trend-"));
		writeFileSync(join(dir, "report.json"), JSON.stringify(makeReport(70, [{ name: "lint", score: 72, issues: 2 }])));
		const trend = computeTrend(makeReport(70, []), dir)!;
		expect(trend.checkDeltas).toHaveLength(1);
		expect(trend.checkDeltas[0]).toMatchObject({ name: "lint", prev: 72, curr: null, delta: 0 });
		expect(formatTransition(trend.checkDeltas[0].transition!)).toBe("72 → not present");
		expect(trend.fixedIssues).toBe(0);
	});
});

describe("computeTrend crashed runner (#107)", () => {
	const crash = { skipped: true, status: "failed", reason: "runner error: boom" };

	it("72 → runner error is a transition, not -72", () => {
		const dir = mkdtempSync(join(tmpdir(), "vcqa-trend-"));
		writeFileSync(join(dir, "report.json"), JSON.stringify(makeReport(70, [{ name: "lint", score: 72, issues: 0 }])));
		const curr = makeReport(60, [{ name: "lint", score: 0, issues: 0 }]);
		curr.checks[0].details = crash;

		const lint = computeTrend(curr, dir)!.checkDeltas.find((d) => d.name === "lint")!;
		expect(lint).toMatchObject({ prev: 72, curr: null, delta: 0 });
		expect(lint.transition).toEqual({ before: { state: "ran", score: 72 }, after: { state: "runner-error" } });
		expect(formatTransition(lint.transition!)).toBe("72 → failed (runner error)");
	});

	it("runner error → 72 is a transition, not +72", () => {
		const dir = mkdtempSync(join(tmpdir(), "vcqa-trend-"));
		const prev = makeReport(60, [{ name: "lint", score: 0, issues: 0 }]);
		prev.checks[0].details = crash;
		writeFileSync(join(dir, "report.json"), JSON.stringify(prev));

		const lint = computeTrend(makeReport(70, [{ name: "lint", score: 72, issues: 0 }]), dir)!.checkDeltas[0];
		expect(lint).toMatchObject({ prev: null, curr: 72, delta: 0 });
		expect(formatTransition(lint.transition!)).toBe("failed (runner error) → 72");
	});
});

describe("computeTrend does not diff issues of a check that did not run on one side (#107)", () => {
	const crashed = { skipped: true, status: "failed", reason: "runner error: boom" };
	const unavailable = { skipped: true, unavailable: true, status: "unavailable" };
	const notRun = (details: Record<string, unknown> | null): VibeReport => {
		if (!details) return makeReport(70, [{ name: "structure", score: 80, issues: 0 }]);
		const r = makeReport(70, [
			{ name: "lint", score: 0, issues: 0 },
			{ name: "structure", score: 80, issues: 0 },
		]);
		r.checks[0].details = details;
		return r;
	};
	const ran = () =>
		makeReport(70, [
			{ name: "lint", score: 72, issues: 3 },
			{ name: "structure", score: 80, issues: 0 },
		]);
	const cases = Object.entries({ crashed, unavailable, dropped: null }).flatMap(([kind, details]) => [
		{ title: `ran (3 issues) → ${kind}`, prev: ran, curr: () => notRun(details) },
		{ title: `${kind} → ran (3 issues)`, prev: () => notRun(details), curr: ran },
	]);

	it.each(cases)("$title: 0 fixed, 0 new", ({ prev, curr }) => {
		const dir = mkdtempSync(join(tmpdir(), "vcqa-trend-"));
		writeFileSync(join(dir, "report.json"), JSON.stringify(prev()));
		const trend = computeTrend(curr(), dir)!;
		expect(trend.fixedIssues).toBe(0);
		expect(trend.newIssues).toBe(0);
		expect(trend.fixed).toEqual([]);
		expect(trend.introduced).toEqual([]);
		expect(trend.checkDeltas.find((d) => d.name === "lint")!.transition).toBeDefined();
		expect(formatTrend(trend)).not.toMatch(/fixed|new/);
	});
});

describe("formatTrend", () => {
	it("formats improvement", () => {
		const out = formatTrend({
			scoreDelta: 5,
			checkDeltas: [],
			newIssues: 0,
			fixedIssues: 3,
			prevTimestamp: "2026-05-29T00:00:00Z",
		});
		expect(out).toContain("5 pts");
		expect(out).toContain("improved");
		expect(out).toContain("3 fixed");
	});

	it("formats regression", () => {
		const out = formatTrend({
			scoreDelta: -3,
			checkDeltas: [],
			newIssues: 2,
			fixedIssues: 0,
			prevTimestamp: "2026-05-29T00:00:00Z",
		});
		expect(out).toContain("3 pts");
		expect(out).toContain("declined");
		expect(out).toContain("2 new");
	});

	it("includes sparkline with history", () => {
		const out = formatTrend(
			{ scoreDelta: 0, checkDeltas: [], newIssues: 0, fixedIssues: 0, prevTimestamp: "2026-05-29T00:00:00Z" },
			[60, 65, 70, 75, 80],
		);
		// Should contain unicode block characters
		expect(out).toMatch(/[▁▂▃▄▅▆▇█]/);
	});
});
