import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setGlobalSrcRoots } from "../fs-utils.js";
import { runDuplication, stripImports, tokenize } from "./duplication.js";

function makeProject(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "vcqa-dup-"));
	writeFileSync(join(dir, "package.json"), "{}");
	for (const [name, content] of Object.entries(files)) {
		const full = join(dir, name);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, content);
	}
	return dir;
}

afterEach(() => setGlobalSrcRoots(undefined));

const duplicateBlock = [
	"function processUser(user: User) {",
	"  const name = user.firstName + ' ' + user.lastName;",
	"  const email = user.email.toLowerCase().trim();",
	"  const age = calculateAge(user.birthDate);",
	"  const isActive = user.status === 'active';",
	"  const role = user.permissions.includes('admin') ? 'admin' : 'user';",
	"  return { name, email, age, isActive, role };",
	"}",
].join("\n");

describe("runDuplication", () => {
	it("detects duplicated code blocks", async () => {
		const dir = makeProject({
			"src/a.ts": `${duplicateBlock}\nexport const a = 1;\n`,
			"src/b.ts": `${duplicateBlock}\nexport const b = 2;\n`,
		});
		const result = await runDuplication(dir);
		expect(result.issues.some((i) => i.rule === "duplicate-code")).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("returns perfect score for unique code", async () => {
		const dir = makeProject({
			"src/a.ts": "export function foo() { return 1; }\nexport function bar() { return 2; }\n",
			"src/b.ts": "export function baz() { return 3; }\nexport function qux() { return 4; }\n",
		});
		const result = await runDuplication(dir);
		expect(result.score).toBe(100);
		expect(result.issues.filter((i) => i.rule === "duplicate-code")).toHaveLength(0);
		rmSync(dir, { recursive: true });
	});

	it("handles single file (needs 2+ to compare)", async () => {
		const dir = makeProject({
			"src/app.ts": "export const x = 1;\n",
		});
		const result = await runDuplication(dir);
		expect(result.score).toBe(100);
		rmSync(dir, { recursive: true });
	});

	it("handles empty project", async () => {
		const dir = makeProject({});
		const result = await runDuplication(dir);
		expect(result.score).toBe(100);
		rmSync(dir, { recursive: true });
	});

	it("ignores import and trivial lines in block matching", async () => {
		// Blocks that are only imports should not count as duplication
		const imports = Array.from({ length: 8 }, (_, i) => `import { mod${i} } from './mod${i}';`).join("\n");
		const dir = makeProject({
			"src/a.ts": `${imports}\nexport const a = 1;\n`,
			"src/b.ts": `${imports}\nexport const b = 2;\n`,
		});
		const result = await runDuplication(dir);
		expect(result.issues.filter((i) => i.rule === "duplicate-code")).toHaveLength(0);
		rmSync(dir, { recursive: true });
	});

	// Regression: the old line-hash reported every overlapping window, so one clone
	// surfaced ~6×. The token detector merges to a single maximal clone.
	it("reports a duplicated block once, not once per sliding window", async () => {
		const dir = makeProject({
			"src/a.ts": `${duplicateBlock}\nexport const a = 1;\n`,
			"src/b.ts": `${duplicateBlock}\nexport const b = 2;\n`,
		});
		const result = await runDuplication(dir);
		const dups = result.issues.filter((i) => i.rule === "duplicate-code");
		expect(dups).toHaveLength(1);
		expect((result.details as { duplicateBlocks: number }).duplicateBlocks).toBe(1);
		rmSync(dir, { recursive: true });
	});

	// Regression: a lookup table differs only by string contents per line. The old
	// detector (and a string-blind tokenizer) self-matched it; distinct string tokens fix it.
	it("does not flag a lookup table whose lines differ only by string literal", async () => {
		const chain = Array.from({ length: 18 }, (_, i) => `  if (key === "k${i}") return "value-number-${i}";`).join("\n");
		const dir = makeProject({
			"src/lookup.ts": `export function lookup(key: string): string {\n${chain}\n  return "";\n}\n`,
		});
		const result = await runDuplication(dir);
		expect(result.issues.filter((i) => i.rule === "duplicate-code")).toHaveLength(0);
		rmSync(dir, { recursive: true });
	});

	it("ignores duplicate blocks below the token threshold", async () => {
		// ~3 short lines ≈ well under 50 tokens
		const small = "function tiny() {\n  return 1 + 2;\n}";
		const dir = makeProject({
			"src/a.ts": `${small}\nexport const a = 1;\n`,
			"src/b.ts": `${small}\nexport const b = 2;\n`,
		});
		const result = await runDuplication(dir);
		expect(result.issues.filter((i) => i.rule === "duplicate-code")).toHaveLength(0);
		rmSync(dir, { recursive: true });
	});

	it("reports clone span (lines) in the message", async () => {
		const dir = makeProject({
			"src/a.ts": `${duplicateBlock}\nexport const a = 1;\n`,
			"src/b.ts": `${duplicateBlock}\nexport const b = 2;\n`,
		});
		const result = await runDuplication(dir);
		const dup = result.issues.find((i) => i.rule === "duplicate-code");
		expect(dup?.message).toMatch(/Duplicate \(\d+ lines\)/);
		rmSync(dir, { recursive: true });
	});
});

describe("tokenize", () => {
	it("splits identifiers and punctuation, tracks line numbers", () => {
		const toks = tokenize("const x = 1;\nconst y = 2;");
		expect(toks.map((t) => t.text)).toEqual(["const", "x", "=", "1", ";", "const", "y", "=", "2", ";"]);
		expect(toks[5]!.line).toBe(2);
	});

	it("skips line and block comments", () => {
		const toks = tokenize("a // comment b\n/* block c */ d");
		expect(toks.map((t) => t.text)).toEqual(["a", "d"]);
	});

	it("treats a string/template literal as one token (never matches inside)", () => {
		const toks = tokenize('const s = "a b c"; const t = `x ${y} z`;');
		const texts = toks.map((t) => t.text);
		expect(texts).toContain('"a b c"');
		expect(texts.filter((t) => t.startsWith('"') || t.startsWith("`")).length).toBe(2);
	});
});

describe("stripImports", () => {
	it("blanks single- and multi-line imports and re-exports, preserving line count", () => {
		const src = ["import { a } from './a';", "import {", "  b,", "} from './b';", "export * from './c';", "const real = 1;"].join("\n");
		const out = stripImports(src);
		expect(out.split("\n")).toHaveLength(6); // line numbers preserved
		expect(out).not.toContain("from");
		expect(out).toContain("const real = 1;");
	});
});
