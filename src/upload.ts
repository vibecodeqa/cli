import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { withFreshAnalyzerSnapshots } from "./report-contract.js";
import type { VibeReport } from "./types.js";

export interface ReportUploadPayload {
	repo: string;
	report: VibeReport;
	sha?: string;
}

export function repoSlugFromReport(report: VibeReport): string {
	return report.meta.repoUrl?.replace(/^https?:\/\/github\.com\//, "")?.replace(/\.git$/, "") || "";
}

export function buildReportUploadPayload(report: VibeReport, sha?: string): ReportUploadPayload | null {
	const repo = repoSlugFromReport(report);
	if (!repo) return null;
	return { repo, report: withFreshAnalyzerSnapshots(report), ...(sha ? { sha } : {}) };
}

/** The commit an upload is attributed to — where github-app posts the
 *  quality-gate status. On a pull_request run the checkout is GitHub's
 *  synthetic merge commit, which no PR displays, so the PR head sha from the
 *  event payload wins; then `GITHUB_SHA`; then the local `HEAD`. */
export function currentGitSha(cwd: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
	return prHeadShaFromEvent(env) || env.GITHUB_SHA || localHeadSha(cwd);
}

function prHeadShaFromEvent(env: NodeJS.ProcessEnv): string | undefined {
	const eventPath = env.GITHUB_EVENT_PATH;
	if (!eventPath || !existsSync(eventPath)) return undefined;
	try {
		const event = JSON.parse(readFileSync(eventPath, "utf-8")) as { pull_request?: { head?: { sha?: unknown } } };
		const sha = event.pull_request?.head?.sha;
		return typeof sha === "string" && sha ? sha : undefined;
	} catch {
		return undefined;
	}
}

function localHeadSha(cwd: string): string | undefined {
	try {
		return execSync("git rev-parse HEAD", { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim() || undefined;
	} catch {
		return undefined;
	}
}
