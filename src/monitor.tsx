/** vcqa monitor — real-time quality control panel.
 *
 * Full-screen TUI that watches your codebase and re-scans on changes.
 * Scan runs in a child process so the UI never freezes.
 * Press 'c' to open settings: thresholds, panel toggles, scan options.
 * Config persists to .vibe-check/monitor.json.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { render, Box, Text, useApp, useInput, useStdout } from "ink";
import { resolve, join, basename } from "node:path";
import { watch, existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { execFile, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { detectStack, detectWorkspace } from "./detect.js";
import { loadHistory } from "./history.js";
import type { CheckResult } from "./types.js";

const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")).version;
const CLI_PATH = fileURLToPath(new URL("./cli.js", import.meta.url));

// ── Config ──

interface MonitorConfig {
	alertBelow: number;
	alertDrop: number;
	debounceMs: number;
	skipTests: boolean;
	panels: { score: boolean; checks: boolean; activity: boolean; issues: boolean };
}

const DEFAULTS: MonitorConfig = {
	alertBelow: 60, alertDrop: 5, debounceMs: 800, skipTests: true,
	panels: { score: true, checks: true, activity: true, issues: true },
};

function configPath(cwd: string): string { return join(cwd, ".vibe-check", "monitor.json"); }

function loadMonitorConfig(cwd: string): MonitorConfig {
	try {
		const p = configPath(cwd);
		if (existsSync(p)) {
			const data = JSON.parse(readFileSync(p, "utf-8"));
			return { ...DEFAULTS, ...data, panels: { ...DEFAULTS.panels, ...data.panels } };
		}
	} catch { /* corrupt */ }
	return { ...DEFAULTS };
}

function saveMonitorConfig(cwd: string, cfg: MonitorConfig): void {
	try {
		const dir = join(cwd, ".vibe-check");
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(configPath(cwd), JSON.stringify(cfg, null, 2));
	} catch { /* can't write */ }
}

// ── Types ──

interface LogEntry {
	time: string;
	text: string;
	type: "info" | "scan" | "change" | "improve" | "regress" | "error" | "alert";
}

interface ScanState {
	checks: CheckResult[];
	score: number;
	grade: string;
	duration: number;
	totalIssues: number;
	scanning: boolean;
	scanCount: number;
	scores: number[];
}

// ── Helpers ──

function gc(grade: string): string {
	if (grade === "A") return "green";
	if (grade === "B") return "yellow";
	return "red";
}

function sc(s: string): string {
	if (s === "error") return "red";
	if (s === "warning") return "yellow";
	return "gray";
}

function spark(values: number[]): string {
	if (values.length < 2) return "";
	const bars = " ▁▂▃▄▅▆▇█";
	const min = Math.min(...values);
	const max = Math.max(...values);
	const range = max - min || 1;
	return values.slice(-20).map((v) => bars[Math.round(((v - min) / range) * 8)]!).join("");
}

function ts(): string {
	return new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function copyToClipboard(text: string): boolean {
	try {
		const cmd = process.platform === "darwin" ? "pbcopy" : process.platform === "win32" ? "clip" : "xclip -selection clipboard";
		execSync(cmd, { input: text, stdio: ["pipe", "pipe", "pipe"] });
		return true;
	} catch {
		return false;
	}
}

function buildFixPrompt(checkName: string, issue: { severity: string; message: string; file?: string; line?: number; rule?: string }, cwd?: string): string {
	const loc = issue.file ? `${issue.file}${issue.line ? `:${issue.line}` : ""}` : "";
	let prompt = `Fix this ${issue.severity} in ${loc || "the project"}:\n${issue.message}${issue.rule ? ` (${issue.rule})` : ""}\nCheck: ${checkName}`;

	// Include source context if available
	if (cwd && issue.file && issue.line) {
		try {
			const fullPath = join(cwd, issue.file);
			if (existsSync(fullPath)) {
				const content = readFileSync(fullPath, "utf-8");
				const lines = content.split("\n");
				const target = issue.line - 1;
				const start = Math.max(0, target - 3);
				const end = Math.min(lines.length, target + 4);
				const snippet = lines.slice(start, end).map((l, i) => {
					const num = start + i + 1;
					const marker = num === issue.line ? ">>>" : "   ";
					return `${marker} ${num}: ${l}`;
				}).join("\n");
				prompt += `\n\nSource:\n${snippet}`;
			}
		} catch { /* ignore */ }
	}

	prompt += "\n\nAnalyze the code, explain the issue, and provide the fix.";
	return prompt;
}

// ── Git changes ──

interface GitChange {
	status: "M" | "A" | "D" | "?" | "R";
	file: string;
}

function getGitChanges(cwd: string): GitChange[] {
	try {
		const out = execSync("git status --porcelain", { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
		if (!out) return [];
		return out.split("\n").map((line) => {
			const status = (line[0] === "?" ? "?" : line.trim()[0]) as GitChange["status"];
			const file = line.slice(3).trim();
			return { status, file };
		});
	} catch {
		return [];
	}
}

// ── Scan via child process — UI never freezes ──

function runScanProcess(
	cwd: string,
	skipTests: boolean,
): Promise<{ checks: CheckResult[]; score: number; grade: string; duration: number; totalIssues: number }> {
	return new Promise((resolve) => {
		const args = ["--json", cwd];
		if (skipTests) args.unshift("--skip-tests");

		execFile(process.execPath, [CLI_PATH, ...args], {
			timeout: 120_000,
			maxBuffer: 10 * 1024 * 1024,
			env: { ...process.env, VCQA_NO_UPDATE_CHECK: "1" },
		}, (err, stdout) => {
			if (err || !stdout) {
				resolve({ checks: [], score: 0, grade: "?", duration: 0, totalIssues: 0 });
				return;
			}
			try {
				const report = JSON.parse(stdout);
				const checks: CheckResult[] = report.checks || [];
				const totalIssues = checks.reduce((s: number, c: CheckResult) => s + c.issues.length, 0);
				resolve({
					checks,
					score: report.score ?? 0,
					grade: report.grade ?? "?",
					duration: report.meta?.duration ?? 0,
					totalIssues,
				});
			} catch {
				resolve({ checks: [], score: 0, grade: "?", duration: 0, totalIssues: 0 });
			}
		});
	});
}

// ── Panels ──

function ScorePanel({ state, height }: { state: ScanState; height: number }) {
	const s = spark(state.scores);
	const active = state.checks.filter((c) => !(c.details as Record<string, unknown>).skipped && !(c.details as Record<string, unknown>).comingSoon);
	return (
		<Box flexDirection="column" width={24} height={height} borderStyle="round" borderColor="gray" paddingX={1}>
			<Text bold color="magenta"> ◈ Score</Text>
			<Box justifyContent="center" marginY={1}>
				<Text color={gc(state.grade)} bold>
					{state.scanning ? " scanning..." : `   ${state.grade} ${state.score}/100`}
				</Text>
			</Box>
			<Text dimColor> {active.length} checks · {state.totalIssues} issues</Text>
			<Text dimColor> {state.duration}ms · scan #{state.scanCount}</Text>
			{s && <Text color="cyan"> {s}</Text>}
		</Box>
	);
}

function ActivityPanel({ log, height }: { log: LogEntry[]; height: number }) {
	const colors: Record<string, string> = {
		info: "gray", scan: "cyan", change: "yellow",
		improve: "green", regress: "red", error: "red", alert: "magenta",
	};
	const visibleLines = Math.max(1, height - 3);
	return (
		<Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} height={height} overflowY="hidden">
			<Text bold color="magenta"> ◈ Activity</Text>
			{log.slice(-visibleLines).map((entry, i) => (
				<Text key={`${entry.time}-${i}`} wrap="truncate">
					<Text dimColor>{entry.time} </Text>
					<Text color={colors[entry.type]}>{entry.text}</Text>
				</Text>
			))}
		</Box>
	);
}

// ── Config Screen ──

interface ConfigOption {
	key: string;
	label: string;
	type: "toggle" | "number";
	value: boolean | number;
	path: string[];
}

function ConfigScreen({ cursor, options }: { cursor: number; options: ConfigOption[] }) {

	return (
		<Box flexDirection="column" borderStyle="double" borderColor="magenta" paddingX={2} paddingY={1}>
			<Text bold color="magenta"> ⚙ Settings</Text>
			<Text dimColor> </Text>
			{options.map((opt, i) => {
				const selected = i === cursor;
				const prefix = selected ? "▸ " : "  ";
				if (opt.type === "toggle") {
					const on = opt.value as boolean;
					return (
						<Text key={opt.key}>
							<Text color={selected ? "white" : "gray"}>{prefix}{opt.label.padEnd(28)}</Text>
							<Text color={on ? "green" : "red"} bold>{on ? "[ON] " : "[OFF]"}</Text>
						</Text>
					);
				}
				return (
					<Text key={opt.key}>
						<Text color={selected ? "white" : "gray"}>{prefix}{opt.label.padEnd(28)}</Text>
						<Text color="cyan" bold>◀ {String(opt.value).padStart(5)} ▶</Text>
					</Text>
				);
			})}
			<Text dimColor> </Text>
			<Text dimColor> ↑↓ navigate · Space toggle · ←→ adjust · Shift+←→ ×10</Text>
			<Text dimColor> s save & close · Esc cancel</Text>
		</Box>
	);
}

// ── Trends Screen ──

function sparkFull(values: number[], width: number): string {
	if (values.length < 2) return "";
	const bars = " ▁▂▃▄▅▆▇█";
	const min = Math.min(...values);
	const max = Math.max(...values);
	const range = max - min || 1;
	// Resample to fit width
	const sampled: number[] = [];
	for (let i = 0; i < width; i++) {
		const idx = Math.round((i / (width - 1)) * (values.length - 1));
		sampled.push(values[idx]);
	}
	return sampled.map((v) => bars[Math.round(((v - min) / range) * 8)]!).join("");
}

function TrendsScreen({ cwd, height }: { cwd: string; height: number }) {
	const historyDir = join(cwd, ".vibe-check", "history");
	const history = loadHistory(historyDir);

	if (history.length < 2) {
		return (
			<Box flexDirection="column" height={height} paddingX={1}>
				<Text bold color="magenta"> ◈ Trends</Text>
				<Text dimColor> Need at least 2 scans. Run the scanner a few more times.</Text>
				<Text dimColor> Esc to go back</Text>
			</Box>
		);
	}

	const latest = history[history.length - 1];
	const first = history[0];
	const overallDelta = latest.score - first.score;
	const scores = history.map((h) => h.score);
	const chartWidth = 40;

	// Get all check names from latest
	const checkNames = [...latest.checkScores.keys()];

	// Build per-check trends
	const checkTrends = checkNames
		.map((name) => {
			const values = history.map((h) => h.checkScores.get(name) ?? 0).filter((v) => v > 0);
			if (values.length < 2) return null;
			const current = values[values.length - 1];
			const prev = values[0];
			const delta = current - prev;
			return { name, current, delta, spark: sparkFull(values, 20) };
		})
		.filter(Boolean)
		.sort((a, b) => a!.delta - b!.delta) as { name: string; current: number; delta: number; spark: string }[];

	const visibleChecks = Math.max(1, height - 10);

	return (
		<Box flexDirection="column" height={height} paddingX={1}>
			<Text bold color="magenta"> ◈ Trends — {history.length} scans</Text>
			<Text dimColor> {first.timestamp.split("T")[0]} → {latest.timestamp.split("T")[0]}</Text>
			<Text> </Text>

			{/* Overall score */}
			<Text bold> Overall Score</Text>
			<Text>
				<Text color="cyan"> {sparkFull(scores, chartWidth)} </Text>
				<Text color={gc(latest.score >= 90 ? "A" : latest.score >= 75 ? "B" : "C")} bold> {latest.score}</Text>
				<Text color={overallDelta >= 0 ? "green" : "red"}> {overallDelta >= 0 ? "+" : ""}{overallDelta}</Text>
			</Text>
			<Text> </Text>

			{/* Per-check trends */}
			<Text bold> Per-Check (first → latest)</Text>
			{checkTrends.slice(0, visibleChecks).map((t) => (
				<Text key={t.name}>
					<Text> {t.name.slice(0, 14).padEnd(14)} </Text>
					<Text color="cyan">{t.spark} </Text>
					<Text color={gc(t.current >= 90 ? "A" : t.current >= 75 ? "B" : "C")}>{String(t.current).padStart(3)} </Text>
					<Text color={t.delta >= 0 ? "green" : "red"}>{t.delta >= 0 ? "+" : ""}{t.delta}</Text>
				</Text>
			))}
			{checkTrends.length > visibleChecks && <Text dimColor> +{checkTrends.length - visibleChecks} more</Text>}

			<Box marginTop={1}>
				<Text dimColor> Esc back to dashboard</Text>
			</Box>
		</Box>
	);
}

// ── Main App ──

/** Load last scan from .vibe-check/report.json for instant display on startup. */
function loadCachedScan(cwd: string): ScanState | null {
	try {
		const reportPath = join(cwd, ".vibe-check", "report.json");
		if (!existsSync(reportPath)) return null;
		const report = JSON.parse(readFileSync(reportPath, "utf-8"));
		const checks: CheckResult[] = report.checks || [];
		const totalIssues = checks.reduce((s: number, c: CheckResult) => s + c.issues.length, 0);
		return {
			checks,
			score: report.score ?? 0,
			grade: report.grade ?? "?",
			duration: report.meta?.duration ?? 0,
			totalIssues,
			scanning: false,
			scanCount: 0,
			scores: [report.score ?? 0],
		};
	} catch {
		return null;
	}
}

// ── Check Detail View ──

function CheckDetail({ check, height, cursor, copied }: { check: CheckResult; height: number; cursor: number; copied: boolean }) {
	const bodyHeight = height - 5; // header + score + blank + footer margin

	// Each issue takes 2-3 lines: header line + message (wraps if long)
	// Estimate lines per issue for scroll calculation
	const issueHeights = check.issues.map((iss) => {
		const msgLen = iss.message.length;
		return msgLen > 80 ? 3 : 2; // 2 lines base, 3 if message wraps
	});

	// Find scroll window that keeps cursor visible
	let scrollStart = 0;
	let linesUsed = 0;
	// First, find how many items fit
	const fits: number[] = [];
	for (let i = 0; i < check.issues.length; i++) {
		if (linesUsed + issueHeights[i] > bodyHeight) break;
		fits.push(i);
		linesUsed += issueHeights[i];
	}
	const maxVisible = fits.length || 1;

	// Adjust scroll so cursor is visible
	if (cursor >= scrollStart + maxVisible) scrollStart = cursor - maxVisible + 1;
	if (cursor < scrollStart) scrollStart = cursor;
	scrollStart = Math.max(0, Math.min(scrollStart, check.issues.length - maxVisible));

	// Collect visible items within height budget
	const visible: { issue: typeof check.issues[0]; idx: number }[] = [];
	let usedLines = 0;
	for (let i = scrollStart; i < check.issues.length; i++) {
		if (usedLines + issueHeights[i] > bodyHeight) break;
		visible.push({ issue: check.issues[i], idx: i });
		usedLines += issueHeights[i];
	}

	const remaining = check.issues.length - (scrollStart + visible.length);

	return (
		<Box flexDirection="column" height={height} paddingX={1} overflowY="hidden">
			<Text bold color="magenta"> ◈ {check.name}</Text>
			<Text>
				<Text color={gc(check.grade)} bold> {check.grade} {check.score}/100</Text>
				<Text dimColor> · {check.issues.length} issues · {check.duration}ms</Text>
				{copied && <Text color="green" bold> ✓ Copied!</Text>}
			</Text>
			<Text> </Text>
			{check.issues.length === 0 ? (
				<Text color="green"> No issues found.</Text>
			) : (
				<>
					{visible.map(({ issue: iss, idx }) => {
						const sel = idx === cursor;
						return (
							<Box key={idx} flexDirection="column" marginBottom={0}>
								<Text>
									<Text color={sel ? "white" : "gray"}>{sel ? "▸" : " "}</Text>
									<Text color={sc(iss.severity)} bold>{iss.severity[0]!.toUpperCase()} </Text>
									{iss.file && <Text color="cyan">{String(iss.file)}{iss.line ? `:${iss.line}` : ""} </Text>}
									{iss.rule && <Text dimColor>({iss.rule})</Text>}
								</Text>
								<Text wrap="wrap">
									<Text color={sel ? "white" : "gray"}>  </Text>
									<Text color={sel ? "white" : undefined}>{iss.message}</Text>
								</Text>
							</Box>
						);
					})}
					{remaining > 0 && <Text dimColor> +{remaining} more (↓ to scroll)</Text>}
				</>
			)}
		</Box>
	);
}

// ── Issue Detail View — source code with highlighted problem ──

interface SourceContext {
	lines: { num: number; text: string; highlight: boolean }[];
	filePath: string;
}

function readSourceContext(cwd: string, file: string | undefined, line: number | undefined, rule: string | undefined): SourceContext | null {
	if (!file || typeof file !== "string") return null;
	const fullPath = join(cwd, file);
	try {
		if (!existsSync(fullPath)) return null;
		const content = readFileSync(fullPath, "utf-8");
		const allLines = content.split("\n");
		const target = (line ?? 1) - 1; // 0-indexed
		const contextRadius = 8;
		const start = Math.max(0, target - contextRadius);
		const end = Math.min(allLines.length, target + contextRadius + 1);

		// Determine which lines to highlight based on rule
		const highlightSet = new Set<number>();
		highlightSet.add(target);

		// For multi-line issues, highlight the block
		if (rule === "empty-catch" || rule === "fallback-catch" || rule === "no-assertions" || rule === "empty-test") {
			// Highlight from target to closing brace
			let depth = 0;
			for (let i = target; i < Math.min(target + 15, allLines.length); i++) {
				highlightSet.add(i);
				depth += (allLines[i].match(/\{/g) || []).length;
				depth -= (allLines[i].match(/\}/g) || []).length;
				if (depth <= 0 && i > target) break;
			}
		} else if (rule === "duplicate-code" || rule === "commented-out-code") {
			// Highlight a block of lines
			for (let i = target; i < Math.min(target + 6, allLines.length); i++) {
				highlightSet.add(i);
			}
		} else if (rule === "high-complexity" || rule === "long-function") {
			// Highlight function signature + a few lines
			for (let i = target; i < Math.min(target + 3, allLines.length); i++) {
				highlightSet.add(i);
			}
		}

		const lines = [];
		for (let i = start; i < end; i++) {
			lines.push({ num: i + 1, text: allLines[i], highlight: highlightSet.has(i) });
		}
		return { lines, filePath: file };
	} catch {
		return null;
	}
}

function IssueDetail({ issue, checkName, cwd, height, copied }: {
	issue: { severity: string; message: string; file?: string; line?: number; rule?: string };
	checkName: string;
	cwd: string;
	height: number;
	copied: boolean;
}) {
	const ctx = readSourceContext(cwd, issue.file, issue.line, issue.rule);
	const prompt = buildFixPrompt(checkName, issue, cwd);
	// Split height: source gets top half, prompt gets bottom
	const srcHeight = ctx ? Math.min(ctx.lines.length + 2, Math.floor((height - 8) * 0.6)) : 0;
	const promptHeight = height - 8 - srcHeight;
	const promptLines = prompt.split("\n");

	return (
		<Box flexDirection="column" height={height} paddingX={1} overflowY="hidden">
			<Text bold color="magenta"> ◈ Issue Detail</Text>
			<Text>
				<Text color={sc(issue.severity)} bold> {issue.severity.toUpperCase()} </Text>
				<Text dimColor>{checkName}</Text>
				{issue.rule && <Text dimColor> · {issue.rule}</Text>}
				{copied && <Text color="green" bold> ✓ Copied!</Text>}
			</Text>
			<Text wrap="wrap"> {issue.message}</Text>
			{issue.file && (
				<Text color="cyan"> {issue.file}{issue.line ? `:${issue.line}` : ""}</Text>
			)}

			{ctx && (
				<Box flexDirection="column" height={srcHeight} overflowY="hidden">
					<Text dimColor> ─── {ctx.filePath} ───</Text>
					{ctx.lines.slice(0, srcHeight - 2).map((l) => (
						<Text key={l.num} wrap="truncate">
							<Text color={l.highlight ? "yellow" : "gray"}>{l.highlight ? "▸" : " "}</Text>
							<Text dimColor>{String(l.num).padStart(4)}│</Text>
							<Text color={l.highlight ? "white" : undefined}>{l.text}</Text>
						</Text>
					))}
					<Text dimColor> ───</Text>
				</Box>
			)}

			{/* Fix prompt — shown below source, ready to copy with y */}
			<Box flexDirection="column" height={Math.max(3, promptHeight)} overflowY="hidden" marginTop={ctx ? 0 : 1}>
				<Text bold color="green"> Fix prompt <Text dimColor>(y to copy)</Text></Text>
				{promptLines.slice(0, Math.max(1, promptHeight - 1)).map((line, i) => (
					<Text key={`p-${i}`} dimColor wrap="truncate"> {line}</Text>
				))}
			</Box>
		</Box>
	);
}

// ── Git Changes View ──

function GitChangesView({ changes, checks, height, cursor }: {
	changes: GitChange[]; checks: CheckResult[]; height: number; cursor: number;
}) {

	// Cross-reference with issues
	const issuesByFile = useMemo(() => {
		const map = new Map<string, number>();
		for (const c of checks) {
			for (const iss of c.issues) {
				if (iss.file && typeof iss.file === "string") {
					map.set(iss.file, (map.get(iss.file) || 0) + 1);
				}
			}
		}
		return map;
	}, [checks]);

	const statusColor: Record<string, string> = { M: "yellow", A: "green", D: "red", "?": "gray", R: "cyan" };
	const visibleLines = Math.max(1, height - 5);

	return (
		<Box flexDirection="column" height={height} paddingX={1} overflowY="hidden">
			<Text bold color="magenta"> ◈ Git Changes ({changes.length})</Text>
			{changes.length === 0 ? (
				<Text dimColor> Working tree clean — no uncommitted changes.</Text>
			) : (
				<>
					{changes.slice(0, visibleLines).map((ch, i) => {
						const sel = i === cursor;
						const count = issuesByFile.get(ch.file) || 0;
						return (
							<Text key={ch.file} wrap="truncate">
								<Text color={sel ? "white" : "gray"}>{sel ? "▸" : " "}</Text>
								<Text color={statusColor[ch.status] || "gray"} bold> {ch.status} </Text>
								<Text color={sel ? "white" : undefined}>{ch.file} </Text>
								{count > 0 ? (
									<Text color="yellow">{count} issue{count !== 1 ? "s" : ""}</Text>
								) : (
									<Text color="green">clean</Text>
								)}
							</Text>
						);
					})}
					{changes.length > visibleLines && <Text dimColor> +{changes.length - visibleLines} more</Text>}
				</>
			)}
		</Box>
	);
}

// ── All Files View ──

function AllFilesView({ checks, height, cursor }: { checks: CheckResult[]; height: number; cursor: number }) {
	// Build file list from all issues, sorted by issue count descending
	const fileMap = useMemo(() => {
		const map = new Map<string, { errors: number; warnings: number; infos: number }>();
		for (const c of checks) {
			for (const iss of c.issues) {
				if (!iss.file || typeof iss.file !== "string") continue;
				const entry = map.get(iss.file) || { errors: 0, warnings: 0, infos: 0 };
				if (iss.severity === "error") entry.errors++;
				else if (iss.severity === "warning") entry.warnings++;
				else entry.infos++;
				map.set(iss.file, entry);
			}
		}
		return [...map.entries()]
			.map(([file, counts]) => ({ file, total: counts.errors + counts.warnings + counts.infos, ...counts }))
			.sort((a, b) => b.total - a.total);
	}, [checks]);

	const visibleLines = Math.max(1, height - 5);
	// Scroll window
	const scrollStart = Math.max(0, Math.min(cursor - Math.floor(visibleLines / 2), fileMap.length - visibleLines));
	const visible = fileMap.slice(scrollStart, scrollStart + visibleLines);

	return (
		<Box flexDirection="column" height={height} paddingX={1} overflowY="hidden">
			<Text bold color="magenta"> ◈ Files with Issues ({fileMap.length})</Text>
			<Text dimColor> sorted by issue count · Enter to drill in</Text>
			<Text> </Text>
			{fileMap.length === 0 ? (
				<Text color="green"> No issues in any file.</Text>
			) : (
				<>
					{visible.map((f, i) => {
						const idx = scrollStart + i;
						const sel = idx === cursor;
						return (
							<Text key={f.file} wrap="truncate">
								<Text color={sel ? "white" : "gray"}>{sel ? "▸" : " "}</Text>
								{f.errors > 0 ? <Text color="red" bold>{String(f.errors).padStart(2)}E </Text> : <Text dimColor>   </Text>}
								{f.warnings > 0 ? <Text color="yellow">{String(f.warnings).padStart(2)}W </Text> : <Text dimColor>   </Text>}
								{f.infos > 0 ? <Text dimColor>{String(f.infos).padStart(2)}I </Text> : <Text dimColor>   </Text>}
								<Text color={sel ? "white" : "cyan"}>{f.file}</Text>
							</Text>
						);
					})}
					{fileMap.length > scrollStart + visibleLines && <Text dimColor> +{fileMap.length - scrollStart - visibleLines} more (↓)</Text>}
				</>
			)}
		</Box>
	);
}

// ── Main App ──

type Panel = "checks" | "issues";
type Mode =
	| { view: "dashboard" }
	| { view: "check-detail"; checkName: string }
	| { view: "issue-detail"; checkName: string; issueIdx: number }
	| { view: "git-changes" }
	| { view: "all-files" }
	| { view: "file-issues"; file: string }
	| { view: "trends" }
	| { view: "config" };

function MonitorApp({ cwd }: { cwd: string }) {
	const { exit } = useApp();
	const { stdout } = useStdout();
	const rows = stdout?.rows ?? 30;

	// Memoize filesystem I/O — only run once
	const cached = useMemo(() => loadCachedScan(cwd), [cwd]);
	const workspace = useMemo(() => detectWorkspace(cwd), [cwd]);
	const stack = useMemo(() => detectStack(cwd, workspace), [cwd, workspace]);

	const [monCfg, setMonCfg] = useState<MonitorConfig>(() => loadMonitorConfig(cwd));
	const [mode, setMode] = useState<Mode>({ view: "dashboard" });
	const [panel, setPanel] = useState<Panel>("checks");
	const [cursor, setCursor] = useState(0);
	const [configCursor, setConfigCursor] = useState(0);
	const [pendingCfg, setPendingCfg] = useState<MonitorConfig | null>(null);
	const [state, setState] = useState<ScanState>(cached ?? {
		checks: [], score: 0, grade: "?", duration: 0,
		totalIssues: 0, scanning: true, scanCount: 0, scores: [],
	});
	const [log, setLog] = useState<LogEntry[]>([
		{ time: ts(), text: cached ? `Loaded cached scan: ${cached.grade} ${cached.score}/100` : `Monitoring ${basename(cwd)}...`, type: cached ? "scan" : "info" },
	]);
	const [copied, setCopied] = useState(false);
	const scanningRef = useRef(false);
	const prevScoreRef = useRef<number | null>(cached ? cached.score : null);

	const addLog = useCallback((text: string, type: LogEntry["type"] = "info") => {
		setLog((prev) => [...prev.slice(-50), { time: ts(), text, type }]);
	}, []);

	// Memoize derived lists
	const activeChecks = useMemo(() =>
		state.checks.filter((c) => !(c.details as Record<string, unknown>).skipped && !(c.details as Record<string, unknown>).comingSoon),
		[state.checks]);
	const allIssues = useMemo(() =>
		state.checks
			.flatMap((c) => c.issues.map((i) => ({ check: c.name, ...i })))
			.sort((a, b) => {
				const o: Record<string, number> = { error: 0, warning: 1, info: 2 };
				return (o[a.severity] ?? 2) - (o[b.severity] ?? 2);
			}),
		[state.checks]);
	const currentList = panel === "checks" ? activeChecks : allIssues;

	// Derived data for file views (memoized, used by both render + keyboard)
	const filesWithIssues = useMemo(() => {
		const map = new Map<string, number>();
		for (const c of state.checks) {
			for (const iss of c.issues) {
				if (iss.file && typeof iss.file === "string") map.set(iss.file, (map.get(iss.file) || 0) + 1);
			}
		}
		return [...map.keys()].sort((a, b) => (map.get(b) || 0) - (map.get(a) || 0));
	}, [state.checks]);
	const gitChanges = useMemo(() => getGitChanges(cwd), [cwd, state.scanCount]);

	// Clamp cursor when data changes
	useEffect(() => {
		setCursor((c) => Math.min(c, Math.max(0, currentList.length - 1)));
	}, [currentList.length]);

	const doScan = useCallback(async () => {
		if (scanningRef.current) return;
		scanningRef.current = true;
		setState((s) => ({ ...s, scanning: true }));
		addLog("Scanning...", "scan");

		const result = await runScanProcess(cwd, monCfg.skipTests);
		const prev = prevScoreRef.current;

		setState((s) => ({
			...result, scanning: false,
			scanCount: s.scanCount + 1,
			scores: [...s.scores.slice(-19), result.score],
		}));

		if (result.score === 0 && result.checks.length === 0) {
			addLog("Scan failed — check project path", "error");
		} else if (prev !== null) {
			const delta = result.score - prev;
			if (delta > 0) addLog(`Score: ${prev} → ${result.score} (+${delta})`, "improve");
			else if (delta < 0) addLog(`Score: ${prev} → ${result.score} (${delta})`, "regress");
			else addLog(`Score: ${result.score} (no change)`, "scan");

			if (delta < 0 && Math.abs(delta) >= monCfg.alertDrop) {
				addLog(`⚠ ALERT: Score dropped ${Math.abs(delta)} pts (threshold: ${monCfg.alertDrop})`, "alert");
			}
		} else {
			addLog(`Score: ${result.grade} ${result.score}/100 — ${result.totalIssues} issues — ${result.duration}ms`, "scan");
		}

		if (result.score > 0 && result.score < monCfg.alertBelow && (prev === null || prev >= monCfg.alertBelow)) {
			addLog(`⚠ ALERT: Score ${result.score} below threshold ${monCfg.alertBelow}`, "alert");
		}

		prevScoreRef.current = result.score;
		scanningRef.current = false;
	}, [cwd, monCfg, addLog]);

	useEffect(() => { doScan(); }, [doScan]);

	// File watcher
	useEffect(() => {
		const watchDirs = workspace.isMonorepo
			? workspace.srcRoots.map((d) => join(cwd, d)).filter((d) => existsSync(d))
			: ["src", "web/src", "lib"].map((d) => join(cwd, d)).filter((d) => existsSync(d));
		if (watchDirs.length === 0) return;

		let debounce: ReturnType<typeof setTimeout> | null = null;
		const watchers = watchDirs.map((dir) =>
			watch(dir, { recursive: true }, (_event, filename) => {
				if (!filename || filename.includes("node_modules") || filename.includes(".vibe-check")) return;
				if (scanningRef.current) return;
				addLog(`Changed: ${filename}`, "change");
				if (debounce) clearTimeout(debounce);
				debounce = setTimeout(() => doScan(), monCfg.debounceMs);
			}),
		);
		return () => { for (const w of watchers) w.close(); };
	}, [cwd, workspace, doScan, addLog, monCfg.debounceMs]);

	const configOptions = useMemo(() => {
		const cfg = pendingCfg ?? monCfg;
		return [
			{ key: "alertBelow", label: "Alert when score below", type: "number" as const, value: cfg.alertBelow, path: ["alertBelow"] },
			{ key: "alertDrop", label: "Alert on score drop ≥", type: "number" as const, value: cfg.alertDrop, path: ["alertDrop"] },
			{ key: "debounceMs", label: "Scan debounce (ms)", type: "number" as const, value: cfg.debounceMs, path: ["debounceMs"] },
			{ key: "skipTests", label: "Skip test execution", type: "toggle" as const, value: cfg.skipTests, path: ["skipTests"] },
			{ key: "p-score", label: "Panel: Score", type: "toggle" as const, value: cfg.panels.score, path: ["panels", "score"] },
			{ key: "p-checks", label: "Panel: Checks", type: "toggle" as const, value: cfg.panels.checks, path: ["panels", "checks"] },
			{ key: "p-activity", label: "Panel: Activity", type: "toggle" as const, value: cfg.panels.activity, path: ["panels", "activity"] },
			{ key: "p-issues", label: "Panel: Issues", type: "toggle" as const, value: cfg.panels.issues, path: ["panels", "issues"] },
		];
	}, [pendingCfg, monCfg]);

	// ── Keyboard — single handler for all views ──
	useInput((input, key) => {
		// Quit from anywhere
		if (input === "q" || (key.ctrl && input === "c")) { exit(); return; }

		// Esc: drill up one level or quit
		if (key.escape) {
			if (mode.view === "config") { setPendingCfg(null); setMode({ view: "dashboard" }); setCursor(0); return; }
			if (mode.view === "issue-detail") { setMode({ view: "check-detail", checkName: mode.checkName }); setCursor(mode.issueIdx); return; }
			if (mode.view === "file-issues") { setMode({ view: "dashboard" }); setCursor(0); return; }
			if (mode.view !== "dashboard") { setMode({ view: "dashboard" }); setCursor(0); return; }
			exit();
			return;
		}

		// Rescan from dashboard or check-detail
		if (input === "r" && (mode.view === "dashboard" || mode.view === "check-detail")) { doScan(); return; }

		// ── Config view ──
		if (mode.view === "config") {
			const cfg = pendingCfg ?? { ...monCfg };
			if (key.upArrow) { setConfigCursor((c) => Math.max(0, c - 1)); return; }
			if (key.downArrow) { setConfigCursor((c) => Math.min(configOptions.length - 1, c + 1)); return; }
			const opt = configOptions[configCursor];
			if (!opt) return;
			if (opt.type === "toggle" && (input === " " || key.return)) {
				const next = { ...cfg, panels: { ...cfg.panels } };
				if (opt.path.length === 1) (next as Record<string, unknown>)[opt.path[0]] = !opt.value;
				else (next.panels as Record<string, boolean>)[opt.path[1]] = !(opt.value as boolean);
				setPendingCfg(next);
			}
			if (opt.type === "number") {
				const step = key.shift ? 10 : 1;
				let v = opt.value as number;
				if (key.rightArrow) v += step;
				if (key.leftArrow) v = Math.max(0, v - step);
				if (v !== opt.value) {
					const next = { ...cfg, panels: { ...cfg.panels } };
					(next as Record<string, unknown>)[opt.path[0]] = v;
					setPendingCfg(next);
				}
			}
			if (input === "s" && pendingCfg) {
				setMonCfg(pendingCfg);
				saveMonitorConfig(cwd, pendingCfg);
				addLog("Settings saved", "info");
				setPendingCfg(null);
				setMode({ view: "dashboard" });
				setCursor(0);
			}
			return;
		}

		// View switching (not from config — handled above)
		if (input === "t") { setMode({ view: "trends" }); setCursor(0); return; }
		if (input === "g") { setMode({ view: "git-changes" }); setCursor(0); return; }
		if (input === "f") { setMode({ view: "all-files" }); setCursor(0); return; }
		if (input === "c") { setMode({ view: "config" }); setConfigCursor(0); setPendingCfg({ ...monCfg, panels: { ...monCfg.panels } }); return; }

		// ── Dashboard navigation ──
		if (mode.view === "dashboard") {
			if (key.tab) { setPanel((p) => p === "checks" ? "issues" : "checks"); setCursor(0); return; }
			if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
			if (key.downArrow) setCursor((c) => Math.min(currentList.length - 1, c + 1));
			if (key.return && panel === "checks" && activeChecks[cursor]) {
				setMode({ view: "check-detail", checkName: activeChecks[cursor].name });
				setCursor(0);
				return;
			}
			if (key.return && panel === "issues" && allIssues[cursor]) {
				setMode({ view: "check-detail", checkName: allIssues[cursor].check });
				setCursor(0);
				return;
			}
		}

		// ── Check detail: ↑↓ scroll, Enter drills into issue, y copies prompt ──
		if (mode.view === "check-detail") {
			const check = state.checks.find((c) => c.name === mode.checkName);
			if (check) {
				if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
				if (key.downArrow) setCursor((c) => Math.min(check.issues.length - 1, c + 1));
				if (key.return && check.issues[cursor]) {
					setMode({ view: "issue-detail", checkName: mode.checkName, issueIdx: cursor });
					return;
				}
				if (input === "y" && check.issues[cursor]) {
					const prompt = buildFixPrompt(check.name, check.issues[cursor], cwd);
					if (copyToClipboard(prompt)) {
						setCopied(true);
						addLog(`Copied fix prompt for ${check.name}:${check.issues[cursor].file || ""}`, "info");
						setTimeout(() => setCopied(false), 2000);
					}
				}
			}
		}

		// ── Issue detail: y copies prompt ──
		if (mode.view === "issue-detail") {
			const check = state.checks.find((c) => c.name === mode.checkName);
			if (check && check.issues[mode.issueIdx] && input === "y") {
				const prompt = buildFixPrompt(check.name, check.issues[mode.issueIdx], cwd);
				if (copyToClipboard(prompt)) {
					setCopied(true);
					addLog(`Copied fix prompt`, "info");
					setTimeout(() => setCopied(false), 2000);
				}
			}
		}

		// ── All files: ↑↓ navigate, Enter drill into file issues ──
		if (mode.view === "all-files") {
			if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
			if (key.downArrow) setCursor((c) => Math.min(filesWithIssues.length - 1, c + 1));
			if (key.return && filesWithIssues[cursor]) {
				setMode({ view: "file-issues", file: filesWithIssues[cursor] });
				setCursor(0);
			}
		}

		// ── Git changes: ↑↓ navigate, Enter drill into file issues ──
		if (mode.view === "git-changes") {
			if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
			if (key.downArrow) setCursor((c) => Math.min(gitChanges.length - 1, c + 1));
			if (key.return && gitChanges[cursor]) {
				setMode({ view: "file-issues", file: gitChanges[cursor].file });
				setCursor(0);
			}
		}

		// ── File issues: ↑↓ navigate, Enter drill into issue detail, y copy ──
		if (mode.view === "file-issues") {
			const fileIssues = state.checks.flatMap((c) =>
				c.issues.filter((i) => i.file === mode.file).map((i) => ({ check: c.name, ...i })),
			);
			if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
			if (key.downArrow) setCursor((c) => Math.min(fileIssues.length - 1, c + 1));
			if (key.return && fileIssues[cursor]) {
				setMode({ view: "issue-detail", checkName: fileIssues[cursor].check, issueIdx: 0 });
			}
			if (input === "y" && fileIssues[cursor]) {
				const prompt = buildFixPrompt(fileIssues[cursor].check, fileIssues[cursor], cwd);
				if (copyToClipboard(prompt)) {
					setCopied(true);
					addLog(`Copied fix prompt`, "info");
					setTimeout(() => setCopied(false), 2000);
				}
			}
		}

		// ── Trends: ↑↓ scroll ──
		if (mode.view === "trends") {
			if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
			if (key.downArrow) setCursor((c) => c + 1);
		}
	});

	const proj = basename(cwd);
	const p = monCfg.panels;

	// ── Render views ──

	if (mode.view === "all-files") {
		return (
			<Box flexDirection="column" height={rows}>
				<Header proj={proj} stack={stack} workspace={workspace} state={state} />
				<AllFilesView checks={state.checks} height={rows - 3} cursor={cursor} />
				<Box paddingX={1}>
					<Text dimColor>Esc back · ↑↓ select · Enter view file issues · q quit</Text>
				</Box>
			</Box>
		);
	}

	if (mode.view === "git-changes") {
		return (
			<Box flexDirection="column" height={rows}>
				<Header proj={proj} stack={stack} workspace={workspace} state={state} />
				<GitChangesView changes={gitChanges} checks={state.checks} height={rows - 3} cursor={cursor} />
				<Box paddingX={1}>
					<Text dimColor>Esc back · ↑↓ select · Enter view file issues · q quit</Text>
				</Box>
			</Box>
		);
	}

	if (mode.view === "file-issues") {
		const fileIssues = state.checks.flatMap((c) =>
			c.issues.filter((i) => i.file === mode.file).map((i) => ({ check: c.name, ...i })),
		);
		return (
			<Box flexDirection="column" height={rows}>
				<Header proj={proj} stack={stack} workspace={workspace} state={state} />
				<Box flexDirection="column" height={rows - 3} paddingX={1} overflowY="hidden">
					<Text bold color="magenta"> ◈ {mode.file}</Text>
					<Text dimColor> {fileIssues.length} issue{fileIssues.length !== 1 ? "s" : ""}{copied && <Text color="green" bold> ✓ Copied!</Text>}</Text>
					<Text> </Text>
					{fileIssues.length === 0 ? (
						<Text color="green"> No issues in this file.</Text>
					) : (
						fileIssues.slice(0, rows - 8).map((iss, i) => {
							const sel = i === cursor;
							return (
								<Box key={`${iss.check}-${iss.line || i}`} flexDirection="column">
									<Text>
										<Text color={sel ? "white" : "gray"}>{sel ? "▸" : " "}</Text>
										<Text color={sc(iss.severity)} bold>{iss.severity[0]!.toUpperCase()} </Text>
										{iss.line && <Text color="cyan">{String(iss.line).padEnd(5)}</Text>}
										<Text dimColor>{iss.check.padEnd(14)}</Text>
										{iss.rule && <Text dimColor>({iss.rule}) </Text>}
									</Text>
									<Text wrap="wrap">
										<Text color={sel ? "white" : "gray"}>  </Text>
										<Text color={sel ? "white" : undefined}>{iss.message}</Text>
									</Text>
								</Box>
							);
						})
					)}
				</Box>
				<Box paddingX={1}>
					<Text dimColor>Esc back · ↑↓ select · Enter source · y copy prompt · q quit</Text>
				</Box>
			</Box>
		);
	}

	if (mode.view === "issue-detail") {
		const check = state.checks.find((c) => c.name === mode.checkName);
		const issue = check?.issues[mode.issueIdx];
		return (
			<Box flexDirection="column" height={rows}>
				<Header proj={proj} stack={stack} workspace={workspace} state={state} />
				{issue ? (
					<IssueDetail issue={issue} checkName={mode.checkName} cwd={cwd} height={rows - 3} copied={copied} />
				) : (
					<Text dimColor> Issue not found</Text>
				)}
				<Box paddingX={1}>
					<Text dimColor>Esc back · y copy fix prompt · q quit</Text>
				</Box>
			</Box>
		);
	}

	if (mode.view === "check-detail") {
		const check = state.checks.find((c) => c.name === mode.checkName);
		return (
			<Box flexDirection="column" height={rows}>
				<Header proj={proj} stack={stack} workspace={workspace} state={state} />
				{check ? <CheckDetail check={check} height={rows - 3} cursor={cursor} copied={copied} /> : <Text dimColor> Check not found</Text>}
				<Box paddingX={1}>
					<Text dimColor>Esc back · ↑↓ select · Enter view source · y copy prompt · q quit</Text>
				</Box>
			</Box>
		);
	}

	if (mode.view === "trends") {
		return (
			<Box flexDirection="column" height={rows}>
				<TrendsScreen cwd={cwd} height={rows} />
			</Box>
		);
	}

	if (mode.view === "config") {
		return (
			<Box flexDirection="column" height={rows} justifyContent="center" alignItems="center">
				<ConfigScreen cursor={configCursor} options={configOptions} />
			</Box>
		);
	}

	// ── Dashboard ──
	const sidebarVisible = p.score || p.checks;
	const mainVisible = p.activity || p.issues;
	const bodyRows = rows - 4;
	const scoreH = p.score ? 8 : 0;
	const checksH = p.checks ? Math.max(6, bodyRows - scoreH) : 0;
	const activityH = p.activity && p.issues ? Math.floor(bodyRows / 2) : p.activity ? bodyRows : 0;
	const issuesH = p.issues ? bodyRows - activityH : 0;

	const errorCount = state.checks.reduce((s, c) => s + c.issues.filter((i) => i.severity === "error").length, 0);
	const warnCount = state.checks.reduce((s, c) => s + c.issues.filter((i) => i.severity === "warning").length, 0);

	return (
		<Box flexDirection="column" height={rows}>
			<Header proj={proj} stack={stack} workspace={workspace} state={state} />

			{/* Metrics bar */}
			<Box paddingX={1} gap={2} height={1}>
				{state.scanCount > 0 && (
					<>
						<Text><Text dimColor>E </Text><Text color="red" bold>{errorCount}</Text></Text>
						<Text><Text dimColor>W </Text><Text color="yellow" bold>{warnCount}</Text></Text>
						<Text><Text dimColor>checks </Text><Text bold>{activeChecks.length}</Text></Text>
						<Text><Text dimColor>scan </Text><Text>{state.duration}ms</Text></Text>
						{state.scores.length >= 2 && <Text color="cyan">{spark(state.scores)}</Text>}
					</>
				)}
			</Box>

			{/* Body */}
			<Box height={bodyRows}>
				{sidebarVisible && (
					<Box flexDirection="column" width={26}>
						{p.score && <ScorePanel state={state} height={scoreH} />}
						{p.checks && (
							<Box flexDirection="column" borderStyle="round" borderColor={panel === "checks" ? "magenta" : "gray"} paddingX={1} width={24} height={checksH} overflowY="hidden">
								<Text bold color="magenta"> ◈ Checks {panel === "checks" && <Text dimColor>◄</Text>}</Text>
								{activeChecks.slice(0, checksH - 3).map((c, i) => {
									const sel = panel === "checks" && i === cursor;
									return (
										<Text key={c.name}>
											<Text color={sel ? "white" : gc(c.grade)}>{sel ? "▸" : " "}{c.grade === "A" ? "●" : c.grade === "B" ? "◐" : "○"} </Text>
											<Text bold={sel}>{c.name.slice(0, 13).padEnd(13)}</Text>
											<Text color={gc(c.grade)}>{String(c.score).padStart(3)}</Text>
										</Text>
									);
								})}
							</Box>
						)}
					</Box>
				)}
				{mainVisible && (
					<Box flexDirection="column" flexGrow={1}>
						{p.activity && <ActivityPanel log={log} height={activityH} />}
						{p.issues && (
							<Box flexDirection="column" borderStyle="round" borderColor={panel === "issues" ? "magenta" : "gray"} paddingX={1} height={issuesH} overflowY="hidden">
								<Text bold color="magenta">
									{" "}◈ Issues ({allIssues.length}) {panel === "issues" && <Text dimColor>◄</Text>}
								</Text>
								{allIssues.slice(0, issuesH - 3).map((iss, i) => {
									const sel = panel === "issues" && i === cursor;
									return (
										<Text key={`${iss.check}-${iss.file || ""}-${iss.line || i}`} wrap="truncate">
											<Text color={sel ? "white" : "gray"}>{sel ? "▸" : " "}</Text>
											<Text color={sc(iss.severity)} bold>{iss.severity[0]!.toUpperCase()} </Text>
											<Text dimColor>{(iss.check || "").slice(0, 11).padEnd(11)} </Text>
											{iss.file && <Text color="cyan">{basename(String(iss.file)).slice(0, 18).padEnd(18)} </Text>}
											<Text>{iss.message.slice(0, 40)}</Text>
										</Text>
									);
								})}
								{allIssues.length > issuesH - 3 && <Text dimColor> +{allIssues.length - (issuesH - 3)} more</Text>}
							</Box>
						)}
					</Box>
				)}
				{!sidebarVisible && !mainVisible && (
					<Box height={bodyRows} justifyContent="center" alignItems="center">
						<Text dimColor>All panels hidden. Press c to configure.</Text>
					</Box>
				)}
			</Box>

			{/* Footer */}
			<Box paddingX={1} justifyContent="space-between">
				<Text dimColor>Tab panel · ↑↓ Enter Esc · r scan · f files · g git · t trends · c config · q</Text>
			</Box>
		</Box>
	);
}

function Header({ proj, stack, workspace, state }: {
	proj: string;
	stack: ReturnType<typeof detectStack>;
	workspace: ReturnType<typeof detectWorkspace>;
	state: ScanState;
}) {
	return (
		<Box paddingX={1} justifyContent="space-between">
			<Text>
				<Text color="magenta" bold>vcqa monitor</Text>
				<Text dimColor> v{VERSION}</Text>
			</Text>
			<Text>
				<Text bold>{proj}</Text>
				<Text dimColor> {stack.language}/{stack.framework}{workspace.isMonorepo ? ` · ${workspace.tool}` : ""}</Text>
			</Text>
			<Text>
				{state.score > 0 && <Text color={gc(state.grade)} bold>{state.grade} {state.score} </Text>}
				<Text dimColor>{state.scanning ? "⟳ scanning" : "● watching"}</Text>
			</Text>
		</Box>
	);
}

// ── Entry ──

export async function startMonitor(cwd: string): Promise<void> {
	const resolved = resolve(cwd);
	if (!process.stdin.isTTY) {
		console.error("  \x1b[31mvcqa monitor requires an interactive terminal (TTY)\x1b[0m");
		process.exit(1);
	}
	const { waitUntilExit } = render(<MonitorApp cwd={resolved} />);
	await waitUntilExit();
}
