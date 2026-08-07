import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type HistoryEntry, loadHistory, scoreDeltaBadge } from "./history.js";

const tmp = join(tmpdir(), "vibe-check-history-test");

function writeReport(
	dir: string,
	filename: string,
	score: number,
	checks: { name: string; score: number; issues?: unknown[] }[],
	timestamp?: string,
	meta: Record<string, unknown> = {},
) {
	const report = {
		version: "0.14.0",
		timestamp: timestamp ?? new Date().toISOString(),
		score,
		grade: "B",
		checks: checks.map((c) => ({ name: c.name, score: c.score, grade: "B", details: {}, issues: c.issues ?? [], duration: 0 })),
		meta: { cwd: "/tmp", node: "v20", duration: 100, stack: {}, repoUrl: null, branch: "main", ...meta },
	};
	writeFileSync(join(dir, filename), JSON.stringify(report));
}

beforeEach(() => {
	mkdirSync(tmp, { recursive: true });
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe("loadHistory", () => {
	it("returns empty array when directory does not exist", () => {
		expect(loadHistory("/nonexistent/path")).toEqual([]);
	});

	it("returns empty array for empty directory", () => {
		expect(loadHistory(tmp)).toEqual([]);
	});

	it("loads and sorts history entries", () => {
		writeReport(tmp, "2026-05-15T10-00-00.json", 72, [{ name: "lint", score: 80 }], "2026-05-15T10:00:00.000Z");
		writeReport(tmp, "2026-05-16T10-00-00.json", 85, [{ name: "lint", score: 90 }], "2026-05-16T10:00:00.000Z");

		const entries = loadHistory(tmp);
		expect(entries).toHaveLength(2);
		expect(entries[0].score).toBe(72);
		expect(entries[1].score).toBe(85);
		expect(entries[1].checkScores.get("lint")).toBe(90);
		expect(entries[1].issues).toEqual([]);
	});

	it("loads compact issue snapshots with analyzer identity", () => {
		writeReport(
			tmp,
			"2026-05-15T10-00-00.json",
			72,
			[
				{
					name: "security",
					score: 60,
					issues: [
						{
							fingerprint: "abc123",
							rule: "xss",
							severity: "warning",
							file: "src/app.ts",
							line: 42,
							message: "Dangerous HTML sink",
						},
					],
				},
			],
			"2026-05-15T10:00:00.000Z",
		);

		const entries = loadHistory(tmp);

		expect(entries[0].issues).toEqual([
			{
				fingerprint: "abc123",
				check: "security",
				rule: "xss",
				severity: "warning",
				file: "src/app.ts",
				line: 42,
				message: "Dangerous HTML sink",
			},
		]);
	});

	it("loads normalized analyzer snapshots for dashboard trends", () => {
		writeReport(tmp, "2026-05-15T10-00-00.json", 72, [{ name: "testing", score: 64 }], "2026-05-15T10:00:00.000Z", {
			analyzerSnapshots: [
				{
					analyzerId: "testing",
					status: "failed",
					score: 64,
					findingCount: 2,
					severityCounts: { error: 1, warning: 1, info: 0 },
					metrics: [{ id: "passRate", label: "Pass rate", value: 93, unit: "percent", trend: "higher-is-better" }],
					durationMs: 55,
				},
			],
		});

		const entries = loadHistory(tmp);

		expect(entries[0].analyzerSnapshots).toEqual([
			{
				analyzerId: "testing",
				status: "failed",
				score: 64,
				findingCount: 2,
				severityCounts: { error: 1, warning: 1, info: 0 },
				metrics: [{ id: "passRate", label: "Pass rate", value: 93, unit: "percent", trend: "higher-is-better" }],
				durationMs: 55,
			},
		]);
	});

	it("skips corrupt files", () => {
		writeReport(tmp, "2026-05-15T10-00-00.json", 72, [{ name: "lint", score: 80 }], "2026-05-15T10:00:00.000Z");
		writeFileSync(join(tmp, "2026-05-15T11-00-00.json"), "not valid json");

		const entries = loadHistory(tmp);
		expect(entries).toHaveLength(1);
	});

	it("skips invalid top-level scores and ignores invalid check scores", () => {
		writeFileSync(
			join(tmp, "2026-05-15T10-00-00.json"),
			JSON.stringify({
				timestamp: "2026-05-15T10:00:00.000Z",
				score: null,
				checks: [{ name: "testing", score: null }],
			}),
		);
		writeFileSync(
			join(tmp, "2026-05-15T11-00-00.json"),
			JSON.stringify({
				timestamp: "2026-05-15T11:00:00.000Z",
				score: 80,
				checks: [
					{ name: "lint", score: 90 },
					{ name: "testing", score: null },
				],
			}),
		);

		const entries = loadHistory(tmp);
		expect(entries).toHaveLength(1);
		expect(entries[0].score).toBe(80);
		expect(entries[0].checkScores.get("lint")).toBe(90);
		expect(entries[0].checkScores.has("testing")).toBe(false);
	});

	it("limits to last 30 entries", () => {
		for (let i = 0; i < 40; i++) {
			const day = String(i + 1).padStart(2, "0");
			writeReport(tmp, `2026-01-${day}T10-00-00.json`, 50 + i, [{ name: "lint", score: 60 + i }], `2026-01-${day}T10:00:00.000Z`);
		}
		const entries = loadHistory(tmp);
		expect(entries).toHaveLength(30);
		// Should keep the LAST 30 (most recent)
		expect(entries[0].score).toBe(60); // entry 11 (index 10, score 50+10=60)
		expect(entries[29].score).toBe(89); // entry 40 (index 39, score 50+39=89)
	});

	it("skips non-json files", () => {
		writeReport(tmp, "2026-05-15T10-00-00.json", 72, [{ name: "lint", score: 80 }], "2026-05-15T10:00:00.000Z");
		writeFileSync(join(tmp, "readme.txt"), "hello");

		const entries = loadHistory(tmp);
		expect(entries).toHaveLength(1);
	});
});

describe("scoreDeltaBadge", () => {
	it("returns null for less than 2 entries", () => {
		expect(scoreDeltaBadge([])).toBeNull();
		expect(scoreDeltaBadge([{ timestamp: "2026-05-15T10:00:00Z", score: 72, checkScores: new Map(), issues: [] }])).toBeNull();
	});

	it("returns up arrow for improvement", () => {
		const entries: HistoryEntry[] = [
			{ timestamp: "2026-05-15T10:00:00Z", score: 72, checkScores: new Map(), issues: [] },
			{ timestamp: "2026-05-15T12:00:00Z", score: 75, checkScores: new Map(), issues: [] },
		];
		const badge = scoreDeltaBadge(entries)!;
		expect(badge.arrow).toBe("\u2191");
		expect(badge.delta).toBe(3);
		expect(badge.label).toContain("3");
		expect(badge.label).toContain("earlier today");
	});

	it("returns down arrow for regression", () => {
		const entries: HistoryEntry[] = [
			{ timestamp: "2026-05-14T10:00:00Z", score: 80, checkScores: new Map(), issues: [] },
			{ timestamp: "2026-05-15T10:00:00Z", score: 75, checkScores: new Map(), issues: [] },
		];
		const badge = scoreDeltaBadge(entries)!;
		expect(badge.arrow).toBe("\u2193");
		expect(badge.delta).toBe(-5);
		expect(badge.label).toContain("yesterday");
	});

	it("returns equals for unchanged", () => {
		const entries: HistoryEntry[] = [
			{ timestamp: "2026-05-08T10:00:00Z", score: 80, checkScores: new Map(), issues: [] },
			{ timestamp: "2026-05-15T10:00:00Z", score: 80, checkScores: new Map(), issues: [] },
		];
		const badge = scoreDeltaBadge(entries)!;
		expect(badge.arrow).toBe("=");
		expect(badge.delta).toBe(0);
		expect(badge.label).toContain("last week");
	});
});
