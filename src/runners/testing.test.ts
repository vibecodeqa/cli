import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectWorkspace } from "../detect.js";
import { buildFileInventory } from "../file-inventory.js";
import { setGlobalSrcRoots } from "../fs-utils.js";
import { buildEffectiveScanPolicy } from "../scan-policy.js";
import type { StackInfo } from "../types.js";
import {
	normalizeTestProjectReport,
	parseTestExecutionJson,
	parseTestExecutionReport,
	runTesting,
	summarizeTestProjectStatus,
	testRunTargets,
} from "./testing.js";

const tsStack: StackInfo = {
	language: "typescript",
	framework: "none",
	bundler: "none",
	testRunner: "vitest",
	linter: "none",
	packageManager: "npm",
};

function makeProject(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "vcqa-test-"));
	writeFileSync(join(dir, "package.json"), "{}");
	for (const [name, content] of Object.entries(files)) {
		const full = join(dir, name);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, content);
	}
	return dir;
}

afterEach(() => setGlobalSrcRoots(undefined));

describe("runTesting", () => {
	it("reports zero tests when none exist", () => {
		const dir = makeProject({
			"src/app.ts": "export const x = 1;\n",
			"src/utils.ts": "export const y = 2;\n",
		});
		const result = runTesting(dir, tsStack, true);
		expect(result.score).toBe(0);
		expect((result.details as any).testFiles).toBe(0);
		rmSync(dir, { recursive: true });
	});

	it("detects unit test files", () => {
		const dir = makeProject({
			"src/app.ts": "export const x = 1;\n",
			"src/app.test.ts":
				"import { describe, it, expect } from 'vitest';\ndescribe('app', () => { it('works', () => { expect(1).toBe(1); }); });\n",
		});
		const result = runTesting(dir, tsStack, true);
		expect((result.details as any).testFiles).toBe(1);
		expect((result.details as any).pyramid.unit).toBe(1);
		expect(result.score).toBeGreaterThan(0);
		rmSync(dir, { recursive: true });
	});

	it("classifies e2e tests", () => {
		const dir = makeProject({
			"src/app.ts": "export const x = 1;\n",
			"e2e/app.e2e.ts":
				"import { test } from '@playwright/test';\ntest('page', async ({ page }) => { await page.goto('/'); expect(page).toBeTruthy(); });\n",
		});
		const result = runTesting(dir, tsStack, true);
		expect((result.details as any).pyramid.e2e).toBe(1);
		rmSync(dir, { recursive: true });
	});

	it("measures test pairing", () => {
		const dir = makeProject({
			"src/auth.ts": "export function login() {}",
			"src/auth.test.ts":
				"import { describe, it, expect } from 'vitest';\ndescribe('auth', () => { it('works', () => { expect(1).toBe(1); }); });\n",
			"src/db.ts": "export function query() {}",
			// db.ts has no test pair
		});
		const result = runTesting(dir, tsStack, true);
		expect((result.details as any).pairing).toBe("50%");
		rmSync(dir, { recursive: true });
	});

	it("counts assertions", () => {
		const dir = makeProject({
			"src/app.ts": "export const x = 1;\n",
			"src/app.test.ts": [
				"import { describe, it, expect } from 'vitest';",
				"describe('app', () => {",
				"  it('test1', () => { expect(1).toBe(1); expect(2).toBe(2); });",
				"  it('test2', () => { expect(3).toBe(3); });",
				"});",
			].join("\n"),
		});
		const result = runTesting(dir, tsStack, true);
		expect((result.details as any).quality.assertionsPerTest).toBeGreaterThanOrEqual(1);
		rmSync(dir, { recursive: true });
	});

	it("finds tests via monorepo srcRoots", () => {
		const dir = makeProject({
			"packages/sdk/src/index.ts": "export const x = 1;",
			"packages/sdk/src/index.test.ts":
				"import { describe, it, expect } from 'vitest';\ndescribe('sdk', () => { it('works', () => { expect(1).toBe(1); }); });\n",
		});
		const srcRoots = ["packages/sdk/src"];
		setGlobalSrcRoots(srcRoots);
		const result = runTesting(dir, tsStack, true, srcRoots);
		expect((result.details as any).testFiles).toBe(1);
		rmSync(dir, { recursive: true });
	});

	it("uses FileInventory for static file discovery and skips ignored/generated tests", () => {
		const dir = makeProject({
			"src/app.ts": "export const app = 1;\n",
			"src/app.test.ts": "import { test, expect } from 'vitest';\ntest('app works', () => { expect(1).toBe(1); });\n",
			"dist/generated.test.ts": "test('generated', () => {});\n",
			".claude/worktrees/agent-a/src/generated.test.ts": "test('agent output', () => {});\n",
		});
		const inventory = buildFileInventory(dir, detectWorkspace(dir), buildEffectiveScanPolicy(dir, {}));
		const result = runTesting(dir, tsStack, true, undefined, undefined, inventory);
		expect(result.details).toMatchObject({ source: "file-inventory", srcFiles: 1, testFiles: 1 });
		expect(result.issues.some((i) => i.file?.includes(".claude/worktrees") || i.file?.startsWith("dist/"))).toBe(false);
		rmSync(dir, { recursive: true });
	});

	it("plans test execution from project contexts before srcRoots fallback", () => {
		const dir = makeProject({
			"pnpm-workspace.yaml": "packages:\n  - packages/*\n",
			"packages/api/package.json": JSON.stringify({ name: "api", devDependencies: { jest: "^30" } }),
			"packages/api/src/index.ts": "export const x = 1;",
			"packages/api/src/index.test.ts": "test('x', () => expect(1).toBe(1));",
			"packages/web/package.json": JSON.stringify({ name: "web", dependencies: { react: "^19" }, devDependencies: { vitest: "^4" } }),
			"packages/web/src/App.tsx": "export const App = () => null;",
			"packages/web/src/App.test.tsx": "import { test, expect } from 'vitest'; test('x', () => expect(1).toBe(1));",
		});
		const workspace = detectWorkspace(dir);
		const targets = testRunTargets(dir, ["packages/api/src", "packages/web/src"], workspace);
		expect(targets.map((t) => `${t.projectPath}:${t.runner}`).sort()).toEqual(["packages/api:jest", "packages/web:vitest"]);
		rmSync(dir, { recursive: true });
	});

	it("reads existing coverage when skipping tests", () => {
		const dir = makeProject({
			"src/app.ts": "export const x = 1;",
			"src/app.test.ts":
				"import { describe, it, expect } from 'vitest';\ndescribe('app', () => { it('works', () => { expect(1).toBe(1); }); });\n",
			"coverage/coverage-summary.json": JSON.stringify({
				total: { statements: { pct: 85 }, branches: { pct: 70 }, lines: { pct: 88 }, functions: { pct: 92 } },
			}),
		});
		const result = runTesting(dir, tsStack, true); // skipExec=true
		expect((result.details as any).coverage).toBeDefined();
		expect((result.details as any).coverage.stmts).toBe(85);
		expect((result.details as any).executionSkipped).toBe(true);
		expect((result.details as any).executionSkipReason).toMatch(/--skip-tests/);
		expect(result.score).toBeGreaterThan(0);
		rmSync(dir, { recursive: true });
	});

	it("normalizes non-numeric coverage percentages", () => {
		const dir = makeProject({
			"src/app.ts": "export const x = 1;",
			"src/app.test.ts":
				"import { describe, it, expect } from 'vitest';\ndescribe('app', () => { it('works', () => { expect(1).toBe(1); }); });\n",
			"coverage/coverage-summary.json": JSON.stringify({
				total: {
					statements: { pct: "Unknown" },
					branches: { pct: "Unknown" },
					lines: { pct: "Unknown" },
					functions: { pct: "Unknown" },
				},
			}),
		});
		const result = runTesting(dir, tsStack, true);
		expect(Number.isFinite(result.score)).toBe(true);
		expect((result.details as any).coverage).toMatchObject({ stmts: 0, branches: 0, lines: 0, fns: 0 });
		rmSync(dir, { recursive: true });
	});

	it("reads coverage from a workspace package when root scope is scanned", () => {
		const dir = makeProject({
			"app/package.json": JSON.stringify({ devDependencies: { vitest: "^4" } }),
			"app/src/app.ts": "export const x = 1;",
			"app/src/app.test.ts":
				"import { describe, it, expect } from 'vitest';\ndescribe('app', () => { it('works', () => { expect(1).toBe(1); }); });\n",
			"app/coverage/coverage-summary.json": JSON.stringify({
				total: { statements: { pct: 74 }, branches: { pct: 61 }, lines: { pct: 76 }, functions: { pct: 80 } },
			}),
		});
		const result = runTesting(dir, tsStack, true, ["app"]);
		expect((result.details as any).coverage).toMatchObject({ stmts: 74, branches: 61, lines: 76, fns: 80 });
		rmSync(dir, { recursive: true });
	});

	it("reads lcov.info when skipping tests", () => {
		const lcov = "SF:src/app.ts\nLF:10\nLH:8\nBRF:4\nBRH:3\nFNF:2\nFNH:2\nend_of_record\n";
		const dir = makeProject({
			"src/app.ts": "export const x = 1;",
			"src/app.test.ts":
				"import { describe, it, expect } from 'vitest';\ndescribe('app', () => { it('works', () => { expect(1).toBe(1); }); });\n",
			"coverage/lcov.info": lcov,
		});
		const result = runTesting(dir, tsStack, true);
		expect((result.details as any).coverage).toBeDefined();
		expect((result.details as any).coverage.lines).toBe(80);
		rmSync(dir, { recursive: true });
	});

	it("parses vitest json when coverage text follows the json object", () => {
		const output = [
			"noise before json",
			'{"numTotalTests":1616,"numPassedTests":1616,"numFailedTests":0,"testResults":[{"name":"x","status":"passed"}]}',
			"% Coverage report from v8",
		].join("\n");
		expect(parseTestExecutionJson(output)).toEqual({ passed: 1616, failed: 0, total: 1616 });
	});

	it("compacts vitest json into suite and test drill-down data", () => {
		const output = JSON.stringify({
			numTotalTests: 2,
			numPassedTests: 1,
			numFailedTests: 1,
			testResults: [
				{
					name: "/tmp/project/src/math.test.ts",
					status: "failed",
					startTime: 1000,
					endTime: 1250,
					assertionResults: [
						{
							ancestorTitles: ["math"],
							title: "adds",
							fullName: "math adds",
							status: "passed",
							duration: 2.25,
							failureMessages: [],
						},
						{
							ancestorTitles: ["math"],
							title: "subtracts",
							fullName: "math subtracts",
							status: "failed",
							duration: 9,
							failureMessages: ["expected 1 to be 2"],
						},
					],
				},
			],
		});
		const report = parseTestExecutionReport(output, "/tmp/project");
		expect(report).toMatchObject({ passed: 1, failed: 1, total: 2 });
		expect(report?.suites[0]).toMatchObject({ file: "src/math.test.ts", failed: 1, total: 2, durationMs: 250 });
		expect(report?.failures[0]).toMatchObject({ file: "src/math.test.ts", name: "math subtracts", error: "expected 1 to be 2" });
		expect(report?.slowest[0]).toMatchObject({ name: "math subtracts", durationMs: 9 });
	});

	it("normalizes suite paths from package cwd to repo-root paths", () => {
		const output = JSON.stringify({
			numTotalTests: 1,
			numPassedTests: 1,
			numFailedTests: 0,
			testResults: [{ name: "src/index.test.ts", status: "passed", assertionResults: [] }],
		});
		const report = parseTestExecutionReport(output, "/repo/agents/coder/web", "/repo");
		expect(report?.suites[0].file).toBe("agents/coder/web/src/index.test.ts");
	});

	it("normalizes parent-relative suite paths that resolve inside the repo", () => {
		const output = JSON.stringify({
			numTotalTests: 1,
			numPassedTests: 1,
			numFailedTests: 0,
			testResults: [{ name: "../../agents/coder/web/src/copilot.test.ts", status: "passed", assertionResults: [] }],
		});
		const report = parseTestExecutionReport(output, "/repo/store/console", "/repo");
		expect(report?.suites[0].file).toBe("agents/coder/web/src/copilot.test.ts");
	});

	it("normalizes mixed monorepo package test outcomes", () => {
		const zeroOutput = JSON.stringify({ numTotalTests: 0, numPassedTests: 0, numFailedTests: 0, testResults: [] });
		const passedOutput = JSON.stringify({
			numTotalTests: 7,
			numPassedTests: 7,
			numFailedTests: 0,
			testResults: [{ name: "src/assistant.test.ts", status: "passed", assertionResults: [] }],
		});
		const projects = [
			normalizeTestProjectReport({
				target: {
					cwd: "/repo/packages/browser-runner",
					runner: "vitest",
					projectId: "packages-browser-runner",
					projectPath: "packages/browser-runner",
				},
				command: "npx vitest run --reporter=json --coverage",
				report: parseTestExecutionReport(zeroOutput, "/repo/packages/browser-runner", "/repo"),
				executionOk: true,
				coverage: null,
			}),
			normalizeTestProjectReport({
				target: {
					cwd: "/repo/packages/compliance",
					runner: "vitest",
					projectId: "packages-compliance",
					projectPath: "packages/compliance",
				},
				command: "npx vitest run --reporter=json --coverage",
				report: parseTestExecutionReport(zeroOutput, "/repo/packages/compliance", "/repo"),
				executionOk: true,
				coverage: null,
			}),
			normalizeTestProjectReport({
				target: {
					cwd: "/repo/agents/job-application-assistant",
					runner: "vitest",
					projectId: "agents-job-application-assistant",
					projectPath: "agents/job-application-assistant",
				},
				command: "npx vitest run --reporter=json --coverage",
				report: parseTestExecutionReport(passedOutput, "/repo/agents/job-application-assistant", "/repo"),
				executionOk: true,
				coverage: null,
			}),
		];

		expect(projects.map((project) => [project.path, project.status, project.passed, project.total, project.coverageStatus])).toEqual([
			["packages/browser-runner", "no-tests-matched", 0, 0, "not-reported"],
			["packages/compliance", "no-tests-matched", 0, 0, "not-reported"],
			["agents/job-application-assistant", "passed", 7, 7, "not-reported"],
		]);
		expect(summarizeTestProjectStatus(projects)).toBe("partial");
		expect(Number.isFinite(projects.reduce((sum, project) => sum + project.total, 0))).toBe(true);
	});

	it("separates parse failures, command failures, skipped execution, and reported coverage", () => {
		const coverage = { statements: 80, branches: 70, lines: 82, functions: 90 };
		const parseFailed = normalizeTestProjectReport({
			target: { cwd: "/repo/packages/api", runner: "vitest", projectId: "api", projectPath: "packages/api" },
			command: "npx vitest run --reporter=json --coverage",
			report: null,
			executionOk: true,
			coverage: null,
		});
		const commandFailed = normalizeTestProjectReport({
			target: { cwd: "/repo/packages/web", runner: "vitest", projectId: "web", projectPath: "packages/web" },
			command: "npx vitest run --reporter=json --coverage",
			report: null,
			executionOk: false,
			coverage: null,
		});
		const skipped = normalizeTestProjectReport({
			target: { cwd: "/repo/packages/sdk", runner: "vitest", projectId: "sdk", projectPath: "packages/sdk" },
			command: null,
			report: null,
			executionOk: null,
			coverage,
			skipped: true,
		});

		expect(parseFailed).toMatchObject({ status: "parse-failed", reportParsed: false, coverageStatus: "not-reported" });
		expect(commandFailed).toMatchObject({ status: "command-failed", reportParsed: false, coverageStatus: "not-reported" });
		expect(skipped).toMatchObject({ status: "skipped", command: null, executionOk: null, coverageStatus: "reported", coverage });
		expect(summarizeTestProjectStatus([skipped])).toBe("skipped");
	});

	it("handles empty project", () => {
		const dir = makeProject({});
		const result = runTesting(dir, tsStack, true);
		expect(result.score).toBe(0);
		rmSync(dir, { recursive: true });
	});

	it("does not false-match test dirs in project path", () => {
		// Create test files ONLY in src/, not in a "/test" path segment
		const dir = makeProject({
			"src/app.ts": "export const x = 1;",
			"src/helpers.ts": "export function h() { return 1; }",
		});
		const result = runTesting(dir, tsStack, true);
		// helpers.ts should NOT be classified as a test file even if temp dir contains "test" substring
		expect((result.details as any).testFiles).toBe(0);
		rmSync(dir, { recursive: true });
	});
});
