import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
		// Full scan of a linter-less fixture now runs the zero-config Biome fallback
		// (a second npx tool-fetch), so allow the same headroom as other full scans.
	}, 60_000);

	it("scan with checks filter only runs specified checks", async () => {
		const report = await scan(TMP, { skipTests: true, checks: ["structure", "type-safety"] });
		expect(report.checks).toHaveLength(2);
		expect(report.checks.map((c) => c.name).sort()).toEqual(["structure", "type-safety"]);
	}, 30_000);

	it("exposes dead-code as a synthetic check without affecting score", async () => {
		const report = await scan(TMP, { skipTests: true, checks: ["performance", "dead-code"] });
		expect(report.checks.map((c) => c.name)).toEqual(["performance", "dead-code"]);
		const deadCode = report.checks.find((c) => c.name === "dead-code");
		expect(deadCode).toBeDefined();
		expect((deadCode!.details as Record<string, unknown>).synthetic).toBe(true);
		expect(report.score).toBe(report.checks.find((c) => c.name === "performance")?.score);
	}, 60_000);

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
		expect((docs as any).status).toBe("skipped");
		expect((docs!.details as Record<string, unknown>).status).toBe("skipped");
		expect(docs!.score).toBe(100);
		expect(docs!.grade).toBe("A");
	}, 30_000);

	it("uses project-level framework evidence for appliesTo gating", async () => {
		rmSync(TMP, { recursive: true, force: true });
		mkdirSync(join(TMP, "packages/web/src"), { recursive: true });
		writeFileSync(join(TMP, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
		writeFileSync(join(TMP, "packages/web/package.json"), JSON.stringify({ dependencies: { react: "^19.0.0" } }));
		writeFileSync(join(TMP, "packages/web/src/App.tsx"), "export function App() { return <div />; }\n");

		const report = await scan(TMP, { skipTests: true, checks: ["react"] });
		const react = report.checks.find((check) => check.name === "react");

		expect(react).toBeDefined();
		expect(react?.details.skipped).not.toBe(true);
		expect(react?.details.projects).toEqual([expect.objectContaining({ path: "packages/web" })]);
	}, 30_000);

	it("renders unavailable premium checks as skipped, not as failures", async () => {
		const originalKey = process.env.VCQA_PRO_KEY;
		delete process.env.VCQA_PRO_KEY;
		try {
			const report = await scan(TMP, { skipTests: true, checks: ["doc-coherence"] });
			const check = report.checks[0]!;
			expect((check.details as Record<string, unknown>).comingSoon).toBe(true);
			expect((check as any).status).toBe("unavailable");
			expect((check.details as Record<string, unknown>).status).toBe("unavailable");
			expect(check.score).toBe(100);
			expect(check.grade).toBe("A");
		} finally {
			if (originalKey === undefined) delete process.env.VCQA_PRO_KEY;
			else process.env.VCQA_PRO_KEY = originalKey;
		}
	}, 30_000);

	it("adds a normalized status to checks that run", async () => {
		const report = await scan(TMP, { skipTests: true, checks: ["structure"] });
		expect((report.checks[0] as any).status).toMatch(/^(passed|failed)$/);
		expect((report.checks[0]!.details as Record<string, unknown>).status).toBe((report.checks[0] as any).status);
	}, 30_000);

	it("emits normalized analyzer snapshots for dashboard and trend consumers", async () => {
		const report = await scan(TMP, { skipTests: true, checks: ["structure", "docs", "react"] });
		expect(report.meta.analyzerSnapshots?.map((snapshot) => snapshot.analyzerId).sort()).toEqual(["docs", "react", "structure"]);
		const structure = report.meta.analyzerSnapshots?.find((snapshot) => snapshot.analyzerId === "structure");
		expect(structure).toMatchObject({
			status: expect.stringMatching(/^(passed|failed|skipped|unavailable)$/),
			findingCount: expect.any(Number),
			severityCounts: expect.objectContaining({ error: expect.any(Number), warning: expect.any(Number), info: expect.any(Number) }),
			metrics: expect.any(Array),
			durationMs: expect.any(Number),
		});
		const react = report.meta.analyzerSnapshots?.find((snapshot) => snapshot.analyzerId === "react");
		expect(react?.status).toBe("skipped");
	}, 30_000);

	it("marks stack-gated checks as not applicable without score impact", async () => {
		const report = await scan(TMP, { skipTests: true, checks: ["flutter", "container-health"] });
		for (const check of report.checks) {
			expect((check.details as Record<string, unknown>).skipped).toBe(true);
			expect((check.details as Record<string, unknown>).scoreMode).toBe("not-applicable");
			expect((check.details as Record<string, unknown>).scoreImpact).toBe(false);
			expect(check.score).toBe(100);
		}
	}, 30_000);

	it("marks zero-weight detected stack checks as advisory instead of silently scored", async () => {
		rmSync(TMP, { recursive: true, force: true });
		mkdirSync(join(TMP, "src"), { recursive: true });
		mkdirSync(join(TMP, "migrations"), { recursive: true });
		writeFileSync(join(TMP, "package.json"), JSON.stringify({ name: "worker", devDependencies: { typescript: "^5" } }));
		writeFileSync(join(TMP, "tsconfig.json"), "{}");
		writeFileSync(
			join(TMP, "wrangler.toml"),
			'name = "worker"\nmain = "src/index.ts"\ncompatibility_date = "2026-01-01"\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "db"\ndatabase_id = "x"\n',
		);
		writeFileSync(join(TMP, "migrations", "0001_init.sql"), "CREATE TABLE users (id TEXT PRIMARY KEY);\n");
		writeFileSync(
			join(TMP, "src", "index.ts"),
			"export default { fetch(_req: Request, env: { DB: D1Database }) { return new Response('ok'); } };\n",
		);

		const report = await scan(TMP, { skipTests: true, checks: ["cloudflare-workers", "sqlite-d1"] });
		for (const check of report.checks) {
			expect((check.details as Record<string, unknown>).skipped).not.toBe(true);
			expect((check.details as Record<string, unknown>).scoreMode).toBe("available-unscored");
			expect((check.details as Record<string, unknown>).scoreImpact).toBe(false);
		}
	}, 30_000);

	it("serializes advisory stack findings as non-gating status", async () => {
		rmSync(TMP, { recursive: true, force: true });
		mkdirSync(join(TMP, "src"), { recursive: true });
		mkdirSync(join(TMP, "migrations"), { recursive: true });
		writeFileSync(join(TMP, "package.json"), JSON.stringify({ name: "worker", devDependencies: { typescript: "^5" } }));
		writeFileSync(join(TMP, "tsconfig.json"), "{}");
		writeFileSync(
			join(TMP, "wrangler.toml"),
			'name = "worker"\nmain = "src/index.ts"\ncompatibility_date = "2024-01-01"\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "db"\ndatabase_id = "x"\n',
		);
		writeFileSync(join(TMP, "migrations", "0001_init.sql"), "CREATE TABLE users (id TEXT PRIMARY KEY);\n");
		writeFileSync(
			join(TMP, "src", "index.ts"),
			"export default { fetch(_req: Request, env: { DB: D1Database }, id = 'u1') { return env.DB.prepare(`SELECT id FROM users WHERE id = '$" +
				"{id}'`).first(); } };\n",
		);

		const report = await scan(TMP, { skipTests: true, checks: ["cloudflare-workers", "sqlite-d1"] });

		for (const check of report.checks) {
			expect(check.issues.length).toBeGreaterThan(0);
			expect((check as any).status).toBe("passed");
			expect((check.details as Record<string, unknown>).status).toBe("passed");
			expect((check.details as Record<string, unknown>).scoreMode).toBe("available-unscored");
			expect((check.details as Record<string, unknown>).scoreImpact).toBe(false);
			expect((check.details as Record<string, unknown>).advisoryFindings).toBe(true);
		}
		expect(report.meta.analyzerSnapshots?.map((snapshot) => snapshot.status)).toEqual(["passed", "passed"]);
	}, 30_000);

	it("serializes html-quality advisory findings as non-gating status", async () => {
		rmSync(TMP, { recursive: true, force: true });
		mkdirSync(TMP, { recursive: true });
		writeFileSync(join(TMP, "package.json"), JSON.stringify({ name: "html-site" }));
		writeFileSync(join(TMP, "index.html"), '<!DOCTYPE html><html><head></head><body><img src="hero.png"></body></html>');

		const report = await scan(TMP, { skipTests: true, checks: ["html-quality"] });
		const html = report.checks[0]!;

		expect(html.issues.length).toBeGreaterThan(0);
		expect(html.score).toBeLessThan(60);
		expect((html as any).status).toBe("passed");
		expect((html.details as Record<string, unknown>).status).toBe("passed");
		expect((html.details as Record<string, unknown>).scoreMode).toBe("available-unscored");
		expect((html.details as Record<string, unknown>).scoreImpact).toBe(false);
		expect((html.details as Record<string, unknown>).advisoryFindings).toBe(true);
		expect(report.meta.analyzerSnapshots?.[0]?.status).toBe("passed");
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

	it("bases filesScanned on the effective inventory instead of generated outputs", async () => {
		mkdirSync(join(TMP, "dist"), { recursive: true });
		mkdirSync(join(TMP, ".claude", "worktrees", "agent", "src"), { recursive: true });
		writeFileSync(join(TMP, "dist", "generated.ts"), "export const generated = 1;\n");
		writeFileSync(join(TMP, ".claude", "worktrees", "agent", "src", "copy.ts"), "export const copy = 1;\n");

		const report = await scan(TMP, { skipTests: true, checks: ["structure"] });

		expect(report.meta.filesScanned).toBe(1);
		expect(report.meta.fileInventory).toMatchObject({
			includedFiles: expect.any(Number),
			ignoredFiles: expect.any(Number),
			ignoredDirectories: expect.any(Number),
		});
	}, 30_000);

	it("attaches tool provenance to the check that shelled out", async () => {
		// `types` runs tsc. Whatever the verdict, the report must record that the
		// tool ran and where — otherwise the result cannot be checked.
		const report = await scan(process.cwd(), { skipTests: true, checks: ["types"] });
		const types = report.checks.find((c) => c.name === "types");
		const runs = (types?.details as Record<string, unknown>).toolRuns as
			| {
					analyzerId: string;
					projectId: string;
					projectPath: string;
					command: string;
					cwd: string;
					status: string;
					durationMs: number;
					output: string;
			  }[]
			| undefined;
		expect(Array.isArray(runs)).toBe(true);
		expect(runs?.length).toBeGreaterThan(0);
		expect(runs?.[0].analyzerId).toBe("types");
		expect(runs?.[0].projectId).toBeTruthy();
		expect(runs?.[0].projectPath).toBeTruthy();
		expect(runs?.[0].cwd).toBeTruthy();
		expect(runs?.[0].command).toBeTruthy();
		expect(runs?.[0].status).toMatch(/^(success|failed)$/);
		expect(runs?.[0].durationMs).toBeGreaterThanOrEqual(0);
		expect(typeof runs?.[0].output).toBe("string");
	}, 120_000);

	it("tags monorepo tool runs by analyzer and project without leaking to skipped checks", async () => {
		rmSync(TMP, { recursive: true, force: true });
		mkdirSync(join(TMP, "bin"), { recursive: true });
		mkdirSync(join(TMP, "packages/api/src"), { recursive: true });
		mkdirSync(join(TMP, "packages/web/src"), { recursive: true });
		writeFileSync(join(TMP, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
		writeFileSync(join(TMP, "packages/api/package.json"), JSON.stringify({ name: "api", devDependencies: { typescript: "^5" } }));
		writeFileSync(join(TMP, "packages/api/tsconfig.json"), JSON.stringify({ include: ["src/**/*.ts"] }));
		writeFileSync(join(TMP, "packages/api/src/index.ts"), "export const api = 1;\n");
		writeFileSync(join(TMP, "packages/web/package.json"), JSON.stringify({ name: "web", devDependencies: { typescript: "^5" } }));
		writeFileSync(join(TMP, "packages/web/tsconfig.json"), JSON.stringify({ include: ["src/**/*.ts"] }));
		writeFileSync(join(TMP, "packages/web/src/index.ts"), "export const web = 1;\n");
		const fakeNpx = join(TMP, "bin", "npx");
		writeFileSync(fakeNpx, '#!/bin/sh\necho "fake-npx:$PWD:$*"\nexit 0\n');
		chmodSync(fakeNpx, 0o755);

		const originalPath = process.env.PATH;
		process.env.PATH = `${join(TMP, "bin")}:${originalPath ?? ""}`;
		try {
			const report = await scan(TMP, { skipTests: true, checks: ["types", "flutter"] });
			const types = report.checks.find((check) => check.name === "types");
			const flutter = report.checks.find((check) => check.name === "flutter");
			const runs = (types?.details as Record<string, unknown>).toolRuns as
				| {
						analyzerId: string;
						projectId: string;
						projectPath: string;
						command: string;
						cwd: string;
						status: string;
						durationMs: number;
						output: string;
				  }[]
				| undefined;

			expect(runs).toHaveLength(2);
			expect(runs?.map((run) => run.analyzerId)).toEqual(["types", "types"]);
			expect(runs?.map((run) => run.projectPath).sort()).toEqual(["packages/api", "packages/web"]);
			expect(runs?.map((run) => run.projectId).sort()).toEqual(["packages-api", "packages-web"]);
			for (const run of runs ?? []) {
				expect(run.command).toBe("npx tsc --noEmit 2>&1 || true");
				expect(run.cwd).toContain(join(TMP, run.projectPath));
				expect(run.status).toBe("success");
				expect(run.durationMs).toBeGreaterThanOrEqual(0);
				expect(run.output).toContain("fake-npx:");
			}
			expect((flutter?.details as Record<string, unknown>).skipped).toBe(true);
			expect((flutter?.details as Record<string, unknown>).toolRuns).toBeUndefined();
		} finally {
			if (originalPath === undefined) delete process.env.PATH;
			else process.env.PATH = originalPath;
		}
	}, 30_000);

	it("does not attach empty provenance to purely built-in checks", async () => {
		// confusion is pure in-process analysis — an empty toolRuns array would be
		// noise in every report.
		const report = await scan(process.cwd(), { skipTests: true, checks: ["confusion"] });
		const c = report.checks.find((x) => x.name === "confusion");
		expect((c?.details as Record<string, unknown>).toolRuns).toBeUndefined();
	}, 60_000);
});
