import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectWorkspace } from "../detect.js";
import { buildFileInventory } from "../file-inventory.js";
import { setGlobalSrcRoots } from "../fs-utils.js";
import { buildEffectiveScanPolicy } from "../scan-policy.js";
import type { StackInfo, WorkspaceInfo } from "../types.js";
import { runStructure } from "./structure.js";

const tsStack: StackInfo = {
	language: "typescript",
	framework: "none",
	bundler: "none",
	testRunner: "none",
	linter: "none",
	packageManager: "npm",
};

function makeProject(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "vcqa-struct-"));
	for (const [name, content] of Object.entries(files)) {
		const full = join(dir, name);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, content);
	}
	return dir;
}

function makeInventory(dir: string) {
	return buildFileInventory(dir, detectWorkspace(dir), buildEffectiveScanPolicy(dir, {}));
}

afterEach(() => setGlobalSrcRoots(undefined));

describe("runStructure", () => {
	it("flags missing required files", () => {
		const dir = makeProject({ "package.json": "{}", "src/app.ts": "export const x = 1;" });
		const result = runStructure(dir, tsStack);
		expect(result.issues.some((i) => i.message.includes("LICENSE"))).toBe(true);
		expect(result.issues.some((i) => i.message.includes(".gitignore"))).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("credits existing files", () => {
		const dir = makeProject({
			"package.json": JSON.stringify({ scripts: { test: "vitest", build: "tsc" } }),
			"tsconfig.json": "{}",
			LICENSE: "MIT",
			".gitignore": "node_modules",
			"README.md": "# App",
			"pnpm-lock.yaml": "",
			"src/app.ts": "export const x = 1;",
			"src/app.test.ts": "test('x', () => {});",
		});
		const result = runStructure(dir, tsStack);
		expect(result.score).toBeGreaterThanOrEqual(80);
		rmSync(dir, { recursive: true });
	});

	it("flags missing lockfile", () => {
		const dir = makeProject({ "package.json": "{}", "src/app.ts": "x" });
		const result = runStructure(dir, tsStack);
		expect(result.issues.some((i) => i.rule === "missing-lockfile")).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("flags missing src directory", () => {
		const dir = makeProject({ "package.json": "{}" });
		const result = runStructure(dir, tsStack);
		expect(result.issues.some((i) => i.rule === "no-src")).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("flags no test files", () => {
		const dir = makeProject({
			"package.json": "{}",
			"src/app.ts": "export const x = 1;",
			"src/utils.ts": "export const y = 2;",
			"src/lib.ts": "export const z = 3;",
			"src/mod.ts": "export const w = 4;",
		});
		const result = runStructure(dir, tsStack);
		expect(result.issues.some((i) => i.rule === "no-tests")).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("flags missing test script", () => {
		const dir = makeProject({
			"package.json": JSON.stringify({ scripts: { build: "tsc" } }),
			"src/app.ts": "export const x = 1;",
		});
		const result = runStructure(dir, tsStack);
		expect(result.issues.some((i) => i.rule === "no-test-script")).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("skips test script check for monorepos", () => {
		const dir = makeProject({
			"package.json": JSON.stringify({ scripts: { build: "tsc" } }),
			"packages/sdk/src/index.ts": "",
		});
		const workspace: WorkspaceInfo = {
			isMonorepo: true,
			tool: "pnpm",
			packages: [{ name: "sdk", path: "packages/sdk", hasSrc: true, hasRootCode: false, hasTests: false, hasLinter: false }],
			srcRoots: ["packages/sdk/src"],
		};
		setGlobalSrcRoots(workspace.srcRoots);
		const result = runStructure(dir, tsStack, workspace);
		expect(result.issues.some((i) => i.rule === "no-test-script")).toBe(false);
		rmSync(dir, { recursive: true });
	});

	it("detects bun.lock (text format) as valid lockfile", () => {
		const dir = makeProject({
			"package.json": JSON.stringify({ scripts: { test: "vitest" } }),
			"bun.lock": "lockfile v1\n",
			"src/app.ts": "export const x = 1;",
		});
		const result = runStructure(dir, tsStack);
		expect((result.details as any).found).toContain("lockfile");
		expect(result.issues.some((i) => i.rule === "missing-lockfile")).toBe(false);
		rmSync(dir, { recursive: true });
	});

	it("accepts tsconfig.base.json in monorepos", () => {
		const dir = makeProject({
			"package.json": "{}",
			"tsconfig.base.json": "{}",
			"packages/sdk/src/index.ts": "",
		});
		const workspace: WorkspaceInfo = {
			isMonorepo: true,
			tool: "pnpm",
			packages: [{ name: "sdk", path: "packages/sdk", hasSrc: true, hasRootCode: false, hasTests: false, hasLinter: false }],
			srcRoots: ["packages/sdk/src"],
		};
		setGlobalSrcRoots(workspace.srcRoots);
		const result = runStructure(dir, tsStack, workspace);
		expect((result.details as any).found).toContain("tsconfig.json");
		rmSync(dir, { recursive: true });
	});

	it("uses FileInventory for source/test counts and skips ignored generated outputs", () => {
		const dir = makeProject({
			"package.json": JSON.stringify({ scripts: { test: "vitest", build: "tsc" } }),
			"tsconfig.json": "{}",
			LICENSE: "MIT",
			".gitignore": "node_modules",
			"pnpm-lock.yaml": "",
			"src/app.ts": "export const app = 1;\n",
			"src/app.test.ts": "test('app', () => {});\n",
			"dist/generated.ts": "export const generated = 1;\n",
			"dist/generated.test.ts": "test('generated', () => {});\n",
			".claude/worktrees/agent-a/src/agent.ts": "export const agent = 1;\n",
			".claude/worktrees/agent-a/src/agent.test.ts": "test('agent', () => {});\n",
		});
		const result = runStructure(dir, tsStack, undefined, makeInventory(dir));

		expect(result.details).toMatchObject({ source: "file-inventory", srcFiles: 1, testFiles: 1, testRatio: "100%" });
		rmSync(dir, { recursive: true });
	});
});
