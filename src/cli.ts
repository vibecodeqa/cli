#!/usr/bin/env node
/** vibe-check — code health scanner for the AI coding era. */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getCheckMeta } from "./check-meta.js";
import { runExplain } from "./commands/explain.js";
import { runFix } from "./commands/fix.js";
import { runInit } from "./commands/init.js";
import { validateCwd } from "./commands/shared.js";
import { loadConfig } from "./config.js";
import { scan } from "./core.js";
import { computeDelta } from "./delta.js";
import { detectStack, detectWorkspace } from "./detect.js";
import { postPRComment } from "./pr-comment.js";
import { generatePages } from "./report/html.js";
import { buildReportHistorySnapshot, withFreshAnalyzerSnapshots } from "./report-contract.js";
import { computeTrend, formatTrend, type TrendDelta } from "./trend.js";
import type { VibeReport, WorkspaceInfo } from "./types.js";
import { buildReportUploadPayload, currentGitSha } from "./upload.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"));
const VERSION: string = pkg.version;

// ── Flag parsing ──

interface ParsedFlags {
	cwd: string;
	outputDir: string;
	jsonOnly: boolean;
	ciMode: boolean;
	skipTests: boolean;
	watchMode: boolean;
	badgeMode: boolean;
	sarifMode: boolean;
	uploadMode: boolean;
	topN: number;
	failUnder: number | null;
	diffBase: string | null;
	prComment: boolean;
	markdownMode: boolean;
	annotations: boolean;
}

function parseFlags(): ParsedFlags {
	const args = process.argv.slice(2);
	const flags = new Set(args.filter((a) => a.startsWith("--")));
	const valueArgIndices = new Set<number>();

	function parseValueFlag(flag: string, fallback?: number): number | null {
		const idx = args.indexOf(flag);
		if (idx === -1) return null;
		const next = args[idx + 1];
		if (next && !next.startsWith("--")) {
			if (/^\d+$/.test(next)) {
				valueArgIndices.add(idx + 1);
				return parseInt(next, 10);
			}
			valueArgIndices.add(idx + 1);
		}
		return fallback ?? null;
	}

	const topN = parseValueFlag("--top", 5) ?? 0;
	const failUnder = parseValueFlag("--fail-under");

	let diffBase: string | null = null;
	const diffIdx = args.indexOf("--diff");
	if (diffIdx !== -1) {
		const next = args[diffIdx + 1];
		if (next && !next.startsWith("--") && !next.startsWith("/") && !next.startsWith(".")) {
			diffBase = next;
			valueArgIndices.add(diffIdx + 1);
		} else {
			diffBase = "HEAD";
		}
	}

	const cwd = resolve(args.find((a, i) => !a.startsWith("--") && !valueArgIndices.has(i)) || ".");
	return {
		cwd,
		outputDir: join(cwd, ".vibe-check"),
		jsonOnly: flags.has("--json"),
		ciMode: flags.has("--ci"),
		skipTests: flags.has("--skip-tests"),
		watchMode: flags.has("--watch"),
		badgeMode: flags.has("--badge"),
		sarifMode: flags.has("--sarif"),
		uploadMode: flags.has("--upload"),
		topN,
		failUnder,
		diffBase,
		prComment: flags.has("--pr-comment"),
		markdownMode: flags.has("--markdown"),
		annotations: flags.has("--annotations"),
	};
}

// ── Output helpers ──

function color(grade: string): string {
	if (grade === "A") return "\x1b[32m";
	if (grade === "B") return "\x1b[33m";
	return "\x1b[31m";
}

function printHelp(): void {
	console.log(`
  \x1b[1m\x1b[38;5;141mvcqa\x1b[0m v${VERSION} — code health scanner

  \x1b[1mUsage:\x1b[0m  npx @vibecodeqa/cli [command] [path] [flags]

  \x1b[1mCommands:\x1b[0m
    init [path]       Set up CI workflow + recommended configs
    fix [path]        Auto-fix (.gitignore, strict mode, biome/eslint, suggestions)
      --ai            Use Claude to fix remaining issues (needs ANTHROPIC_API_KEY)
      --check NAME    Only fix issues from a specific check (e.g. --check security)
      --dry-run       Show what AI would fix without applying changes
    explain [check]   Deep-dive explanation of a check (what/risk/fix)
    monitor [path]    Live quality control panel — re-scans on file changes

  \x1b[1mFlags:\x1b[0m
    --skip-tests      Skip test execution (faster scan)
    --ci              CI mode (exit 1 if score < 60)
    --fail-under N    Exit 1 if score below N (e.g. --fail-under 80)
    --json            Output JSON only (no terminal UI)
    --badge           Generate SVG badge
    --sarif           Generate SARIF for GitHub Code Scanning
    --upload          Upload report to app.vibecodeqa.online
    --top [N]         Show top N issues to fix (default: 5)
    --diff [base]     Only show issues in changed files (vs HEAD or branch)
    --markdown        Output markdown summary (pipe to file or clipboard)
    --pr-comment      Post score as GitHub PR comment (needs GITHUB_TOKEN)
    --annotations     Emit GitHub Actions ::warning/::error annotations
    --watch           Re-scan on file changes
    -v, --version     Print version
    -h, --help        Show this help

  \x1b[1mExamples:\x1b[0m
    npx @vibecodeqa/cli                     # scan current directory
    npx @vibecodeqa/cli init                # set up CI + configs
    npx @vibecodeqa/cli fix                 # auto-fix what's fixable
    npx @vibecodeqa/cli fix --ai            # AI-powered fix (uses Claude)
    npx @vibecodeqa/cli fix --ai --check security  # fix only security issues
    npx @vibecodeqa/cli fix --ai --dry-run  # preview AI fixes without applying
    npx @vibecodeqa/cli --skip-tests --top  # fast scan with top issues
    npx @vibecodeqa/cli --ci --fail-under 80  # CI with quality gate
`);
}

function printHeader(cwd: string, stack: ReturnType<typeof detectStack>, workspace: WorkspaceInfo): void {
	console.log("");
	console.log(`  \x1b[1m\x1b[38;5;141mvcqa\x1b[0m v${VERSION}`);
	console.log(`  \x1b[2m${cwd}\x1b[0m`);
	console.log("");
	const parts = [stack.language, stack.framework, stack.bundler, stack.testRunner, stack.linter, stack.packageManager].filter(
		(v) => v !== "none" && v !== "unknown",
	);
	console.log(`  stack: ${parts.join(" + ")}`);
	if (workspace.isMonorepo) {
		console.log(`  workspace: ${workspace.tool} monorepo — ${workspace.packages.length} packages`);
		for (const p of workspace.packages.slice(0, 8)) {
			const f = [p.hasSrc && "src", p.hasTests && "tests", p.hasLinter && "linter"].filter(Boolean).join(", ");
			console.log(`    \x1b[2m${p.path}\x1b[0m (${f || "empty"})`);
		}
		if (workspace.packages.length > 8) console.log(`    \x1b[2m...and ${workspace.packages.length - 8} more\x1b[0m`);
	}
	console.log("");
}

function generateMarkdown(report: VibeReport, trend: TrendDelta | null, prevReport?: VibeReport): string {
	const { score, grade, checks } = report;
	const gradeEmoji = grade === "A" ? "🟢" : grade === "B" ? "🟡" : grade === "C" ? "🟠" : "🔴";
	let md = `# ${gradeEmoji} VibeCode QA: ${grade} ${score}/100\n\n`;

	// Delta section — shows what changed with specific fixed/new issues
	if (prevReport) {
		const delta = computeDelta(prevReport, report);
		const arrow = delta.scoreDelta > 0 ? "📈" : delta.scoreDelta < 0 ? "📉" : "➡️";
		md += `${arrow} **${delta.scoreDelta > 0 ? "+" : ""}${delta.scoreDelta}** vs previous`;
		if (delta.fixed.length > 0) md += ` · **${delta.fixed.length} fixed**`;
		if (delta.introduced.length > 0) md += ` · ${delta.introduced.length} new`;
		md += "\n\n";

		// Per-check changes
		const changed = delta.checks.filter((c) => c.delta !== 0).sort((a, b) => b.delta - a.delta);
		if (changed.length > 0) {
			for (const c of changed.slice(0, 8)) {
				const a = c.delta > 0 ? "+" : "";
				md += `- ${c.delta > 0 ? "✅" : "⚠️"} ${c.name}: ${c.before} → ${c.after} (${a}${c.delta})\n`;
			}
			md += "\n";
		}
	} else if (trend) {
		const arrow = trend.scoreDelta > 0 ? "📈" : trend.scoreDelta < 0 ? "📉" : "➡️";
		md += `${arrow} **${trend.scoreDelta > 0 ? "+" : ""}${trend.scoreDelta}** vs previous`;
		if (trend.fixedIssues > 0) md += ` · ${trend.fixedIssues} fixed`;
		if (trend.newIssues > 0) md += ` · ${trend.newIssues} new`;
		md += "\n\n";
	}

	// Stack + detected components — context for why a given check set applied.
	const stack = report.meta.stack;
	const stackBits = [stack.framework !== "none" && stack.framework !== "unknown" ? stack.framework : null, stack.language]
		.filter(Boolean)
		.join(" / ");
	md += `**Stack:** ${stackBits}`;
	if (stack.components && stack.components.length > 0) md += ` · **Components:** ${stack.components.join(", ")}`;
	if (report.meta.workspace?.isMonorepo) md += ` · monorepo (${report.meta.workspace.tool})`;
	md += "\n\n";

	const ran = checks.filter((c) => {
		const det = c.details as Record<string, unknown>;
		return !det.skipped && !det.comingSoon;
	});
	const gated = checks.filter((c) => {
		const det = c.details as Record<string, unknown>;
		return det.skipped && !det.comingSoon;
	});

	// Category rollup — where the score actually comes from. A flat check list
	// hides that Testing carries 13 points and html-quality carries none.
	const byCategory = new Map<string, { score: number; weight: number; checks: number }>();
	for (const c of ran) {
		const meta = getCheckMeta(c.name);
		if (meta.weight <= 0) continue;
		const row = byCategory.get(meta.category) ?? { score: 0, weight: 0, checks: 0 };
		row.score += c.score * meta.weight;
		row.weight += meta.weight;
		row.checks += 1;
		byCategory.set(meta.category, row);
	}
	if (byCategory.size > 0) {
		md += "| Category | Score | Weight |\n|----------|-------|--------|\n";
		for (const [cat, row] of byCategory) {
			const catScore = Math.round(row.score / row.weight);
			const emoji = catScore >= 90 ? "🟢" : catScore >= 75 ? "🟡" : catScore >= 60 ? "🟠" : "🔴";
			md += `| ${emoji} ${cat} | ${catScore}/100 | ${row.weight} |\n`;
		}
		md += "\n";
	}

	md += `### Checks that ran (${ran.length} of ${checks.length})\n\n`;
	md += "| Check | Score | Grade | Score impact |\n|-------|-------|-------|--------------|\n";
	for (const c of ran) {
		const emoji = c.score >= 90 ? "🟢" : c.score >= 75 ? "🟡" : c.score >= 60 ? "🟠" : "🔴";
		const scoreMode = (c.details as Record<string, unknown>).scoreMode;
		const impact =
			scoreMode === "available-unscored" ? "advisory" : scoreMode === "available-scored" ? "scored" : String(scoreMode ?? "scored");
		md += `| ${emoji} ${c.name} | ${c.score}/100 | ${c.grade} | ${impact} |\n`;
	}

	// What did NOT run, and why. Without this the report reads as "the product
	// has N checks and you passed them" rather than "N of M applied to you".
	if (gated.length > 0) {
		md += `\n<details>\n<summary><b>Not applicable to this project (${gated.length})</b> — these checks exist but were skipped</summary>\n\n`;
		md += "| Check | Why it was skipped |\n|-------|--------------------|\n";
		for (const c of gated) {
			const reason = (c.details as Record<string, unknown>).reason;
			md += `| ${c.name} | ${typeof reason === "string" ? reason : "not applicable"} |\n`;
		}
		md += "\n</details>\n";
	}
	const premium = checks.filter((c) => (c.details as Record<string, unknown>).comingSoon).length;
	if (premium > 0) {
		md += `\n*${premium} AI-analysis checks are advisory (Pro) and excluded from the score.*\n`;
	}

	const errors = checks.flatMap((c) => c.issues.filter((i) => i.severity === "error"));
	const warnings = checks.flatMap((c) => c.issues.filter((i) => i.severity === "warning"));
	if (errors.length + warnings.length > 0) {
		md += `\n## Issues (${errors.length} errors, ${warnings.length} warnings)\n\n`;
		for (const i of [...errors, ...warnings].slice(0, 15)) {
			const loc = i.file ? ` \`${i.file}${i.line ? `:${i.line}` : ""}\`` : "";
			md += `- ${i.severity === "error" ? "❌" : "⚠️"} ${i.message}${loc}\n`;
		}
		const remaining = errors.length + warnings.length - 15;
		if (remaining > 0) md += `\n*...and ${remaining} more*\n`;
	}

	md += `\n---\n**Full report:** \`.vibe-check/report/index.html\` — per-category pages, every issue with file and line, architecture diagrams, file heatmap and trends. This summary is the headline only.\n`;
	md += `\n*vcqa v${report.version} · ${report.meta.duration}ms*\n`;
	return md;
}

function emitAnnotations(report: VibeReport): void {
	for (const c of report.checks) {
		for (const i of c.issues) {
			if (i.severity === "info") continue;
			const level = i.severity === "error" ? "error" : "warning";
			const file = i.file && typeof i.file === "string" ? i.file : "";
			const line = i.line || "";
			const loc = file ? ` file=${file}${line ? `,line=${line}` : ""}` : "";
			console.log(`::${level}${loc ? loc : ""}::${c.name}: ${i.message}`);
		}
	}
}

async function printResults(
	report: VibeReport,
	trend: ReturnType<typeof computeTrend>,
	flags: Pick<ParsedFlags, "jsonOnly" | "badgeMode" | "sarifMode" | "topN" | "ciMode">,
	outputDir: string,
	interactive: boolean,
): Promise<void> {
	const { score, grade, checks } = report;
	const totalIssues = checks.reduce((s, c) => s + c.issues.length, 0);

	if (flags.jsonOnly) {
		console.log(JSON.stringify(report));
	} else {
		const gc = color(grade);
		console.log("");
		console.log(
			`  ${gc}\x1b[1m${grade}\x1b[0m ${gc}${score}/100\x1b[0m  \x1b[2m${checks.length} checks · ${totalIssues} issues · ${report.meta.duration}ms\x1b[0m`,
		);
		if (trend) {
			const historyDir = join(outputDir, "history");
			const { loadHistory } = await import("./history.js");
			const history = loadHistory(historyDir);
			const scores = history.map((h) => h.score);
			if (report.score !== scores[scores.length - 1]) scores.push(report.score);
			console.log(formatTrend(trend, scores));
		}
		console.log("");

		const { getCheckMeta } = await import("./check-meta.js");
		const effectiveTopN = flags.topN > 0 ? flags.topN : interactive ? 3 : 0;
		if (effectiveTopN > 0) {
			const allIssues = checks.flatMap((c) => c.issues.map((iss) => ({ check: c.name, weight: getCheckMeta(c.name).weight, ...iss })));
			allIssues.sort((a, b) => {
				const sevOrder = { error: 0, warning: 1, info: 2 };
				const sevDiff = (sevOrder[a.severity] ?? 2) - (sevOrder[b.severity] ?? 2);
				if (sevDiff !== 0) return sevDiff;
				return b.weight - a.weight;
			});
			const top = allIssues.slice(0, effectiveTopN);
			if (top.length > 0) {
				const more = allIssues.length - top.length;
				const moreStr = more > 0 ? ` \x1b[2m(+${more} more)\x1b[0m` : "";
				console.log(`  \x1b[1mTop ${top.length} issues to fix:\x1b[0m${moreStr}`);
				for (const iss of top) {
					const sevColor = iss.severity === "error" ? "\x1b[31m" : iss.severity === "warning" ? "\x1b[33m" : "\x1b[2m";
					const sevChar = iss.severity[0]!.toUpperCase();
					const loc = iss.file && typeof iss.file === "string" ? `\x1b[2m${iss.file}${iss.line ? `:${iss.line}` : ""}\x1b[0m ` : "";
					console.log(`  ${sevColor}${sevChar}\x1b[0m ${loc}${iss.message}`);
				}
				console.log("");
			}
		}

		if (!flags.ciMode) {
			const weakest = checks
				.filter((c) => {
					const det = c.details as Record<string, unknown>;
					return !det.skipped && !det.comingSoon && c.score < 70;
				})
				.sort((a, b) => a.score - b.score)
				.slice(0, 3);
			if (weakest.length > 0) {
				console.log("  \x1b[1mWeakest areas:\x1b[0m");
				for (const c of weakest) {
					const gc2 = color(c.grade);
					const label = getCheckMeta(c.name).label || c.name;
					console.log(
						`  ${gc2}${c.grade}\x1b[0m \x1b[2m${String(c.score).padStart(3)}\x1b[0m  ${label.padEnd(18)}\x1b[2m→ vcqa explain ${c.name}\x1b[0m`,
					);
				}
				console.log("");
			}
		}

		console.log(`  \x1b[2mReport: ${join(outputDir, "report/index.html")}\x1b[0m`);
		console.log(`  \x1b[2mJSON:   ${join(outputDir, "report.json")}\x1b[0m`);
		if (flags.badgeMode) console.log(`  \x1b[2mBadge:  ${join(outputDir, "badge.svg")}\x1b[0m`);
		if (flags.sarifMode) console.log(`  \x1b[2mSARIF:  ${join(outputDir, "report.sarif")}\x1b[0m`);
		if (!interactive && !flags.ciMode) {
			console.log(`  \x1b[2mExplore: \x1b[0m\x1b[1mvcqa monitor\x1b[0m\x1b[2m — live TUI to drill into issues & copy fix-prompts\x1b[0m`);
		}
		console.log("");
	}
}

function getChangedFiles(cwd: string, base: string): Set<string> | null {
	try {
		const args = base === "HEAD" ? ["diff", "--name-only"] : ["diff", "--name-only", `${base}...HEAD`];
		const stdout = execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
		if (!stdout) return new Set();
		return new Set(stdout.split("\n").filter((f) => f.length > 0));
	} catch {
		return null;
	}
}

// ── Report output ──

async function writeOutputs(report: VibeReport, outputDir: string, flags: ParsedFlags, prevReport?: VibeReport): Promise<void> {
	mkdirSync(outputDir, { recursive: true });
	const normalizedReport = withFreshAnalyzerSnapshots(report);

	// Always write JSON
	writeFileSync(join(outputDir, "report.json"), JSON.stringify(normalizedReport, null, 2));

	// Save history
	const historyDir = join(outputDir, "history");
	mkdirSync(historyDir, { recursive: true });
	writeFileSync(join(historyDir, `${normalizedReport.timestamp}.json`), JSON.stringify(buildReportHistorySnapshot(normalizedReport)));
	const historyFiles = readdirSync(historyDir).sort();
	for (const old of historyFiles.slice(0, historyFiles.length - 30)) {
		try {
			unlinkSync(join(historyDir, old));
		} catch {
			/* ignore */
		}
	}

	// HTML report
	if (!flags.jsonOnly) {
		const reportDir = join(outputDir, "report");
		mkdirSync(reportDir, { recursive: true });
		const historyDir = join(outputDir, "history");
		const pages = generatePages(normalizedReport, historyDir, prevReport);
		for (const [filename, html] of pages) {
			writeFileSync(join(reportDir, filename), html);
		}
	}

	// Badge
	if (flags.badgeMode) {
		const { buildBadge } = await import("./report/svg.js");
		writeFileSync(join(outputDir, "badge.svg"), buildBadge(normalizedReport.score, normalizedReport.grade));
	}

	// SARIF
	if (flags.sarifMode) {
		const { generateSARIF } = await import("./report/sarif.js");
		writeFileSync(join(outputDir, "report.sarif"), generateSARIF(normalizedReport));
	}
}

// ── Upload ──

async function handleUpload(report: VibeReport, cwd: string, quietMode: boolean): Promise<void> {
	const token = process.env.VCQA_TOKEN || process.env.GITHUB_TOKEN;
	if (!token) {
		if (!quietMode) console.log("  \x1b[33m\u26a0 Set VCQA_TOKEN to enable upload\x1b[0m");
		return;
	}
	// buildReportUploadPayload owns the repo-slug rule and returns null when
	// there is no remote to attribute the report to. Deriving the slug a second
	// time here, just to explain the refusal, would be a second copy of it.
	const payload = buildReportUploadPayload(report, currentGitSha(cwd));
	if (!payload) {
		if (!quietMode) console.log("  \x1b[33m\u26a0 No git remote — can't upload\x1b[0m");
		return;
	}
	try {
		const res = await fetch("https://api.vibecodeqa.online/api/reports", {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
			body: JSON.stringify(payload),
		});
		if (res.ok) {
			const data = (await res.json()) as { totalReports?: number };
			if (!quietMode) console.log(`  \x1b[32m\u2713 Uploaded to dashboard\x1b[0m \x1b[2m(${data.totalReports || 1} reports)\x1b[0m`);
		} else if (!quietMode) {
			console.log(`  \x1b[33m\u26a0 Upload failed: ${res.status}\x1b[0m`);
		}
	} catch {
		if (!quietMode) console.log(`  \x1b[33m\u26a0 Upload failed (network error)\x1b[0m`);
	}
}

// ── Watch mode ──

async function startWatch(cwd: string): Promise<void> {
	const { watch } = await import("node:fs");
	const workspace = detectWorkspace(cwd);
	const watchDirs = workspace.isMonorepo
		? workspace.srcRoots.map((d) => join(cwd, d)).filter((d) => existsSync(d))
		: ["src", "web/src"].map((d) => join(cwd, d)).filter((d) => existsSync(d));
	if (watchDirs.length === 0) {
		console.log("  \x1b[31mNo src/ directory to watch\x1b[0m");
		process.exit(1);
	}

	console.log("  \x1b[2mWatching for changes... (Ctrl+C to stop)\x1b[0m\n");
	let debounce: ReturnType<typeof setTimeout> | null = null;
	let running = false;
	for (const dir of watchDirs) {
		watch(dir, { recursive: true }, (_event, filename) => {
			if (!filename || filename.includes("node_modules") || filename.includes(".vibe-check")) return;
			if (running) return;
			if (debounce) clearTimeout(debounce);
			debounce = setTimeout(async () => {
				running = true;
				try {
					console.log(`  \x1b[2mChanged: ${filename} — re-scanning...\x1b[0m`);
					await main().catch((err) => {
						console.error("scan error:", err);
					});
				} finally {
					running = false;
				}
			}, 500);
		});
	}
	await new Promise(() => {});
}

// ── Interactive prompt ──

function readKey(): Promise<string> {
	return new Promise((resolve) => {
		const stdin = process.stdin;
		const wasRaw = stdin.isRaw;
		stdin.setRawMode?.(true);
		stdin.resume();
		stdin.once("data", (buf) => {
			stdin.setRawMode?.(wasRaw ?? false);
			stdin.pause();
			resolve(buf.toString("utf-8"));
		});
	});
}

function openPath(target: string): void {
	const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
	import("node:child_process").then(({ spawn }) => {
		try {
			spawn(cmd, [target], { detached: true, stdio: "ignore", shell: process.platform === "win32" }).unref();
		} catch {
			/* best-effort */
		}
	});
}

async function promptNextAction(cwd: string, outputDir: string): Promise<void> {
	process.stdout.write(
		"  \x1b[1m[m]\x1b[0m\x1b[2m monitor\x1b[0m   \x1b[1m[o]\x1b[0m\x1b[2m open report\x1b[0m   \x1b[1m[f]\x1b[0m\x1b[2m fix --ai\x1b[0m   \x1b[1m[enter]\x1b[0m\x1b[2m quit\x1b[0m  ",
	);
	let key: string;
	try {
		key = await readKey();
	} catch {
		process.stdout.write("\n");
		return;
	}
	process.stdout.write("\n");
	const k = key.toLowerCase();
	if (k === "m") {
		const { startMonitor } = await import("./monitor.js");
		await startMonitor(cwd);
	} else if (k === "o") {
		const reportPath = join(outputDir, "report/index.html");
		openPath(reportPath);
		console.log(`  \x1b[2mOpening ${reportPath}\x1b[0m`);
	} else if (k === "f") {
		console.log("");
		await runFix(cwd, { ai: true });
	}
}

// ── Update check ──

async function checkForUpdate(currentVersion: string): Promise<void> {
	try {
		const res = await fetch("https://registry.npmjs.org/@vibecodeqa/cli/latest", { signal: AbortSignal.timeout(3000) });
		if (!res.ok) return;
		const data = (await res.json()) as { version?: string };
		const latest = data.version;
		if (!latest || latest === currentVersion) return;
		const cur = currentVersion.split(".").map(Number);
		const lat = latest.split(".").map(Number);
		const isNewer =
			lat[0] > cur[0] || (lat[0] === cur[0] && lat[1] > cur[1]) || (lat[0] === cur[0] && lat[1] === cur[1] && lat[2] > cur[2]);
		if (isNewer) {
			console.log(`  \x1b[33mUpdate available: ${currentVersion} → ${latest}\x1b[0m  Run \x1b[1mnpx @vibecodeqa/cli@latest\x1b[0m\n`);
		}
	} catch {
		/* network error — silently ignore */
	}
}

// ── Main ──

async function main() {
	const args = process.argv.slice(2);
	if (args.includes("--version") || args.includes("-v")) {
		console.log(VERSION);
		return;
	}
	if (args.includes("--help") || args.includes("-h")) {
		printHelp();
		return;
	}

	if (args[0] === "init") {
		await runInit(resolve(args.slice(1).find((a) => !a.startsWith("-")) || "."));
		return;
	}
	if (args[0] === "fix") {
		const fixArgs = args.slice(1);
		const path = fixArgs.find((a) => !a.startsWith("-")) || ".";
		const aiMode = fixArgs.includes("--ai");
		const dryRun = fixArgs.includes("--dry-run");
		const checkIdx = fixArgs.indexOf("--check");
		const checkFilter = checkIdx !== -1 ? fixArgs[checkIdx + 1] : undefined;
		await runFix(resolve(path), { ai: aiMode, dryRun, checkFilter });
		return;
	}
	if (args[0] === "explain") {
		await runExplain(args[1]);
		return;
	}
	if (args[0] === "monitor") {
		const { startMonitor } = await import("./monitor.js");
		await startMonitor(resolve(args.slice(1).find((a) => !a.startsWith("-")) || "."));
		return;
	}

	const flags = parseFlags();
	const { cwd, outputDir, jsonOnly, ciMode, skipTests, watchMode, diffBase } = flags;
	validateCwd(cwd);

	const config = loadConfig(cwd);
	const workspace = detectWorkspace(cwd);
	const stack = detectStack(cwd, workspace);
	const quietMode = jsonOnly || flags.markdownMode;
	if (!quietMode) printHeader(cwd, stack, workspace);

	// Run scan using core API with progress output
	const report = await scan(cwd, {
		skipTests,
		config,
		onProgress: quietMode
			? undefined
			: (check, result) => {
					const det = result.details as Record<string, unknown>;
					const premium = det.comingSoon;
					const skipped = det.skipped;
					const advisory = det.scoreMode === "available-unscored";
					const c = premium ? "\x1b[2m" : skipped ? "\x1b[2m" : color(result.grade);
					const label = premium ? "soon" : skipped ? "skip" : advisory ? "adv" : result.grade;
					const scoreStr = premium ? "PRO" : skipped ? "—" : advisory ? `${result.score}/100*` : `${result.score}/100`;
					const issueStr = result.issues.length > 0 ? `  \x1b[2m${result.issues.length} issues\x1b[0m` : "";
					console.log(`  ${check.padEnd(14)}${c}${label.padEnd(5)}${scoreStr}\x1b[0m  \x1b[2m${result.duration}ms\x1b[0m${issueStr}`);
				},
	});

	const { score, checks } = report;

	// --diff: filter issues to only changed files
	if (diffBase) {
		const changedFiles = getChangedFiles(cwd, diffBase);
		if (changedFiles) {
			for (const c of checks) {
				c.issues = c.issues.filter((i) => !i.file || changedFiles.has(i.file));
			}
		}
	}
	report.meta.analyzerSnapshots = withFreshAnalyzerSnapshots(report).meta.analyzerSnapshots;

	const trend = computeTrend(report, outputDir);

	// Load previous report BEFORE writeOutputs overwrites it (for delta in markdown/PR)
	let prevReport: VibeReport | undefined;
	const prevReportPath = join(outputDir, "report.json");
	if (existsSync(prevReportPath)) {
		try {
			prevReport = JSON.parse(readFileSync(prevReportPath, "utf-8"));
		} catch {
			/* corrupt */
		}
	}

	await writeOutputs(report, outputDir, flags, prevReport);

	const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY) && !quietMode && !ciMode && !watchMode;

	if (flags.markdownMode) {
		console.log(generateMarkdown(report, trend, prevReport));
	} else {
		await printResults(report, trend, flags, outputDir, interactive);
	}

	if (flags.annotations) emitAnnotations(report);
	if (flags.uploadMode) await handleUpload(report, cwd, quietMode);

	if (flags.prComment) {
		const posted = await postPRComment(report, trend, cwd, prevReport);
		if (!quietMode) {
			if (posted) console.log("  \x1b[32m\u2713 PR comment posted\x1b[0m");
			else console.log("  \x1b[2mNo PR detected or no GITHUB_TOKEN — skipping PR comment\x1b[0m");
		}
	}

	const failUnder = flags.failUnder ?? (ciMode ? 60 : (config.failUnder ?? 0));
	if (failUnder > 0 && score < failUnder && !watchMode) {
		if (!quietMode) console.log(`  \x1b[31mFailing: score ${score} < ${failUnder}\x1b[0m\n`);
		process.exit(1);
	}

	if (!quietMode && !ciMode && !watchMode && !process.env.VCQA_NO_UPDATE_CHECK) {
		checkForUpdate(VERSION).catch(() => {}); // ok — non-blocking, best-effort
	}

	if (watchMode) {
		await startWatch(cwd);
		return;
	}

	if (interactive && existsSync(join(cwd, ".git")) && !existsSync(join(cwd, ".github", "workflows", "vibecodeqa.yml"))) {
		console.log(`  \x1b[2mTip: Add CI scanning with one line:\x1b[0m  \x1b[1m- uses: vibecodeqa/action@v1\x1b[0m`);
		console.log("");
	}

	if (interactive && !flags.uploadMode && !flags.prComment) {
		await promptNextAction(cwd, outputDir);
	}
}

main().catch((err) => {
	console.error("vibe-check error:", err);
	process.exit(1);
});
