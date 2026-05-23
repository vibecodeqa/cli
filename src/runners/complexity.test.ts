import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runComplexity } from "./complexity.js";

const TMP = join(import.meta.dirname!, "__test_complexity__");

function setup(files: Record<string, string>) {
	rmSync(TMP, { recursive: true, force: true });
	mkdirSync(join(TMP, "src"), { recursive: true });
	for (const [path, content] of Object.entries(files)) {
		writeFileSync(join(TMP, path), content);
	}
}

function cleanup() {
	rmSync(TMP, { recursive: true, force: true });
}

describe("runComplexity", () => {
	it("gives A for simple functions", () => {
		setup({
			"src/simple.ts": `
export function add(a: number, b: number): number {
  return a + b;
}

export function greet(name: string): string {
  return "Hello " + name;
}`,
		});
		const result = runComplexity(TMP);
		expect(result.grade).toBe("A");
		expect(result.score).toBe(100);
		expect(result.issues).toHaveLength(0);
		cleanup();
	});

	it("flags long functions", () => {
		const longBody = Array.from({ length: 65 }, (_, i) => `  const x${i} = ${i};`).join("\n");
		setup({
			"src/long.ts": `export function bigFunction() {\n${longBody}\n}`,
		});
		const result = runComplexity(TMP);
		expect(result.issues.some((i) => i.rule === "long-function")).toBe(true);
		expect(result.score).toBeLessThan(100);
		cleanup();
	});

	it("flags complex functions", () => {
		const branches = Array.from({ length: 20 }, (_, i) => `  if (x > ${i}) { y += ${i}; }`).join("\n");
		setup({
			"src/complex.ts": `export function complex(x: number) {\n  let y = 0;\n${branches}\n  return y;\n}`,
		});
		const result = runComplexity(TMP);
		expect(result.issues.some((i) => i.rule === "high-complexity")).toBe(true);
		cleanup();
	});

	it("handles braces in strings without truncating function", () => {
		setup({
			"src/braces.ts": [
				"export function render(data: any) {",
				'  const open = "{";',
				'  const close = "}";',
				"  const msg = `Value: ${data.value}`;",
				"  if (data.valid) {",
				"    return open + msg + close;",
				"  }",
				'  return "none";',
				"}",
			].join("\n"),
		});
		const result = runComplexity(TMP);
		// Should detect 1 function with correct line count (9 lines), not truncate at the string brace
		expect((result.details as any).functionCount).toBe(1);
		cleanup();
	});

	it("returns A for empty src", () => {
		setup({});
		const result = runComplexity(TMP);
		expect(result.score).toBe(100);
		cleanup();
	});
});
