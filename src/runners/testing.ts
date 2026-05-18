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
import { basename, extname, join } from "node:path";
import { getProductionFiles, readDeps } from "../fs-utils.js";
import type { CheckResult, Issue, StackInfo } from "../types.js";
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

function findTestFiles(cwd: string, srcRoots?: string[]): TestFile[] {
	const files: TestFile[] = [];
	const dirs = srcRoots ? [...srcRoots, "e2e", "playwright"] : ["src", "web/src", "test", "tests", "__tests__", "e2e", "playwright"];
	const seen = new Set<string>();
	for (const dir of dirs) {
		const full = join(cwd, dir);
		if (seen.has(full)) continue;
		seen.add(full);
		if (existsSync(full)) walkTests(full, cwd, files);
	}
	return files;
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
		if (![".ts", ".tsx", ".js", ".jsx"].includes(ext)) continue;
		if (
			!entry.includes(".test.") &&
			!entry.includes(".spec.") &&
			!entry.includes(".e2e.") &&
			!entry.includes(".int.") &&
			!dir.includes("__tests__") &&
			!dir.includes("/e2e") &&
			!dir.includes("/test")
		)
			continue;

		let content: string;
		try {
			content = readFileSync(full, "utf-8");
		} catch {
			continue;
		}
		const relPath = full.replace(`${cwd}/`, "");
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

function findSourceFiles(cwd: string, srcRoots?: string[]): string[] {
	return getProductionFiles(cwd, srcRoots).map((f) => f.path);
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

function runTestsWithCoverage(
	cwd: string,
	stack: StackInfo,
): { execution: { passed: number; failed: number; total: number } | null; coverage: CoverageData | null } {
	if (stack.testRunner === "none") return { execution: null, coverage: null };

	// Single command: run tests with JSON reporter AND coverage
	const cmd =
		stack.testRunner === "vitest"
			? "npx vitest run --reporter=json --coverage 2>/dev/null || true"
			: "npx jest --json --coverage --coverageReporters=json-summary 2>/dev/null || true";
	const { stdout } = run(cmd, cwd, 120_000);

	// Parse execution results from JSON output
	let execution: { passed: number; failed: number; total: number } | null = null;
	try {
		const jsonStart = stdout.indexOf("{");
		if (jsonStart >= 0) {
			const data = JSON.parse(stdout.slice(jsonStart));
			execution = {
				passed: data.numPassedTests || 0,
				failed: data.numFailedTests || 0,
				total: data.numTotalTests || 0,
			};
		}
	} catch {
		/* parse failed */
	}

	// Parse coverage from file
	const coverage = readCoverageFile(cwd);

	return { execution, coverage };
}

function readCoverageFile(cwd: string): CoverageData | null {
	const searchPaths = ["coverage/coverage-summary.json", "test-results/coverage/coverage-summary.json"];
	for (const p of searchPaths) {
		const full = join(cwd, p);
		if (existsSync(full)) {
			try {
				const summary = JSON.parse(readFileSync(full, "utf-8"));
				if (summary?.total) {
					return {
						statements: summary.total.statements?.pct || 0,
						lines: summary.total.lines?.pct || 0,
						branches: summary.total.branches?.pct || 0,
						functions: summary.total.functions?.pct || 0,
					};
				}
			} catch {
				/* parse failed */
			}
		}
	}
	return null;
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

export function runTesting(cwd: string, stack: StackInfo, skipExec: boolean, srcRoots?: string[]): CheckResult {
	const start = Date.now();
	const issues: Issue[] = [];

	// 1. Discover test files and classify by layer
	const testFiles = findTestFiles(cwd, srcRoots);
	const srcFiles = findSourceFiles(cwd, srcRoots);

	if (testFiles.length === 0) {
		return {
			name: "testing",
			score: 0,
			grade: "F",
			details: {
				reason: "No test files found",
				srcFiles: srcFiles.length,
				testFiles: 0,
				pyramid: { unit: 0, integration: 0, component: 0, e2e: 0 },
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

	if (!skipExec) {
		// Run tests ONCE with both coverage and JSON output
		const combined = runTestsWithCoverage(cwd, stack);
		execution = combined.execution;
		coverage = combined.coverage;

		if (execution) {
			if (execution.failed > 0) {
				issues.push({ severity: "error", message: `${execution.failed} of ${execution.total} tests failing`, rule: "failing-tests" });
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
			pairing: `${pairingPct}%`,
			quality: {
				assertionsPerTest: quality.avgAssertionsPerTest,
				mockRatio: quality.mockRatio,
				snapshotRatio: quality.snapshotRatio,
			},
			...(execution ? { passed: execution.passed, failed: execution.failed, total: execution.total } : {}),
			...(coverage
				? { coverage: { stmts: coverage.statements, branches: coverage.branches, lines: coverage.lines, fns: coverage.functions } }
				: {}),
		},
		issues,
		duration: Date.now() - start,
	};
}

function countUntestable(srcFiles: string[]): number {
	return srcFiles.filter((f) => {
		const b = basename(f).replace(/\.(ts|tsx|js|jsx)$/, "");
		return ["index", "main", "types", "constants", "config"].includes(b);
	}).length;
}
