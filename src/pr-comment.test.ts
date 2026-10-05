import { describe, expect, it } from "vitest";

// We can't test the full postPRComment (needs GitHub API), but we can
// test that the module loads and the PR detection handles missing env gracefully.
// The buildCommentBody function is private, so we test via integration.

describe("pr-comment module", () => {
	it("imports without error", async () => {
		const mod = await import("./pr-comment.js");
		expect(mod.postPRComment).toBeTypeOf("function");
	});

	it("postPRComment returns false when no PR context", async () => {
		const { postPRComment } = await import("./pr-comment.js");
		const report = {
			version: "0.30.0",
			timestamp: new Date().toISOString(),
			score: 75,
			grade: "B" as const,
			checks: [{ name: "lint", score: 80, grade: "B" as const, details: {}, issues: [], duration: 10 }],
			meta: { cwd: "/tmp", node: "v22", duration: 100, stack: {} as any, repoUrl: null, branch: "main" },
		};
		// No GITHUB_TOKEN, no GITHUB_EVENT_PATH, no gh CLI context
		const result = await postPRComment(report, null, "/tmp/nonexistent");
		expect(result).toBe(false);
	});
});

describe("PR comment body (#107)", () => {
	const base = {
		version: "0.56.0",
		timestamp: "2026-10-05T00:00:00Z",
		score: 80,
		grade: "B" as const,
		meta: { cwd: "/tmp", node: "v22", duration: 100, stack: {} as any, repoUrl: null, branch: "main" },
	};
	const unavailable = {
		name: "lint",
		status: "unavailable",
		score: 100,
		grade: "A" as const,
		details: { skipped: true, unavailable: true, status: "unavailable" },
		issues: [],
		duration: 1,
	};
	const scored = { name: "lint", status: "failed", score: 72, grade: "C" as const, details: { status: "failed" }, issues: [], duration: 1 };

	it("lists lint unavailable → 72 as a status change, not a 100 → 72 regression", async () => {
		const { buildCommentBody } = await import("./pr-comment.js");
		const body = buildCommentBody({ ...base, checks: [scored] }, null, { ...base, checks: [unavailable] });
		expect(body).toContain("lint: unavailable → 72");
		expect(body).not.toContain("100 → 72");
		expect(body).not.toContain("(-28)");
	});

	it("does not show removing the tool as a +N improvement", async () => {
		const { buildCommentBody } = await import("./pr-comment.js");
		const body = buildCommentBody({ ...base, checks: [unavailable] }, null, { ...base, checks: [{ ...scored, score: 64 }] });
		expect(body).toContain("lint: 64 → unavailable");
		expect(body).not.toContain("+36");
		expect(body).not.toContain("64 → 100");
	});
});
