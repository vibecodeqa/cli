import { detectCiContext } from "./ci-context.js";
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
 *  synthetic merge commit, which no PR displays, so this is the PR head
 *  (`git.headSha`); off-PR it is the scanned commit — the checkout, else
 *  `GITHUB_SHA` when there is no local git. */
export function currentGitSha(cwd: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
	const { git } = detectCiContext(cwd, env);
	return git.headSha ?? git.sha ?? undefined;
}
