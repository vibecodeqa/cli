/** vibecodeqa/cli#106 — a test run that hits its time limit is "not run", not
 * "failed", and leaves nothing behind.
 *
 * The fixture's `vitest` is a local fake (node_modules/vitest), so `npx vitest`
 * resolves it without a download. It starts a grandchild (`sleep`), records
 * both pids, then waits the number of ms in `fake-sleep-ms` before printing a
 * passing vitest JSON report and a fresh coverage summary. A stale coverage
 * summary is on disk before the run.
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scan } from "../core.js";
import type { ToolRun } from "./exec.js";
import { resolveTestTimeout } from "./testing.js";

const FAKE_VITEST = `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const sleepMs = Number(readFileSync("fake-sleep-ms", "utf-8"));
const grandchild = spawn("sleep", ["60"], { stdio: "ignore" });
writeFileSync("pids.json", JSON.stringify({ fake: process.pid, grandchild: grandchild.pid }));
setTimeout(() => {
	grandchild.kill("SIGKILL");
	mkdirSync("coverage", { recursive: true });
	const pct = { pct: 90 };
	writeFileSync("coverage/coverage-summary.json", JSON.stringify({ total: { statements: pct, lines: pct, branches: pct, functions: pct } }));
	console.log(JSON.stringify({ numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, testResults: [] }));
}, sleepMs);
`;

const STALE_PCT = { pct: 42 };
const STALE_COVERAGE = { total: { statements: STALE_PCT, lines: STALE_PCT, branches: STALE_PCT, functions: STALE_PCT } };

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeFixture(sleepMs: number, settings?: Record<string, unknown>): string {
	const dir = mkdtempSync(join(tmpdir(), "vcqa-timeout-"));
	dirs.push(dir);
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "timeout-fixture", devDependencies: { vitest: "1.0.0" } }));
	if (settings) writeFileSync(join(dir, ".vcqa.json"), JSON.stringify({ checks: { testing: { settings } } }));
	mkdirSync(join(dir, "src"));
	writeFileSync(join(dir, "src/app.ts"), "export const x = 1;\n");
	writeFileSync(
		join(dir, "src/app.test.ts"),
		"import { expect, it } from 'vitest';\nimport { x } from './app';\nit('works as expected', () => { expect(x).toBe(1); });\n",
	);
	mkdirSync(join(dir, "coverage"));
	writeFileSync(join(dir, "coverage/coverage-summary.json"), JSON.stringify(STALE_COVERAGE));
	writeFileSync(join(dir, "fake-sleep-ms"), String(sleepMs));
	mkdirSync(join(dir, "node_modules/vitest"), { recursive: true });
	mkdirSync(join(dir, "node_modules/.bin"), { recursive: true });
	writeFileSync(
		join(dir, "node_modules/vitest/package.json"),
		JSON.stringify({ name: "vitest", version: "1.0.0", bin: { vitest: "cli.js" } }),
	);
	writeFileSync(join(dir, "node_modules/vitest/cli.js"), FAKE_VITEST);
	chmodSync(join(dir, "node_modules/vitest/cli.js"), 0o755);
	symlinkSync("../vitest/cli.js", join(dir, "node_modules/.bin/vitest"));
	return dir;
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function scanTesting(dir: string, testTimeoutMs?: number) {
	const report = await scan(dir, { checks: ["testing"], testTimeoutMs });
	const check = report.checks.find((c) => c.name === "testing");
	if (!check) throw new Error("testing check missing");
	const details = check.details as Record<string, any>;
	return { check, details, toolRuns: (details.toolRuns ?? []) as ToolRun[] };
}

describe("test run timeout (#106)", () => {
	it.skipIf(process.platform === "win32")(
		"a run past the configured limit is a warning, scores like --skip-tests, reads no coverage and leaves no process",
		async () => {
			const dir = makeFixture(30_000, { timeoutMs: 2000 });
			const { check, details, toolRuns } = await scanTesting(dir);

			const run = toolRuns.find((r) => r.tool === "vitest");
			expect(run).toMatchObject({ status: "timeout", timedOut: true, timeoutMs: 2000, ok: false });
			expect(run?.durationMs).toBeLessThan(10_000);

			expect(details.testTimeoutMs).toBe(2000);
			expect(details.testTimeoutSource).toBe("config");
			expect(details.executionStatus).toBe("timeout");
			expect(details.testProjects).toHaveLength(1);
			expect(details.testProjects[0]).toMatchObject({
				status: "timeout",
				statusLabel: "timed out after 2 s",
				timeoutMs: 2000,
				coverageStatus: "not-reported",
				coverage: null,
			});
			// The stale 42% summary on disk was not read.
			expect(details.coverage).toBeUndefined();

			const timeoutIssues = check.issues.filter((i) => i.rule === "test-run-timeout");
			expect(timeoutIssues).toHaveLength(1);
			expect(timeoutIssues[0].severity).toBe("warning");
			expect(check.issues.some((i) => i.rule === "test-run-command-failed")).toBe(false);

			// Execution scored as for --skip-tests: same fixture, same static
			// points, and --skip-tests gets 10/20 for execution plus whatever the
			// stale coverage file is worth (which the timed-out scan must not get).
			const skipped = await scan(dir, { checks: ["testing"], skipTests: true });
			const skippedCheck = skipped.checks.find((c) => c.name === "testing");
			const avgStale = 42;
			const staleCoveragePoints = Math.round((avgStale / 100) * 20);
			expect(check.score).toBe((skippedCheck?.score ?? 0) - staleCoveragePoints);

			// Nothing from the timed-out run survives scan().
			const pids = JSON.parse(readFileSync(join(dir, "pids.json"), "utf-8")) as { fake: number; grandchild: number };
			expect(isAlive(pids.fake)).toBe(false);
			expect(isAlive(pids.grandchild)).toBe(false);
		},
		30_000,
	);

	it.skipIf(process.platform === "win32")(
		"the same fixture passes with a larger limit from --test-timeout",
		async () => {
			const dir = makeFixture(2500, { timeoutMs: 2000 });
			const { check, details, toolRuns } = await scanTesting(dir, 15_000);

			const run = toolRuns.find((r) => r.tool === "vitest");
			expect(run).toMatchObject({ status: "success", ok: true });
			expect(run?.timedOut).toBeUndefined();
			expect(details.testTimeoutMs).toBe(15_000);
			expect(details.testTimeoutSource).toBe("flag");
			expect(details.testProjects[0]).toMatchObject({ status: "passed", coverageStatus: "reported" });
			expect(details.testProjects[0].timeoutMs).toBeUndefined();
			expect(details.coverage).toMatchObject({ stmts: 90 });
			expect(check.issues.some((i) => i.rule === "test-run-timeout")).toBe(false);
			expect(existsSync(join(dir, "pids.json"))).toBe(true);
		},
		30_000,
	);
});

describe("resolveTestTimeout", () => {
	it("defaults to 120 s", () => {
		expect(resolveTestTimeout()).toEqual({ ms: 120_000, source: "default" });
	});

	it("prefers the flag over the setting", () => {
		expect(resolveTestTimeout({ timeoutMs: 5000, settings: { timeoutMs: 9000 } })).toEqual({ ms: 5000, source: "flag" });
		expect(resolveTestTimeout({ settings: { timeoutMs: 9000 } })).toEqual({ ms: 9000, source: "config" });
	});

	it("falls back to the default for an invalid setting and says so", () => {
		expect(resolveTestTimeout({ settings: { timeoutMs: "fast" } })).toEqual({ ms: 120_000, source: "default", invalidSetting: "fast" });
		expect(resolveTestTimeout({ settings: { timeoutMs: -1 } })).toMatchObject({ ms: 120_000, source: "default" });
		expect(resolveTestTimeout({ settings: { timeoutMs: 1.5 } })).toMatchObject({ ms: 120_000, source: "default" });
	});

	it("accepts up to 2^31-1 ms and rejects anything a timer would fire at once", () => {
		expect(resolveTestTimeout({ settings: { timeoutMs: 2 ** 31 - 1 } })).toEqual({ ms: 2 ** 31 - 1, source: "config" });
		expect(resolveTestTimeout({ settings: { timeoutMs: 3e9 } })).toEqual({ ms: 120_000, source: "default", invalidSetting: 3e9 });
		expect(resolveTestTimeout({ timeoutMs: 2 ** 31, settings: { timeoutMs: 9000 } })).toEqual({ ms: 9000, source: "config" });
	});
});
