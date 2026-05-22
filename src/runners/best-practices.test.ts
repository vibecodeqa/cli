import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkspaceInfo } from "../types.js";
import { runBestPractices } from "./best-practices.js";

function makeProject(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "vcqa-bp-"));
	for (const [name, content] of Object.entries(files)) {
		const full = join(dir, name);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, content);
	}
	return dir;
}

describe("runBestPractices", () => {
	afterEach(() => {});

	it("flags missing CI/CD workflows", () => {
		const dir = makeProject({ "package.json": "{}" });
		const result = runBestPractices(dir);
		expect(result.issues.some((i) => i.rule === "no-ci")).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("credits existing CI workflows", () => {
		const dir = makeProject({
			"package.json": "{}",
			".github/workflows/ci.yml": "name: CI\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n",
		});
		const result = runBestPractices(dir);
		expect(result.issues.some((i) => i.rule === "no-ci")).toBe(false);
		rmSync(dir, { recursive: true });
	});

	it("flags missing lockfile", () => {
		const dir = makeProject({ "package.json": "{}" });
		const result = runBestPractices(dir);
		expect(result.issues.some((i) => i.rule === "lockfile")).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("credits existing lockfile", () => {
		const dir = makeProject({ "package.json": "{}", "pnpm-lock.yaml": "" });
		const result = runBestPractices(dir);
		expect(result.issues.some((i) => i.rule === "lockfile")).toBe(false);
		rmSync(dir, { recursive: true });
	});

	it("flags missing linter config", () => {
		const dir = makeProject({ "package.json": "{}" });
		const result = runBestPractices(dir);
		expect(result.issues.some((i) => i.rule === "linter-config")).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("credits biome.json", () => {
		const dir = makeProject({ "package.json": "{}", "biome.json": "{}" });
		const result = runBestPractices(dir);
		expect(result.issues.some((i) => i.rule === "linter-config")).toBe(false);
		rmSync(dir, { recursive: true });
	});

	it("flags missing test script", () => {
		const dir = makeProject({ "package.json": JSON.stringify({ scripts: { build: "tsc" } }) });
		const result = runBestPractices(dir);
		expect(result.issues.some((i) => i.rule === "test-script")).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("produces a score between 0-100", () => {
		const dir = makeProject({ "package.json": "{}" });
		const result = runBestPractices(dir);
		expect(result.score).toBeGreaterThanOrEqual(0);
		expect(result.score).toBeLessThanOrEqual(100);
		rmSync(dir, { recursive: true });
	});

	it("improves score with more practices followed", () => {
		const dirBare = makeProject({ "package.json": "{}" });
		const dirGood = makeProject({
			"package.json": JSON.stringify({ scripts: { test: "vitest", build: "tsc" }, engines: { node: ">=18" }, repository: { url: "https://github.com/test/test" } }),
			"pnpm-lock.yaml": "",
			"biome.json": "{}",
			".github/workflows/ci.yml": "name: CI\non: push\n",
			"tsconfig.json": '{"compilerOptions":{"strict":true}}',
		});
		const rBare = runBestPractices(dirBare);
		const rGood = runBestPractices(dirGood);
		expect(rGood.score).toBeGreaterThan(rBare.score);
		rmSync(dirBare, { recursive: true });
		rmSync(dirGood, { recursive: true });
	});
});
