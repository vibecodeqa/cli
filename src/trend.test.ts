import { describe, expect, it } from "vitest";
import { computeTrend, formatTrend, trendHTML } from "./trend.js";
import type { VibeReport } from "./types.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

describe("formatTrend", () => {
	it("formats improvement", () => {
		const out = formatTrend({
			scoreDelta: 5, checkDeltas: [], newIssues: 0, fixedIssues: 3, prevTimestamp: "2026-05-29T00:00:00Z",
		});
		expect(out).toContain("5 pts");
		expect(out).toContain("improved");
		expect(out).toContain("3 fixed");
	});

	it("formats regression", () => {
		const out = formatTrend({
			scoreDelta: -3, checkDeltas: [], newIssues: 2, fixedIssues: 0, prevTimestamp: "2026-05-29T00:00:00Z",
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

describe("trendHTML", () => {
	it("generates valid HTML", () => {
		const html = trendHTML({
			scoreDelta: 5, checkDeltas: [{ name: "lint", prev: 70, curr: 75, delta: 5 }],
			newIssues: 0, fixedIssues: 2, prevTimestamp: "2026-05-29T00:00:00Z",
		});
		expect(html).toContain("+5 pts");
		expect(html).toContain("2 fixed");
		expect(html).toContain("lint +5");
		expect(html).toContain("var(--pass)");
	});
});
