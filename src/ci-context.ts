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
	pull_request?: { number?: number; head?: { ref?: string; sha?: string }; base?: { ref?: string; sha?: string } };
	issue?: { number?: number };
	merge_group?: { head_sha?: string; base_sha?: string; head_commit?: { timestamp?: string } | null };
	repository?: { default_branch?: string };
}

export interface CiContext {
	git: ReportGitProvenance;
	/** null = known not to be running in CI. */
	ci: ReportCiProvenance | null;
	/** `owner/repo` from `GITHUB_REPOSITORY`, when set. */
	repository: string | null;
	/** The triggering event payload (`GITHUB_EVENT_PATH`), when readable. */
	event: GitHubEventPayload | null;
	/** Why `git.headSha` is null although the run is CI, when it is. */
	headShaNote: string | null;
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
		return { git, ci: null, repository, event, headShaNote: null };
	}

	const eventName = env.GITHUB_EVENT_NAME || "";
	const ref = env.GITHUB_REF || null;
	const sha = env.GITHUB_SHA || localHead;
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
	const { headShaNote, fallbackDate } = applyEvent(git, eventName, event ?? {}, env, localHead);
	git.commitDate = commitDate(cwd, git.headSha ?? git.sha) ?? fallbackDate;
	return { git, ci: githubActionsRun(env, eventName, repository), repository, event, headShaNote };
}

interface EventEffect {
	headShaNote: string | null;
	fallbackDate: string | null;
}

/** Refine `git` from the event payload. Events not listed keep the defaults:
 *  the scanned commit is its own head, with no base and no PR. */
function applyEvent(
	git: ReportGitProvenance,
	eventName: string,
	event: GitHubEventPayload,
	env: NodeJS.ProcessEnv,
	localHead: string | null,
): EventEffect {
	const none: EventEffect = { headShaNote: null, fallbackDate: null };
	const pr = event.pull_request;
	if (PR_MERGE_EVENTS.has(eventName) && pr) {
		// The checkout is GitHub's merge of head into base: `sha` stays that merge
		// commit (it is what was scanned); the head is exposed separately.
		git.headSha = str(pr.head?.sha);
		git.baseSha = str(pr.base?.sha);
		git.branch = env.GITHUB_HEAD_REF || str(pr.head?.ref);
		git.prNumber = num(pr.number);
		return none;
	}
	if (eventName === "pull_request_target" && pr) return applyPullRequestTarget(git, pr, env, localHead);
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
	return none;
}

/** Runs in the base repository's context: the default checkout is the base
 *  branch, not the PR, and GITHUB_SHA is the base tip either way. Only when the
 *  workflow checked out the PR head itself does the scan describe the head. */
function applyPullRequestTarget(
	git: ReportGitProvenance,
	pr: NonNullable<GitHubEventPayload["pull_request"]>,
	env: NodeJS.ProcessEnv,
	localHead: string | null,
): EventEffect {
	const head = str(pr.head?.sha);
	git.baseSha = str(pr.base?.sha);
	git.prNumber = num(pr.number);
	if (head && localHead === head) {
		git.sha = head;
		git.headSha = head;
		git.branch = env.GITHUB_HEAD_REF || str(pr.head?.ref);
		return { headShaNote: null, fallbackDate: null };
	}
	git.headSha = null;
	git.branch = env.GITHUB_BASE_REF || str(pr.base?.ref) || git.branch;
	return {
		headShaNote: "pull_request_target checks out the base branch, not the PR head; the scan does not describe the PR head",
		fallbackDate: null,
	};
}

function githubActionsRun(env: NodeJS.ProcessEnv, eventName: string, repository: string | null): ReportCiProvenance {
	const runId = env.GITHUB_RUN_ID || "";
	const server = (env.GITHUB_SERVER_URL || "https://github.com").replace(/\/+$/, "");
	const attempt = Number.parseInt(env.GITHUB_RUN_ATTEMPT || "", 10);
	return {
		provider: "github-actions",
		runId,
		runAttempt: Number.isFinite(attempt) && attempt > 0 ? attempt : 1,
		runUrl: runId && repository ? `${server}/${repository}/actions/runs/${runId}` : "",
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
