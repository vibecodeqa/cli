import { describe, expect, it } from "vitest";
import { buildAnalyzerSnapshots } from "./analyzer-snapshot.js";
import type { CheckResult } from "./types.js";

function check(overrides: Partial<CheckResult> & { name: string }): CheckResult {
	return {
		name: overrides.name,
		score: overrides.score ?? 100,
		grade: overrides.grade ?? "A",
		details: overrides.details ?? {},
		issues: overrides.issues ?? [],
		duration: overrides.duration ?? 5,
	};
}

describe("buildAnalyzerSnapshots", () => {
	it("builds stable status, severity counts, and metrics without bespoke detail parsing", () => {
		const snapshots = buildAnalyzerSnapshots([
			check({
				name: "testing",
				details: { tests: 12, failed: 1, status: "failed" },
				issues: [{ severity: "error", message: "test failed" }],
			}),
			check({
				name: "react",
				details: {
					metrics: [{ id: "jsxFiles", label: "JSX/TSX files", value: 4, unit: "count", trend: "neutral" }],
					status: "passed",
				},
			}),
			check({
				name: "dependencies",
				details: { outdated: 2, durationMs: 40, packageManager: "pnpm", status: "passed" },
				issues: [{ severity: "warning", message: "outdated" }],
			}),
		]);

		expect(snapshots).toHaveLength(3);
		expect(snapshots[0]).toMatchObject({
			analyzerId: "testing",
			status: "failed",
			findingCount: 1,
			severityCounts: { error: 1, warning: 0, info: 0 },
		});
		expect(snapshots[0].metrics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "tests", value: 12, unit: "count" }),
				expect.objectContaining({ id: "failed", value: 1, trend: "lower-is-better" }),
			]),
		);
		expect(snapshots[1].metrics).toEqual([{ id: "jsxFiles", label: "JSX/TSX files", value: 4, unit: "count", trend: "neutral" }]);
		expect(snapshots[2].metrics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "outdated", value: 2 }),
				expect.objectContaining({ id: "durationMs", value: 40, unit: "ms" }),
				expect.objectContaining({ id: "packageManager", value: "pnpm" }),
			]),
		);
	});

	it("marks skipped and unavailable checks as trendable snapshots", () => {
		const snapshots = buildAnalyzerSnapshots([
			check({ name: "flutter", details: { skipped: true, reason: "not applicable" } }),
			check({ name: "doc-coherence", details: { comingSoon: true } }),
		]);

		expect(snapshots.map((snapshot) => snapshot.status)).toEqual(["skipped", "unavailable"]);
	});

	it("does not turn advisory findings into hard failed snapshots", () => {
		const snapshots = buildAnalyzerSnapshots([
			check({
				name: "html-quality",
				score: 0,
				grade: "F",
				details: { scoreMode: "available-unscored", scoreImpact: false, advisoryFindings: true },
				issues: [{ severity: "error", message: "missing title" }],
			}),
		]);

		expect(snapshots[0]).toMatchObject({
			analyzerId: "html-quality",
			status: "passed",
			findingCount: 1,
		});
	});
});

describe("buildAnalyzerSnapshots not-run checks (#107)", () => {
	it("omits score for skipped and unavailable checks", () => {
		const snaps = buildAnalyzerSnapshots([
			check({ name: "lint", score: 100, details: { skipped: true, unavailable: true, status: "unavailable" } }),
			check({ name: "react", score: 100, details: { skipped: true, status: "skipped" } }),
			check({ name: "ai-review", score: 100, details: { comingSoon: true } }),
			check({ name: "types", score: 88, details: { status: "passed" } }),
		]);
		expect(snaps.map((s) => s.status)).toEqual(["unavailable", "skipped", "unavailable", "passed"]);
		for (const s of snaps.slice(0, 3)) expect(s).not.toHaveProperty("score");
		expect(snaps[3].score).toBe(88);
		expect(JSON.parse(JSON.stringify(snaps[0]))).not.toHaveProperty("score");
	});
});

describe("buildAnalyzerSnapshots crashed runner (#107)", () => {
	it("keeps status failed but omits the placeholder 0", () => {
		const [snap] = buildAnalyzerSnapshots([
			check({ name: "lint", score: 0, details: { skipped: true, status: "failed", reason: "runner error: boom" } }),
		]);
		expect(snap.status).toBe("failed");
		expect(snap).not.toHaveProperty("score");
	});
});
