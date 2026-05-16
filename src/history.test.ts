import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type HistoryEntry, loadHistory, scoreDeltaBadge } from "./history.js";

const tmp = join(tmpdir(), "vibe-check-history-test");

function writeReport(dir: string, filename: string, score: number, checks: { name: string; score: number }[], timestamp?: string) {
	const report = {
		version: "0.14.0",
		timestamp: timestamp ?? new Date().toISOString(),
		score,
		grade: "B",
		checks: checks.map((c) => ({ name: c.name, score: c.score, grade: "B", details: {}, issues: [], duration: 0 })),
		meta: { cwd: "/tmp", node: "v20", duration: 100, stack: {}, repoUrl: null, branch: "main" },
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
	});

	it("skips corrupt files", () => {
		writeReport(tmp, "2026-05-15T10-00-00.json", 72, [{ name: "lint", score: 80 }], "2026-05-15T10:00:00.000Z");
		writeFileSync(join(tmp, "2026-05-15T11-00-00.json"), "not valid json");

		const entries = loadHistory(tmp);
		expect(entries).toHaveLength(1);
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
		expect(scoreDeltaBadge([{ timestamp: "2026-05-15T10:00:00Z", score: 72, checkScores: new Map() }])).toBeNull();
	});

	it("returns up arrow for improvement", () => {
		const entries: HistoryEntry[] = [
			{ timestamp: "2026-05-15T10:00:00Z", score: 72, checkScores: new Map() },
			{ timestamp: "2026-05-15T12:00:00Z", score: 75, checkScores: new Map() },
		];
		const badge = scoreDeltaBadge(entries)!;
		expect(badge.arrow).toBe("\u2191");
		expect(badge.delta).toBe(3);
		expect(badge.label).toContain("3");
		expect(badge.label).toContain("earlier today");
	});

	it("returns down arrow for regression", () => {
		const entries: HistoryEntry[] = [
			{ timestamp: "2026-05-14T10:00:00Z", score: 80, checkScores: new Map() },
			{ timestamp: "2026-05-15T10:00:00Z", score: 75, checkScores: new Map() },
		];
		const badge = scoreDeltaBadge(entries)!;
		expect(badge.arrow).toBe("\u2193");
		expect(badge.delta).toBe(-5);
		expect(badge.label).toContain("yesterday");
	});

	it("returns equals for unchanged", () => {
		const entries: HistoryEntry[] = [
			{ timestamp: "2026-05-08T10:00:00Z", score: 80, checkScores: new Map() },
			{ timestamp: "2026-05-15T10:00:00Z", score: 80, checkScores: new Map() },
		];
		const badge = scoreDeltaBadge(entries)!;
		expect(badge.arrow).toBe("=");
		expect(badge.delta).toBe(0);
		expect(badge.label).toContain("last week");
	});
});
