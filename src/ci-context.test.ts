import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectCiContext } from "./ci-context.js";
import { detectPR } from "./pr-comment.js";
import { currentGitSha } from "./upload.js";

const EVENTS = join(import.meta.dirname!, "..", "fixtures", "github-events");
const HEAD_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const PUSH_SHA = "c".repeat(40);
const BEFORE_SHA = "d".repeat(40);
const QUEUE_SHA = "e".repeat(40);

// This suite may itself run under GitHub Actions. Every case passes an explicit
// env, and process.env's GITHUB_* are stripped for the duration so nothing that
// falls back to process.env can see the real run.
let savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
	savedEnv = {};
	for (const key of Object.keys(process.env)) {
		if (key.startsWith("GITHUB_")) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
	}
});
afterEach(() => {
	for (const [key, value] of Object.entries(savedEnv)) process.env[key] = value;
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const dirs: string[] = [];
function gitRepo(branch = "trunk"): { dir: string; head: string; git: (...args: string[]) => string } {
	const dir = mkdtempSync(join(tmpdir(), "vcqa-ci-context-"));
	dirs.push(dir);
	const git = (...args: string[]) =>
		execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], {
			cwd: dir,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();
	git("init", "-q", "-b", branch);
	writeFileSync(join(dir, "a.txt"), "a\n");
	git("add", "a.txt");
	git("commit", "-q", "-m", "init");
	return { dir, head: git("rev-parse", "HEAD"), git };
}

function actionsEnv(eventName: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
	return {
		GITHUB_ACTIONS: "true",
		GITHUB_EVENT_NAME: eventName,
		GITHUB_EVENT_PATH: join(EVENTS, `${eventName}.json`),
		GITHUB_REPOSITORY: "octo-org/widgets",
		GITHUB_SERVER_URL: "https://github.com",
		GITHUB_RUN_ID: "123456",
		GITHUB_RUN_ATTEMPT: "2",
		GITHUB_ACTOR: "octocat",
		...extra,
	};
}

describe("detectCiContext — no CI", () => {
	it("detached HEAD: sha from HEAD, no branch, ci null", () => {
		const { dir, head, git } = gitRepo();
		git("checkout", "-q", "--detach");
		const ctx = detectCiContext(dir, {});
		expect(ctx.ci).toBeNull();
		expect(ctx.git).toMatchObject({
			sha: head,
			headSha: head,
			baseSha: null,
			branch: null,
			ref: null,
			prNumber: null,
			defaultBranch: null,
		});
		expect(ctx.git.commitDate).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	it("on a branch: local branch and ref", () => {
		const { dir } = gitRepo("feature/x");
		const ctx = detectCiContext(dir, {});
		expect(ctx.git.branch).toBe("feature/x");
		expect(ctx.git.ref).toBe("refs/heads/feature/x");
	});

	it("ignores stray GITHUB_* when not running in Actions", () => {
		const { dir, head } = gitRepo();
		const ctx = detectCiContext(dir, { GITHUB_SHA: "1".repeat(40), GITHUB_HEAD_REF: "nope" });
		expect(ctx.git.sha).toBe(head);
		expect(ctx.git.branch).toBe("trunk");
		expect(ctx.ci).toBeNull();
	});
});

describe("detectCiContext — GitHub Actions", () => {
	it("pull_request: sha = merge sha, headSha = PR head, branch = head ref", () => {
		const { dir, head: mergeSha, git } = gitRepo();
		git("checkout", "-q", "--detach"); // actions/checkout leaves refs/pull/N/merge detached
		const ctx = detectCiContext(
			dir,
			actionsEnv("pull_request", {
				GITHUB_SHA: mergeSha,
				GITHUB_REF: "refs/pull/42/merge",
				GITHUB_REF_NAME: "42/merge",
				GITHUB_HEAD_REF: "feature/login",
				GITHUB_BASE_REF: "main",
			}),
		);
		expect(ctx.git).toEqual({
			sha: mergeSha,
			headSha: HEAD_SHA,
			baseSha: BASE_SHA,
			branch: "feature/login",
			ref: "refs/pull/42/merge",
			prNumber: 42,
			// The head commit is not in a shallow merge checkout.
			commitDate: null,
			defaultBranch: "main",
		});
		expect(ctx.ci).toEqual({
			provider: "github-actions",
			runId: "123456",
			runAttempt: 2,
			runUrl: "https://github.com/octo-org/widgets/actions/runs/123456",
			event: "pull_request",
			actor: "octocat",
		});
		expect(ctx.headShaNote).toBeNull();
	});

	it("push: baseSha = before, branch from GITHUB_REF, commitDate falls back to head_commit", () => {
		const { dir } = gitRepo();
		const ctx = detectCiContext(dir, actionsEnv("push", { GITHUB_SHA: PUSH_SHA, GITHUB_REF: "refs/heads/main", GITHUB_REF_NAME: "main" }));
		expect(ctx.git).toEqual({
			sha: PUSH_SHA,
			headSha: PUSH_SHA,
			baseSha: BEFORE_SHA,
			branch: "main",
			ref: "refs/heads/main",
			prNumber: null,
			commitDate: "2026-10-01T09:30:00+10:00",
			defaultBranch: "main",
		});
		expect(ctx.ci?.event).toBe("push");
	});

	it("push of a new branch: all-zero before → baseSha null", () => {
		const { dir } = gitRepo();
		const ctx = detectCiContext(
			dir,
			actionsEnv("push", {
				GITHUB_EVENT_PATH: join(EVENTS, "push-new-branch.json"),
				GITHUB_SHA: PUSH_SHA,
				GITHUB_REF: "refs/heads/feature/new",
				GITHUB_REF_NAME: "feature/new",
			}),
		);
		expect(ctx.git.baseSha).toBeNull();
		expect(ctx.git.branch).toBe("feature/new");
	});

	it("push of a tag: no branch", () => {
		const { dir, git } = gitRepo();
		git("checkout", "-q", "--detach");
		const ctx = detectCiContext(
			dir,
			actionsEnv("push", { GITHUB_SHA: PUSH_SHA, GITHUB_REF: "refs/tags/v1.0.0", GITHUB_REF_NAME: "v1.0.0" }),
		);
		expect(ctx.git.branch).toBeNull();
		expect(ctx.git.ref).toBe("refs/tags/v1.0.0");
	});

	it("workflow_dispatch: scanned commit is the head, no base, no PR", () => {
		const { dir, head } = gitRepo("main");
		const ctx = detectCiContext(
			dir,
			actionsEnv("workflow_dispatch", { GITHUB_SHA: head, GITHUB_REF: "refs/heads/main", GITHUB_REF_NAME: "main" }),
		);
		expect(ctx.git).toMatchObject({ sha: head, headSha: head, baseSha: null, branch: "main", prNumber: null, defaultBranch: "main" });
		expect(ctx.git.commitDate).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(ctx.ci?.event).toBe("workflow_dispatch");
	});

	it("merge_group: headSha = merge_group.head_sha, baseSha = merge_group.base_sha", () => {
		const { dir } = gitRepo();
		const queueRef = `refs/heads/gh-readonly-queue/main/pr-42-${BASE_SHA}`;
		const ctx = detectCiContext(
			dir,
			actionsEnv("merge_group", { GITHUB_SHA: QUEUE_SHA, GITHUB_REF: queueRef, GITHUB_REF_NAME: queueRef.slice("refs/heads/".length) }),
		);
		expect(ctx.git).toMatchObject({
			sha: QUEUE_SHA,
			headSha: QUEUE_SHA,
			baseSha: BASE_SHA,
			branch: `gh-readonly-queue/main/pr-42-${BASE_SHA}`,
			prNumber: null,
			commitDate: "2026-10-01T10:00:00Z",
		});
	});

	it("pull_request_target with the default (base) checkout: headSha null, with a reason", () => {
		const { dir, head: baseTip } = gitRepo("main");
		const ctx = detectCiContext(
			dir,
			actionsEnv("pull_request_target", {
				GITHUB_SHA: baseTip,
				GITHUB_REF: "refs/heads/main",
				GITHUB_REF_NAME: "main",
				GITHUB_HEAD_REF: "patch-1",
				GITHUB_BASE_REF: "main",
			}),
		);
		expect(ctx.git).toMatchObject({ sha: baseTip, headSha: null, baseSha: BASE_SHA, branch: "main", prNumber: 43 });
		expect(ctx.headShaNote).toMatch(/pull_request_target/);
	});

	it("pull_request_target with the PR head checked out: the scan describes the head", () => {
		const { dir, head } = gitRepo();
		const eventPath = join(dir, "event.json");
		writeFileSync(
			eventPath,
			JSON.stringify({
				number: 43,
				pull_request: { number: 43, head: { ref: "patch-1", sha: head }, base: { ref: "main", sha: BASE_SHA } },
			}),
		);
		const ctx = detectCiContext(
			dir,
			actionsEnv("pull_request_target", {
				GITHUB_EVENT_PATH: eventPath,
				GITHUB_SHA: BASE_SHA, // always the base tip on pull_request_target
				GITHUB_REF: "refs/heads/main",
				GITHUB_HEAD_REF: "patch-1",
			}),
		);
		expect(ctx.git).toMatchObject({ sha: head, headSha: head, baseSha: BASE_SHA, branch: "patch-1", prNumber: 43 });
		expect(ctx.headShaNote).toBeNull();
	});

	it("missing run metadata degrades to empty strings, not a broken URL", () => {
		const { dir } = gitRepo();
		const ctx = detectCiContext(dir, { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "push" });
		expect(ctx.ci).toEqual({ provider: "github-actions", runId: "", runAttempt: 1, runUrl: "", event: "push", actor: null });
	});
});

describe("consumers share the context", () => {
	it("--upload and --pr-comment agree with the report on a pull_request run", () => {
		const { dir, head: mergeSha } = gitRepo();
		const env = actionsEnv("pull_request", { GITHUB_SHA: mergeSha, GITHUB_REF: "refs/pull/42/merge", GITHUB_HEAD_REF: "feature/login" });
		expect(currentGitSha(dir, env)).toBe(HEAD_SHA);
		expect(detectPR(dir, env)).toEqual({ owner: "octo-org", repo: "widgets", prNumber: 42 });
	});

	it("--pr-comment keeps the issue fallback (issue_comment on a PR)", () => {
		const { dir } = gitRepo();
		const eventPath = join(dir, "issue_comment.json");
		writeFileSync(eventPath, JSON.stringify({ action: "created", issue: { number: 7, pull_request: {} }, comment: { body: "/vcqa" } }));
		expect(detectPR(dir, actionsEnv("issue_comment", { GITHUB_EVENT_PATH: eventPath }))).toEqual({
			owner: "octo-org",
			repo: "widgets",
			prNumber: 7,
		});
	});

	it("pull_request_target on the base checkout uploads against the scanned base commit", () => {
		const { dir, head: baseTip } = gitRepo("main");
		const env = actionsEnv("pull_request_target", { GITHUB_SHA: baseTip, GITHUB_REF: "refs/heads/main" });
		expect(currentGitSha(dir, env)).toBe(baseTip);
	});
});
