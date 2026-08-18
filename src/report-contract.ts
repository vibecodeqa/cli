import { buildAnalyzerSnapshots } from "./analyzer-snapshot.js";
import { issueSnapshot } from "./issue-fingerprint.js";
import type { AnalyzerSnapshot, VibeReport } from "./types.js";

export function withFreshAnalyzerSnapshots(report: VibeReport): VibeReport {
	return {
		...report,
		meta: {
			...report.meta,
			analyzerSnapshots: buildAnalyzerSnapshots(report.checks),
		},
	};
}

export interface ReportHistorySnapshot {
	score: number;
	grade: string;
	timestamp: string;
	meta: {
		duration: number;
		analyzerSnapshots: AnalyzerSnapshot[];
	};
	checks: Array<{
		name: string;
		score: number;
		issueCount: number;
		duration: number;
		details: Record<string, unknown>;
		issues: ReturnType<typeof issueSnapshot>[];
	}>;
}

export function buildReportHistorySnapshot(report: VibeReport): ReportHistorySnapshot {
	const normalized = withFreshAnalyzerSnapshots(report);
	return {
		score: normalized.score,
		grade: normalized.grade,
		timestamp: normalized.timestamp,
		meta: {
			duration: normalized.meta.duration,
			analyzerSnapshots: normalized.meta.analyzerSnapshots ?? [],
		},
		checks: normalized.checks.map((check) => ({
			name: check.name,
			score: check.score,
			issueCount: check.issues.length,
			duration: check.duration,
			details: check.details,
			issues: check.issues.map((issue) => issueSnapshot(check.name, issue)),
		})),
	};
}
