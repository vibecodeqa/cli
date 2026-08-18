import { describe, expect, it } from "vitest";
import type { VibeReport } from "./types.js";
import { buildReportUploadPayload, repoSlugFromReport } from "./upload.js";

function report(): VibeReport {
	return {
		version: "0.55.0",
		timestamp: "2026-08-14T00:00:00.000Z",
		score: 82,
		grade: "B",
		checks: [
			{
				name: "testing",
				score: 70,
				grade: "C",
				details: {
					status: "failed",
					metrics: [
						{ id: "testFiles", label: "Test files", value: 4, unit: "count", trend: "higher-is-better" },
						{ id: "statementCoverage", label: "Statement coverage", value: 81.5, unit: "percent", trend: "higher-is-better" },
					],
				},
				issues: [{ severity: "warning", message: "low branch coverage" }],
				duration: 25,
			},
			{
				name: "complexity",
				score: 94,
				grade: "A",
				details: { totalLines: 120, durationMs: 9, status: "passed" },
				issues: [],
				duration: 9,
			},
		],
		meta: {
			cwd: "/tmp/project",
			node: "v22.0.0",
			duration: 50,
			stack: { language: "typescript", framework: "none", bundler: "none", testRunner: "vitest", linter: "none", packageManager: "pnpm" },
			repoUrl: "https://github.com/vibecodeqa/cli.git",
			branch: "main",
			analyzerSnapshots: [],
		},
	};
}

describe("upload payload contract", () => {
	it("derives the GitHub repo slug from report metadata", () => {
		expect(repoSlugFromReport(report())).toBe("vibecodeqa/cli");
	});

	it("posts a full report with fresh normalized analyzer snapshots", () => {
		const payload = buildReportUploadPayload(report(), "abc123");

		expect(payload).toMatchObject({ repo: "vibecodeqa/cli", sha: "abc123" });
		expect(payload?.report.meta.analyzerSnapshots).toHaveLength(2);
		expect(payload?.report.meta.analyzerSnapshots?.map((snapshot) => snapshot.analyzerId)).toEqual(["testing", "complexity"]);

		const testing = payload?.report.meta.analyzerSnapshots?.find((snapshot) => snapshot.analyzerId === "testing");
		expect(testing).toMatchObject({
			status: "failed",
			findingCount: 1,
			severityCounts: { error: 0, warning: 1, info: 0 },
			durationMs: 25,
		});
		expect(testing?.metrics).toEqual([
			{ id: "testFiles", label: "Test files", value: 4, unit: "count", trend: "higher-is-better" },
			{ id: "statementCoverage", label: "Statement coverage", value: 81.5, unit: "percent", trend: "higher-is-better" },
		]);

		const complexity = payload?.report.meta.analyzerSnapshots?.find((snapshot) => snapshot.analyzerId === "complexity");
		expect(complexity?.metrics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "totalLines", value: 120, unit: "count" }),
				expect.objectContaining({ id: "durationMs", value: 9, unit: "ms" }),
			]),
		);
	});

	it("returns null instead of uploading when repo metadata is missing", () => {
		const missingRepo = report();
		missingRepo.meta.repoUrl = null;

		expect(buildReportUploadPayload(missingRepo)).toBeNull();
	});
});
