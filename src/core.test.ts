import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CHECK_META, computeScore, gradeFromScore, scan } from "./core.js";

const TMP = join(import.meta.dirname!, "__test_core__");

beforeEach(() => {
	rmSync(TMP, { recursive: true, force: true });
	mkdirSync(join(TMP, "src"), { recursive: true });
	writeFileSync(join(TMP, "package.json"), JSON.stringify({ name: "test-project" }));
	writeFileSync(join(TMP, "src", "index.ts"), "export const x = 1;\n");
});

afterEach(() => {
	rmSync(TMP, { recursive: true, force: true });
});

describe("core API", () => {
	it("scan returns a VibeReport with score and checks", async () => {
		const report = await scan(TMP, { skipTests: true });
		expect(report.score).toBeGreaterThanOrEqual(0);
		expect(report.score).toBeLessThanOrEqual(100);
		expect(report.grade).toMatch(/^[A-F]$/);
		expect(report.checks.length).toBeGreaterThan(0);
		expect(report.version).toBeDefined();
		expect(report.timestamp).toBeDefined();
		expect(report.meta.stack).toBeDefined();
		expect(report.meta.duration).toBeGreaterThan(0);
	}, 30_000);

	it("scan with checks filter only runs specified checks", async () => {
		const report = await scan(TMP, { skipTests: true, checks: ["structure", "type-safety"] });
		expect(report.checks).toHaveLength(2);
		expect(report.checks.map((c) => c.name).sort()).toEqual(["structure", "type-safety"]);
	}, 30_000);

	it("scan calls onProgress for each check", async () => {
		const progress: string[] = [];
		await scan(TMP, {
			skipTests: true,
			checks: ["structure", "docs"],
			onProgress: (check) => progress.push(check),
		});
		expect(progress).toEqual(["structure", "docs"]);
	}, 30_000);

	it("scan respects config disabling checks", async () => {
		const report = await scan(TMP, {
			skipTests: true,
			checks: ["structure", "docs"],
			config: { checks: { docs: { enabled: false } } },
		});
		const docs = report.checks.find((c) => c.name === "docs");
		expect(docs).toBeDefined();
		expect((docs!.details as Record<string, unknown>).skipped).toBe(true);
	}, 30_000);

	it("produces no console output", async () => {
		const origLog = console.log;
		const origWrite = process.stdout.write;
		let output = "";
		console.log = (...args: unknown[]) => {
			output += args.join(" ");
		};
		process.stdout.write = ((chunk: unknown) => {
			output += String(chunk);
			return true;
		}) as typeof process.stdout.write;
		try {
			await scan(TMP, { skipTests: true, checks: ["structure"] });
		} finally {
			console.log = origLog;
			process.stdout.write = origWrite;
		}
		expect(output).toBe("");
	}, 30_000);
});

describe("re-exports", () => {
	it("CHECK_META covers the whole runner registry (count sanity, >= 35)", () => {
		expect(Object.keys(CHECK_META).length).toBeGreaterThanOrEqual(35);
	});

	it("computeScore works", () => {
		const score = computeScore([{ name: "testing", score: 80, grade: "B", details: {}, issues: [], duration: 0 }]);
		expect(score).toBe(80);
	});

	it("gradeFromScore works", () => {
		expect(gradeFromScore(95)).toBe("A");
		expect(gradeFromScore(50)).toBe("D");
	});
});

describe("auditability", () => {
	it("reports how many source files the scan walked", async () => {
		const report = await scan(process.cwd(), { skipTests: true, checks: ["structure"] });
		expect(report.meta.filesScanned).toBeGreaterThan(0);
	}, 60_000);

	it("attaches tool provenance to the check that shelled out", async () => {
		// `types` runs tsc. Whatever the verdict, the report must record that the
		// tool ran and where — otherwise the result cannot be checked.
		const report = await scan(process.cwd(), { skipTests: true, checks: ["types"] });
		const types = report.checks.find((c) => c.name === "types");
		const runs = (types?.details as Record<string, unknown>).toolRuns as { command: string; cwd: string }[] | undefined;
		expect(Array.isArray(runs)).toBe(true);
		expect(runs?.length).toBeGreaterThan(0);
		expect(runs?.[0].cwd).toBeTruthy();
		expect(runs?.[0].command).toBeTruthy();
	}, 120_000);

	it("does not attach empty provenance to purely built-in checks", async () => {
		// confusion is pure in-process analysis — an empty toolRuns array would be
		// noise in every report.
		const report = await scan(process.cwd(), { skipTests: true, checks: ["confusion"] });
		const c = report.checks.find((x) => x.name === "confusion");
		expect((c?.details as Record<string, unknown>).toolRuns).toBeUndefined();
	}, 60_000);
});
