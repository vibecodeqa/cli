import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

	it("does not credit missing tsconfig as strict mode", () => {
		// Projects with no tsconfig.json should NOT get credit for strict mode
		const dir = makeProject({ "package.json": "{}" });
		const result = runBestPractices(dir);
		// Should not have ts-strict-mode issue (because practice isn't counted at all)
		expect(result.issues.some((i) => i.rule === "ts-strict-mode")).toBe(false);
		rmSync(dir, { recursive: true });
	});

	it("flags tsconfig without strict mode", () => {
		const dir = makeProject({
			"package.json": "{}",
			"tsconfig.json": '{"compilerOptions":{}}',
		});
		const result = runBestPractices(dir);
		expect(result.issues.some((i) => i.rule === "ts-strict-mode")).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("does not credit docker-compose-only projects for Dockerfile practices", () => {
		const dir = makeProject({
			"package.json": "{}",
			"docker-compose.yml": "version: '3'\nservices:\n  app:\n    image: node:20\n",
		});
		const result = runBestPractices(dir);
		// Should not have docker-pin-version issue since there's no Dockerfile to check
		expect(result.issues.some((i) => i.rule === "docker-pin-version")).toBe(false);
		rmSync(dir, { recursive: true });
	});

	it("flags missing health endpoint for server projects", () => {
		const dir = makeProject({
			"package.json": JSON.stringify({ dependencies: { express: "^4" } }),
			"src/index.ts": 'import express from "express";\nconst app = express();\napp.listen(3000);\n',
		});
		const result = runBestPractices(dir);
		expect(result.issues.some((i) => i.rule === "no-health-endpoint")).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("flags missing Helmet.js for server projects", () => {
		const dir = makeProject({
			"package.json": JSON.stringify({ dependencies: { express: "^4" } }),
			"src/index.ts": 'import express from "express";\nconst app = express();\napp.listen(3000);\n',
		});
		const result = runBestPractices(dir);
		expect(result.issues.some((i) => i.rule === "no-helmet")).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("credits Helmet.js when installed", () => {
		const dir = makeProject({
			"package.json": JSON.stringify({ dependencies: { express: "^4", helmet: "^7" } }),
			"src/index.ts": 'import express from "express";\nconst app = express();\napp.listen(3000);\n',
		});
		const result = runBestPractices(dir);
		expect(result.issues.some((i) => i.rule === "no-helmet")).toBe(false);
		rmSync(dir, { recursive: true });
	});

	it("flags missing input validation for API projects", () => {
		const dir = makeProject({
			"package.json": JSON.stringify({ dependencies: { express: "^4" } }),
			"src/index.ts": 'import express from "express";\nconst app = express();\napp.listen(3000);\n',
		});
		const result = runBestPractices(dir);
		expect(result.issues.some((i) => i.rule === "no-input-validation")).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("credits Zod when installed", () => {
		const dir = makeProject({
			"package.json": JSON.stringify({ dependencies: { express: "^4", zod: "^3" } }),
			"src/index.ts": 'import express from "express";\nconst app = express();\napp.listen(3000);\n',
		});
		const result = runBestPractices(dir);
		expect(result.issues.some((i) => i.rule === "no-input-validation")).toBe(false);
		rmSync(dir, { recursive: true });
	});

	it("credits health endpoint when present", () => {
		const dir = makeProject({
			"package.json": JSON.stringify({ dependencies: { express: "^4" } }),
			"src/index.ts": 'import express from "express";\nconst app = express();\napp.get("/health", (req, res) => res.json({ ok: true }));\napp.listen(3000);\n',
		});
		const result = runBestPractices(dir);
		expect(result.issues.some((i) => i.rule === "no-health-endpoint")).toBe(false);
		rmSync(dir, { recursive: true });
	});

	it("flags pull_request_target with checkout (pwn request)", () => {
		const dir = makeProject({
			"package.json": "{}",
			".github/workflows/ci.yml": [
				"name: CI",
				"on: pull_request_target",
				"jobs:",
				"  test:",
				"    runs-on: ubuntu-latest",
				"    steps:",
				"      - uses: actions/checkout@v4",
				"        with:",
				"          ref: ${{ github.event.pull_request.head.sha }}",
			].join("\n"),
		});
		const result = runBestPractices(dir);
		expect(result.issues.some((i) => i.rule === "pwn-request")).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("flags script injection in run blocks", () => {
		const dir = makeProject({
			"package.json": "{}",
			".github/workflows/greet.yml": [
				"name: Greet",
				"on: issues",
				"permissions: { contents: read }",
				"jobs:",
				"  greet:",
				"    runs-on: ubuntu-latest",
				"    steps:",
				"      - run: echo \"Hello ${{ github.event.issue.title }}\"",
			].join("\n"),
		});
		const result = runBestPractices(dir);
		expect(result.issues.some((i) => i.rule === "gha-script-injection")).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("flags write-all permissions", () => {
		const dir = makeProject({
			"package.json": "{}",
			".github/workflows/ci.yml": "name: CI\non: push\npermissions: write-all\njobs:\n  test:\n    runs-on: ubuntu-latest\n",
		});
		const result = runBestPractices(dir);
		expect(result.issues.some((i) => i.rule === "write-all-permissions")).toBe(true);
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
			"package.json": JSON.stringify({
				scripts: { test: "vitest", build: "tsc" },
				engines: { node: ">=18" },
				repository: { url: "https://github.com/test/test" },
			}),
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
