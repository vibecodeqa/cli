#!/usr/bin/env node
/** vibe-check — code health scanner for the AI coding era. */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getCheckMeta } from "./check-meta.js";
import { detectRepoUrl, detectStack, detectWorkspace } from "./detect.js";
import { setGlobalSrcRoots } from "./fs-utils.js";
import { generatePages } from "./report/html.js";
import { runAccessibility } from "./runners/accessibility.js";
import { runArchitecture } from "./runners/architecture.js";
import { runBestPractices } from "./runners/best-practices.js";
import { runCodeCoherence } from "./runners/code-coherence.js";
import { runComplexity } from "./runners/complexity.js";
import { runConfusion } from "./runners/confusion.js";
import { runContext } from "./runners/context.js";
import { runDependencies } from "./runners/dependencies.js";
import { runDocCoherence } from "./runners/doc-coherence.js";
import { runDocs } from "./runners/docs.js";
import { runDuplication } from "./runners/duplication.js";
import { runErrorHandling } from "./runners/error-handling.js";
import { runLint } from "./runners/lint.js";
import { runPerformance } from "./runners/performance.js";
import { runReact } from "./runners/react.js";
import { runSecrets } from "./runners/secrets.js";
import { runSecurity } from "./runners/security.js";
import { runStandards } from "./runners/standards.js";
import { runStructure } from "./runners/structure.js";
import { runTesting } from "./runners/testing.js";
import { runTypeSafety } from "./runners/type-safety.js";
import { runTypeCheck } from "./runners/types-check.js";
import { computeScore } from "./score.js";
import { computeTrend, formatTrend } from "./trend.js";
import type { CheckResult, VibeReport, WorkspaceInfo } from "./types.js";
import { gradeFromScore } from "./types.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"));
const VERSION: string = pkg.version;

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
	topN: number; // 0 = don't show, N = show top N issues
	failUnder: number | null; // exit 1 if score < this, null = use --ci default
}

function parseFlags(): ParsedFlags {
	const args = process.argv.slice(2);
	const flags = new Set(args.filter((a) => a.startsWith("--")));
	// Parse flags with value arguments
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
			// Non-numeric value after flag — consume it to prevent misuse as cwd
			valueArgIndices.add(idx + 1);
		}
		return fallback ?? null;
	}

	const topN = parseValueFlag("--top", 5) ?? 0;
	const failUnder = parseValueFlag("--fail-under");

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
	};
}

function color(grade: string): string {
	if (grade === "A") return "\x1b[32m";
	if (grade === "B") return "\x1b[33m";
	return "\x1b[31m";
}

function runChecks(
	cwd: string,
	stack: ReturnType<typeof detectStack>,
	workspace: WorkspaceInfo,
	skipTests: boolean,
	isDart: boolean,
	jsonOnly: boolean,
): CheckResult[] {
	const srcRoots = workspace.isMonorepo ? workspace.srcRoots : undefined;
	const runners: { name: string; fn: () => CheckResult }[] = [
		// Foundations
		{ name: "structure", fn: () => runStructure(cwd, stack, workspace) },
		{ name: "lint", fn: () => runLint(cwd, stack, workspace) },
		{ name: "types", fn: () => runTypeCheck(cwd, isDart, workspace) },
		{ name: "type-safety", fn: () => runTypeSafety(cwd, isDart) },
		{ name: "standards", fn: () => runStandards(cwd, stack) },
		// Quality
		{ name: "complexity", fn: () => runComplexity(cwd) },
		{ name: "duplication", fn: () => runDuplication(cwd) },
		{ name: "error-handling", fn: () => runErrorHandling(cwd, stack) },
		{ name: "react", fn: () => runReact(cwd, stack) },
		{ name: "accessibility", fn: () => runAccessibility(cwd) },
		{ name: "docs", fn: () => runDocs(cwd) },
		{ name: "best-practices", fn: () => runBestPractices(cwd, workspace) },
		// Testing
		{ name: "testing", fn: () => runTesting(cwd, stack, skipTests, srcRoots) },
		// Security
		{ name: "secrets", fn: () => runSecrets(cwd) },
		{ name: "security", fn: () => runSecurity(cwd) },
		{ name: "dependencies", fn: () => runDependencies(cwd, stack) },
		// Architecture
		{ name: "architecture", fn: () => runArchitecture(cwd, workspace) },
		{ name: "performance", fn: () => runPerformance(cwd) },
		// LLM Readiness
		{ name: "confusion", fn: () => runConfusion(cwd) },
		{ name: "context", fn: () => runContext(cwd) },
		// AI Analysis (premium)
		{ name: "doc-coherence", fn: () => runDocCoherence(cwd) },
		{ name: "code-coherence", fn: () => runCodeCoherence(cwd) },
	];

	const checks: CheckResult[] = [];
	for (const runner of runners) {
		if (!jsonOnly) process.stdout.write(`  ${runner.name.padEnd(14)}`);
		let result: CheckResult;
		try {
			result = runner.fn();
		} catch (err) {
			// Runner crashed — record as errored, don't kill the scan
			result = {
				name: runner.name,
				score: 0,
				grade: "F",
				details: { skipped: true, reason: `runner error: ${err instanceof Error ? err.message : "unknown"}` },
				issues: [],
				duration: 0,
			};
		}
		checks.push(result);
		if (!jsonOnly) {
			const det = result.details as Record<string, unknown>;
			const skipped = det.skipped;
			const premium = det.comingSoon;
			const c = premium ? "\x1b[2m" : skipped ? "\x1b[2m" : color(result.grade);
			const label = premium ? "soon" : skipped ? "skip" : result.grade;
			const scoreStr = premium ? "PRO" : skipped ? "—" : `${result.score}/100`;
			const issueStr = result.issues.length > 0 ? `  \x1b[2m${result.issues.length} issues\x1b[0m` : "";
			console.log(`${c}${label.padEnd(5)}${scoreStr}\x1b[0m  \x1b[2m${result.duration}ms\x1b[0m${issueStr}`);
		}
	}
	return checks;
}

async function writeOutputs(report: VibeReport, outputDir: string, flags: Pick<ParsedFlags, "badgeMode" | "sarifMode">): Promise<void> {
	if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

	// Save to history before overwriting current report
	const historyDir = join(outputDir, "history");
	if (!existsSync(historyDir)) mkdirSync(historyDir, { recursive: true });
	const historyFile = join(historyDir, `${report.timestamp.replace(/[:.]/g, "-")}.json`);
	writeFileSync(historyFile, JSON.stringify(report, null, 2));

	// Keep only last 30 history entries
	const historyFiles = readdirSync(historyDir)
		.filter((f) => f.endsWith(".json"))
		.sort();
	if (historyFiles.length > 30) {
		for (const old of historyFiles.slice(0, historyFiles.length - 30)) {
			try {
				unlinkSync(join(historyDir, old));
			} catch {
				/* ignore */
			}
		}
	}

	writeFileSync(join(outputDir, "report.json"), JSON.stringify(report, null, 2));

	// Generate multi-page HTML report
	const reportDir = join(outputDir, "report");
	if (!existsSync(reportDir)) mkdirSync(reportDir, { recursive: true });
	const pages = generatePages(report, historyDir);
	for (const [filename, html] of pages) {
		writeFileSync(join(reportDir, filename), html);
	}

	// Badge SVG
	if (flags.badgeMode) {
		const { buildBadge } = await import("./report/svg.js");
		const badgeSvg = buildBadge(report.score, report.grade);
		writeFileSync(join(outputDir, "badge.svg"), badgeSvg);
	}

	// SARIF output for GitHub Code Scanning
	if (flags.sarifMode) {
		const { generateSARIF } = await import("./report/sarif.js");
		writeFileSync(join(outputDir, "report.sarif"), generateSARIF(report));
	}
}

async function printResults(
	report: VibeReport,
	trend: ReturnType<typeof computeTrend>,
	flags: Pick<ParsedFlags, "jsonOnly" | "badgeMode" | "sarifMode" | "topN">,
	outputDir: string,
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
			// Load history for sparkline
			const historyDir = join(outputDir, "history");
			const { loadHistory } = await import("./history.js");
			const history = loadHistory(historyDir);
			const scores = history.map((h) => h.score);
			if (report.score !== scores[scores.length - 1]) scores.push(report.score);
			console.log(formatTrend(trend, scores));
		}
		console.log("");
		console.log(`  \x1b[2mReport: ${join(outputDir, "report/index.html")}\x1b[0m`);
		console.log(`  \x1b[2mJSON:   ${join(outputDir, "report.json")}\x1b[0m`);
		if (flags.badgeMode) console.log(`  \x1b[2mBadge:  ${join(outputDir, "badge.svg")}\x1b[0m`);
		if (flags.sarifMode) console.log(`  \x1b[2mSARIF:  ${join(outputDir, "report.sarif")}\x1b[0m`);
		console.log("");

		// Top actionable issues
		if (flags.topN > 0) {
			const allIssues = checks.flatMap((c) =>
				c.issues.map((iss) => ({ check: c.name, weight: getCheckMeta(c.name).weight, ...iss })),
			);
			// Sort by: errors first, then by check weight (highest-impact first)
			allIssues.sort((a, b) => {
				const sevOrder = { error: 0, warning: 1, info: 2 };
				const sevDiff = (sevOrder[a.severity] ?? 2) - (sevOrder[b.severity] ?? 2);
				if (sevDiff !== 0) return sevDiff;
				return b.weight - a.weight;
			});
			const top = allIssues.slice(0, flags.topN);
			if (top.length > 0) {
				console.log(`  \x1b[1mTop ${top.length} issues to fix:\x1b[0m`);
				for (const iss of top) {
					const sevColor = iss.severity === "error" ? "\x1b[31m" : iss.severity === "warning" ? "\x1b[33m" : "\x1b[2m";
					const sevChar = iss.severity[0]!.toUpperCase();
					const loc = iss.file && typeof iss.file === "string"
						? `\x1b[2m${iss.file}${iss.line ? `:${iss.line}` : ""}\x1b[0m `
						: "";
					console.log(`  ${sevColor}${sevChar}\x1b[0m ${loc}${iss.message}`);
				}
				console.log("");
			}
		}
	}
}

async function handleUpload(report: VibeReport, cwd: string, jsonOnly: boolean): Promise<void> {
	const repo = report.meta.repoUrl?.replace(/^https:\/\/github\.com\//, "") || cwd.split("/").pop() || "project";
	const token = process.env.VCQA_TOKEN || "";
	try {
		const res = await fetch("https://api.vibecodeqa.online/api/reports", {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
			body: JSON.stringify({ repo, report }),
		});
		if (res.ok) {
			const data = (await res.json()) as { totalReports?: number };
			if (!jsonOnly) console.log(`  \x1b[32m\u2713 Uploaded to dashboard\x1b[0m \x1b[2m(${data.totalReports || 1} reports)\x1b[0m`);
		} else if (!jsonOnly) {
			console.log(`  \x1b[33m\u26a0 Upload failed: ${res.status}\x1b[0m \x1b[2m(set VCQA_TOKEN env var)\x1b[0m`);
		}
	} catch {
		if (!jsonOnly) console.log(`  \x1b[33m\u26a0 Upload failed (network error)\x1b[0m`);
	}
}

async function startWatch(cwd: string): Promise<void> {
	const { watch } = await import("node:fs");
	const workspace = detectWorkspace(cwd);
	const watchDirs = workspace.isMonorepo
		? workspace.srcRoots.map((d) => join(cwd, d)).filter((d) => existsSync(d))
		: ["src", "web/src"].map((d) => join(cwd, d)).filter((d) => existsSync(d));
	const srcDirs = watchDirs;
	if (srcDirs.length === 0) {
		console.log("  \x1b[31mNo src/ directory to watch\x1b[0m");
		process.exit(1);
	}

	console.log("  \x1b[2mWatching for changes... (Ctrl+C to stop)\x1b[0m");
	console.log("");

	let debounce: ReturnType<typeof setTimeout> | null = null;
	let running = false;
	for (const dir of srcDirs) {
		watch(dir, { recursive: true }, (_event, filename) => {
			if (!filename || filename.includes("node_modules") || filename.includes(".vibe-check")) return;
			if (running) return;
			if (debounce) clearTimeout(debounce);
			debounce = setTimeout(async () => {
				running = true;
				console.log(`  \x1b[2mChanged: ${filename} — re-scanning...\x1b[0m`);
				await main().catch(() => {});
				running = false;
			}, 500);
		});
	}

	// Keep process alive
	await new Promise(() => {});
}

async function main() {
	const args = process.argv.slice(2);

	if (args.includes("--version") || args.includes("-v")) {
		console.log(VERSION);
		return;
	}

	if (args.includes("--help") || args.includes("-h")) {
		console.log(`
  \x1b[1m\x1b[38;5;141mvcqa\x1b[0m v${VERSION} — code health scanner

  \x1b[1mUsage:\x1b[0m  npx @vibecodeqa/cli [path] [flags]

  \x1b[1mFlags:\x1b[0m
    --skip-tests      Skip test execution (faster scan)
    --ci              CI mode (exit 1 if score < 60)
    --fail-under N    Exit 1 if score below N (e.g. --fail-under 80)
    --json            Output JSON only (no terminal UI)
    --badge           Generate SVG badge
    --sarif           Generate SARIF for GitHub Code Scanning
    --upload          Upload report to app.vibecodeqa.online
    --top [N]         Show top N issues to fix (default: 5)
    --watch           Re-scan on file changes
    -v, --version     Print version
    -h, --help        Show this help

  \x1b[1mExamples:\x1b[0m
    npx @vibecodeqa/cli                     # scan current directory
    npx @vibecodeqa/cli ./my-project        # scan specific path
    npx @vibecodeqa/cli --skip-tests --top  # fast scan with top issues
    npx @vibecodeqa/cli --ci --sarif        # CI with GitHub integration
`);
		return;
	}

	const flags = parseFlags();
	const { cwd, outputDir, jsonOnly, ciMode, skipTests, watchMode } = flags;
	const start = Date.now();

	// Validate cwd
	if (!existsSync(cwd)) {
		console.error(`  \x1b[31mError: path does not exist: ${cwd}\x1b[0m`);
		process.exit(1);
	}
	try {
		if (!statSync(cwd).isDirectory()) {
			console.error(`  \x1b[31mError: not a directory: ${cwd}\x1b[0m`);
			process.exit(1);
		}
	} catch {
		console.error(`  \x1b[31mError: cannot access: ${cwd}\x1b[0m`);
		process.exit(1);
	}

	if (!jsonOnly) {
		console.log("");
		console.log(`  \x1b[1m\x1b[38;5;141mvcqa\x1b[0m v${VERSION}`);
		console.log(`  \x1b[2m${cwd}\x1b[0m`);
		console.log("");
	}

	const stack = detectStack(cwd);
	const workspace = detectWorkspace(cwd);
	setGlobalSrcRoots(workspace.isMonorepo ? workspace.srcRoots : undefined);
	if (!jsonOnly) {
		const parts = [stack.language, stack.framework, stack.bundler, stack.testRunner, stack.linter, stack.packageManager].filter(
			(v) => v !== "none" && v !== "unknown",
		);
		console.log(`  stack: ${parts.join(" + ")}`);
		if (workspace.isMonorepo) {
			console.log(`  workspace: ${workspace.tool} monorepo — ${workspace.packages.length} packages`);
			for (const pkg of workspace.packages.slice(0, 8)) {
				const flags = [pkg.hasSrc && "src", pkg.hasTests && "tests", pkg.hasLinter && "linter"].filter(Boolean).join(", ");
				console.log(`    \x1b[2m${pkg.path}\x1b[0m (${flags || "empty"})`);
			}
			if (workspace.packages.length > 8) console.log(`    \x1b[2m...and ${workspace.packages.length - 8} more\x1b[0m`);
		}
		console.log("");
	}

	const isDart = stack.language === "dart";
	const checks = runChecks(cwd, stack, workspace, skipTests, isDart, jsonOnly);

	const score = computeScore(checks);
	const grade = gradeFromScore(score);
	const duration = Date.now() - start;

	const report: VibeReport = {
		version: VERSION,
		timestamp: new Date().toISOString(),
		score,
		grade,
		checks,
		meta: { cwd, node: process.version, duration, stack, workspace, ...detectRepoUrl(cwd) },
	};

	const trend = computeTrend(report, outputDir);

	await writeOutputs(report, outputDir, flags);
	await printResults(report, trend, flags, outputDir);

	if (flags.uploadMode) {
		await handleUpload(report, cwd, jsonOnly);
	}

	// CI exit code: fail if score below threshold
	const failUnder = flags.failUnder ?? (ciMode ? 60 : 0);
	if (failUnder > 0 && score < failUnder) {
		if (!jsonOnly) console.log(`  \x1b[31mFailing: score ${score} < ${failUnder}\x1b[0m\n`);
		process.exit(1);
	}

	if (watchMode) {
		await startWatch(cwd);
	}
}

main().catch((err) => {
	console.error("vibe-check error:", err);
	process.exit(1);
});
