/** Trend comparison — compares current report to previous run. */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { VibeReport } from "./types.js";

export interface TrendDelta {
	scoreDelta: number; // positive = improved
	checkDeltas: { name: string; prev: number; curr: number; delta: number }[];
	newIssues: number;
	fixedIssues: number;
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

	for (const curr of report.checks) {
		const prevCheck = prev.checks.find((c) => c.name === curr.name);
		const prevScore = prevCheck?.score ?? 0;
		checkDeltas.push({
			name: curr.name,
			prev: prevScore,
			curr: curr.score,
			delta: curr.score - prevScore,
		});
	}

	const currIssueCount = report.checks.reduce((s, c) => s + c.issues.length, 0);
	const prevIssueCount = prev.checks.reduce((s, c) => s + c.issues.length, 0);
	const newIssues = Math.max(0, currIssueCount - prevIssueCount);
	const fixedIssues = Math.max(0, prevIssueCount - currIssueCount);

	return { scoreDelta, checkDeltas, newIssues, fixedIssues, prevTimestamp: prev.timestamp };
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
	return slice.map((v) => {
		const idx = Math.min(7, Math.floor(((v - min) / range) * 7));
		return blocks[idx];
	}).join("");
}

/** Render trend HTML for the report. */
export function trendHTML(trend: TrendDelta): string {
	const arrow = trend.scoreDelta > 0 ? "&#9650;" : trend.scoreDelta < 0 ? "&#9660;" : "&#9644;";
	const color = trend.scoreDelta > 0 ? "var(--pass)" : trend.scoreDelta < 0 ? "var(--fail)" : "var(--muted)";

	let deltas = "";
	for (const d of trend.checkDeltas) {
		if (d.delta === 0) continue;
		const c = d.delta > 0 ? "var(--pass)" : "var(--fail)";
		deltas += `<span class="td-item" style="color:${c}">${d.name} ${d.delta > 0 ? "+" : ""}${d.delta}</span>`;
	}

	return `<div class="trend">
<div class="trend-head"><span class="trend-arrow" style="color:${color}">${arrow}</span><span style="color:${color};font-weight:700">${trend.scoreDelta > 0 ? "+" : ""}${trend.scoreDelta} pts</span><span class="trend-vs">vs ${trend.prevTimestamp.split("T")[0]}</span></div>
<div class="trend-stats">${trend.fixedIssues > 0 ? `<span style="color:var(--pass)">${trend.fixedIssues} fixed</span>` : ""}${trend.newIssues > 0 ? `<span style="color:var(--fail)">${trend.newIssues} new</span>` : ""}</div>
${deltas ? `<div class="trend-deltas">${deltas}</div>` : ""}
</div>`;
}
