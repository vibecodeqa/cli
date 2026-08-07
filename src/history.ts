/** Read report history from .vibe-check/history/ and return sorted snapshots. */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { IssueSnapshot } from "./issue-fingerprint.js";
import type { AnalyzerSnapshot, VibeReport } from "./types.js";

export interface HistoryEntry {
	timestamp: string;
	score: number;
	checkScores: Map<string, number>;
	issues: IssueSnapshot[];
	analyzerSnapshots: AnalyzerSnapshot[];
}

/** Load history entries from historyDir, sorted oldest-first. Returns last 30 max. */
export function loadHistory(historyDir: string): HistoryEntry[] {
	if (!existsSync(historyDir)) return [];

	const files = readdirSync(historyDir)
		.filter((f) => f.endsWith(".json"))
		.sort(); // filenames are timestamp-based, so lexicographic = chronological

	const entries: HistoryEntry[] = [];
	for (const file of files) {
		try {
			const raw: VibeReport = JSON.parse(readFileSync(join(historyDir, file), "utf-8"));
			if (raw.score === null || raw.score === undefined || !Number.isFinite(Number(raw.score)) || !raw.checks) continue;
			const checkScores = new Map<string, number>();
			const issues: IssueSnapshot[] = [];
			const analyzerSnapshots = normalizeAnalyzerSnapshots(raw.meta?.analyzerSnapshots);
			for (const c of raw.checks) {
				if (c.score !== null && c.score !== undefined && Number.isFinite(Number(c.score))) {
					checkScores.set(c.name, Number(c.score));
				}
				if (Array.isArray((c as { issues?: unknown }).issues)) {
					for (const issue of (c as { issues: unknown[] }).issues) {
						const snapshot = normalizeHistoryIssue(c.name, issue);
						if (snapshot) issues.push(snapshot);
					}
				}
			}
			entries.push({ timestamp: raw.timestamp, score: Number(raw.score), checkScores, issues, analyzerSnapshots });
		} catch {
			// skip corrupt files
		}
	}

	return entries.slice(-30);
}

function normalizeAnalyzerSnapshots(raw: unknown): AnalyzerSnapshot[] {
	if (!Array.isArray(raw)) return [];
	return raw.flatMap((item) => {
		if (!item || typeof item !== "object") return [];
		const snapshot = item as Record<string, unknown>;
		if (typeof snapshot.analyzerId !== "string") return [];
		const status = typeof snapshot.status === "string" ? snapshot.status : "passed";
		const metrics = Array.isArray(snapshot.metrics)
			? (snapshot.metrics.filter((metric) => metric && typeof metric === "object") as AnalyzerSnapshot["metrics"])
			: [];
		return [
			{
				analyzerId: snapshot.analyzerId,
				status,
				score: typeof snapshot.score === "number" ? snapshot.score : undefined,
				findingCount: typeof snapshot.findingCount === "number" ? snapshot.findingCount : 0,
				severityCounts:
					snapshot.severityCounts && typeof snapshot.severityCounts === "object" ? (snapshot.severityCounts as Record<string, number>) : {},
				metrics,
				durationMs: typeof snapshot.durationMs === "number" ? snapshot.durationMs : 0,
			},
		];
	});
}

function normalizeHistoryIssue(checkName: string, raw: unknown): IssueSnapshot | null {
	if (!raw || typeof raw !== "object") return null;
	const issue = raw as Record<string, unknown>;
	const fingerprint = typeof issue.fingerprint === "string" ? issue.fingerprint : "";
	const message = typeof issue.message === "string" ? issue.message : "";
	const severity = issue.severity;
	if (!fingerprint || !message || (severity !== "error" && severity !== "warning" && severity !== "info")) return null;
	return {
		fingerprint,
		check: typeof issue.check === "string" ? issue.check : checkName,
		rule: typeof issue.rule === "string" ? issue.rule : undefined,
		severity,
		file: typeof issue.file === "string" ? issue.file : undefined,
		line: typeof issue.line === "number" ? issue.line : undefined,
		message,
	};
}

/** Compute a human-friendly delta badge like "up 3 from last week" or "down 5 from yesterday". */
export function scoreDeltaBadge(entries: HistoryEntry[]): { arrow: string; delta: number; label: string } | null {
	if (entries.length < 2) return null;

	const current = entries[entries.length - 1]!;
	const prev = entries[entries.length - 2]!;
	const delta = current.score - prev.score;
	const arrow = delta > 0 ? "\u2191" : delta < 0 ? "\u2193" : "=";

	const now = new Date(current.timestamp);
	const then = new Date(prev.timestamp);
	const diffMs = now.getTime() - then.getTime();
	const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

	let timeLabel: string;
	if (diffDays === 0) timeLabel = "earlier today";
	else if (diffDays === 1) timeLabel = "yesterday";
	else if (diffDays <= 7) timeLabel = "last week";
	else timeLabel = `${diffDays}d ago`;

	return { arrow, delta, label: `${arrow}${Math.abs(delta)} from ${timeLabel}` };
}
