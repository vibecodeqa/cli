import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { VibeReport } from "./types.js";
import { buildReportUploadPayload, currentGitSha, repoSlugFromReport } from "./upload.js";

const EVENTS = join(import.meta.dirname!, "..", "fixtures", "github-events");

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

describe("upload sha", () => {
	// Every case passes an explicit env, so the GITHUB_* of a CI run executing
	// this suite cannot leak in.
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});
	const repoWithCommit = () => {
		const dir = mkdtempSync(join(tmpdir(), "vcqa-upload-git-"));
		dirs.push(dir);
		const git = (...args: string[]) =>
			execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], {
				cwd: dir,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			}).trim();
		git("init", "-q");
		writeFileSync(join(dir, "a.txt"), "a\n");
		git("add", "a.txt");
		git("commit", "-q", "-m", "init");
		return { dir, head: git("rev-parse", "HEAD") };
	};

	it("uses the PR head sha on pull_request, not the merge sha", () => {
		const { dir, head: mergeSha } = repoWithCommit();
		const env = {
			GITHUB_ACTIONS: "true",
			GITHUB_EVENT_NAME: "pull_request",
			GITHUB_EVENT_PATH: join(EVENTS, "pull_request.json"),
			GITHUB_SHA: mergeSha,
		};
		expect(currentGitSha(dir, env)).toBe("a".repeat(40));
	});

	it("uses the checked-out commit on push", () => {
		const { dir, head } = repoWithCommit();
		const env = {
			GITHUB_ACTIONS: "true",
			GITHUB_EVENT_NAME: "push",
			GITHUB_EVENT_PATH: join(EVENTS, "push.json"),
			GITHUB_SHA: head,
		};
		expect(currentGitSha(dir, env)).toBe(head);
	});

	it("uses GITHUB_SHA on push when there is no local git", () => {
		const dir = mkdtempSync(join(tmpdir(), "vcqa-upload-nogit-"));
		dirs.push(dir);
		const env = {
			GITHUB_ACTIONS: "true",
			GITHUB_EVENT_NAME: "push",
			GITHUB_EVENT_PATH: join(EVENTS, "push.json"),
			GITHUB_SHA: "c".repeat(40),
		};
		expect(currentGitSha(dir, env)).toBe("c".repeat(40));
	});

	it("falls back to the local HEAD outside CI", () => {
		const { dir, head } = repoWithCommit();
		expect(currentGitSha(dir, {})).toBe(head);
	});
});
