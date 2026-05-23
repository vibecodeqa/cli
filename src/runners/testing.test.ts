import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setGlobalSrcRoots } from "../fs-utils.js";
import type { StackInfo } from "../types.js";
import { runTesting } from "./testing.js";

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
		expect(result.score).toBeGreaterThan(0);
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
