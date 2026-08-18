import { execSync } from "node:child_process";
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

export function currentGitSha(cwd: string): string | undefined {
	try {
		return execSync("git rev-parse HEAD", { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
	} catch {
		return undefined;
	}
}
