/** Trend comparison — compares current report to previous run. */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkSide, compareCheckSides, issuesComparable, type StatusTransition } from "./delta.js";
import { type IssueSnapshot, issueSnapshot, readIssueFingerprint } from "./issue-fingerprint.js";
import type { VibeReport } from "./types.js";

export interface TrendDelta {
	scoreDelta: number; // positive = improved
	/**
	 * `delta` is 0 and `transition` is set when either side did not run or its
	 * runner crashed (#107). `prev`/`curr` are null for such a side, or an absent one.
	 */
	checkDeltas: { name: string; prev: number | null; curr: number | null; delta: number; transition?: StatusTransition }[];
	newIssues: number;
	fixedIssues: number;
	introduced?: IssueSnapshot[];
	fixed?: IssueSnapshot[];
	prevTimestamp: string;
}

export function computeTrend(report: VibeReport, outputDir: string): TrendDelta | null {
	const prevPath = join(outputDir, "report.json");
	if (!existsSync(prevPath)) return null;

	let prev: VibeReport;
	try {
		prev = JSON.parse(readFileSync(prevPath, "utf-8"));
	} catch {
		return null;
	}

	if (!prev.score && prev.score !== 0) return null;

	const scoreDelta = report.score - prev.score;
	const checkDeltas: TrendDelta["checkDeltas"] = [];

	// Union of names, so a check that disappeared reads "72 → not present".
	// Issues are compared only for checks that ran in both scans (#107).
	const comparable = new Set<string>();
	const names = report.checks.map((c) => c.name);
	for (const c of prev.checks) if (!names.includes(c.name)) names.push(c.name);
	for (const name of names) {
		const prevSide = checkSide(prev.checks.find((c) => c.name === name));
		const currSide = checkSide(report.checks.find((c) => c.name === name));
		if (issuesComparable(prevSide, currSide)) comparable.add(name);
		const { delta, transition } = compareCheckSides(prevSide, currSide);
		checkDeltas.push({
			name,
			prev: prevSide.score ?? null,
			curr: currSide.score ?? null,
			delta,
			...(transition ? { transition } : {}),
		});
	}

	const prevIssueMap = issueMap(prev, comparable);
	const currIssueMap = issueMap(report, comparable);
	const introduced = [...currIssueMap.entries()].filter(([fp]) => !prevIssueMap.has(fp)).map(([, issue]) => issue);
	const fixed = [...prevIssueMap.entries()].filter(([fp]) => !currIssueMap.has(fp)).map(([, issue]) => issue);
	const newIssues = introduced.length;
	const fixedIssues = fixed.length;

	return { scoreDelta, checkDeltas, newIssues, fixedIssues, introduced, fixed, prevTimestamp: prev.timestamp };
}

function issueMap(report: VibeReport, comparable: Set<string>): Map<string, IssueSnapshot> {
	const out = new Map<string, IssueSnapshot>();
	for (const check of report.checks) {
		if (!comparable.has(check.name)) continue;
		for (const issue of check.issues) {
			const fp = readIssueFingerprint(check.name, issue);
			out.set(fp, issueSnapshot(check.name, issue));
		}
	}
	return out;
}

/** Render trend delta as terminal-friendly string with sparkline. */
export function formatTrend(trend: TrendDelta, historyScores?: number[]): string {
	const arrow = trend.scoreDelta > 0 ? "\u2191" : trend.scoreDelta < 0 ? "\u2193" : "=";
	const color = trend.scoreDelta > 0 ? "\x1b[32m" : trend.scoreDelta < 0 ? "\x1b[31m" : "\x1b[2m";
	let out = `  ${color}${arrow} ${Math.abs(trend.scoreDelta)} pts${trend.scoreDelta > 0 ? " improved" : trend.scoreDelta < 0 ? " declined" : " unchanged"}\x1b[0m`;
	out += `  \x1b[2mvs ${trend.prevTimestamp.split("T")[0]}\x1b[0m`;
	if (trend.fixedIssues > 0) out += `  \x1b[32m${trend.fixedIssues} fixed\x1b[0m`;
	if (trend.newIssues > 0) out += `  \x1b[31m${trend.newIssues} new\x1b[0m`;

	// Terminal sparkline from history
	if (historyScores && historyScores.length >= 2) {
		out += `\n  \x1b[2m${terminalSparkline(historyScores)}\x1b[0m`;
	}

	return out;
}

/** Render a sparkline using unicode block characters. */
function terminalSparkline(values: number[]): string {
	const blocks = ["\u2581", "\u2582", "\u2583", "\u2584", "\u2585", "\u2586", "\u2587", "\u2588"];
	const last = Math.min(values.length, 20);
	const slice = values.slice(-last);
	const min = Math.min(...slice);
	const max = Math.max(...slice);
	const range = max - min || 1;
	return slice
		.map((v) => {
			const idx = Math.min(7, Math.floor(((v - min) / range) * 7));
			return blocks[idx];
		})
		.join("");
}
