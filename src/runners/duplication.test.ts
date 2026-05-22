import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setGlobalSrcRoots } from "../fs-utils.js";
import { runDuplication } from "./duplication.js";

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
	it("detects duplicated code blocks", () => {
		const dir = makeProject({
			"src/a.ts": `${duplicateBlock}\nexport const a = 1;\n`,
			"src/b.ts": `${duplicateBlock}\nexport const b = 2;\n`,
		});
		const result = runDuplication(dir);
		expect(result.issues.some((i) => i.rule === "duplicate-code")).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("returns perfect score for unique code", () => {
		const dir = makeProject({
			"src/a.ts": "export function foo() { return 1; }\nexport function bar() { return 2; }\n",
			"src/b.ts": "export function baz() { return 3; }\nexport function qux() { return 4; }\n",
		});
		const result = runDuplication(dir);
		expect(result.score).toBe(100);
		expect(result.issues.filter((i) => i.rule === "duplicate-code")).toHaveLength(0);
		rmSync(dir, { recursive: true });
	});

	it("handles single file (needs 2+ to compare)", () => {
		const dir = makeProject({
			"src/app.ts": "export const x = 1;\n",
		});
		const result = runDuplication(dir);
		expect(result.score).toBe(100);
		rmSync(dir, { recursive: true });
	});

	it("handles empty project", () => {
		const dir = makeProject({});
		const result = runDuplication(dir);
		expect(result.score).toBe(100);
		rmSync(dir, { recursive: true });
	});

	it("ignores import and trivial lines in block matching", () => {
		// Blocks that are only imports should not count as duplication
		const imports = Array.from({ length: 8 }, (_, i) => `import { mod${i} } from './mod${i}';`).join("\n");
		const dir = makeProject({
			"src/a.ts": imports + "\nexport const a = 1;\n",
			"src/b.ts": imports + "\nexport const b = 2;\n",
		});
		const result = runDuplication(dir);
		expect(result.issues.filter((i) => i.rule === "duplicate-code")).toHaveLength(0);
		rmSync(dir, { recursive: true });
	});
});
