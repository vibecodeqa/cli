import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setGlobalSrcRoots } from "../fs-utils.js";
import { runStandards } from "./standards.js";

function makeProject(files: Record<string, string>, stack = { language: "typescript" as const }): { dir: string; stack: any } {
	const dir = mkdtempSync(join(tmpdir(), "vcqa-std-"));
	writeFileSync(join(dir, "package.json"), "{}");
	for (const [name, content] of Object.entries(files)) {
		const full = join(dir, name);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, content);
	}
	return {
		dir,
		stack: { language: stack.language, framework: "none", bundler: "none", testRunner: "none", linter: "none", packageManager: "npm" },
	};
}

afterEach(() => setGlobalSrcRoots(undefined));

describe("runStandards", () => {
	it("detects console.log in production code", () => {
		const { dir, stack } = makeProject({
			"src/app.ts": 'console.log("debug");\nexport const x = 1;\n',
		});
		const result = runStandards(dir, stack);
		expect(result.issues.some((i) => i.message.includes("console.log"))).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("detects var keyword", () => {
		const { dir, stack } = makeProject({
			"src/app.ts": "var x = 1;\n",
		});
		const result = runStandards(dir, stack);
		expect(result.issues.some((i) => i.message.includes("var"))).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("detects large files", () => {
		const { dir, stack } = makeProject({
			"src/big.ts": Array.from({ length: 350 }, (_, i) => `export const v${i} = ${i};`).join("\n"),
		});
		const result = runStandards(dir, stack);
		expect(result.issues.some((i) => i.rule === "large-file")).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("detects missing tsconfig strict mode", () => {
		const { dir, stack } = makeProject({
			"src/app.ts": "export const x = 1;\n",
			"tsconfig.json": '{"compilerOptions":{}}',
		});
		const result = runStandards(dir, stack);
		expect(result.issues.some((i) => i.rule === "ts-strict")).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("finds strict in tsconfig.base.json", () => {
		const { dir, stack } = makeProject({
			"src/app.ts": "export const x = 1;\n",
			"tsconfig.base.json": '{"compilerOptions":{"strict":true}}',
		});
		const result = runStandards(dir, stack);
		expect(result.issues.some((i) => i.rule === "ts-strict")).toBe(false);
		rmSync(dir, { recursive: true });
	});

	it("returns clean score for well-written code", () => {
		const { dir, stack } = makeProject({
			"src/app.ts": "export function greet(name: string): string {\n  return `Hello ${name}`;\n}\n",
			"tsconfig.json": '{"compilerOptions":{"strict":true}}',
		});
		const result = runStandards(dir, stack);
		expect(result.score).toBeGreaterThanOrEqual(90);
		rmSync(dir, { recursive: true });
	});

	it("suggests noUncheckedIndexedAccess when strict is enabled", () => {
		const { dir, stack } = makeProject({
			"src/app.ts": "export const x = 1;\n",
			"tsconfig.json": '{"compilerOptions":{"strict":true}}',
		});
		const result = runStandards(dir, stack);
		expect(result.issues.some((i) => i.rule === "ts-maturity" && i.message.includes("noUncheckedIndexedAccess"))).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("does not suggest maturity flags when strict is off", () => {
		const { dir, stack } = makeProject({
			"src/app.ts": "export const x = 1;\n",
			"tsconfig.json": '{"compilerOptions":{}}',
		});
		const result = runStandards(dir, stack);
		expect(result.issues.some((i) => i.rule === "ts-maturity")).toBe(false);
		rmSync(dir, { recursive: true });
	});

	it("handles empty project gracefully", () => {
		const { dir, stack } = makeProject({});
		const result = runStandards(dir, stack);
		expect(result.name).toBe("standards");
		expect(result.score).toBeGreaterThanOrEqual(0);
		rmSync(dir, { recursive: true });
	});

	it("exponential penalty: 400-line file scores worse than 350-line file", () => {
		const lines350 = Array.from({ length: 350 }, (_, i) => `export const v${i} = ${i};`).join("\n");
		const lines400 = Array.from({ length: 400 }, (_, i) => `export const v${i} = ${i};`).join("\n");

		const { dir: d1, stack: s1 } = makeProject({ "src/a.ts": lines350 });
		const { dir: d2, stack: s2 } = makeProject({ "src/a.ts": lines400 });
		const r1 = runStandards(d1, s1);
		const r2 = runStandards(d2, s2);

		expect(r2.score).toBeLessThan(r1.score);
		rmSync(d1, { recursive: true });
		rmSync(d2, { recursive: true });
	});

	it("exponential penalty: 800-line file scores much worse than 400-line file", () => {
		const lines400 = Array.from({ length: 400 }, (_, i) => `export const v${i} = ${i};`).join("\n");
		const lines800 = Array.from({ length: 800 }, (_, i) => `export const v${i} = ${i};`).join("\n");

		const { dir: d1, stack: s1 } = makeProject({ "src/a.ts": lines400 });
		const { dir: d2, stack: s2 } = makeProject({ "src/a.ts": lines800 });
		const r1 = runStandards(d1, s1);
		const r2 = runStandards(d2, s2);

		// 800 lines should score at least 20 points worse than 400 lines
		expect(r1.score - r2.score).toBeGreaterThan(20);
		rmSync(d1, { recursive: true });
		rmSync(d2, { recursive: true });
	});

	it("detects strict mode in workspace package tsconfig", () => {
		const { dir, stack } = makeProject({
			"packages/api/tsconfig.json": JSON.stringify({ compilerOptions: { strict: true } }),
			"packages/api/src/index.ts": "export const x = 1;\n",
		});
		setGlobalSrcRoots(["packages/api/src"]);
		const workspace = {
			isMonorepo: true,
			tool: "pnpm" as const,
			packages: [{ name: "api", path: "packages/api", hasSrc: true, hasRootCode: false, hasTests: false, hasLinter: false }],
			srcRoots: ["packages/api/src"],
		};
		const result = runStandards(dir, stack, workspace);
		expect(result.issues.some((i) => i.rule === "ts-strict")).toBe(false);
		rmSync(dir, { recursive: true });
	});

	it("no penalty for files under 300 lines", () => {
		const lines250 = Array.from({ length: 250 }, (_, i) => `export const v${i} = ${i};`).join("\n");
		const { dir, stack } = makeProject({ "src/a.ts": lines250 });
		const result = runStandards(dir, stack);
		expect(result.issues.filter(i => i.rule === "large-file")).toHaveLength(0);
		rmSync(dir, { recursive: true });
	});
});
