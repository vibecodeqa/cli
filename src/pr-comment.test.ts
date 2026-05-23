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
