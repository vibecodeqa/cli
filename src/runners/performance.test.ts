import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setGlobalSrcRoots } from "../fs-utils.js";
import { runPerformance } from "./performance.js";

function makeProject(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "vcqa-perf-"));
	for (const [name, content] of Object.entries(files)) {
		const full = join(dir, name);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, content);
	}
	return dir;
}

afterEach(() => setGlobalSrcRoots(undefined));

describe("runPerformance", { timeout: 45_000 }, () => {
	it("detects barrel files", () => {
		const dir = makeProject({
			"package.json": "{}",
			"src/index.ts": ["export { a } from './a';", "export { b } from './b';", "export { c } from './c';", "export { d } from './d';"].join(
				"\n",
			),
			"src/a.ts": "export const a = 1;",
			"src/b.ts": "export const b = 2;",
			"src/c.ts": "export const c = 3;",
			"src/d.ts": "export const d = 4;",
		});
		const result = runPerformance(dir);
		expect(result.issues.some((i) => i.rule === "barrel-import")).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("detects heavy dependencies", () => {
		const dir = makeProject({
			"package.json": JSON.stringify({ dependencies: { moment: "^2.29", lodash: "^4.17" } }),
			"src/app.ts": "export const x = 1;\n",
		});
		const result = runPerformance(dir);
		expect(result.issues.filter((i) => i.rule === "heavy-dependency")).toHaveLength(2);
		rmSync(dir, { recursive: true });
	});

	it("detects runtime CSS-in-JS", () => {
		const dir = makeProject({
			"package.json": JSON.stringify({ dependencies: { "styled-components": "^6" } }),
			"src/app.ts": "export const x = 1;\n",
		});
		const result = runPerformance(dir);
		expect(result.issues.some((i) => i.rule === "runtime-css")).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("returns perfect score for clean project", () => {
		const dir = makeProject({
			"package.json": "{}",
			"src/app.ts": "export function greet(name: string) { return `Hello ${name}`; }\n",
		});
		const result = runPerformance(dir);
		expect(result.score).toBe(100);
		rmSync(dir, { recursive: true });
	});

	it("handles empty project", () => {
		const dir = makeProject({ "package.json": "{}" });
		const result = runPerformance(dir);
		expect(result.score).toBe(100);
		expect(result.details.skipped).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("detects lodash without lodash-es", () => {
		const dir = makeProject({
			"package.json": JSON.stringify({ dependencies: { lodash: "^4.17" } }),
			"src/app.ts": "export const x = 1;\n",
		});
		const result = runPerformance(dir);
		expect(result.issues.some((i) => i.rule === "non-esm-dep")).toBe(true);
		rmSync(dir, { recursive: true });
	});
});
