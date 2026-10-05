import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectCiContext, type GitRunner, isShaOnRemote } from "./ci-context.js";
import { detectPR } from "./pr-comment.js";
import { currentGitSha } from "./upload.js";

const EVENTS = join(import.meta.dirname!, "..", "fixtures", "github-events");
const HEAD_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const PUSH_SHA = "c".repeat(40);
const BEFORE_SHA = "d".repeat(40);
const QUEUE_SHA = "e".repeat(40);

// This suite may itself run under GitHub Actions. Every case passes an explicit
// env, and process.env's GITHUB_* and CI are stripped for the duration so
// nothing that falls back to process.env can see the real run.
let savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
	savedEnv = {};
	for (const key of Object.keys(process.env)) {
		if (key.startsWith("GITHUB_") || key === "CI") {
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

/** A directory with no git: the scanned commit can only come from GITHUB_SHA. */
function noGitDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "vcqa-ci-context-nogit-"));
	dirs.push(dir);
	return dir;
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

	it("shaOnRemote: false for an unpushed HEAD, true once a remote-tracking ref contains it", () => {
		const { dir, git } = gitRepo();
		expect(detectCiContext(dir, {}).shaOnRemote).toBe(false);
		git("update-ref", "refs/remotes/origin/trunk", "HEAD");
		expect(detectCiContext(dir, {}).shaOnRemote).toBe(true);
	});

	it("another CI provider (CI set): the pushed check is skipped, so links keep the sha", () => {
		const { dir, git } = gitRepo();
		git("checkout", "-q", "--detach"); // a pipeline ref no remote-tracking branch contains
		expect(detectCiContext(dir, {}).shaOnRemote).toBe(false);
		expect(detectCiContext(dir, { CI: "true" }).shaOnRemote).toBeNull();
		expect(detectCiContext(dir, { CI: "1" }).shaOnRemote).toBeNull();
		expect(detectCiContext(dir, { CI: "false" }).shaOnRemote).toBe(false);
		expect(detectCiContext(dir, { CI: "0" }).shaOnRemote).toBe(false);
	});

	it("ignores stray GITHUB_* when not running in Actions", () => {
		const { dir, head } = gitRepo();
		const ctx = detectCiContext(dir, { GITHUB_SHA: "1".repeat(40), GITHUB_HEAD_REF: "nope" });
		expect(ctx.git.sha).toBe(head);
		expect(ctx.git.branch).toBe("trunk");
		expect(ctx.ci).toBeNull();
	});
});

describe("isShaOnRemote", () => {
	/** The real git, recording every call. */
	function recordingRunner(): { run: GitRunner; calls: string[][] } {
		const calls: string[][] = [];
		const run: GitRunner = (cwd, args, timeoutMs) => {
			calls.push(args);
			return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: timeoutMs });
		};
		return { run, calls };
	}
	const usedContains = (calls: string[][]) => calls.some((args) => args.includes("--contains"));

	function trackingRepo() {
		const repo = gitRepo();
		repo.git("remote", "add", "origin", "https://github.com/octo-org/widgets.git");
		repo.git("update-ref", "refs/remotes/origin/trunk", "HEAD");
		repo.git("config", "branch.trunk.remote", "origin");
		repo.git("config", "branch.trunk.merge", "refs/heads/trunk");
		return repo;
	}

	it("upstream contains HEAD: true from merge-base, without scanning every remote branch", () => {
		const { dir, head } = trackingRepo();
		const { run, calls } = recordingRunner();
		expect(isShaOnRemote(dir, head, "trunk", { run })).toBe(true);
		expect(calls[0]).toEqual(["merge-base", "--is-ancestor", head, "@{upstream}"]);
		expect(usedContains(calls)).toBe(false);
	});

	it("upstream behind HEAD (local commits): false, without scanning every remote branch", () => {
		const { dir, git } = trackingRepo();
		writeFileSync(join(dir, "b.txt"), "b\n");
		git("add", "b.txt");
		git("commit", "-q", "-m", "local only");
		const { run, calls } = recordingRunner();
		expect(isShaOnRemote(dir, git("rev-parse", "HEAD"), "trunk", { run })).toBe(false);
		expect(usedContains(calls)).toBe(false);
	});

	it("no upstream: falls back to `branch -r --contains`, under a timeout", () => {
		const { dir, head, git } = gitRepo();
		const { run, calls } = recordingRunner();
		expect(isShaOnRemote(dir, head, "trunk", { run })).toBe(false);
		expect(usedContains(calls)).toBe(true);
		git("update-ref", "refs/remotes/origin/other", "HEAD"); // pushed, but not tracked
		expect(isShaOnRemote(dir, head, "trunk", { run })).toBe(true);
		let timeout: number | undefined;
		isShaOnRemote(dir, head, "trunk", {
			run: (cwd, args, timeoutMs) => {
				if (args.includes("--contains")) timeout = timeoutMs;
				return run(cwd, args, timeoutMs);
			},
		});
		expect(timeout).toBeGreaterThan(0);
	});

	it("the fallback timing out: false (branch link) on a branch, null (sha link) when detached", () => {
		const { dir, head } = gitRepo();
		const timingOut: GitRunner = (_cwd, args, timeoutMs) => {
			if (args[0] === "merge-base") throw Object.assign(new Error("no upstream"), { status: 128 });
			expect(timeoutMs).toBe(50);
			throw Object.assign(new Error("spawnSync git ETIMEDOUT"), { code: "ETIMEDOUT", signal: "SIGTERM", status: null });
		};
		expect(isShaOnRemote(dir, head, "trunk", { run: timingOut, timeoutMs: 50 })).toBe(false);
		expect(isShaOnRemote(dir, head, null, { run: timingOut, timeoutMs: 50 })).toBeNull();
	});

	it("git failing outright: null", () => {
		const failing: GitRunner = () => {
			throw Object.assign(new Error("not a git repository"), { status: 128 });
		};
		expect(isShaOnRemote(noGitDir(), HEAD_SHA, "trunk", { run: failing })).toBeNull();
		expect(isShaOnRemote(noGitDir(), null, "trunk")).toBeNull();
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

	it("push without local git: sha = GITHUB_SHA, baseSha = before, commitDate falls back to head_commit", () => {
		const dir = noGitDir();
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
		const dir = noGitDir();
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
		const { dir, head, git } = gitRepo();
		git("checkout", "-q", "--detach");
		const ctx = detectCiContext(dir, actionsEnv("push", { GITHUB_SHA: head, GITHUB_REF: "refs/tags/v1.0.0", GITHUB_REF_NAME: "v1.0.0" }));
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
		const dir = noGitDir();
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

	it("no GITHUB_RUN_ID: ci is null rather than an empty runId the schema rejects", () => {
		const { dir, head } = gitRepo();
		const ctx = detectCiContext(dir, { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "push", GITHUB_SHA: head });
		expect(ctx.ci).toBeNull();
		expect(ctx.git.sha).toBe(head);
	});

	it("run id without a repository: no run URL, but a schema-valid run", () => {
		const { dir } = gitRepo();
		const ctx = detectCiContext(dir, { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "push", GITHUB_RUN_ID: "77" });
		expect(ctx.ci).toEqual({ provider: "github-actions", runId: "77", runAttempt: 1, runUrl: "", event: "push", actor: null });
	});
});

/** A repo shaped like a PR: `main` moved on after `feature/login` branched,
 *  and `merge` is GitHub's refs/pull/N/merge — parents [base tip, head]. */
function prRepo(): {
	dir: string;
	base: string;
	head: string;
	merge: string;
	git: (...args: string[]) => string;
	eventPath: (number: number, headRef: string) => string;
} {
	const { dir, git } = gitRepo("main");
	git("checkout", "-q", "-b", "feature/login");
	writeFileSync(join(dir, "b.txt"), "b\n");
	git("add", "b.txt");
	git("commit", "-q", "-m", "head");
	const head = git("rev-parse", "HEAD");
	git("checkout", "-q", "main");
	writeFileSync(join(dir, "c.txt"), "c\n");
	git("add", "c.txt");
	git("commit", "-q", "-m", "base moved");
	const base = git("rev-parse", "HEAD");
	git("checkout", "-q", "--detach", base);
	git("merge", "-q", "--no-ff", "-m", "Merge head into base", head);
	const merge = git("rev-parse", "HEAD");
	const eventPath = (number: number, headRef: string) => {
		const path = join(dir, `event-${number}.json`);
		writeFileSync(
			path,
			JSON.stringify({
				number,
				pull_request: { number, head: { ref: headRef, sha: head }, base: { ref: "main", sha: base } },
				repository: { default_branch: "main" },
			}),
		);
		return path;
	};
	return { dir, base, head, merge, git, eventPath };
}

describe("detectCiContext — the checkout, not GITHUB_SHA, is the scanned commit", () => {
	it("pull_request, default merge checkout: sha = merge, headSha = PR head", () => {
		const { dir, base, head, merge, eventPath } = prRepo();
		const env = actionsEnv("pull_request", {
			GITHUB_EVENT_PATH: eventPath(42, "feature/login"),
			GITHUB_SHA: merge,
			GITHUB_REF: "refs/pull/42/merge",
		});
		const ctx = detectCiContext(dir, env);
		expect(ctx.git).toMatchObject({ sha: merge, headSha: head, baseSha: base, branch: "feature/login", prNumber: 42 });
		expect(currentGitSha(dir, detectCiContext(dir, env))).toBe(head);
	});

	it("pull_request with `ref: pull_request.head.sha` checked out: sha = PR head, not the merge sha", () => {
		const { dir, base, head, merge, git, eventPath } = prRepo();
		git("checkout", "-q", "--detach", head);
		const env = actionsEnv("pull_request", {
			GITHUB_EVENT_PATH: eventPath(42, "feature/login"),
			GITHUB_SHA: merge,
			GITHUB_REF: "refs/pull/42/merge",
		});
		const ctx = detectCiContext(dir, env);
		expect(ctx.git).toMatchObject({ sha: head, headSha: head, baseSha: base, branch: "feature/login", prNumber: 42 });
		expect(currentGitSha(dir, detectCiContext(dir, env))).toBe(head);
	});

	it("pull_request_target with the merge ref checked out: describes the PR, status goes to the head, not the base tip", () => {
		const { dir, base, head, merge, eventPath } = prRepo();
		const env = actionsEnv("pull_request_target", {
			GITHUB_EVENT_PATH: eventPath(43, "patch-1"),
			GITHUB_SHA: base, // always the base tip on pull_request_target
			GITHUB_REF: "refs/heads/main",
			GITHUB_HEAD_REF: "patch-1",
			GITHUB_BASE_REF: "main",
		});
		const ctx = detectCiContext(dir, env);
		expect(ctx.git).toMatchObject({ sha: merge, headSha: head, baseSha: base, branch: "patch-1", prNumber: 43 });
		expect(ctx.headShaNote).toBeNull();
		expect(currentGitSha(dir, detectCiContext(dir, env))).toBe(head);
		expect(currentGitSha(dir, detectCiContext(dir, env))).not.toBe(base);
	});

	it("pull_request_target merge checkout is recognised in a depth-1 clone (parents absent)", () => {
		const { dir: origin, base, head, merge, git, eventPath } = prRepo();
		git("branch", "pr-merge", merge);
		const clone = mkdtempSync(join(tmpdir(), "vcqa-ci-context-shallow-"));
		dirs.push(clone);
		execFileSync("git", ["clone", "-q", "--depth", "1", "--branch", "pr-merge", `file://${origin}`, clone], { stdio: "pipe" });
		const env = actionsEnv("pull_request_target", {
			GITHUB_EVENT_PATH: eventPath(43, "patch-1"),
			GITHUB_SHA: base,
			GITHUB_REF: "refs/heads/main",
		});
		const ctx = detectCiContext(clone, env);
		expect(ctx.git).toMatchObject({ sha: merge, headSha: head, prNumber: 43 });
		expect(ctx.git.commitDate).toBeNull(); // the head object is not in the clone
	});

	it("a second repository checked out under `path:` is described from its own git, not the event", () => {
		const { dir, head } = gitRepo("tooling");
		const env = actionsEnv("pull_request", {
			GITHUB_SHA: "1".repeat(40), // the workflow repo's merge commit
			GITHUB_REF: "refs/pull/42/merge",
			GITHUB_HEAD_REF: "feature/login",
		});
		const ctx = detectCiContext(dir, env);
		expect(ctx.git).toEqual({
			sha: head,
			headSha: head,
			baseSha: null,
			branch: "tooling",
			ref: "refs/heads/tooling",
			prNumber: null,
			commitDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
			defaultBranch: null,
		});
		expect(ctx.ci?.runId).toBe("123456"); // still the same run
		expect(currentGitSha(dir, detectCiContext(dir, env))).toBe(head);
	});

	it("a second repository on a push run is described from its own git too", () => {
		const { dir, head, git } = gitRepo();
		git("checkout", "-q", "--detach");
		const ctx = detectCiContext(dir, actionsEnv("push", { GITHUB_SHA: PUSH_SHA, GITHUB_REF: "refs/heads/main" }));
		expect(ctx.git).toMatchObject({ sha: head, headSha: head, baseSha: null, branch: null, ref: null, defaultBranch: null });
	});
});

describe("detectCiContext — a local branch named like the PR head", () => {
	/** A pull_request payload whose head and base live in the given repositories. */
	function prEvent(dir: string, pr: { headRef: string; headSha: string; baseSha: string; headRepo: string }): string {
		const path = join(dir, "event-branch.json");
		writeFileSync(
			path,
			JSON.stringify({
				number: 7,
				pull_request: {
					number: 7,
					head: { ref: pr.headRef, sha: pr.headSha, repo: { full_name: pr.headRepo } },
					base: { ref: "main", sha: pr.baseSha, repo: { full_name: "octo-org/widgets" } },
				},
				repository: { default_branch: "main" },
			}),
		);
		return path;
	}

	it("fork PR from the fork's main, with the base repo's `main` checked out: not the PR, not attributed to it", () => {
		const { dir, base, head, merge, git } = prRepo();
		git("checkout", "-q", "main"); // `ref: main` — local branch "main", at the base tip
		const env = actionsEnv("pull_request", {
			GITHUB_EVENT_PATH: prEvent(dir, { headRef: "main", headSha: head, baseSha: base, headRepo: "forker/widgets" }),
			GITHUB_SHA: merge,
			GITHUB_REF: "refs/pull/7/merge",
			GITHUB_HEAD_REF: "main",
		});
		const ctx = detectCiContext(dir, env);
		expect(ctx.git).toMatchObject({ sha: base, headSha: base, branch: "main", prNumber: null });
		// The status is for the commit actually scanned, and no PR claims it.
		expect(currentGitSha(dir, ctx)).toBe(base);
		expect(ctx.git.prNumber).not.toBe(7);
	});

	it("fork PR whose head is an ancestor of the local branch is still not matched by name", () => {
		const { dir, head, merge, git } = prRepo();
		git("checkout", "-q", "feature/login");
		const env = actionsEnv("pull_request", {
			GITHUB_EVENT_PATH: prEvent(dir, { headRef: "feature/login", headSha: head, baseSha: "b".repeat(40), headRepo: "forker/widgets" }),
			GITHUB_SHA: merge,
			GITHUB_REF: "refs/pull/7/merge",
		});
		// localHead === payload head, so it is the head by sha — the fork guard only gates the name match.
		expect(detectCiContext(dir, env).git).toMatchObject({ sha: head, headSha: head, prNumber: 7 });
		writeFileSync(join(dir, "d.txt"), "d\n");
		git("add", "d.txt");
		git("commit", "-q", "-m", "local on top");
		expect(detectCiContext(dir, env).git).toMatchObject({ branch: "feature/login", prNumber: null });
	});

	it("same-repo PR, `ref: head_ref` checked out after a re-push: the scan is the PR head branch", () => {
		const { dir, base, head, merge, git } = prRepo();
		git("checkout", "-q", "feature/login");
		writeFileSync(join(dir, "d.txt"), "d\n");
		git("add", "d.txt");
		git("commit", "-q", "-m", "pushed after the event");
		const tip = git("rev-parse", "HEAD");
		const env = actionsEnv("pull_request", {
			GITHUB_EVENT_PATH: prEvent(dir, { headRef: "feature/login", headSha: head, baseSha: base, headRepo: "octo-org/widgets" }),
			GITHUB_SHA: merge,
			GITHUB_REF: "refs/pull/7/merge",
			GITHUB_HEAD_REF: "feature/login",
		});
		const ctx = detectCiContext(dir, env);
		expect(ctx.git).toMatchObject({ sha: tip, headSha: tip, baseSha: base, branch: "feature/login", prNumber: 7 });
		expect(currentGitSha(dir, ctx)).toBe(tip);
	});

	it("same-repo PR, branch name matches but the payload head is not an ancestor: described locally", () => {
		const { dir, base, head, merge, git } = prRepo();
		git("checkout", "-q", "-B", "feature/login", "main"); // same name, unrelated history
		const env = actionsEnv("pull_request", {
			GITHUB_EVENT_PATH: prEvent(dir, { headRef: "feature/login", headSha: head, baseSha: base, headRepo: "octo-org/widgets" }),
			GITHUB_SHA: merge,
			GITHUB_REF: "refs/pull/7/merge",
		});
		expect(detectCiContext(dir, env).git).toMatchObject({ sha: base, headSha: base, prNumber: null });
	});
});

describe("detectCiContext — pull_request without a readable event payload", () => {
	it("takes the PR number from GITHUB_REF, the branch from GITHUB_HEAD_REF, head/base from the merge parents", () => {
		const { dir, base, head, merge } = prRepo();
		const env = actionsEnv("pull_request", {
			GITHUB_EVENT_PATH: join(dir, "missing-event.json"),
			GITHUB_SHA: merge,
			GITHUB_REF: "refs/pull/42/merge",
			GITHUB_HEAD_REF: "feature/login",
			GITHUB_BASE_REF: "main",
		});
		const ctx = detectCiContext(dir, env);
		expect(ctx.event).toBeNull();
		expect(ctx.git).toMatchObject({ sha: merge, headSha: head, baseSha: base, branch: "feature/login", prNumber: 42 });
		expect(currentGitSha(dir, detectCiContext(dir, env))).toBe(head);
		expect(detectPR(dir, detectCiContext(dir, env))).toEqual({ owner: "octo-org", repo: "widgets", prNumber: 42 });
	});

	it("without local git still records the PR number and branch", () => {
		const dir = noGitDir();
		const ctx = detectCiContext(dir, {
			GITHUB_ACTIONS: "true",
			GITHUB_EVENT_NAME: "pull_request",
			GITHUB_SHA: "1".repeat(40),
			GITHUB_REF: "refs/pull/7/merge",
			GITHUB_HEAD_REF: "fix/thing",
			GITHUB_RUN_ID: "1",
		});
		expect(ctx.git).toMatchObject({ sha: "1".repeat(40), headSha: null, branch: "fix/thing", prNumber: 7 });
	});
});

describe("consumers share the context", () => {
	it("--upload and --pr-comment agree with the report on a pull_request run", () => {
		const { dir, head: mergeSha } = gitRepo();
		const env = actionsEnv("pull_request", { GITHUB_SHA: mergeSha, GITHUB_REF: "refs/pull/42/merge", GITHUB_HEAD_REF: "feature/login" });
		expect(currentGitSha(dir, detectCiContext(dir, env))).toBe(HEAD_SHA);
		expect(detectPR(dir, detectCiContext(dir, env))).toEqual({ owner: "octo-org", repo: "widgets", prNumber: 42 });
	});

	it("--pr-comment keeps the issue fallback (issue_comment on a PR)", () => {
		const { dir } = gitRepo();
		const eventPath = join(dir, "issue_comment.json");
		writeFileSync(eventPath, JSON.stringify({ action: "created", issue: { number: 7, pull_request: {} }, comment: { body: "/vcqa" } }));
		expect(detectPR(dir, detectCiContext(dir, actionsEnv("issue_comment", { GITHUB_EVENT_PATH: eventPath })))).toEqual({
			owner: "octo-org",
			repo: "widgets",
			prNumber: 7,
		});
	});

	it("pull_request_target on the base checkout uploads against the scanned base commit", () => {
		const { dir, head: baseTip } = gitRepo("main");
		const env = actionsEnv("pull_request_target", { GITHUB_SHA: baseTip, GITHUB_REF: "refs/heads/main" });
		expect(currentGitSha(dir, detectCiContext(dir, env))).toBe(baseTip);
	});
});
