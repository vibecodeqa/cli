import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setGlobalSrcRoots } from "../fs-utils.js";
import { runCommentStaleness } from "./comment-staleness.js";

function makeProject(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "vcqa-cs-"));
	writeFileSync(join(dir, "package.json"), "{}");
	for (const [name, content] of Object.entries(files)) {
		const full = join(dir, name);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, content);
	}
	return dir;
}

afterEach(() => setGlobalSrcRoots(undefined));

describe("runCommentStaleness", () => {
	it("returns PRO placeholder without VCQA_PRO_KEY", () => {
		const orig = process.env.VCQA_PRO_KEY;
		delete process.env.VCQA_PRO_KEY;
		const dir = makeProject({ "src/app.ts": "export const x = 1;\n" });
		const result = runCommentStaleness(dir);
		expect(result.details.comingSoon).toBe(true);
		process.env.VCQA_PRO_KEY = orig;
		rmSync(dir, { recursive: true });
	});

	it("detects stale TODO with date", () => {
		process.env.VCQA_PRO_KEY = "test";
		const dir = makeProject({
			"src/app.ts": "// TODO 2024-01-15: fix this\nexport function broken() { return 1; }\n",
		});
		const result = runCommentStaleness(dir);
		expect(result.issues.some((i) => i.rule === "stale-todo")).toBe(true);
		delete process.env.VCQA_PRO_KEY;
		rmSync(dir, { recursive: true });
	});

	it("detects undated TODO", () => {
		process.env.VCQA_PRO_KEY = "test";
		const dir = makeProject({
			"src/app.ts": "// TODO: refactor this later\nexport function old() {}\n",
		});
		const result = runCommentStaleness(dir);
		expect(result.issues.some((i) => i.rule === "undated-todo")).toBe(true);
		delete process.env.VCQA_PRO_KEY;
		rmSync(dir, { recursive: true });
	});

	it("detects commented-out code blocks", () => {
		process.env.VCQA_PRO_KEY = "test";
		const dir = makeProject({
			"src/app.ts": [
				"// const oldCode = doSomething();",
				"// const result = oldCode.process();",
				"// const final = result.map(x => x.value);",
				"// return final;",
				"export function current() { return 2; }",
			].join("\n"),
		});
		const result = runCommentStaleness(dir);
		expect(result.issues.some((i) => i.rule === "commented-out-code")).toBe(true);
		delete process.env.VCQA_PRO_KEY;
		rmSync(dir, { recursive: true });
	});

	it("detects numeric mismatch in comments", () => {
		process.env.VCQA_PRO_KEY = "test";
		const dir = makeProject({
			"src/app.ts": [
				"// handles 3 cases",
				"export function handler(x: number) {",
				"  switch(x) {",
				"    case 1: return 'a';",
				"    case 2: return 'b';",
				"    case 3: return 'c';",
				"    case 4: return 'd';",
				"    case 5: return 'e';",
				"  }",
				"}",
			].join("\n"),
		});
		const result = runCommentStaleness(dir);
		expect(result.issues.some((i) => i.rule === "numeric-mismatch")).toBe(true);
		delete process.env.VCQA_PRO_KEY;
		rmSync(dir, { recursive: true });
	});

	it("detects @deprecated without replacement", () => {
		process.env.VCQA_PRO_KEY = "test";
		const dir = makeProject({
			"src/app.ts": "/** @deprecated */\nexport function legacy() {}\n",
		});
		const result = runCommentStaleness(dir);
		expect(result.issues.some((i) => i.rule === "deprecated-no-replacement")).toBe(true);
		delete process.env.VCQA_PRO_KEY;
		rmSync(dir, { recursive: true });
	});

	it("does not flag @deprecated with replacement", () => {
		process.env.VCQA_PRO_KEY = "test";
		const dir = makeProject({
			"src/app.ts": "/** @deprecated use newFn instead */\nexport function legacy() {}\n",
		});
		const result = runCommentStaleness(dir);
		expect(result.issues.some((i) => i.rule === "deprecated-no-replacement")).toBe(false);
		delete process.env.VCQA_PRO_KEY;
		rmSync(dir, { recursive: true });
	});

	it("returns clean score for well-commented code", () => {
		process.env.VCQA_PRO_KEY = "test";
		const dir = makeProject({
			"src/app.ts": "/** Adds two numbers */\nexport function add(a: number, b: number) { return a + b; }\n",
		});
		const result = runCommentStaleness(dir);
		expect(result.score).toBe(100);
		expect(result.issues).toHaveLength(0);
		delete process.env.VCQA_PRO_KEY;
		rmSync(dir, { recursive: true });
	});

	it("collects comment+code pairs for LLM analysis", () => {
		process.env.VCQA_PRO_KEY = "test";
		const dir = makeProject({
			"src/app.ts": "/** Adds two numbers */\nexport function add(a: number, b: number) { return a + b; }\n",
		});
		const result = runCommentStaleness(dir);
		const pairs = (result.details as any).commentPairsForLLM;
		expect(pairs).toBeDefined();
		expect(pairs.length).toBeGreaterThan(0);
		expect(pairs[0].comment).toContain("Adds two numbers");
		delete process.env.VCQA_PRO_KEY;
		rmSync(dir, { recursive: true });
	});
});
