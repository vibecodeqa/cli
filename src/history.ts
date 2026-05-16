/** Read report history from .vibe-check/history/ and return sorted snapshots. */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { VibeReport } from "./types.js";

export interface HistoryEntry {
	timestamp: string;
	score: number;
	checkScores: Map<string, number>;
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
			if (raw.score === null || raw.score === undefined || !raw.checks) continue;
			const checkScores = new Map<string, number>();
			for (const c of raw.checks) {
				checkScores.set(c.name, c.score);
			}
			entries.push({ timestamp: raw.timestamp, score: raw.score, checkScores });
		} catch {
			// skip corrupt files
		}
	}

	return entries;
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
