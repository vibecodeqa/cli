/** Where a scan ran: which commit, branch, PR and CI run it describes.
 *
 * Read from the environment the CI provider sets (GitHub Actions today) and
 * from the local git checkout — never guessed. Shared by the report (core.ts),
 * `--upload` (upload.ts) and `--pr-comment` (pr-comment.ts) so the three
 * cannot disagree about which commit a result belongs to.
 *
 * The shapes below mirror `ReportGitProvenance`, `ReportCiProvenance` and
 * `ReportScanInfo` from @vibecodeqa/schema 0.6.0. Until the CLI depends on
 * 0.6.0 they are declared here; older schema versions keep the fields through
 * `.passthrough()`. Bumping the dependency should be a type swap, nothing more.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { detectLocalBranch } from "./detect.js";

/** Git state of the scanned tree. Mirrors schema 0.6.0 `ReportGitProvenance`.
 *  On a `pull_request` run the checkout is GitHub's synthetic merge commit, so
 *  `sha` is that merge commit and `headSha` is the PR head. */
export interface ReportGitProvenance {
	sha: string | null;
	headSha: string | null;
	baseSha: string | null;
	branch: string | null;
	ref: string | null;
	prNumber: number | null;
	commitDate: string | null;
	defaultBranch: string | null;
}

/** Mirrors schema 0.6.0 `ReportCiProvenance`. */
export interface ReportCiProvenance {
	provider: "github-actions" | (string & {});
	runId: string;
	runAttempt: number;
	runUrl: string;
	event: string;
	actor: string | null;
}

/** Mirrors schema 0.6.0 `ReportScanInfo`. */
export interface ReportScanInfo {
	id: string;
	skipTests: boolean;
	diffBase: string | null;
}

/** The provenance fields schema 0.6.0 adds to `VibeReport.meta`. */
export interface ReportProvenanceMeta {
	source: string;
	scan: ReportScanInfo;
	git: ReportGitProvenance;
	ci: ReportCiProvenance | null;
}

/** The parts of a GitHub event payload this module reads. */
export interface GitHubEventPayload {
	before?: string;
	head_commit?: { timestamp?: string } | null;
	pull_request?: {
		number?: number;
		head?: { ref?: string; sha?: string; repo?: { full_name?: string } | null };
		base?: { ref?: string; sha?: string; repo?: { full_name?: string } | null };
	};
	issue?: { number?: number };
	merge_group?: { head_sha?: string; base_sha?: string; head_commit?: { timestamp?: string } | null };
	repository?: { default_branch?: string };
}

export interface CiContext {
	git: ReportGitProvenance;
	/** null = not running in CI, or in a CI run with no run id to name it by. */
	ci: ReportCiProvenance | null;
	/** `owner/repo` from `GITHUB_REPOSITORY`, when set. */
	repository: string | null;
	/** The triggering event payload (`GITHUB_EVENT_PATH`), when readable. */
	event: GitHubEventPayload | null;
	/** Why `git.headSha` is null although the run is CI, when it is. */
	headShaNote: string | null;
	/** Whether `git.sha` is on a remote, so a `blob/<sha>` link resolves.
	 *  Asked only of local scans, where an unpushed HEAD is the normal state
	 *  (from local remote-tracking refs — no network); null when not asked or
	 *  git could not say. A CI checkout is always of a pushed ref. */
	shaOnRemote: boolean | null;
}

/** Events whose checkout is `refs/pull/N/merge` and whose payload carries the PR. */
const PR_MERGE_EVENTS = new Set(["pull_request", "pull_request_review", "pull_request_review_comment"]);

const ZERO_SHA = /^0+$/;

export function detectCiContext(cwd: string, env: NodeJS.ProcessEnv = process.env): CiContext {
	const event = readEvent(env);
	const repository = env.GITHUB_REPOSITORY || null;
	const localHead = gitOut(cwd, ["rev-parse", "HEAD"]);
	const localBranch = detectLocalBranch(cwd);

	if (env.GITHUB_ACTIONS !== "true") {
		const git: ReportGitProvenance = {
			sha: localHead,
			headSha: localHead,
			baseSha: null,
			branch: localBranch,
			ref: localBranch ? `refs/heads/${localBranch}` : null,
			prNumber: null,
			commitDate: commitDate(cwd, localHead),
			defaultBranch: null,
		};
		return { git, ci: null, repository, event, headShaNote: null, shaOnRemote: onRemote(cwd, localHead) };
	}

	const eventName = env.GITHUB_EVENT_NAME || "";
	const ref = env.GITHUB_REF || null;
	// The commit actually checked out. GITHUB_SHA is the commit the *event*
	// names, which a workflow is free not to check out (`ref:` a PR head sha, a
	// PR merge ref under pull_request_target, a second repository under `path:`);
	// it stands in only when there is no local git to ask.
	const sha = localHead ?? env.GITHUB_SHA ?? null;
	const git: ReportGitProvenance = {
		sha,
		headSha: sha,
		baseSha: null,
		branch: (ref?.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : null) ?? localBranch,
		ref,
		prNumber: null,
		commitDate: null,
		defaultBranch: str(event?.repository?.default_branch),
	};
	const checkout: Checkout = { cwd, localHead, localBranch, onEventCommit: !localHead || !env.GITHUB_SHA || localHead === env.GITHUB_SHA };
	const { headShaNote, fallbackDate } = applyEvent(git, eventName, event ?? {}, env, checkout);
	git.commitDate = commitDate(cwd, git.headSha ?? git.sha) ?? fallbackDate;
	return { git, ci: githubActionsRun(env, eventName, repository), repository, event, headShaNote, shaOnRemote: null };
}

interface EventEffect {
	headShaNote: string | null;
	fallbackDate: string | null;
}

/** What is on disk, as opposed to what the event names. */
interface Checkout {
	cwd: string;
	localHead: string | null;
	localBranch: string | null;
	/** The checkout is the event's own commit (`GITHUB_SHA`), or there is no
	 *  local git to say otherwise — the event payload describes the scan. */
	onEventCommit: boolean;
}

const NO_EFFECT: EventEffect = { headShaNote: null, fallbackDate: null };

/** Refine `git` from the event payload. Events not listed keep the defaults:
 *  the scanned commit is its own head, with no base and no PR. A checkout the
 *  event does not describe is described from local git alone. */
function applyEvent(
	git: ReportGitProvenance,
	eventName: string,
	event: GitHubEventPayload,
	env: NodeJS.ProcessEnv,
	checkout: Checkout,
): EventEffect {
	const pr = event.pull_request;
	if (PR_MERGE_EVENTS.has(eventName)) {
		const fromRun = pr ?? pullRequestFromEnv(env, checkout);
		if (fromRun) return applyPullRequest(git, fromRun, env, checkout);
	}
	if (eventName === "pull_request_target" && pr) return applyPullRequestTarget(git, pr, env, checkout);
	if (!checkout.onEventCommit) return describeLocalCheckout(git, checkout);
	if (eventName === "merge_group" && event.merge_group) {
		// The merge queue's temporary branch: head_sha is the queued commit, which
		// is also what GITHUB_SHA checks out.
		git.headSha = str(event.merge_group.head_sha) ?? git.sha;
		git.baseSha = str(event.merge_group.base_sha);
		return { headShaNote: null, fallbackDate: str(event.merge_group.head_commit?.timestamp) };
	}
	if (eventName === "push") {
		const before = str(event.before);
		// A new branch (or tag) push has no previous commit: before is all zeros.
		git.baseSha = before && !ZERO_SHA.test(before) ? before : null;
		return { headShaNote: null, fallbackDate: str(event.head_commit?.timestamp) };
	}
	return NO_EFFECT;
}

/** pull_request*: the default checkout is GitHub's merge of head into base, so
 *  `sha` is that merge commit and the head is exposed separately. A workflow
 *  that checked out the PR head itself scanned the head: `sha` is the head. */
function applyPullRequest(
	git: ReportGitProvenance,
	pr: NonNullable<GitHubEventPayload["pull_request"]>,
	env: NodeJS.ProcessEnv,
	checkout: Checkout,
): EventEffect {
	const head = str(pr.head?.sha);
	const headRef = env.GITHUB_HEAD_REF || str(pr.head?.ref);
	const onHead = (head !== null && checkout.localHead === head) || isHeadBranchCheckout(pr, headRef, env, checkout);
	if (!onHead && !checkout.onEventCommit && !isMergeOf(checkout, head)) return describeLocalCheckout(git, checkout);
	git.headSha = onHead ? git.sha : head;
	git.baseSha = str(pr.base?.sha);
	git.branch = headRef;
	git.prNumber = num(pr.number);
	return NO_EFFECT;
}

/** `ref: ${{ github.head_ref }}` checked out after a re-push: the local branch
 *  is the PR's head branch, now ahead of the payload's head sha. A branch name
 *  alone proves nothing — a fork PR from the fork's `main` with the base repo's
 *  `main` checked out matches by name but is the base tip — so the branch only
 *  counts when the PR comes from this same repository and the payload's head
 *  is an ancestor of HEAD. */
function isHeadBranchCheckout(
	pr: NonNullable<GitHubEventPayload["pull_request"]>,
	headRef: string | null,
	env: NodeJS.ProcessEnv,
	checkout: Checkout,
): boolean {
	const head = str(pr.head?.sha);
	if (!head || !/^[0-9a-f]{7,64}$/i.test(head) || !headRef || !checkout.localHead || checkout.localBranch !== headRef) return false;
	const headRepo = str(pr.head?.repo?.full_name);
	const baseRepo = str(pr.base?.repo?.full_name) ?? (env.GITHUB_REPOSITORY || null);
	if (!headRepo || !baseRepo || headRepo !== baseRepo) return false;
	return gitOk(checkout.cwd, ["merge-base", "--is-ancestor", head, checkout.localHead]);
}

/** The PR as far as the environment alone can say, for a run whose event
 *  payload is unreadable: number from `GITHUB_REF` (`refs/pull/N/merge`),
 *  branch from `GITHUB_HEAD_REF`, and head/base from the merge commit's
 *  parents ([base, head]) when the checkout is that merge. */
function pullRequestFromEnv(env: NodeJS.ProcessEnv, checkout: Checkout): GitHubEventPayload["pull_request"] | null {
	const match = /^refs\/pull\/(\d+)\/(?:merge|head)$/.exec(env.GITHUB_REF || "");
	const number = match ? Number.parseInt(match[1]!, 10) : Number.NaN;
	const headRef = env.GITHUB_HEAD_REF || undefined;
	if (!(number > 0) && !headRef) return null;
	const parents = checkout.onEventCommit ? commitParents(checkout.cwd, checkout.localHead) : [];
	const [baseSha, headSha] = parents.length === 2 ? parents : [];
	return {
		number: number > 0 ? number : undefined,
		head: { ref: headRef, sha: headSha },
		base: { ref: env.GITHUB_BASE_REF || undefined, sha: baseSha },
	};
}

/** Runs in the base repository's context: the default checkout is the base
 *  branch, not the PR, and GITHUB_SHA is the base tip either way. Only when the
 *  workflow checked out the PR head — or its merge into base — does the scan
 *  describe the PR. */
function applyPullRequestTarget(
	git: ReportGitProvenance,
	pr: NonNullable<GitHubEventPayload["pull_request"]>,
	env: NodeJS.ProcessEnv,
	checkout: Checkout,
): EventEffect {
	const head = str(pr.head?.sha);
	const onHead = head !== null && checkout.localHead === head;
	if (onHead || isMergeOf(checkout, head)) {
		// sha stays the checkout: the head itself, or the merge commit (which
		// no PR displays — statuses go to headSha).
		git.headSha = head;
		git.baseSha = str(pr.base?.sha);
		git.branch = env.GITHUB_HEAD_REF || str(pr.head?.ref);
		git.prNumber = num(pr.number);
		return NO_EFFECT;
	}
	if (!checkout.onEventCommit) return describeLocalCheckout(git, checkout);
	git.headSha = null;
	git.baseSha = str(pr.base?.sha);
	git.prNumber = num(pr.number);
	git.branch = env.GITHUB_BASE_REF || str(pr.base?.ref) || git.branch;
	return {
		headShaNote: "pull_request_target checks out the base branch, not the PR head; the scan does not describe the PR head",
		fallbackDate: null,
	};
}

/** The workflow checked out something the event does not name — another ref,
 *  or another repository entirely. Nothing from the payload applies; describe
 *  what is on disk. */
function describeLocalCheckout(git: ReportGitProvenance, checkout: Checkout): EventEffect {
	git.sha = checkout.localHead;
	git.headSha = checkout.localHead;
	git.baseSha = null;
	git.branch = checkout.localBranch;
	git.ref = checkout.localBranch ? `refs/heads/${checkout.localBranch}` : null;
	git.prNumber = null;
	git.defaultBranch = null;
	return NO_EFFECT;
}

/** Whether the checkout is a merge commit with `head` among its parents — how
 *  `refs/pull/N/merge` looks. Reads the raw commit object, so it works in a
 *  depth-1 clone where the parents themselves are absent. */
function isMergeOf(checkout: Checkout, head: string | null): boolean {
	if (!head) return false;
	const parents = commitParents(checkout.cwd, checkout.localHead);
	return parents.length >= 2 && parents.includes(head);
}

function commitParents(cwd: string, sha: string | null): string[] {
	if (!sha || !/^[0-9a-f]{7,64}$/i.test(sha)) return [];
	const raw = gitOut(cwd, ["cat-file", "commit", sha]);
	if (!raw) return [];
	const parents: string[] = [];
	for (const line of raw.split("\n")) {
		if (line === "") break; // end of headers
		if (line.startsWith("parent ")) parents.push(line.slice("parent ".length).trim());
	}
	return parents;
}

/** The Actions run, or null when there is no run id to name it by (some
 *  Actions-compatible runners and local emulators) — schema 0.6.0 requires a
 *  non-empty `runId`, so a run without one is reported as no run. */
function githubActionsRun(env: NodeJS.ProcessEnv, eventName: string, repository: string | null): ReportCiProvenance | null {
	const runId = env.GITHUB_RUN_ID;
	if (!runId) return null;
	const server = (env.GITHUB_SERVER_URL || "https://github.com").replace(/\/+$/, "");
	const attempt = Number.parseInt(env.GITHUB_RUN_ATTEMPT || "", 10);
	return {
		provider: "github-actions",
		runId,
		runAttempt: Number.isFinite(attempt) && attempt > 0 ? attempt : 1,
		runUrl: repository ? `${server}/${repository}/actions/runs/${runId}` : "",
		event: eventName,
		actor: env.GITHUB_ACTOR || null,
	};
}

function readEvent(env: NodeJS.ProcessEnv): GitHubEventPayload | null {
	const eventPath = env.GITHUB_EVENT_PATH;
	if (!eventPath || !existsSync(eventPath)) return null;
	try {
		const parsed: unknown = JSON.parse(readFileSync(eventPath, "utf-8"));
		return parsed && typeof parsed === "object" ? (parsed as GitHubEventPayload) : null;
	} catch {
		return null;
	}
}

/** Committer date of `sha`, or null when the object is not in the clone —
 *  expected for a PR head under a shallow merge checkout. */
function commitDate(cwd: string, sha: string | null): string | null {
	if (!sha || !/^[0-9a-f]{7,64}$/i.test(sha)) return null;
	return gitOut(cwd, ["show", "-s", "--format=%cI", `${sha}^{commit}`, "--"]);
}

/** Whether any remote-tracking branch contains `sha`; null when git fails. */
function onRemote(cwd: string, sha: string | null): boolean | null {
	if (!sha) return null;
	try {
		const out = execFileSync("git", ["branch", "-r", "--contains", sha], { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
		return out.trim().length > 0;
	} catch {
		return null;
	}
}

/** Whether a git command exits 0 (a yes/no question such as `--is-ancestor`). */
function gitOk(cwd: string, args: string[]): boolean {
	try {
		execFileSync("git", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
		return true;
	} catch {
		return false;
	}
}

function gitOut(cwd: string, args: string[]): string | null {
	try {
		return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim() || null;
	} catch {
		return null;
	}
}

function str(value: unknown): string | null {
	return typeof value === "string" && value ? value : null;
}

function num(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}
