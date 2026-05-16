#!/usr/bin/env node
/** vibe-check — code health scanner for the AI coding era. */

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { detectRepoUrl, detectStack } from "./detect.js";
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
import type { CheckResult, VibeReport } from "./types.js";
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
}

function parseFlags(): ParsedFlags {
	const args = process.argv.slice(2);
	const flags = new Set(args.filter((a) => a.startsWith("--")));
	const cwd = resolve(args.find((a) => !a.startsWith("--")) || ".");
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
	};
}

function color(grade: string): string {
	if (grade === "A") return "\x1b[32m";
	if (grade === "B") return "\x1b[33m";
	return "\x1b[31m";
}

function runChecks(cwd: string, stack: ReturnType<typeof detectStack>, skipTests: boolean, isDart: boolean, jsonOnly: boolean): CheckResult[] {
	const runners: { name: string; fn: () => CheckResult }[] = [
		// Foundations
		{ name: "structure", fn: () => runStructure(cwd, stack) },
		{ name: "lint", fn: () => runLint(cwd, stack) },
		{ name: "types", fn: () => runTypeCheck(cwd, isDart) },
		{ name: "type-safety", fn: () => runTypeSafety(cwd, isDart) },
		{ name: "standards", fn: () => runStandards(cwd, stack) },
		// Quality
		{ name: "complexity", fn: () => runComplexity(cwd) },
		{ name: "duplication", fn: () => runDuplication(cwd) },
		{ name: "error-handling", fn: () => runErrorHandling(cwd, stack) },
		{ name: "react", fn: () => runReact(cwd, stack) },
		{ name: "accessibility", fn: () => runAccessibility(cwd) },
		{ name: "docs", fn: () => runDocs(cwd) },
		{ name: "best-practices", fn: () => runBestPractices(cwd) },
		// Testing
		{ name: "testing", fn: () => runTesting(cwd, stack, skipTests) },
		// Security
		{ name: "secrets", fn: () => runSecrets(cwd) },
		{ name: "security", fn: () => runSecurity(cwd) },
		{ name: "dependencies", fn: () => runDependencies(cwd, stack) },
		// Architecture
		{ name: "architecture", fn: () => runArchitecture(cwd) },
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
		const result = runner.fn();
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

function printResults(
	report: VibeReport,
	trend: ReturnType<typeof computeTrend>,
	flags: Pick<ParsedFlags, "jsonOnly" | "badgeMode" | "sarifMode">,
	outputDir: string,
): void {
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
		if (trend) console.log(formatTrend(trend));
		console.log("");
		console.log(`  \x1b[2mReport: ${join(outputDir, "report/index.html")}\x1b[0m`);
		console.log(`  \x1b[2mJSON:   ${join(outputDir, "report.json")}\x1b[0m`);
		if (flags.badgeMode) console.log(`  \x1b[2mBadge:  ${join(outputDir, "badge.svg")}\x1b[0m`);
		if (flags.sarifMode) console.log(`  \x1b[2mSARIF:  ${join(outputDir, "report.sarif")}\x1b[0m`);
		console.log("");
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
	const srcDirs = ["src", "web/src"].map((d) => join(cwd, d)).filter((d) => existsSync(d));
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
	const flags = parseFlags();
	const { cwd, outputDir, jsonOnly, ciMode, skipTests, watchMode } = flags;
	const start = Date.now();

	if (!jsonOnly) {
		console.log("");
		console.log(`  \x1b[1m\x1b[38;5;141mvcqa\x1b[0m v${VERSION}`);
		console.log(`  \x1b[2m${cwd}\x1b[0m`);
		console.log("");
	}

	const stack = detectStack(cwd);
	if (!jsonOnly) {
		const parts = [stack.language, stack.framework, stack.bundler, stack.testRunner, stack.linter, stack.packageManager].filter(
			(v) => v !== "none" && v !== "unknown",
		);
		console.log(`  stack: ${parts.join(" + ")}`);
		console.log("");
	}

	const isDart = stack.language === "dart";
	const checks = runChecks(cwd, stack, skipTests, isDart, jsonOnly);

	const score = computeScore(checks);
	const grade = gradeFromScore(score);
	const duration = Date.now() - start;

	const report: VibeReport = {
		version: VERSION,
		timestamp: new Date().toISOString(),
		score,
		grade,
		checks,
		meta: { cwd, node: process.version, duration, stack, ...detectRepoUrl(cwd) },
	};

	const trend = computeTrend(report, outputDir);

	await writeOutputs(report, outputDir, flags);
	printResults(report, trend, flags, outputDir);

	if (flags.uploadMode) {
		await handleUpload(report, cwd, jsonOnly);
	}

	if (ciMode && score < 60) {
		process.exit(1);
	}

	if (!jsonOnly && !ciMode && !watchMode) {
		try {
			const { execFileSync } = await import("node:child_process");
			const openCmd = process.platform === "darwin" ? "open" : "xdg-open";
			execFileSync(openCmd, [join(outputDir, "report/index.html")], { stdio: "ignore" });
		} catch {
			/* failed to open browser */
		}
	}

	if (watchMode) {
		await startWatch(cwd);
	}
}

main().catch((err) => {
	console.error("vibe-check error:", err);
	process.exit(1);
});
