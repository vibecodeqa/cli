import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectWorkspace } from "../detect.js";
import { buildFileInventory } from "../file-inventory.js";
import { setGlobalSrcRoots } from "../fs-utils.js";
import { buildEffectiveScanPolicy } from "../scan-policy.js";
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

function inventory(dir: string) {
	return buildFileInventory(dir, detectWorkspace(dir), buildEffectiveScanPolicy(dir, {}));
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
		const issue = result.issues.find((i) => i.message.includes("var"));
		expect(issue).toBeDefined();
		expect(issue!.severity).toBe("warning");
		rmSync(dir, { recursive: true });
	});

	it("does not match code smell rules inside template literals", () => {
		const { dir, stack } = makeProject({
			"src/app.ts": `export function buildLoaderJs(): string {
  return \`
    var URL = "https://example.com";
    console.log(URL);
    if (URL == location.href) {}
    document.body.innerHTML = "<p>loaded</p>";
    document.write("hello");
    eval("1 + 1");
  \`;
}
`,
			"tsconfig.json":
				'{"compilerOptions":{"strict":true,"noUncheckedIndexedAccess":true,"verbatimModuleSyntax":true,"skipLibCheck":true}}',
		});
		const result = runStandards(dir, stack);
		expect(result.issues.some((i) => i.rule === "var keyword")).toBe(false);
		expect(result.issues.some((i) => i.rule === "console.log")).toBe(false);
		expect(result.issues.some((i) => i.rule === "loose equality")).toBe(false);
		expect(result.issues.some((i) => i.rule === "innerHTML assignment")).toBe(false);
		expect(result.issues.some((i) => i.rule === "document.write")).toBe(false);
		expect(result.issues.some((i) => i.rule === "eval()")).toBe(false);
		rmSync(dir, { recursive: true });
	});

	it("does not match code smell rules inside string-built embedded browser code", () => {
		const { dir, stack } = makeProject({
			"src/loader.ts": `export function buildLoaderJs(): string {
  return [
    'var URL = "https://example.com";',
    "console.log(URL);",
    "if (URL == location.href) {}",
    "document.body.innerHTML = '<p>loaded</p>';",
    "eval('1 + 1');",
  ].join("\\n");
}
`,
			"tsconfig.json":
				'{"compilerOptions":{"strict":true,"noUncheckedIndexedAccess":true,"verbatimModuleSyntax":true,"skipLibCheck":true}}',
		});
		const result = runStandards(dir, stack);
		const smellRules = new Set(["var keyword", "console.log", "loose equality", "innerHTML assignment", "eval()"]);
		expect(result.issues.filter((i) => smellRules.has(i.rule ?? "")).map((i) => i.rule)).toEqual([]);
		rmSync(dir, { recursive: true });
	});

	it("does not match code smell rules inside comments documenting code", () => {
		const { dir, stack } = makeProject({
			"src/comments.ts": `// var URL = "https://example.com"; console.log(URL); eval("1 + 1");
/*
document.body.innerHTML = "<p>loaded</p>";
if (URL == location.href) {}
*/
export const ok = true;
`,
			"tsconfig.json":
				'{"compilerOptions":{"strict":true,"noUncheckedIndexedAccess":true,"verbatimModuleSyntax":true,"skipLibCheck":true}}',
		});
		const result = runStandards(dir, stack);
		const smellRules = new Set(["var keyword", "console.log", "loose equality", "innerHTML assignment", "eval()"]);
		expect(result.issues.filter((i) => smellRules.has(i.rule ?? "")).map((i) => i.rule)).toEqual([]);
		rmSync(dir, { recursive: true });
	});

	it("still detects real code smell rules outside literals and comments", () => {
		const { dir, stack } = makeProject({
			"src/app.ts": `export function run(input: string, el: HTMLElement, a: string, b: string): unknown {
  var count = 1;
  console.log(count);
  if (a == b) count++;
  el.innerHTML = input;
  return eval(input);
}
`,
			"tsconfig.json":
				'{"compilerOptions":{"strict":true,"noUncheckedIndexedAccess":true,"verbatimModuleSyntax":true,"skipLibCheck":true}}',
		});
		const result = runStandards(dir, stack);
		expect(result.issues.some((i) => i.rule === "var keyword")).toBe(true);
		expect(result.issues.some((i) => i.rule === "console.log")).toBe(true);
		expect(result.issues.some((i) => i.rule === "loose equality")).toBe(true);
		expect(result.issues.some((i) => i.rule === "innerHTML assignment")).toBe(true);
		expect(result.issues.some((i) => i.rule === "eval()")).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("still detects real code inside template interpolation", () => {
		const { dir, stack } = makeProject({
			"src/app.ts": `export function render(value: string): string {
  return \`value: \${eval(value)}\`;
}
`,
			"tsconfig.json":
				'{"compilerOptions":{"strict":true,"noUncheckedIndexedAccess":true,"verbatimModuleSyntax":true,"skipLibCheck":true}}',
		});
		const result = runStandards(dir, stack);
		expect(result.issues.some((i) => i.rule === "eval()")).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("detects large files", () => {
		const { dir, stack } = makeProject({
			"src/big.ts": Array.from({ length: 650 }, (_, i) => `export const v${i} = ${i};`).join("\n"),
		});
		const result = runStandards(dir, stack);
		const issue = result.issues.find((i) => i.rule === "large-file");
		expect(issue).toBeDefined();
		expect(issue!.severity).toBe("warning");
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
			"src/app.ts": "export function greet(name: string): string {\n  return 'Hello ' + name;\n}\n",
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
		expect(result.issues.filter((i) => i.rule === "large-file")).toHaveLength(0);
		rmSync(dir, { recursive: true });
	});

	it("uses FileInventory and excludes ignored/generated source", () => {
		const generatedLines = Array.from({ length: 650 }, (_, i) => `export const dist${i} = ${i};`).join("\n");
		const agentLines = Array.from({ length: 650 }, (_, i) => `export const agent${i} = ${i};`).join("\n");
		const { dir, stack } = makeProject({
			"src/app.ts": "export const app = 1;\n",
			"dist/generated.ts": `${generatedLines}\nconsole.log("dist");\n`,
			".claude/worktrees/agent-a/src/generated.ts": `${agentLines}\nconsole.log("agent");\n`,
			"tsconfig.json":
				'{"compilerOptions":{"strict":true,"noUncheckedIndexedAccess":true,"verbatimModuleSyntax":true,"skipLibCheck":true}}',
		});
		const result = runStandards(dir, stack, undefined, inventory(dir));
		expect(result.details).toMatchObject({ filesScanned: 1, source: "file-inventory" });
		expect(result.issues.some((i) => i.file?.includes(".claude/worktrees") || i.file?.startsWith("dist/"))).toBe(false);
		expect(result.issues.some((i) => i.rule === "large-file" || i.rule === "console.log")).toBe(false);
		rmSync(dir, { recursive: true });
	});
});
