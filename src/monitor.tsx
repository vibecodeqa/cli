/** vcqa monitor — real-time quality control panel.
 *
 * Full-screen TUI that watches your codebase and re-scans on changes.
 * Scan runs in a child process so the UI never freezes.
 * Press 'c' to open settings: thresholds, panel toggles, scan options.
 * Config persists to .vibe-check/monitor.json.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { render, Box, Text, useApp, useInput, useStdout } from "ink";
import { resolve, join, basename } from "node:path";
import { watch, existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

import { detectStack, detectWorkspace } from "./detect.js";
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

function bar(score: number, width: number): string {
	const filled = Math.round((score / 100) * width);
	return "█".repeat(filled) + "░".repeat(width - filled);
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

function ChecksPanel({ checks, height }: { checks: CheckResult[]; height: number }) {
	const active = checks.filter((c) => !(c.details as Record<string, unknown>).skipped && !(c.details as Record<string, unknown>).comingSoon);
	const pro = checks.filter((c) => (c.details as Record<string, unknown>).comingSoon);
	const visibleLines = Math.max(1, height - 3);
	return (
		<Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} width={24} height={height} overflowY="hidden">
			<Text bold color="magenta"> ◈ Checks</Text>
			{active.slice(0, visibleLines).map((c) => (
				<Text key={c.name}>
					<Text color={gc(c.grade)}> {c.grade === "A" ? "●" : c.grade === "B" ? "◐" : "○"} </Text>
					<Text>{c.name.slice(0, 13).padEnd(13)}</Text>
					<Text dimColor> {bar(c.score, 4)} </Text>
					<Text color={gc(c.grade)}>{String(c.score).padStart(3)}</Text>
				</Text>
			))}
			{active.length > visibleLines && <Text dimColor> +{active.length - visibleLines} more</Text>}
			{pro.length > 0 && <Text color="magenta"> ◆ {pro.length} Pro</Text>}
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
				<Text key={i} wrap="truncate">
					<Text dimColor>{entry.time} </Text>
					<Text color={colors[entry.type]}>{entry.text}</Text>
				</Text>
			))}
		</Box>
	);
}

function IssuesPanel({ checks, height }: { checks: CheckResult[]; height: number }) {
	const issues = checks
		.flatMap((c) => c.issues.map((i) => ({ check: c.name, ...i })))
		.sort((a, b) => {
			const o: Record<string, number> = { error: 0, warning: 1, info: 2 };
			return (o[a.severity] ?? 2) - (o[b.severity] ?? 2);
		});
	const errors = issues.filter((i) => i.severity === "error").length;
	const warnings = issues.filter((i) => i.severity === "warning").length;
	const visibleLines = Math.max(1, height - 3);

	return (
		<Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} height={height} overflowY="hidden">
			<Text bold color="magenta">
				{" "}◈ Issues ({issues.length})
				{errors > 0 && <Text color="red"> {errors}E</Text>}
				{warnings > 0 && <Text color="yellow"> {warnings}W</Text>}
			</Text>
			{issues.slice(0, visibleLines).map((iss, i) => (
				<Text key={i} wrap="truncate">
					<Text color={sc(iss.severity)} bold>{iss.severity[0]!.toUpperCase()} </Text>
					<Text dimColor>{(iss.check || "").slice(0, 11).padEnd(11)} </Text>
					{iss.file && <Text color="cyan">{basename(String(iss.file)).slice(0, 18).padEnd(18)} </Text>}
					<Text>{iss.message.slice(0, 45)}</Text>
				</Text>
			))}
			{issues.length > visibleLines && <Text dimColor> +{issues.length - visibleLines} more</Text>}
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

function ConfigScreen({
	monCfg, onSave, onClose,
}: {
	monCfg: MonitorConfig;
	onSave: (cfg: MonitorConfig) => void;
	onClose: () => void;
}) {
	const [cursor, setCursor] = useState(0);
	const [cfg, setCfg] = useState<MonitorConfig>(JSON.parse(JSON.stringify(monCfg)));

	const options: ConfigOption[] = [
		{ key: "alertBelow", label: "Alert when score below", type: "number", value: cfg.alertBelow, path: ["alertBelow"] },
		{ key: "alertDrop", label: "Alert on score drop ≥", type: "number", value: cfg.alertDrop, path: ["alertDrop"] },
		{ key: "debounceMs", label: "Scan debounce (ms)", type: "number", value: cfg.debounceMs, path: ["debounceMs"] },
		{ key: "skipTests", label: "Skip test execution", type: "toggle", value: cfg.skipTests, path: ["skipTests"] },
		{ key: "p-score", label: "Panel: Score", type: "toggle", value: cfg.panels.score, path: ["panels", "score"] },
		{ key: "p-checks", label: "Panel: Checks", type: "toggle", value: cfg.panels.checks, path: ["panels", "checks"] },
		{ key: "p-activity", label: "Panel: Activity", type: "toggle", value: cfg.panels.activity, path: ["panels", "activity"] },
		{ key: "p-issues", label: "Panel: Issues", type: "toggle", value: cfg.panels.issues, path: ["panels", "issues"] },
	];

	useInput((input, key) => {
		if (key.escape || input === "c") { onClose(); return; }
		if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
		if (key.downArrow) setCursor((c) => Math.min(options.length - 1, c + 1));

		const opt = options[cursor];
		if (!opt) return;

		if (opt.type === "toggle" && (input === " " || key.return)) {
			const next = { ...cfg };
			if (opt.path.length === 1) {
				(next as Record<string, unknown>)[opt.path[0]] = !opt.value;
			} else {
				(next.panels as Record<string, boolean>)[opt.path[1]] = !(opt.value as boolean);
			}
			setCfg(next);
		}

		if (opt.type === "number") {
			const step = key.shift ? 10 : 1;
			let v = opt.value as number;
			if (key.rightArrow) v += step;
			if (key.leftArrow) v = Math.max(0, v - step);
			if (v !== opt.value) {
				const next = { ...cfg };
				(next as Record<string, unknown>)[opt.path[0]] = v;
				setCfg(next);
			}
		}

		if (input === "s") { onSave(cfg); onClose(); }
	});

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

// ── Main App ──

function MonitorApp({ cwd }: { cwd: string }) {
	const { exit } = useApp();
	const { stdout } = useStdout();
	const rows = stdout?.rows ?? 30;

	const [monCfg, setMonCfg] = useState<MonitorConfig>(() => loadMonitorConfig(cwd));
	const [mode, setMode] = useState<"monitor" | "config">("monitor");
	const [state, setState] = useState<ScanState>({
		checks: [], score: 0, grade: "?", duration: 0,
		totalIssues: 0, scanning: true, scanCount: 0, scores: [],
	});
	const [log, setLog] = useState<LogEntry[]>([
		{ time: ts(), text: `Monitoring ${basename(cwd)}...`, type: "info" },
	]);
	const scanningRef = useRef(false);
	const prevScoreRef = useRef<number | null>(null);

	const addLog = useCallback((text: string, type: LogEntry["type"] = "info") => {
		setLog((prev) => [...prev.slice(-50), { time: ts(), text, type }]);
	}, []);

	const workspace = detectWorkspace(cwd);
	const stack = detectStack(cwd, workspace);

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

	// Initial scan
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

	// Keyboard — all input handled, nothing echoed
	useInput((input, key) => {
		if (key.escape) {
			if (mode === "config") { setMode("monitor"); return; }
			exit();
			return;
		}
		if (input === "q" || (key.ctrl && input === "c")) { exit(); return; }
		if (mode !== "monitor") return;
		if (input === "r") doScan();
		if (input === "c") setMode("config");
	});

	const proj = basename(cwd);
	const p = monCfg.panels;

	if (mode === "config") {
		return (
			<Box flexDirection="column" height={rows} justifyContent="center" alignItems="center">
				<ConfigScreen
					monCfg={monCfg}
					onSave={(cfg) => { setMonCfg(cfg); saveMonitorConfig(cwd, cfg); addLog("Settings saved", "info"); }}
					onClose={() => setMode("monitor")}
				/>
			</Box>
		);
	}

	// Fixed panel heights — no reflow on content changes
	const sidebarVisible = p.score || p.checks;
	const mainVisible = p.activity || p.issues;
	const bodyRows = rows - 4;
	const scoreH = p.score ? 8 : 0;
	const checksH = p.checks ? Math.max(6, bodyRows - scoreH) : 0;
	const activityH = p.activity && p.issues ? Math.floor(bodyRows / 2) : p.activity ? bodyRows : 0;
	const issuesH = p.issues ? bodyRows - activityH : 0;

	const errorCount = state.checks.reduce((s, c) => s + c.issues.filter((i) => i.severity === "error").length, 0);
	const warnCount = state.checks.reduce((s, c) => s + c.issues.filter((i) => i.severity === "warning").length, 0);
	const activeCount = state.checks.filter((c) => !(c.details as Record<string, unknown>).skipped && !(c.details as Record<string, unknown>).comingSoon).length;

	return (
		<Box flexDirection="column" height={rows}>
			{/* Header */}
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

			{/* Metrics bar */}
			<Box paddingX={1} gap={2} height={1}>
				{state.scanCount > 0 && (
					<>
						<Text><Text dimColor>E </Text><Text color="red" bold>{errorCount}</Text></Text>
						<Text><Text dimColor>W </Text><Text color="yellow" bold>{warnCount}</Text></Text>
						<Text><Text dimColor>checks </Text><Text bold>{activeCount}</Text></Text>
						<Text><Text dimColor>scan </Text><Text>{state.duration}ms</Text></Text>
						{state.scores.length >= 2 && <Text color="cyan">{spark(state.scores)}</Text>}
					</>
				)}
			</Box>

			{/* Body — fixed heights, no reflow */}
			<Box height={bodyRows}>
				{sidebarVisible && (
					<Box flexDirection="column" width={26}>
						{p.score && <ScorePanel state={state} height={scoreH} />}
						{p.checks && <ChecksPanel checks={state.checks} height={checksH} />}
					</Box>
				)}
				{mainVisible && (
					<Box flexDirection="column" flexGrow={1}>
						{p.activity && <ActivityPanel log={log} height={activityH} />}
						{p.issues && <IssuesPanel checks={state.checks} height={issuesH} />}
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
				<Text dimColor>q/Esc quit · r rescan · c settings</Text>
				{monCfg.alertBelow > 0 && (
					<Text dimColor>alert &lt;{monCfg.alertBelow} · drop ≥{monCfg.alertDrop}</Text>
				)}
			</Box>
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
