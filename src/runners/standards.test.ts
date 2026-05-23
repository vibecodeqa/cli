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

	it("handles empty project gracefully", () => {
		const { dir, stack } = makeProject({});
		const result = runStandards(dir, stack);
		// Empty TS project gets penalized for missing strict mode but doesn't crash
		expect(result.name).toBe("standards");
		expect(result.score).toBeGreaterThanOrEqual(0);
		rmSync(dir, { recursive: true });
	});
});
