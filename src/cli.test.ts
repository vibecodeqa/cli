import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CLI = join(import.meta.dirname!, "..", "dist", "cli.js");
const TMP = join(import.meta.dirname!, "__test_cli__");

function run(args: string): string {
	try {
		return execSync(`node ${CLI} ${args}`, { encoding: "utf-8", timeout: 30_000, cwd: TMP });
	} catch (e: any) {
		return e.stdout || e.stderr || String(e);
	}
}

beforeEach(() => {
	rmSync(TMP, { recursive: true, force: true });
	mkdirSync(join(TMP, "src"), { recursive: true });
	writeFileSync(join(TMP, "package.json"), JSON.stringify({ name: "test-project" }));
	writeFileSync(join(TMP, "src", "index.ts"), "export const x = 1;\n");
});

afterEach(() => {
	rmSync(TMP, { recursive: true, force: true });
});

describe("CLI flags", () => {
	it("--version prints version", () => {
		const out = run("--version");
		expect(out.trim()).toMatch(/^\d+\.\d+\.\d+$/);
	});

	it("-v prints version", () => {
		const out = run("-v");
		expect(out.trim()).toMatch(/^\d+\.\d+\.\d+$/);
	});

	it("--help shows usage", () => {
		const out = run("--help");
		expect(out).toContain("Usage:");
		expect(out).toContain("--skip-tests");
		expect(out).toContain("init");
		expect(out).toContain("fix");
	});

	it(
		"--json produces valid JSON",
		() => {
			const out = run("--skip-tests --json .");
			const report = JSON.parse(out);
			expect(report.version).toBeDefined();
			expect(report.score).toBeGreaterThanOrEqual(0);
			expect(report.score).toBeLessThanOrEqual(100);
			expect(report.checks).toBeInstanceOf(Array);
			expect(report.checks.length).toBe(22);
		},
		15_000,
	);

	it("nonexistent path exits with error", () => {
		const out = execSync(`node ${CLI} --skip-tests /nonexistent 2>&1 || true`, { encoding: "utf-8" });
		expect(out).toContain("does not exist");
	});
});

describe("init command", () => {
	it("creates workflow file", () => {
		const out = run("init .");
		expect(out).toContain("vibecodeqa.yml");
		expect(existsSync(join(TMP, ".github", "workflows", "vibecodeqa.yml"))).toBe(true);
		const workflow = readFileSync(join(TMP, ".github", "workflows", "vibecodeqa.yml"), "utf-8");
		expect(workflow).toContain("pull_request");
		expect(workflow).toContain("--fail-under");
	});

	it("does not overwrite existing workflow", () => {
		mkdirSync(join(TMP, ".github", "workflows"), { recursive: true });
		writeFileSync(join(TMP, ".github", "workflows", "vibecodeqa.yml"), "custom");
		run("init .");
		expect(readFileSync(join(TMP, ".github", "workflows", "vibecodeqa.yml"), "utf-8")).toBe("custom");
	});

	it("adds .vibe-check to .gitignore", () => {
		writeFileSync(join(TMP, ".gitignore"), "node_modules\n");
		run("init .");
		const gi = readFileSync(join(TMP, ".gitignore"), "utf-8");
		expect(gi).toContain(".vibe-check/");
	});

	it("skips .gitignore if no .gitignore exists", () => {
		run("init .");
		expect(existsSync(join(TMP, ".gitignore"))).toBe(false);
	});

	it("creates biome.json when biome is a dep", () => {
		writeFileSync(join(TMP, "package.json"), JSON.stringify({ devDependencies: { "@biomejs/biome": "2" } }));
		mkdirSync(join(TMP, "node_modules", "@biomejs", "biome"), { recursive: true });
		run("init .");
		expect(existsSync(join(TMP, "biome.json"))).toBe(true);
	});

	it("validates path", () => {
		const out = execSync(`node ${CLI} init /nonexistent 2>&1 || true`, { encoding: "utf-8" });
		expect(out).toContain("does not exist");
	});
});

describe("fix command", () => {
	it(
		"shows fix suggestions for empty catch",
		() => {
			writeFileSync(join(TMP, "src", "bad.ts"), "export function f() { try { x() } catch {} }\n");
			const out = run("fix .");
			expect(out).toContain("Fix:");
		},
		15_000,
	);

	it(
		"shows score after fix",
		() => {
			const out = run("fix .");
			expect(out).toContain("Score after fix:");
		},
		15_000,
	);

	it("validates path", () => {
		const out = execSync(`node ${CLI} fix /nonexistent 2>&1 || true`, { encoding: "utf-8" });
		expect(out).toContain("does not exist");
	});
});

describe("report output", () => {
	it(
		"--json produces report with 22 checks and workspace info",
		() => {
			const out = run("--skip-tests --json .");
			const report = JSON.parse(out);
			expect(report.checks.length).toBe(22);
			expect(report.meta.workspace).toBeDefined();
			expect(typeof report.meta.workspace.isMonorepo).toBe("boolean");
			// Also verify report file was written
			expect(existsSync(join(TMP, ".vibe-check", "report.json"))).toBe(true);
		},
		15_000,
	);

	it(
		"--badge and --sarif generate output files",
		() => {
			run("--skip-tests --badge --sarif .");
			expect(existsSync(join(TMP, ".vibe-check", "badge.svg"))).toBe(true);
			expect(existsSync(join(TMP, ".vibe-check", "report.sarif"))).toBe(true);
		},
		15_000,
	);
});
