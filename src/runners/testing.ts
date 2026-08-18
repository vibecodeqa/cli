/** Comprehensive testing assessment — pyramid layers, quality, coverage.
 *
 * Dimensions assessed:
 *   1. Pyramid presence — which layers exist? (unit, integration, e2e, component)
 *   2. Test execution — pass/fail from the runner
 *   3. Coverage — statement, branch, function, line
 *   4. File pairing — does each source file have a test file?
 *   5. Test quality — naming, assertions, mocking patterns, snapshot smell
 *   6. Pyramid balance — right ratio of fast-to-slow tests
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import type { FileInventory } from "../file-inventory.js";
import { inventorySourceFiles } from "../file-inventory.js";
import { getProductionFiles, normalizeToolPath, readDeps } from "../fs-utils.js";
import type { AnalyzerMetric, CheckResult, Issue, StackInfo, WorkspaceInfo } from "../types.js";
import { gradeFromScore } from "../types.js";
import { run } from "./exec.js";

// ── Types ──

type TestLayer = "unit" | "integration" | "e2e" | "component";

interface TestFile {
	path: string; // relative to cwd
	layer: TestLayer;
	lines: number;
	assertions: number;
	mocks: number;
	snapshots: number;
	describes: number;
	its: number;
}

interface LayerSummary {
	present: boolean;
	files: number;
	assertions: number;
	score: number; // 0-100
}

interface CoverageData {
	statements: number;
	lines: number;
	branches: number;
	functions: number;
}

type TestCaseStatus = "passed" | "failed" | "skipped" | "todo" | "unknown";
type TestProjectRunStatus = "passed" | "failed" | "partial" | "no-tests-matched" | "parse-failed" | "command-failed" | "skipped";
type TestCoverageStatus = "reported" | "not-reported";

interface TestCaseReport {
	name: string;
	status: TestCaseStatus;
	durationMs: number | null;
	error?: string;
}

interface TestSuiteReport {
	file: string;
	status: TestCaseStatus;
	durationMs: number | null;
	passed: number;
	failed: number;
	skipped: number;
	total: number;
	tests: TestCaseReport[];
}

interface TestExecutionReport {
	runner: string;
	cwd: string;
	projectId?: string;
	projectPath?: string;
	passed: number;
	failed: number;
	total: number;
	durationMs: number | null;
	suites: TestSuiteReport[];
	failures: (TestCaseReport & { file: string })[];
	slowest: (TestCaseReport & { file: string })[];
}

interface NormalizedTestProjectReport extends TestExecutionReport {
	id: string;
	path: string;
	command: string | null;
	status: TestProjectRunStatus;
	statusLabel: string;
	executionOk: boolean | null;
	reportParsed: boolean;
	coverageStatus: TestCoverageStatus;
	coverage: CoverageData | null;
}

// ── Classification rules ──

function classifyTestFile(relPath: string, content: string): TestLayer {
	const lower = relPath.toLowerCase();

	// E2E — explicit directory or file naming
	if (lower.includes("/e2e/") || lower.includes(".e2e.") || lower.includes("/playwright/") || lower.includes(".pw.")) return "e2e";
	if (/\b(page|browser|navigate|goto|click|fill|expect\(page)\b/.test(content) && /playwright|puppeteer|cypress/.test(content))
		return "e2e";

	// Integration — explicit naming or real API/DB calls
	if (lower.includes("integration") || lower.includes(".int.")) return "integration";
	if (/\bfetch\(["']https?:/.test(content) && !/mock|stub|spy|vi\.fn|jest\.fn/.test(content)) return "integration";
	if (/\bglobalSetup\b/.test(content)) return "integration";

	// Component — React component tests (render, screen, fireEvent)
	if (/\b(render|screen|fireEvent|userEvent|@testing-library)\b/.test(content)) return "component";
	if (lower.includes(".component.")) return "component";

	// Default: unit
	return "unit";
}

function countPatterns(content: string) {
	const assertions = (content.match(/\bexpect\s*\(/g) || []).length + (content.match(/\bassert[.(]/g) || []).length;
	const mocks = (
		content.match(
			/\b(vi\.fn|jest\.fn|vi\.mock|jest\.mock|vi\.spyOn|jest\.spyOn|sinon\.(stub|spy|mock)|\.mockResolvedValue|\.mockReturnValue|\.mockImplementation)\b/g,
		) || []
	).length;
	const snapshots = (content.match(/\btoMatchSnapshot|toMatchInlineSnapshot\b/g) || []).length;
	const describes = (content.match(/\bdescribe\s*\(/g) || []).length;
	const its = (content.match(/\b(it|test)\s*\(/g) || []).length;
	return { assertions, mocks, snapshots, describes, its };
}

// ── File discovery ──

function findTestFiles(cwd: string, srcRoots?: string[], inventory?: FileInventory): TestFile[] {
	if (inventory) return inventoryTestFiles(inventory);

	const files: TestFile[] = [];
	const dirs = srcRoots
		? [...srcRoots, "e2e", "playwright"]
		: existsSync(join(cwd, "src"))
			? ["src", "web/src", "lib", "test", "tests", "__tests__", "e2e", "playwright"]
			: [".", "test", "tests", "__tests__", "e2e", "playwright"];
	const seen = new Set<string>();
	for (const dir of dirs) {
		const full = join(cwd, dir);
		if (seen.has(full)) continue;
		seen.add(full);
		if (existsSync(full)) walkTests(full, cwd, files);
	}
	return files;
}

function inventoryTestFiles(inventory: FileInventory): TestFile[] {
	return inventorySourceFiles(inventory, { includeTests: true }).flatMap((file) => {
		if (!isTestCandidate(file.path)) return [];
		const layer = classifyTestFile(file.path, file.content);
		const patterns = countPatterns(file.content);
		return [
			{
				path: file.path,
				layer,
				lines: file.lines,
				...patterns,
			},
		];
	});
}

function walkTests(dir: string, cwd: string, out: TestFile[]): void {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
		const full = join(dir, entry);
		try {
			if (statSync(full).isDirectory()) {
				walkTests(full, cwd, out);
				continue;
			}
		} catch {
			continue;
		}
		const ext = extname(entry);
		if (![".ts", ".tsx", ".js", ".jsx", ".dart"].includes(ext)) continue;
		// Check if file is in a test directory by matching path segments (not substrings)
		const relDir = dir.startsWith(cwd) ? dir.slice(cwd.length) : dir;
		const relPath = full.replace(`${cwd}/`, "");
		if (!isTestCandidate(relPath, relDir, entry)) continue;

		let content: string;
		try {
			content = readFileSync(full, "utf-8");
		} catch {
			continue;
		}
		const layer = classifyTestFile(relPath, content);
		const patterns = countPatterns(content);

		out.push({
			path: relPath,
			layer,
			lines: content.split("\n").length,
			...patterns,
		});
	}
}

function isTestCandidate(relPath: string, relDir = "", entry = basename(relPath)): boolean {
	const inTestDir = /(?:^|\/)(?:test|tests|__tests__|e2e|playwright)(?:\/|$)/.test(relDir || relPath);
	return (
		entry.includes(".test.") ||
		entry.includes(".spec.") ||
		entry.includes(".e2e.") ||
		entry.includes(".int.") ||
		entry.endsWith("_test.dart") ||
		inTestDir
	);
}

function findSourceFiles(cwd: string, srcRoots?: string[], inventory?: FileInventory): string[] {
	return (inventory ? inventorySourceFiles(inventory) : getProductionFiles(cwd, srcRoots)).map((f) => f.path);
}

// ── Pairing analysis ──

function computePairing(srcFiles: string[], testFiles: TestFile[]): { paired: number; unpaired: string[] } {
	const testBases = new Set(
		testFiles.map((t) => {
			const b = basename(t.path);
			return b.replace(/\.(test|spec|e2e|int)\.(ts|tsx|js|jsx)$/, "");
		}),
	);

	const unpaired: string[] = [];
	let paired = 0;
	for (const src of srcFiles) {
		const b = basename(src).replace(/\.(ts|tsx|js|jsx)$/, "");
		// Skip files that conventionally don't need tests
		if (["index", "main", "types", "constants", "config"].includes(b)) continue;
		if (testBases.has(b)) {
			paired++;
		} else {
			unpaired.push(src);
		}
	}
	return { paired, unpaired };
}

// ── E2E tool detection ──

function detectE2E(cwd: string): { tool: string; configured: boolean } {
	const allDeps = readDeps(cwd);
	if (allDeps["@playwright/test"] || allDeps.playwright) {
		const hasConfig = existsSync(join(cwd, "playwright.config.ts")) || existsSync(join(cwd, "playwright.config.js"));
		return { tool: "playwright", configured: hasConfig };
	}
	if (allDeps.cypress) {
		const hasConfig =
			existsSync(join(cwd, "cypress.config.ts")) || existsSync(join(cwd, "cypress.config.js")) || existsSync(join(cwd, "cypress.json"));
		return { tool: "cypress", configured: hasConfig };
	}
	return { tool: "none", configured: false };
}

// ── Combined test + coverage execution (single run) ──

function packageRootFromSrcRoot(srcRoot: string): string {
	const clean = srcRoot.replace(/^\/+|\/+$/g, "");
	if (!clean) return "";
	const parts = clean.split("/");
	const leaf = parts.at(-1);
	if (parts.length > 1 && leaf && ["src", "lib", "test", "tests", "__tests__", "e2e"].includes(leaf)) {
		parts.pop();
	}
	if (parts.length === 1 && ["src", "lib", "test", "tests", "__tests__", "e2e"].includes(parts[0])) return "";
	return parts.join("/");
}

function directRunnerFor(cwd: string): StackInfo["testRunner"] {
	const deps = readDeps(cwd);
	if (deps.vitest) return "vitest";
	if (deps.jest) return "jest";
	return "none";
}

export interface TestRunTarget {
	cwd: string;
	runner: StackInfo["testRunner"];
	projectId?: string;
	projectPath?: string;
}

export function testRunTargets(cwd: string, srcRoots?: string[], workspace?: WorkspaceInfo): TestRunTarget[] {
	const projectTargets = (workspace?.projects ?? [])
		.map((project) => ({
			cwd: project.path === "." ? cwd : join(cwd, project.path),
			runner: project.stack.testRunner,
			projectId: project.id,
			projectPath: project.path,
		}))
		.filter((target) => target.runner === "vitest" || target.runner === "jest");
	if (projectTargets.length > 0) return projectTargets;

	if (!srcRoots || srcRoots.length === 0) {
		const runner = directRunnerFor(cwd);
		return runner === "none" ? [] : [{ cwd, runner }];
	}

	const packageRoots = new Set<string>();
	for (const srcRoot of srcRoots) {
		const pkg = packageRootFromSrcRoot(srcRoot);
		if (!pkg) continue;
		if (existsSync(join(cwd, pkg, "package.json"))) packageRoots.add(pkg);
	}

	const packageCandidates = [...packageRoots]
		.map((rel) => ({
			cwd: join(cwd, rel),
			runner: directRunnerFor(join(cwd, rel)),
			projectId: rel.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "") || "project",
			projectPath: rel,
		}))
		.filter((r) => r.runner !== "none");
	if (packageCandidates.length > 0) return packageCandidates;

	const rootRunner = directRunnerFor(cwd);
	return rootRunner === "none" ? [] : [{ cwd, runner: rootRunner }];
}

function coverageRoots(cwd: string, srcRoots?: string[]): string[] {
	const roots = [cwd];
	for (const srcRoot of srcRoots ?? []) {
		const pkg = packageRootFromSrcRoot(srcRoot);
		if (!pkg) continue;
		const full = join(cwd, pkg);
		if (!roots.includes(full)) roots.push(full);
	}
	return roots;
}

function firstJsonObject(stdout: string): unknown | null {
	const start = stdout.indexOf("{");
	if (start < 0) return null;

	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < stdout.length; i++) {
		const ch = stdout[i];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (ch === "\\") {
				escaped = true;
			} else if (ch === '"') {
				inString = false;
			}
			continue;
		}
		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch === "{") depth++;
		if (ch === "}") {
			depth--;
			if (depth === 0) {
				try {
					return JSON.parse(stdout.slice(start, i + 1));
				} catch {
					return null;
				}
			}
		}
	}
	return null;
}

function normalizeStatus(status: unknown): TestCaseStatus {
	const s = String(status || "").toLowerCase();
	if (s === "passed" || s === "failed" || s === "skipped" || s === "todo") return s;
	if (s === "pending") return "skipped";
	return "unknown";
}

function asDuration(v: unknown): number | null {
	const n = Number(v);
	return Number.isFinite(n) ? Math.max(0, Math.round(n * 10) / 10) : null;
}

function trimError(messages: unknown): string | undefined {
	const list = Array.isArray(messages) ? messages : messages ? [messages] : [];
	const text = list.map(String).join("\n").trim();
	if (!text) return undefined;
	return text.length > 4000 ? `${text.slice(0, 4000)}\n...truncated` : text;
}

function relativeTestFile(runCwd: string, file: unknown, repoCwd = runCwd): string {
	const path = String(file || "unknown");
	if (!path || path === "unknown") return path;
	if (!path.startsWith("/")) return normalizeToolPath(repoCwd, runCwd, path);
	const rel = relative(runCwd, path).replace(/\\/g, "/");
	if (!rel.startsWith("..")) return normalizeToolPath(repoCwd, runCwd, rel);
	return normalizeToolPath(repoCwd, runCwd, path);
}

function readAssertionName(raw: Record<string, unknown>): string {
	const full = String(raw.fullName || "").trim();
	if (full) return full;
	const title = String(raw.title || "").trim();
	const ancestors = Array.isArray(raw.ancestorTitles) ? raw.ancestorTitles.map(String).filter(Boolean) : [];
	return [...ancestors, title].filter(Boolean).join(" ");
}

function compactSuite(runCwd: string, raw: Record<string, unknown>, repoCwd = runCwd): TestSuiteReport {
	const assertions = Array.isArray(raw.assertionResults) ? (raw.assertionResults as Record<string, unknown>[]) : [];
	const tests = assertions.map((a) => {
		const status = normalizeStatus(a.status);
		return {
			name: readAssertionName(a),
			status,
			durationMs: asDuration(a.duration),
			...(status === "failed" ? { error: trimError(a.failureMessages) } : {}),
		};
	});
	const passed = tests.filter((t) => t.status === "passed").length;
	const failed = tests.filter((t) => t.status === "failed").length;
	const skipped = tests.filter((t) => t.status === "skipped" || t.status === "todo").length;
	const start = Number(raw.startTime);
	const end = Number(raw.endTime);
	const suiteDuration = Number.isFinite(start) && Number.isFinite(end) && end >= start ? asDuration(end - start) : null;
	return {
		file: relativeTestFile(runCwd, raw.name, repoCwd),
		status: failed > 0 ? "failed" : skipped > 0 && passed === 0 ? "skipped" : passed > 0 ? "passed" : normalizeStatus(raw.status),
		durationMs: suiteDuration,
		passed,
		failed,
		skipped,
		total: tests.length,
		tests,
	};
}

export function parseTestExecutionReport(stdout: string, runCwd = "", repoCwd = runCwd): TestExecutionReport | null {
	const data = firstJsonObject(stdout) as Record<string, unknown> | null;
	if (!data) return null;
	const suites = (Array.isArray(data.testResults) ? (data.testResults as Record<string, unknown>[]) : [])
		.map((suite) => compactSuite(runCwd, suite, repoCwd))
		.sort((a, b) => b.failed - a.failed || (b.durationMs ?? 0) - (a.durationMs ?? 0) || a.file.localeCompare(b.file));
	const allTests = suites.flatMap((suite) => suite.tests.map((test) => ({ ...test, file: suite.file })));
	return {
		runner: "vitest",
		cwd: runCwd,
		passed: Number(data.numPassedTests) || 0,
		failed: Number(data.numFailedTests) || 0,
		total: Number(data.numTotalTests) || 0,
		durationMs: null,
		suites,
		failures: allTests.filter((t) => t.status === "failed"),
		slowest: allTests
			.filter((t) => t.durationMs !== null)
			.sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0))
			.slice(0, 25),
	};
}

export function parseTestExecutionJson(stdout: string): { passed: number; failed: number; total: number } | null {
	const report = parseTestExecutionReport(stdout);
	if (!report) return null;
	return { passed: report.passed, failed: report.failed, total: report.total };
}

function commandForTestTarget(target: TestRunTarget): string {
	return target.runner === "vitest"
		? "npx vitest run --reporter=json --coverage"
		: "npx jest --json --coverage --coverageReporters=json-summary";
}

function statusLabel(status: TestProjectRunStatus): string {
	switch (status) {
		case "passed":
			return "passed";
		case "failed":
			return "failed";
		case "partial":
			return "partial";
		case "no-tests-matched":
			return "no tests matched";
		case "parse-failed":
			return "report could not be parsed";
		case "command-failed":
			return "command failed";
		case "skipped":
			return "skipped";
	}
}

function reportStatus(report: TestExecutionReport | null, executionOk: boolean | null): TestProjectRunStatus {
	if (!report) return executionOk === false ? "command-failed" : "parse-failed";
	if (report.failed > 0) return "failed";
	if (report.total === 0) return "no-tests-matched";
	if (report.passed > 0 && report.passed < report.total) return "partial";
	return "passed";
}

export function normalizeTestProjectReport(input: {
	target: TestRunTarget;
	command: string | null;
	report: TestExecutionReport | null;
	executionOk: boolean | null;
	coverage: CoverageData | null;
	skipped?: boolean;
}): NormalizedTestProjectReport {
	const status = input.skipped ? "skipped" : reportStatus(input.report, input.executionOk);
	const base = input.report ?? {
		runner: input.target.runner,
		cwd: input.target.cwd,
		projectId: input.target.projectId,
		projectPath: input.target.projectPath,
		passed: 0,
		failed: 0,
		total: 0,
		durationMs: null,
		suites: [],
		failures: [],
		slowest: [],
	};
	return {
		...base,
		runner: input.target.runner,
		cwd: input.target.cwd,
		projectId: input.target.projectId,
		projectPath: input.target.projectPath,
		id: input.target.projectId ?? "root",
		path: input.target.projectPath ?? ".",
		command: input.command,
		status,
		statusLabel: statusLabel(status),
		executionOk: input.executionOk,
		reportParsed: Boolean(input.report),
		coverageStatus: input.coverage ? "reported" : "not-reported",
		coverage: input.coverage,
	};
}

export function summarizeTestProjectStatus(projects: Pick<NormalizedTestProjectReport, "status">[]): TestProjectRunStatus | "unknown" {
	if (projects.length === 0) return "unknown";
	if (projects.every((p) => p.status === "skipped")) return "skipped";
	if (projects.some((p) => p.status === "failed" || p.status === "command-failed")) return "failed";
	if (projects.some((p) => p.status === "passed" || p.status === "partial")) {
		return projects.every((p) => p.status === "passed") ? "passed" : "partial";
	}
	if (projects.every((p) => p.status === "no-tests-matched")) return "no-tests-matched";
	return "parse-failed";
}

function runTestsWithCoverage(
	cwd: string,
	stack: StackInfo,
	srcRoots?: string[],
	workspace?: WorkspaceInfo,
): {
	execution: { passed: number; failed: number; total: number } | null;
	coverage: CoverageData | null;
	reports: NormalizedTestProjectReport[];
} {
	const roots = testRunTargets(cwd, srcRoots, workspace);
	if (stack.testRunner === "none" && roots.length === 0) return { execution: null, coverage: null, reports: [] };
	let execution: { passed: number; failed: number; total: number } | null = null;
	let coverage: CoverageData | null = null;
	const reports: NormalizedTestProjectReport[] = [];

	for (const root of roots) {
		const cmd = commandForTestTarget(root);
		const { stdout, ok } = run(cmd, root.cwd, 120_000, {
			projectId: root.projectId,
			projectPath: root.projectPath,
		});
		const report = parseTestExecutionReport(stdout, root.cwd, cwd);
		const parsed = report ? { passed: report.passed, failed: report.failed, total: report.total } : null;
		const projectCoverage = readCoverageFile(root.cwd);
		reports.push(normalizeTestProjectReport({ target: root, command: cmd, report, executionOk: ok, coverage: projectCoverage }));
		if (parsed) {
			execution = execution
				? {
						passed: execution.passed + parsed.passed,
						failed: execution.failed + parsed.failed,
						total: execution.total + parsed.total,
					}
				: parsed;
		}
		coverage ??= projectCoverage;
	}

	coverage ??= readCoverageFile(cwd, srcRoots);

	return { execution, coverage, reports };
}

function readCoverageFile(cwd: string, srcRoots?: string[]): CoverageData | null {
	// Try JSON coverage-summary (vitest, jest, istanbul)
	const searchPaths = ["coverage/coverage-summary.json", "test-results/coverage/coverage-summary.json"];
	for (const root of coverageRoots(cwd, srcRoots)) {
		for (const p of searchPaths) {
			const full = join(root, p);
			if (existsSync(full)) {
				try {
					const summary = JSON.parse(readFileSync(full, "utf-8"));
					if (summary?.total) {
						return {
							statements: asCoveragePct(summary.total.statements?.pct),
							lines: asCoveragePct(summary.total.lines?.pct),
							branches: asCoveragePct(summary.total.branches?.pct),
							functions: asCoveragePct(summary.total.functions?.pct),
						};
					}
				} catch {
					/* parse failed */
				}
			}
		}
	}
	// Try lcov.info (common output from c8, nyc, lcov)
	const lcovPaths = ["coverage/lcov.info", "lcov.info"];
	for (const root of coverageRoots(cwd, srcRoots)) {
		for (const p of lcovPaths) {
			const full = join(root, p);
			if (existsSync(full)) {
				return parseLcov(readFileSync(full, "utf-8"));
			}
		}
	}
	return null;
}

function asCoveragePct(value: unknown): number {
	const n = Number(value);
	return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
}

function parseLcov(content: string): CoverageData | null {
	let linesHit = 0,
		linesTotal = 0;
	let branchesHit = 0,
		branchesTotal = 0;
	let functionsHit = 0,
		functionsTotal = 0;
	for (const line of content.split("\n")) {
		if (line.startsWith("LH:")) linesHit += parseInt(line.slice(3), 10) || 0;
		if (line.startsWith("LF:")) linesTotal += parseInt(line.slice(3), 10) || 0;
		if (line.startsWith("BRH:")) branchesHit += parseInt(line.slice(4), 10) || 0;
		if (line.startsWith("BRF:")) branchesTotal += parseInt(line.slice(4), 10) || 0;
		if (line.startsWith("FNH:")) functionsHit += parseInt(line.slice(4), 10) || 0;
		if (line.startsWith("FNF:")) functionsTotal += parseInt(line.slice(4), 10) || 0;
	}
	if (linesTotal === 0) return null;
	const pct = (hit: number, total: number) => (total > 0 ? Math.round((hit / total) * 10000) / 100 : 0);
	return {
		statements: pct(linesHit, linesTotal), // lcov doesn't distinguish statements from lines
		lines: pct(linesHit, linesTotal),
		branches: pct(branchesHit, branchesTotal),
		functions: pct(functionsHit, functionsTotal),
	};
}

// ── Test execution ──

// ── Quality analysis ──

interface QualityMetrics {
	avgAssertionsPerTest: number;
	testsWithNoAssertions: number;
	mockRatio: number; // mocks / assertions — high = over-mocked
	snapshotRatio: number; // snapshots / total assertions — high = brittle
	emptyDescribes: number;
	wellNamedTests: number; // tests with descriptive names (>10 chars in it())
	totalTests: number;
}

function analyzeQuality(testFiles: TestFile[]): QualityMetrics {
	let totalAssertions = 0;
	let totalMocks = 0;
	let totalSnapshots = 0;
	let totalIts = 0;
	let testsWithNoAssertions = 0;

	for (const f of testFiles) {
		totalAssertions += f.assertions;
		totalMocks += f.mocks;
		totalSnapshots += f.snapshots;
		totalIts += f.its;
		if (f.assertions === 0 && f.its > 0) testsWithNoAssertions += f.its;
	}

	return {
		avgAssertionsPerTest: totalIts > 0 ? Math.round((totalAssertions / totalIts) * 10) / 10 : 0,
		testsWithNoAssertions,
		mockRatio: totalAssertions > 0 ? Math.round((totalMocks / totalAssertions) * 100) / 100 : 0,
		snapshotRatio: totalAssertions > 0 ? Math.round((totalSnapshots / totalAssertions) * 100) / 100 : 0,
		emptyDescribes: 0,
		wellNamedTests: totalIts, // simplified for v0.2
		totalTests: totalIts,
	};
}

// ── Main runner ──

export function runTesting(
	cwd: string,
	stack: StackInfo,
	skipExec: boolean,
	srcRoots?: string[],
	workspace?: WorkspaceInfo,
	inventory?: FileInventory,
): CheckResult {
	const start = Date.now();
	const issues: Issue[] = [];

	// 1. Discover test files and classify by layer
	const testFiles = findTestFiles(cwd, srcRoots, inventory);
	const srcFiles = findSourceFiles(cwd, srcRoots, inventory);

	if (testFiles.length === 0) {
		return {
			name: "testing",
			score: 0,
			grade: "F",
			details: {
				reason: "No test files found",
				srcFiles: srcFiles.length,
				testFiles: 0,
				source: inventory ? "file-inventory" : "legacy-walk",
				pyramid: { unit: 0, integration: 0, component: 0, e2e: 0 },
				metrics: testingMetrics({
					srcFiles: srcFiles.length,
					testFiles: 0,
					layerFiles: { unit: 0, integration: 0, component: 0, e2e: 0 },
					pairingPct: 0,
					quality: null,
					coverage: null,
					execution: null,
				}),
			},
			issues: [{ severity: "error", message: `${srcFiles.length} source files with zero tests`, rule: "no-tests" }],
			duration: Date.now() - start,
		};
	}

	// 2. Pyramid layer analysis
	const layers: Record<TestLayer, TestFile[]> = { unit: [], integration: [], component: [], e2e: [] };
	for (const f of testFiles) layers[f.layer].push(f);

	const pyramid: Record<TestLayer, LayerSummary> = {
		unit: {
			present: layers.unit.length > 0,
			files: layers.unit.length,
			assertions: layers.unit.reduce((s, f) => s + f.assertions, 0),
			score: 0,
		},
		integration: {
			present: layers.integration.length > 0,
			files: layers.integration.length,
			assertions: layers.integration.reduce((s, f) => s + f.assertions, 0),
			score: 0,
		},
		component: {
			present: layers.component.length > 0,
			files: layers.component.length,
			assertions: layers.component.reduce((s, f) => s + f.assertions, 0),
			score: 0,
		},
		e2e: {
			present: layers.e2e.length > 0,
			files: layers.e2e.length,
			assertions: layers.e2e.reduce((s, f) => s + f.assertions, 0),
			score: 0,
		},
	};

	// 3. E2E tool detection
	const e2eTool = detectE2E(cwd);
	const needsE2E = stack.framework !== "none"; // frontends should have E2E
	const needsComponent = stack.framework === "react" || stack.framework === "vue" || stack.framework === "svelte";

	// 4. Penalize missing layers based on what the stack needs
	if (!pyramid.unit.present) {
		issues.push({ severity: "error", message: "No unit tests found — every project needs unit tests", rule: "no-unit-tests" });
	}
	if (!pyramid.integration.present && srcFiles.length > 5) {
		issues.push({
			severity: "warning",
			message: "No integration tests — consider testing service boundaries",
			rule: "no-integration-tests",
		});
	}
	if (needsComponent && !pyramid.component.present) {
		issues.push({
			severity: "warning",
			message: `${stack.framework} project with no component tests — test your UI components`,
			rule: "no-component-tests",
		});
	}
	if (needsE2E && !pyramid.e2e.present) {
		if (e2eTool.tool === "none") {
			issues.push({
				severity: "warning",
				message: "No E2E test framework (Playwright/Cypress) — critical user flows untested",
				rule: "no-e2e-framework",
			});
		} else if (!e2eTool.configured) {
			issues.push({ severity: "info", message: `${e2eTool.tool} installed but not configured`, rule: "e2e-not-configured" });
		} else {
			issues.push({ severity: "info", message: `${e2eTool.tool} configured but no E2E test files found`, rule: "e2e-no-tests" });
		}
	}

	// 5. File pairing analysis
	const pairing = computePairing(srcFiles, testFiles);
	const pairingPct =
		srcFiles.length > 0 ? Math.round((pairing.paired / Math.max(1, srcFiles.length - countUntestable(srcFiles))) * 100) : 100;

	if (pairingPct < 30) {
		issues.push({ severity: "warning", message: `Only ${pairingPct}% of source files have matching test files`, rule: "low-test-pairing" });
	}
	// Report up to 5 unpaired files
	for (const f of pairing.unpaired.slice(0, 5)) {
		issues.push({ severity: "info", message: `No test file for ${f}`, file: f, rule: "untested-file" });
	}
	if (pairing.unpaired.length > 5) {
		issues.push({ severity: "info", message: `...and ${pairing.unpaired.length - 5} more untested files`, rule: "untested-file" });
	}

	// 6. Test quality analysis
	const quality = analyzeQuality(testFiles);

	if (quality.avgAssertionsPerTest < 1) {
		issues.push({
			severity: "warning",
			message: `Low assertion density: ${quality.avgAssertionsPerTest} assertions/test (aim for 2+)`,
			rule: "low-assertions",
		});
	}
	if (quality.mockRatio > 0.5) {
		issues.push({
			severity: "warning",
			message: `High mock ratio: ${quality.mockRatio} mocks per assertion — tests may not reflect real behavior`,
			rule: "over-mocked",
		});
	}
	if (quality.snapshotRatio > 0.3) {
		issues.push({
			severity: "warning",
			message: `${Math.round(quality.snapshotRatio * 100)}% of assertions are snapshots — brittle, prefer explicit assertions`,
			rule: "snapshot-heavy",
		});
	}

	// 7. Execute tests + collect coverage (unless --skip-tests)
	let execution: { passed: number; failed: number; total: number } | null = null;
	let coverage: CoverageData | null = null;
	let testReports: NormalizedTestProjectReport[] = [];
	const testTargets = testRunTargets(cwd, srcRoots, workspace);

	if (!skipExec) {
		// Run tests ONCE with both coverage and JSON output
		const combined = runTestsWithCoverage(cwd, stack, srcRoots, workspace);
		execution = combined.execution;
		coverage = combined.coverage;
		testReports = combined.reports;

		if (execution) {
			if (execution.failed > 0) {
				issues.push({ severity: "error", message: `${execution.failed} of ${execution.total} tests failing`, rule: "failing-tests" });
			}
		}
	} else {
		// --skip-tests: still try to read existing coverage reports
		coverage = readCoverageFile(cwd, srcRoots);
		testReports = testTargets.map((target) =>
			normalizeTestProjectReport({
				target,
				command: null,
				report: null,
				executionOk: null,
				coverage: readCoverageFile(target.cwd),
				skipped: true,
			}),
		);
	}

	for (const report of testReports) {
		const staticTestCount = staticTestFilesForProject(report.path, testFiles);
		if (report.status === "no-tests-matched" && staticTestCount > 0) {
			issues.push({
				severity: "warning",
				message: `${report.path} has ${staticTestCount} discovered test file${staticTestCount === 1 ? "" : "s"}, but ${report.runner} matched 0 tests`,
				rule: "test-run-no-tests-matched",
			});
		}
		if (report.status === "parse-failed" || report.status === "command-failed") {
			issues.push({
				severity: report.status === "command-failed" ? "error" : "warning",
				message: `${report.path} ${report.runner} ${report.statusLabel}`,
				rule: `test-run-${report.status}`,
			});
		}
	}

	if (coverage) {
		if (coverage.branches < 50) {
			issues.push({
				severity: "warning",
				message: `Branch coverage ${coverage.branches}% — below 50% threshold`,
				rule: "low-branch-coverage",
			});
		}
		if (coverage.statements < 60) {
			issues.push({
				severity: "warning",
				message: `Statement coverage ${coverage.statements}% — below 60% threshold`,
				rule: "low-statement-coverage",
			});
		}
	}

	// 8. Compute composite score
	let score = 0;

	// Pyramid presence (30 points)
	const layerCount = [
		pyramid.unit.present,
		pyramid.integration.present,
		pyramid.component.present && needsComponent,
		pyramid.e2e.present && needsE2E,
	].filter(Boolean).length;
	const expectedLayers = 1 + (srcFiles.length > 5 ? 1 : 0) + (needsComponent ? 1 : 0) + (needsE2E ? 1 : 0);
	const pyramidScore = expectedLayers > 0 ? Math.round((layerCount / expectedLayers) * 30) : 30;
	score += pyramidScore;

	// Execution (20 points)
	if (execution) {
		const passRate = execution.total > 0 ? execution.passed / execution.total : 0;
		score += Math.round(passRate * 20);
	} else if (!skipExec) {
		// Couldn't run tests
	} else {
		score += 10; // partial credit when skipped
	}

	// Coverage (20 points)
	if (coverage) {
		const avgCov = (coverage.statements + coverage.branches + coverage.lines + coverage.functions) / 4;
		score += Math.round((avgCov / 100) * 20);
	}

	// Pairing (15 points)
	score += Math.round((pairingPct / 100) * 15);

	// Quality (15 points)
	let qualityScore = 15;
	if (quality.avgAssertionsPerTest < 1) qualityScore -= 5;
	if (quality.mockRatio > 0.5) qualityScore -= 3;
	if (quality.snapshotRatio > 0.3) qualityScore -= 3;
	if (quality.testsWithNoAssertions > 0) qualityScore -= 2;
	score += Math.max(0, qualityScore);

	score = Math.max(0, Math.min(100, score));

	return {
		name: "testing",
		score,
		grade: gradeFromScore(score),
		details: {
			pyramid: {
				unit: pyramid.unit.files,
				integration: pyramid.integration.files,
				component: pyramid.component.files,
				e2e: pyramid.e2e.files,
			},
			layersPresent: `${layerCount}/${expectedLayers}`,
			e2eTool: e2eTool.tool,
			testFiles: testFiles.length,
			srcFiles: srcFiles.length,
			source: inventory ? "file-inventory" : "legacy-walk",
			pairing: `${pairingPct}%`,
			quality: {
				assertionsPerTest: quality.avgAssertionsPerTest,
				mockRatio: quality.mockRatio,
				snapshotRatio: quality.snapshotRatio,
			},
			...(skipExec
				? {
						executionSkipped: true,
						executionSkipReason: "Scan ran with --skip-tests; existing coverage artifacts were read, but the test runner was not executed.",
					}
				: {}),
			executionStatus: summarizeTestProjectStatus(testReports),
			...(execution ? { passed: execution.passed, failed: execution.failed, total: execution.total } : {}),
			...(testReports.length > 0 ? { testReports } : {}),
			...(testReports.length > 0
				? {
						testProjects: testReports.map((report) => ({
							id: report.id,
							path: report.path,
							runner: report.runner,
							command: report.command,
							status: report.status,
							statusLabel: report.statusLabel,
							reportParsed: report.reportParsed,
							executionOk: report.executionOk,
							passed: report.passed,
							failed: report.failed,
							total: report.total,
							durationMs: report.durationMs,
							coverageStatus: report.coverageStatus,
							coverage: report.coverage
								? {
										stmts: report.coverage.statements,
										branches: report.coverage.branches,
										lines: report.coverage.lines,
										fns: report.coverage.functions,
									}
								: null,
						})),
					}
				: {}),
			...(coverage
				? { coverage: { stmts: coverage.statements, branches: coverage.branches, lines: coverage.lines, fns: coverage.functions } }
				: {}),
			metrics: testingMetrics({
				srcFiles: srcFiles.length,
				testFiles: testFiles.length,
				layerFiles: {
					unit: pyramid.unit.files,
					integration: pyramid.integration.files,
					component: pyramid.component.files,
					e2e: pyramid.e2e.files,
				},
				pairingPct,
				quality,
				coverage,
				execution,
			}),
		},
		issues,
		duration: Date.now() - start,
	};
}

function testingMetrics(input: {
	srcFiles: number;
	testFiles: number;
	layerFiles: Record<TestLayer, number>;
	pairingPct: number;
	quality: QualityMetrics | null;
	coverage: CoverageData | null;
	execution: { passed: number; failed: number; total: number } | null;
}): AnalyzerMetric[] {
	const metrics: AnalyzerMetric[] = [
		{ id: "srcFiles", label: "Source files", value: input.srcFiles, unit: "count", trend: "neutral" },
		{ id: "testFiles", label: "Test files", value: input.testFiles, unit: "count", trend: "higher-is-better" },
		{ id: "unitTestFiles", label: "Unit test files", value: input.layerFiles.unit, unit: "count", trend: "higher-is-better" },
		{
			id: "integrationTestFiles",
			label: "Integration test files",
			value: input.layerFiles.integration,
			unit: "count",
			trend: "higher-is-better",
		},
		{
			id: "componentTestFiles",
			label: "Component test files",
			value: input.layerFiles.component,
			unit: "count",
			trend: "higher-is-better",
		},
		{ id: "e2eTestFiles", label: "E2E test files", value: input.layerFiles.e2e, unit: "count", trend: "higher-is-better" },
		{ id: "pairingPct", label: "Source files paired with tests", value: input.pairingPct, unit: "percent", trend: "higher-is-better" },
	];

	if (input.quality) {
		metrics.push(
			{
				id: "assertionsPerTest",
				label: "Assertions per test",
				value: input.quality.avgAssertionsPerTest,
				unit: "count",
				trend: "higher-is-better",
			},
			{ id: "mockRatio", label: "Mock ratio", value: input.quality.mockRatio, trend: "lower-is-better" },
			{ id: "snapshotRatio", label: "Snapshot ratio", value: input.quality.snapshotRatio, trend: "lower-is-better" },
		);
	}

	if (input.execution) {
		const passRate = input.execution.total > 0 ? Math.round((input.execution.passed / input.execution.total) * 10000) / 100 : 0;
		metrics.push(
			{ id: "testsPassed", label: "Tests passed", value: input.execution.passed, unit: "count", trend: "higher-is-better" },
			{ id: "testsFailed", label: "Tests failed", value: input.execution.failed, unit: "count", trend: "lower-is-better" },
			{ id: "testsTotal", label: "Tests total", value: input.execution.total, unit: "count", trend: "higher-is-better" },
			{ id: "testPassRate", label: "Test pass rate", value: passRate, unit: "percent", trend: "higher-is-better" },
		);
	}

	if (input.coverage) {
		metrics.push(
			{
				id: "statementCoverage",
				label: "Statement coverage",
				value: input.coverage.statements,
				unit: "percent",
				trend: "higher-is-better",
			},
			{ id: "branchCoverage", label: "Branch coverage", value: input.coverage.branches, unit: "percent", trend: "higher-is-better" },
			{ id: "lineCoverage", label: "Line coverage", value: input.coverage.lines, unit: "percent", trend: "higher-is-better" },
			{ id: "functionCoverage", label: "Function coverage", value: input.coverage.functions, unit: "percent", trend: "higher-is-better" },
		);
	}

	return metrics;
}

function countUntestable(srcFiles: string[]): number {
	return srcFiles.filter((f) => {
		const b = basename(f).replace(/\.(ts|tsx|js|jsx)$/, "");
		return ["index", "main", "types", "constants", "config"].includes(b);
	}).length;
}

function staticTestFilesForProject(projectPath: string, testFiles: TestFile[]): number {
	if (projectPath === ".") return testFiles.length;
	const prefix = `${projectPath.replace(/^\/+|\/+$/g, "")}/`;
	return testFiles.filter((file) => file.path.startsWith(prefix)).length;
}
