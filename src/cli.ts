#!/usr/bin/env node
/** vibe-check — code health scanner for the AI coding era. */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { aiFixIssues, collectFixableIssues } from "./ai-fix.js";
import { getCheckMeta } from "./check-meta.js";
import { getCheckIgnore, isCheckEnabled, loadConfig, type VcqaConfig } from "./config.js";
import { detectRepoUrl, detectStack, detectWorkspace } from "./detect.js";
import { setGlobalIgnore, setGlobalSrcRoots } from "./fs-utils.js";
import { postPRComment } from "./pr-comment.js";
import { generatePages } from "./report/html.js";
import { runAccessibility } from "./runners/accessibility.js";
import { runArchitecture } from "./runners/architecture.js";
import { runBestPractices } from "./runners/best-practices.js";
import { runCodeCoherence } from "./runners/code-coherence.js";
import { runCommentStaleness } from "./runners/comment-staleness.js";
import { runComplexity } from "./runners/complexity.js";
import { runDeadPatterns } from "./runners/dead-patterns.js";
import { runTestAudit } from "./runners/test-audit.js";
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
import { computeTrend, formatTrend, type TrendDelta } from "./trend.js";
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
	diffBase: string | null; // --diff [base] — only report issues in changed files
	prComment: boolean; // --pr-comment — post score as GitHub PR comment
	markdownMode: boolean; // --markdown — output markdown summary
	annotations: boolean; // --annotations — GitHub Actions ::warning annotations
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

	// --diff [base] — only show issues in changed files
	let diffBase: string | null = null;
	const diffIdx = args.indexOf("--diff");
	if (diffIdx !== -1) {
		const next = args[diffIdx + 1];
		if (next && !next.startsWith("--") && !next.startsWith("/") && !next.startsWith(".")) {
			diffBase = next;
			valueArgIndices.add(diffIdx + 1);
		} else {
			diffBase = "HEAD"; // default: uncommitted changes
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

function color(grade: string): string {
	if (grade === "A") return "\x1b[32m";
	if (grade === "B") return "\x1b[33m";
	return "\x1b[31m";
}

async function runChecks(
	cwd: string,
	stack: ReturnType<typeof detectStack>,
	workspace: WorkspaceInfo,
	skipTests: boolean,
	isDart: boolean,
	jsonOnly: boolean,
	config?: VcqaConfig,
): Promise<CheckResult[]> {
	const srcRoots = workspace.isMonorepo ? workspace.srcRoots : undefined;
	const runners: { name: string; fn: () => CheckResult | Promise<CheckResult> }[] = [
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
		{ name: "comment-staleness", fn: () => runCommentStaleness(cwd) },
		{ name: "dead-patterns", fn: () => runDeadPatterns(cwd) },
		{ name: "test-audit", fn: () => runTestAudit(cwd) },
	];

	const checks: CheckResult[] = [];
	for (const runner of runners) {
		// Skip checks disabled in config
		if (config && !isCheckEnabled(config, runner.name)) {
			checks.push({
				name: runner.name,
				score: 0,
				grade: "F",
				details: { skipped: true, reason: "disabled in config" },
				issues: [],
				duration: 0,
			});
			if (!jsonOnly) console.log(`  ${runner.name.padEnd(14)}\x1b[2mskip — disabled\x1b[0m`);
			continue;
		}
		if (!jsonOnly) process.stdout.write(`  ${runner.name.padEnd(14)}`);
		let result: CheckResult;
		try {
			const maybeResult = runner.fn();
			result = maybeResult instanceof Promise ? await maybeResult : maybeResult;
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
			// Load history for sparkline
			const historyDir = join(outputDir, "history");
			const { loadHistory } = await import("./history.js");
			const history = loadHistory(historyDir);
			const scores = history.map((h) => h.score);
			if (report.score !== scores[scores.length - 1]) scores.push(report.score);
			console.log(formatTrend(trend, scores));
		}
		console.log("");

		// Top actionable issues. Explicit --top wins; otherwise show a few by default
		// in an interactive terminal so the scan never dead-ends at a file path.
		const effectiveTopN = flags.topN > 0 ? flags.topN : interactive ? 3 : 0;
		if (effectiveTopN > 0) {
			const allIssues = checks.flatMap((c) => c.issues.map((iss) => ({ check: c.name, weight: getCheckMeta(c.name).weight, ...iss })));
			// Sort by: errors first, then by check weight (highest-impact first)
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

		// Next steps: surface the weakest scored dimensions and how to dig into each.
		// Skipped in CI (clean machine-readable-ish output) — interactive runs get the on-ramp.
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
					const gc = color(c.grade);
					const label = getCheckMeta(c.name).label || c.name;
					console.log(
						`  ${gc}${c.grade}\x1b[0m \x1b[2m${String(c.score).padStart(3)}\x1b[0m  ${label.padEnd(18)}\x1b[2m→ vcqa explain ${c.name}\x1b[0m`,
					);
				}
				console.log("");
			}
		}

		// Report paths + the interactive on-ramp.
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

async function handleUpload(report: VibeReport, cwd: string, jsonOnly: boolean): Promise<void> {
	const repo = report.meta.repoUrl?.replace(/^https:\/\/github\.com\//, "") || cwd.split("/").pop() || "project";
	const token = process.env.VCQA_TOKEN || "";
	// Get current commit SHA for quality gate status
	let sha: string | undefined;
	try {
		const { execSync } = await import("node:child_process");
		sha = execSync("git rev-parse HEAD", { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
	} catch {
		/* not a git repo */
	}
	try {
		const res = await fetch("https://api.vibecodeqa.online/api/reports", {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
			body: JSON.stringify({ repo, report, sha }),
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
				try {
					console.log(`  \x1b[2mChanged: ${filename} — re-scanning...\x1b[0m`);
					await main().catch(() => {});
				} finally {
					running = false;
				}
			}, 500);
		});
	}

	// Keep process alive
	await new Promise(() => {});
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

// ── init command ──

async function runInit(cwd: string): Promise<void> {
	console.log("");
	console.log(`  \x1b[1m\x1b[38;5;141mvcqa init\x1b[0m`);
	console.log(`  \x1b[2m${cwd}\x1b[0m`);
	console.log("");

	validateCwd(cwd);

	const stack = detectStack(cwd);
	let created = 0;

	// 1. GitHub Actions workflow
	const workflowDir = join(cwd, ".github", "workflows");
	const workflowPath = join(workflowDir, "vibecodeqa.yml");
	if (!existsSync(workflowPath)) {
		try {
			mkdirSync(workflowDir, { recursive: true });
			writeFileSync(
				workflowPath,
				`name: VibeCode QA
on: [pull_request]
permissions: { contents: read }
jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npx @vibecodeqa/cli --ci --fail-under 70 --sarif --badge
      - uses: github/codeql-action/upload-sarif@v3
        if: always()
        with:
          sarif_file: .vibe-check/report.sarif
`,
			);
			console.log(`  \x1b[32m+\x1b[0m .github/workflows/vibecodeqa.yml`);
			created++;
		} catch {
			console.log(`  \x1b[31m!\x1b[0m .github/workflows/vibecodeqa.yml (write failed — check permissions)`);
		}
	} else {
		console.log(`  \x1b[2m=\x1b[0m .github/workflows/vibecodeqa.yml (exists)`);
	}

	// 2. Biome config (if biome is a dep but no config exists)
	if (
		(stack.linter === "biome" || existsSync(join(cwd, "node_modules", "@biomejs", "biome"))) &&
		!existsSync(join(cwd, "biome.json")) &&
		!existsSync(join(cwd, "biome.jsonc"))
	) {
		writeFileSync(
			join(cwd, "biome.json"),
			JSON.stringify(
				{
					$schema: "https://biomejs.dev/schemas/2.0.0/schema.json",
					formatter: { indentStyle: "tab", lineWidth: 120 },
					linter: { enabled: true, rules: { recommended: true } },
					organizeImports: { enabled: true },
				},
				null,
				"\t",
			) + "\n",
		);
		console.log(`  \x1b[32m+\x1b[0m biome.json`);
		created++;
	}

	// 3. Create .vcqa.json if not present
	const vcqaConfigPath = join(cwd, ".vcqa.json");
	if (!existsSync(vcqaConfigPath)) {
		const allCheckNames = [
			"structure", "lint", "types", "type-safety", "standards",
			"complexity", "duplication", "error-handling", "react", "accessibility",
			"docs", "best-practices", "testing",
			"secrets", "security", "dependencies",
			"architecture", "performance",
			"confusion", "context",
			"doc-coherence", "code-coherence", "comment-staleness", "dead-patterns", "test-audit",
		];
		const checksConfig: Record<string, Record<string, unknown>> = {};
		for (const name of allCheckNames) {
			checksConfig[name] = {};
		}
		const config = {
			_comment: "vcqa config — docs: https://vibecodeqa.online/skills",
			checks: checksConfig,
			_checks_help: "Set { \"enabled\": false } to disable. Add \"ignore\": [\"generated/**\"] to skip files per-check.",
			ignore: [],
			_ignore_help: "Global file patterns to skip: [\"vendor/**\", \"*.generated.ts\", \"proto/**\"]",
			failUnder: 60,
			_failUnder_help: "Exit with code 1 if score below this. Overridden by --fail-under flag.",
		};
		writeFileSync(vcqaConfigPath, JSON.stringify(config, null, 2) + "\n");
		console.log(`  \x1b[32m+\x1b[0m .vcqa.json`);
		created++;
	}

	// 4. Add .vibe-check to .gitignore
	const gitignorePath = join(cwd, ".gitignore");
	if (existsSync(gitignorePath)) {
		const content = readFileSync(gitignorePath, "utf-8");
		if (!content.includes(".vibe-check")) {
			writeFileSync(gitignorePath, content.trimEnd() + "\n.vibe-check/\n");
			console.log(`  \x1b[32m+\x1b[0m .gitignore (added .vibe-check/)`);
			created++;
		}
	}

	console.log("");
	if (created > 0) {
		console.log(`  \x1b[32mCreated ${created} file(s).\x1b[0m Run \x1b[1mnpx @vibecodeqa/cli\x1b[0m to scan.`);
	} else {
		console.log(`  \x1b[2mAlready set up. Run npx @vibecodeqa/cli to scan.\x1b[0m`);
	}
	console.log("");
}

// ── explain command ──

async function runExplain(checkName?: string): Promise<void> {
	if (!checkName) {
		console.log("\n  \x1b[1mUsage:\x1b[0m vcqa explain <check>\n");
		console.log("  Available checks:");
		const { CHECK_META } = await import("./check-meta.js");
		for (const [name, meta] of Object.entries(CHECK_META)) {
			console.log(`    \x1b[1m${name.padEnd(16)}\x1b[0m ${meta.label} (${meta.category}, ${meta.weight}%)`);
		}
		console.log("");
		return;
	}
	const meta = getCheckMeta(checkName);
	if (!meta.description || meta.description.length < 20) {
		console.log(`\n  \x1b[31mUnknown check: ${checkName}\x1b[0m`);
		console.log("  Run \x1b[1mvcqa explain\x1b[0m to see available checks.\n");
		return;
	}
	console.log("");
	console.log(
		`  \x1b[1m\x1b[38;5;141m${meta.label}\x1b[0m  \x1b[2m${meta.category} · ${meta.priority} priority · ${meta.weight}% weight\x1b[0m`,
	);
	console.log("");
	console.log(`  \x1b[1mWhat:\x1b[0m ${meta.description}`);
	console.log("");
	console.log(`  \x1b[1mRisk:\x1b[0m ${meta.risk}`);
	console.log("");
	console.log(`  \x1b[1mFix:\x1b[0m ${meta.recommendation}`);
	if (meta.deeperTools?.length) {
		console.log("");
		console.log(`  \x1b[1mGo deeper:\x1b[0m ${meta.deeperTools.join(", ")}`);
	}
	console.log("");
}

// ── fix command ──

async function runFix(cwd: string, opts: { ai?: boolean; dryRun?: boolean; checkFilter?: string } = {}): Promise<void> {
	console.log("");
	console.log(`  \x1b[1m\x1b[38;5;141mvcqa fix${opts.ai ? " --ai" : ""}${opts.dryRun ? " --dry-run" : ""}${opts.checkFilter ? ` --check ${opts.checkFilter}` : ""}\x1b[0m`);
	console.log(`  \x1b[2m${cwd}\x1b[0m`);
	console.log("");

	validateCwd(cwd);

	const stack = detectStack(cwd);
	let fixed = 0;

	// 0. Auto-fix structure issues (missing files)
	if (!existsSync(join(cwd, ".gitignore"))) {
		writeFileSync(join(cwd, ".gitignore"), "node_modules\ndist\n.vibe-check\ncoverage\n.env\n.env.local\n");
		console.log("  \x1b[32m\u2713 Created .gitignore\x1b[0m");
		fixed++;
	}

	// Add .vibe-check to existing .gitignore if missing
	if (existsSync(join(cwd, ".gitignore"))) {
		const gi = readFileSync(join(cwd, ".gitignore"), "utf-8");
		if (!gi.includes(".vibe-check")) {
			writeFileSync(join(cwd, ".gitignore"), gi.trimEnd() + "\n.vibe-check/\n");
			console.log("  \x1b[32m\u2713 Added .vibe-check/ to .gitignore\x1b[0m");
			fixed++;
		}
	}

	// Enable strict mode if tsconfig exists without it
	const tsconfigPath = join(cwd, "tsconfig.json");
	if (existsSync(tsconfigPath)) {
		try {
			const raw = readFileSync(tsconfigPath, "utf-8");
			const tsconfig = JSON.parse(raw);
			if (!tsconfig.compilerOptions?.strict) {
				tsconfig.compilerOptions = { ...tsconfig.compilerOptions, strict: true };
				writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2) + "\n");
				console.log('  \x1b[32m\u2713 Enabled "strict": true in tsconfig.json\x1b[0m');
				fixed++;
			}
		} catch {
			/* can't parse tsconfig */
		}
	}

	// 1. Run biome format (auto-fixable lint + format issues)
	if (stack.linter === "biome") {
		console.log("  \x1b[1mFormatting with Biome...\x1b[0m");
		const { execSync } = await import("node:child_process");
		try {
			execSync("npx biome check --write .", { cwd, stdio: "inherit", timeout: 30_000 });
			fixed++;
		} catch {
			console.log("  \x1b[33mBiome had issues (some may be unfixable)\x1b[0m");
		}
	} else if (stack.linter === "eslint") {
		console.log("  \x1b[1mFixing with ESLint...\x1b[0m");
		const { execSync } = await import("node:child_process");
		try {
			execSync("npx eslint --fix src/", { cwd, stdio: "inherit", timeout: 30_000 });
			fixed++;
		} catch {
			console.log("  \x1b[33mESLint had issues (some may be unfixable)\x1b[0m");
		}
	}

	// 2. Scan to find remaining issues and generate fix suggestions
	console.log("");
	console.log("  \x1b[1mScanning for remaining issues...\x1b[0m");
	console.log("");

	const workspace = detectWorkspace(cwd);
	setGlobalSrcRoots(workspace.isMonorepo ? workspace.srcRoots : undefined);
	const enrichedStack = detectStack(cwd, workspace);
	const isDart = enrichedStack.language === "dart";
	const checks = await runChecks(cwd, enrichedStack, workspace, true, isDart, true);
	const score = computeScore(checks);

	// AI-powered fix mode
	if (opts.ai) {
		const aiIssues = collectFixableIssues(checks, suggestFix, opts.checkFilter);
		if (aiIssues.length === 0) {
			console.log("  \x1b[2mNo fixable issues found.\x1b[0m");
		} else {
			console.log(`  \x1b[1mAI fixing ${Math.min(aiIssues.length, 10)} issues${opts.dryRun ? " (dry run)" : ""}...\x1b[0m`);
			console.log("");
			const results = await aiFixIssues(cwd, aiIssues, { dryRun: opts.dryRun || false });
			const applied = results.filter((r) => r.applied).length;

			if (applied > 0) {
				// Re-scan to show new score
				console.log("");
				console.log("  \x1b[1mRe-scanning...\x1b[0m");
				const reChecks = await runChecks(cwd, enrichedStack, workspace, true, isDart, true);
				const newScore = computeScore(reChecks);
				const newGrade = gradeFromScore(newScore);
				const delta = newScore - score;
				console.log(`  Score: \x1b[${newScore >= 75 ? "32" : newScore >= 60 ? "33" : "31"}m${newGrade} ${newScore}/100\x1b[0m${delta > 0 ? ` \x1b[32m(+${delta})\x1b[0m` : ""}`);
				console.log(`  \x1b[32m${applied} AI fix(es) applied.\x1b[0m Re-run \x1b[1mnpx @vibecodeqa/cli\x1b[0m for full report.`);
			} else {
				const grade = gradeFromScore(score);
				console.log(`\n  Score: \x1b[${score >= 75 ? "32" : score >= 60 ? "33" : "31"}m${grade} ${score}/100\x1b[0m`);
				if (opts.dryRun) console.log("  \x1b[2mDry run — no files modified. Remove --dry-run to apply.\x1b[0m");
			}
		}
		console.log("");
		return;
	}

	// Collect actionable issues with fix suggestions (non-AI mode)
	const fixable: { check: string; file: string; line: number; message: string; fix: string }[] = [];

	for (const c of checks) {
		for (const iss of c.issues) {
			if (!iss.file || typeof iss.file !== "string" || !iss.line) continue;
			const fix = suggestFix(c.name, iss.rule || "", iss.message);
			if (fix) fixable.push({ check: c.name, file: iss.file, line: iss.line, message: iss.message, fix });
		}
	}

	// Print top fixable issues
	const top = fixable.slice(0, 10);
	if (top.length > 0) {
		console.log(`  \x1b[1m${top.length} issues with fix suggestions:\x1b[0m`);
		console.log("");
		for (const f of top) {
			console.log(`  \x1b[2m${f.file}:${f.line}\x1b[0m`);
			console.log(`  ${f.message}`);
			console.log(`  \x1b[32mFix: ${f.fix}\x1b[0m`);
			console.log("");
		}
	}

	const grade = gradeFromScore(score);
	console.log(`  Score after fix: \x1b[${score >= 75 ? "32" : score >= 60 ? "33" : "31"}m${grade} ${score}/100\x1b[0m`);
	if (fixed > 0) console.log(`  \x1b[32m${fixed} auto-fix(es) applied.\x1b[0m Re-run \x1b[1mnpx @vibecodeqa/cli\x1b[0m for full report.`);
	console.log("");
}

function suggestFix(check: string, rule: string, message: string): string | null {
	// Map common issues to actionable fixes
	if (rule === "empty-catch") return "Add error logging: catch(e) { console.error(e); }";
	if (rule === "throw-string") return 'Replace throw "msg" with throw new Error("msg")';
	if (rule === "swallowed-promise") return "Add logging: .catch((e) => { console.error(e); })";
	if (rule === "floating-promise") return "Add await or .catch() to handle the promise";
	if (rule === "unsafe-json-parse") return "Wrap in try-catch: try { JSON.parse(x) } catch { /* handle */ }";
	if (rule === "no-error-boundary") return "Add <ErrorBoundary> wrapper in your React app root";
	if (rule === "img-alt") return 'Add alt attribute: <img alt="description" ...>';
	if (rule === "click-events") return 'Add role="button" and onKeyDown handler';
	if (rule === "vue-v-for-key") return 'Add :key="item.id" to the v-for element';
	if (rule === "missing-key") return "Add key={item.id} to the JSX element in .map()";
	if (rule === "index-key") return "Use a stable unique ID instead of array index for key";
	if (rule === "conditional-hook") return "Move the hook call before any conditional (if/switch)";
	if (rule === "no-tests") return "Create a test file: src/__tests__/example.test.ts";
	if (rule === "no-readme") return "Create README.md with: project description, install, usage";
	if (rule === "no-changelog") return "Create CHANGELOG.md or use changesets: npx changeset init";
	if (rule === "env-not-ignored") return "Add .env to .gitignore";
	if (rule === "secret-detected") return "Move to environment variable, rotate the exposed secret";
	if (rule === "no-ci") return "Run: npx @vibecodeqa/cli init";
	if (rule === "missing-lockfile") return "Run: pnpm install (or npm install) to generate lockfile";
	if (rule === "missing-file" && message.includes("LICENSE")) return "Add LICENSE file: https://choosealicense.com/";
	if (rule === "long-function") return "Extract logic into smaller helper functions";
	if (rule === "high-complexity") return "Reduce nesting: use early returns, extract conditions";
	if (rule === "duplicate-code") return "Extract shared logic into a helper function";
	if (rule === "circular-dep") return "Extract shared types to a separate file both modules import";
	if (rule === "god-module") return "Split into focused interfaces — one responsibility per module";
	if (rule === "process-exit") return "Replace process.exit() with throw new Error()";
	if (check === "security" && message.includes("innerHTML")) return "Use textContent or DOM APIs instead";
	if (check === "security" && message.includes("ev" + "al")) return `Remove ${"ev" + "al"}() — use a safer alternative`;
	if (check === "security" && message.includes("v-html")) return 'Sanitize with DOMPurify: v-html="DOMPurify.sanitize(input)"';
	return null;
}

function validateCwd(cwd: string): void {
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
}

function generateMarkdown(report: VibeReport, trend: TrendDelta | null): string {
	const { score, grade, checks } = report;
	const gradeEmoji = grade === "A" ? "🟢" : grade === "B" ? "🟡" : grade === "C" ? "🟠" : "🔴";
	let md = `# ${gradeEmoji} VibeCode QA: ${grade} ${score}/100\n\n`;

	if (trend) {
		const arrow = trend.scoreDelta > 0 ? "📈" : trend.scoreDelta < 0 ? "📉" : "➡️";
		md += `${arrow} **${trend.scoreDelta > 0 ? "+" : ""}${trend.scoreDelta}** vs previous`;
		if (trend.fixedIssues > 0) md += ` · ${trend.fixedIssues} fixed`;
		if (trend.newIssues > 0) md += ` · ${trend.newIssues} new`;
		md += "\n\n";
	}

	md += "| Check | Score | Grade |\n|-------|-------|-------|\n";
	for (const c of checks) {
		const det = c.details as Record<string, unknown>;
		if (det.skipped || det.comingSoon) continue;
		const emoji = c.score >= 90 ? "🟢" : c.score >= 75 ? "🟡" : c.score >= 60 ? "🟠" : "🔴";
		md += `| ${emoji} ${c.name} | ${c.score}/100 | ${c.grade} |\n`;
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

	md += `\n---\n*vcqa v${report.version} · ${report.meta.duration}ms*\n`;
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
			// GitHub Actions annotation format
			console.log(`::${level}${loc ? loc : ""}::${c.name}: ${i.message}`);
		}
	}
}

/** Get changed files from git diff. Returns null if git unavailable. */
function getChangedFiles(cwd: string, base: string): Set<string> | null {
	try {
		const { execSync } = require("node:child_process") as typeof import("node:child_process");
		const cmd = base === "HEAD" ? "git diff --name-only" : `git diff --name-only ${base}...HEAD`;
		const stdout = execSync(cmd, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
		if (!stdout) return new Set();
		return new Set(stdout.split("\n").filter((f) => f.length > 0));
	} catch {
		return null;
	}
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
		for (const pkg of workspace.packages.slice(0, 8)) {
			const f = [pkg.hasSrc && "src", pkg.hasTests && "tests", pkg.hasLinter && "linter"].filter(Boolean).join(", ");
			console.log(`    \x1b[2m${pkg.path}\x1b[0m (${f || "empty"})`);
		}
		if (workspace.packages.length > 8) console.log(`    \x1b[2m...and ${workspace.packages.length - 8} more\x1b[0m`);
	}
	console.log("");
}

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
		const path = args.slice(1).find((a) => !a.startsWith("-")) || ".";
		await runInit(resolve(path));
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
		const path = args.slice(1).find((a) => !a.startsWith("-")) || ".";
		const { startMonitor } = await import("./monitor.js");
		await startMonitor(resolve(path));
		return;
	}

	const flags = parseFlags();
	const { cwd, outputDir, jsonOnly, ciMode, skipTests, watchMode, diffBase } = flags;
	const start = Date.now();

	validateCwd(cwd);

	const config = loadConfig(cwd);
	const workspace = detectWorkspace(cwd);
	const stack = detectStack(cwd, workspace);
	setGlobalSrcRoots(workspace.isMonorepo ? workspace.srcRoots : undefined);
	setGlobalIgnore(config.ignore);
	const quietMode = jsonOnly || flags.markdownMode;
	if (!quietMode) printHeader(cwd, stack, workspace);

	const isDart = stack.language === "dart";
	const checks = await runChecks(cwd, stack, workspace, skipTests, isDart, quietMode, config);

	// Per-check ignore: filter issues matching check-specific ignore patterns
	for (const c of checks) {
		const patterns = getCheckIgnore(config, c.name);
		if (!patterns?.length) continue;
		c.issues = c.issues.filter((i) => {
			if (!i.file || typeof i.file !== "string") return true;
			const f = i.file;
			return !patterns.some((p) => {
				if (p.endsWith("/**")) return f.startsWith(p.slice(0, -3) + "/");
				if (p.startsWith("*")) return f.endsWith(p.slice(1));
				return f.startsWith(p);
			});
		});
	}

	// --diff: filter issues to only changed files
	if (diffBase) {
		const changedFiles = getChangedFiles(cwd, diffBase);
		if (changedFiles) {
			for (const c of checks) {
				c.issues = c.issues.filter((i) => !i.file || changedFiles.has(i.file));
			}
		}
	}

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

	// Interactive = a real terminal session (not piped, CI, JSON, or watch). Gates the
	// post-scan prompt and the default top-issues view.
	const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY) && !quietMode && !ciMode && !watchMode;

	if (flags.markdownMode) {
		console.log(generateMarkdown(report, trend));
	} else {
		await printResults(report, trend, flags, outputDir, interactive);
	}

	if (flags.annotations) {
		emitAnnotations(report);
	}

	if (flags.uploadMode) {
		await handleUpload(report, cwd, quietMode);
	}

	if (flags.prComment) {
		const posted = await postPRComment(report, trend, cwd);
		if (!quietMode) {
			if (posted) console.log("  \x1b[32m\u2713 PR comment posted\x1b[0m");
			else console.log("  \x1b[2mNo PR detected or no GITHUB_TOKEN — skipping PR comment\x1b[0m");
		}
	}

	// CI exit code: fail if score below threshold (skip in watch mode)
	const failUnder = flags.failUnder ?? (ciMode ? 60 : (config.failUnder ?? 0));
	if (failUnder > 0 && score < failUnder && !watchMode) {
		if (!quietMode) console.log(`  \x1b[31mFailing: score ${score} < ${failUnder}\x1b[0m\n`);
		process.exit(1);
	}

	// Non-blocking update check (don't slow down the scan)
	if (!quietMode && !ciMode && !watchMode && !process.env.VCQA_NO_UPDATE_CHECK) {
		checkForUpdate(VERSION).catch(() => {});
	}

	if (watchMode) {
		await startWatch(cwd);
		return;
	}

	// Interactive on-ramp: offer to open the live monitor or the HTML report.
	if (interactive && !flags.uploadMode && !flags.prComment) {
		await promptNextAction(cwd, outputDir);
	}
}

/** Read a single keypress from a TTY, restoring stdin state afterward. */
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

/** Open a file/URL with the OS default handler (detached). */
function openPath(target: string): void {
	const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
	import("node:child_process").then(({ spawn }) => {
		try {
			spawn(cmd, [target], { detached: true, stdio: "ignore", shell: process.platform === "win32" }).unref();
		} catch {
			/* opening is best-effort */
		}
	});
}

/** Post-scan prompt: [m] monitor · [o] open report · anything else quits. */
async function promptNextAction(cwd: string, outputDir: string): Promise<void> {
	process.stdout.write(
		"  \x1b[1m[m]\x1b[0m\x1b[2m monitor\x1b[0m   \x1b[1m[o]\x1b[0m\x1b[2m open report\x1b[0m   \x1b[1m[enter]\x1b[0m\x1b[2m quit\x1b[0m  ",
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
	}
	// any other key (enter, q, ctrl-c, …) → quit
}

async function checkForUpdate(currentVersion: string): Promise<void> {
	try {
		const res = await fetch("https://registry.npmjs.org/@vibecodeqa/cli/latest", { signal: AbortSignal.timeout(3000) });
		if (!res.ok) return;
		const data = (await res.json()) as { version?: string };
		const latest = data.version;
		if (!latest || latest === currentVersion) return;
		// Only show if npm version is actually newer (semver compare)
		const cur = currentVersion.split(".").map(Number);
		const lat = latest.split(".").map(Number);
		const isNewer = lat[0] > cur[0] || (lat[0] === cur[0] && lat[1] > cur[1]) || (lat[0] === cur[0] && lat[1] === cur[1] && lat[2] > cur[2]);
		if (isNewer) {
			console.log(`  \x1b[33mUpdate available: ${currentVersion} → ${latest}\x1b[0m  Run \x1b[1mnpx @vibecodeqa/cli@latest\x1b[0m\n`);
		}
	} catch {
		/* network error — silently ignore */
	}
}

main().catch((err) => {
	console.error("vibe-check error:", err);
	process.exit(1);
});
