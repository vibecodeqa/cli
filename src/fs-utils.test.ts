import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectSourceFiles, getProductionFiles, getTestFiles, readDeps, readSafe } from "./fs-utils.js";

function makeProject(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "vcqa-fs-"));
	writeFileSync(join(dir, "package.json"), "{}");
	for (const [name, content] of Object.entries(files)) {
		const full = join(dir, name);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, content);
	}
	return dir;
}

describe("collectSourceFiles", () => {
	it("finds ts/tsx files in src/", () => {
		const dir = makeProject({
			"src/app.ts": "export const x = 1;",
			"src/App.tsx": "export function App() {}",
		});
		const files = collectSourceFiles(dir);
		expect(files).toHaveLength(2);
		expect(files.map((f) => f.path).sort()).toEqual(["src/App.tsx", "src/app.ts"]);
		rmSync(dir, { recursive: true });
	});

	it("marks test files correctly", () => {
		const dir = makeProject({
			"src/app.ts": "export const x = 1;",
			"src/app.test.ts": "import { x } from './app'; test('x', () => {});",
		});
		const files = collectSourceFiles(dir);
		const testFile = files.find((f) => f.isTest);
		expect(testFile).toBeDefined();
		expect(testFile!.path).toContain(".test.");
		rmSync(dir, { recursive: true });
	});

	it("skips node_modules and dist", () => {
		const dir = makeProject({
			"src/app.ts": "export const x = 1;",
			"src/node_modules/foo.ts": "bad",
			"src/dist/out.ts": "bad",
		});
		const files = collectSourceFiles(dir);
		expect(files).toHaveLength(1);
		rmSync(dir, { recursive: true });
	});

	it("skips files over 1MB", () => {
		const dir = makeProject({
			"src/small.ts": "export const x = 1;",
			"src/huge.ts": "x".repeat(1_100_000),
		});
		const files = collectSourceFiles(dir);
		expect(files).toHaveLength(1);
		expect(files[0]!.path).toBe("src/small.ts");
		rmSync(dir, { recursive: true });
	});
});

describe("getProductionFiles", () => {
	it("excludes test files", () => {
		const dir = makeProject({
			"src/app.ts": "export const x = 1;",
			"src/app.test.ts": "test('x', () => {});",
		});
		const files = getProductionFiles(dir);
		expect(files).toHaveLength(1);
		expect(files[0]!.isTest).toBe(false);
		rmSync(dir, { recursive: true });
	});
});

describe("getTestFiles", () => {
	it("returns only test files", () => {
		const dir = makeProject({
			"src/app.ts": "export const x = 1;",
			"src/app.test.ts": "test('x', () => {});",
		});
		const files = getTestFiles(dir);
		expect(files).toHaveLength(1);
		expect(files[0]!.isTest).toBe(true);
		rmSync(dir, { recursive: true });
	});
});

describe("readSafe", () => {
	it("reads existing file", () => {
		const dir = makeProject({ "src/a.ts": "hello" });
		expect(readSafe(dir, "src/a.ts")).toBe("hello");
		rmSync(dir, { recursive: true });
	});

	it("returns empty string for missing file", () => {
		expect(readSafe("/tmp/nonexistent", "nope.ts")).toBe("");
	});
});

describe("readDeps", () => {
	it("reads dependencies from package.json", () => {
		const dir = mkdtempSync(join(tmpdir(), "vcqa-deps-"));
		writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { react: "^18" }, devDependencies: { vitest: "^4" } }));
		const deps = readDeps(dir);
		expect(deps.react).toBe("^18");
		expect(deps.vitest).toBe("^4");
		rmSync(dir, { recursive: true });
	});

	it("returns empty for missing package.json", () => {
		expect(readDeps("/tmp/nonexistent")).toEqual({});
	});
});
