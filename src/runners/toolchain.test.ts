import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detectStack, detectWorkspace } from "../detect.js";

/**
 * Issue #100: `types`, `lint` (project ESLint config) and knip all delegate to
 * tools resolved from the project's own dependencies. On a checkout nobody has
 * installed they must report `unavailable` — and must not shell out to `npx` at
 * all — rather than score whatever a half-blind or wrong-package run printed.
 *
 * The exec layer is replaced with a recorder that answers with canned tool
 * output, so these assert on exactly which commands were attempted, with no
 * network and no real tools.
 */
const runCalls: Array<{ cmd: string; cwd: string }> = [];

vi.mock("./exec.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./exec.js")>();
	return {
		...actual,
		run: vi.fn((cmd: string, cwd: string) => {
			runCalls.push({ cmd, cwd });
			if (cmd.startsWith("npx tsc")) {
				return { stdout: "src/index.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.\n", ok: true };
			}
			if (cmd.startsWith("npx eslint")) {
				const filePath = join(cwd, "src/index.ts");
				return {
					stdout: JSON.stringify([{ filePath, messages: [{ severity: 2, message: "no-unused-vars", line: 1, ruleId: "no-unused-vars" }] }]),
					ok: true,
				};
			}
			if (cmd.startsWith("npx knip")) {
				return { stdout: JSON.stringify({ issues: [{ file: "src/dead.ts", files: [{ name: "src/dead.ts" }] }] }), ok: true };
			}
			if (cmd.startsWith("npx @biomejs/biome")) {
				return {
					stdout: JSON.stringify({
						diagnostics: [
							{ severity: "warning", description: "use const", category: "lint/style/useConst", location: { path: "src/index.js" } },
						],
					}),
					ok: true,
				};
			}
			return { stdout: "", ok: false };
		}),
	};
});

const { runTypeCheck } = await import("./types-check.js");
const { runLint } = await import("./lint.js");
const { runPerformance, deadCodeCheckFromPerformance } = await import("./performance.js");
const { probeDependencies, resetToolchainProbes } = await import("./toolchain.js");

const dirs: string[] = [];

function project(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "vcqa-deps-"));
	dirs.push(dir);
	for (const [name, content] of Object.entries(files)) {
		const full = join(dir, name);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, content);
	}
	return dir;
}

/** Stand-in for `<pm> install`: one resolvable package per name. */
function install(dir: string, names: string[]): void {
	for (const name of names) {
		mkdirSync(join(dir, "node_modules", name), { recursive: true });
		writeFileSync(join(dir, "node_modules", name, "package.json"), JSON.stringify({ name, version: "1.0.0" }));
	}
}

/** A TypeScript + ESLint project, as checked out: no node_modules. */
function tsEslintFixture(): string {
	return project({
		"package.json": JSON.stringify({
			name: "ts-eslint-fixture",
			main: "src/index.ts",
			devDependencies: { typescript: "^5", eslint: "^9", "typescript-eslint": "^8" },
		}),
		"pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
		"tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ["src"] }),
		"eslint.config.js": "import tseslint from 'typescript-eslint';\nexport default tseslint.config(...tseslint.configs.recommended);\n",
		"src/index.ts": "const x: number = 'nope';\nexport const y = x;\n",
	});
}

const npxCalls = () => runCalls.filter((c) => c.cmd.startsWith("npx "));

beforeEach(() => {
	runCalls.length = 0;
	resetToolchainProbes();
});

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	resetToolchainProbes();
});

describe("probeDependencies", () => {
	it("reports a declared-but-uninstalled project and infers the package manager from the lockfile", () => {
		const dir = tsEslintFixture();
		expect(probeDependencies(dir)).toMatchObject({ installed: false, packageManager: "pnpm", declared: 3 });
	});

	it("counts a manifest that declares nothing as installed", () => {
		const dir = project({ "package.json": "{}" });
		expect(probeDependencies(dir).installed).toBe(true);
	});

	it("resolves dependencies hoisted to a workspace root, like Node does", () => {
		const dir = project({
			"package.json": JSON.stringify({ private: true, workspaces: ["packages/*"] }),
			"yarn.lock": "",
			"packages/web/package.json": JSON.stringify({ name: "web", dependencies: { react: "^19" } }),
		});
		expect(probeDependencies(join(dir, "packages/web"))).toMatchObject({ installed: false, packageManager: "yarn" });
		install(dir, ["react"]);
		// Installing changes the fingerprint the cache is keyed on — no reset needed.
		expect(probeDependencies(join(dir, "packages/web")).installed).toBe(true);
	});
});

describe("TypeScript + ESLint fixture without node_modules (#100)", () => {
	const reason = "dependencies not installed — run `pnpm install`";

	it("reports types unavailable and never invokes npx tsc", () => {
		const dir = tsEslintFixture();
		const result = runTypeCheck(dir, false, detectWorkspace(dir));
		expect(result.details).toMatchObject({ skipped: true, unavailable: true, reason });
		expect(result.issues).toEqual([]);
		expect(npxCalls()).toEqual([]);
	});

	it("reports lint unavailable and never invokes npx eslint", () => {
		const dir = tsEslintFixture();
		const workspace = detectWorkspace(dir);
		const stack = detectStack(dir, workspace);
		expect(stack.linter).toBe("eslint");
		const result = runLint(dir, stack, workspace);
		expect(result.details).toMatchObject({ skipped: true, unavailable: true, reason, linter: "eslint" });
		expect(npxCalls()).toEqual([]);
	});

	it("reports the knip part unavailable, never invokes npx knip, and still scores the rest of performance", () => {
		const dir = tsEslintFixture();
		const perf = runPerformance(dir, detectWorkspace(dir));
		const details = perf.details as Record<string, unknown>;
		expect(details.deadCodeTool).toBeUndefined();
		expect(details.deadCodeUnavailable).toEqual([{ path: ".", reason }]);
		expect(perf.score).toBe(100);
		expect(details.unavailable).toBeUndefined();

		const deadCode = deadCodeCheckFromPerformance(perf);
		expect(deadCode.name).toBe("dead-code");
		expect(deadCode.details).toMatchObject({ skipped: true, unavailable: true, reason, synthetic: true });
		expect(npxCalls()).toEqual([]);
	});
});

describe("the same fixture with dependencies installed (#100)", () => {
	it("scores types, lint and knip as before", () => {
		const dir = tsEslintFixture();
		install(dir, ["typescript", "eslint", "typescript-eslint"]);
		const workspace = detectWorkspace(dir);

		const types = runTypeCheck(dir, false, workspace);
		expect(types.details.unavailable).toBeUndefined();
		expect(types.score).toBe(95);
		expect(types.issues).toEqual([expect.objectContaining({ rule: "TS2322", file: "src/index.ts" })]);

		const lint = runLint(dir, detectStack(dir, workspace), workspace);
		expect(lint.details.unavailable).toBeUndefined();
		expect(lint.details).toMatchObject({ linter: "eslint", errors: 1 });

		const perf = runPerformance(dir, workspace);
		expect(perf.details).toMatchObject({ deadCodeTool: "knip", unusedFiles: 1 });
		expect((perf.details as Record<string, unknown>).deadCodeUnavailable).toBeUndefined();
		expect(deadCodeCheckFromPerformance(perf).details.unavailable).toBeUndefined();

		expect(npxCalls().map((c) => c.cmd.split(" ").slice(0, 2).join(" "))).toEqual(["npx tsc", "npx eslint", "npx knip"]);
	});
});

describe("zero-config Biome (#100 leaves it unchanged)", () => {
	it("still scores a project with no linter config and no node_modules", () => {
		const dir = project({
			"package.json": JSON.stringify({ name: "plain", dependencies: { lodash: "^4" } }),
			"src/index.js": "var x = 1;\nexport { x };\n",
		});
		const workspace = detectWorkspace(dir);
		const stack = detectStack(dir, workspace);
		expect(stack.linter).toBe("none");
		expect(probeDependencies(dir).installed).toBe(false);

		const result = runLint(dir, stack, workspace);
		expect(result.details).toMatchObject({ linter: "biome", zeroConfig: true, warnings: 1 });
		expect(result.details.unavailable).toBeUndefined();
		expect(npxCalls().map((c) => c.cmd)).toEqual([expect.stringMatching(/^npx @biomejs\/biome lint /)]);
	});
});

describe("monorepos (#100) — probed per project directory", () => {
	function monorepo(pkgDeps: Record<string, string>): string {
		const pkg = (name: string) => JSON.stringify({ name, devDependencies: pkgDeps });
		return project({
			"package.json": JSON.stringify({ private: true }),
			"pnpm-workspace.yaml": "packages:\n  - packages/*\n",
			"pnpm-lock.yaml": "",
			"packages/a/package.json": pkg("a"),
			"packages/a/tsconfig.json": JSON.stringify({ include: ["src"] }),
			"packages/a/eslint.config.js": "export default [];\n",
			"packages/a/src/index.ts": "export const a = 1;\n",
			"packages/b/package.json": pkg("b"),
			"packages/b/tsconfig.json": JSON.stringify({ include: ["src"] }),
			"packages/b/eslint.config.js": "export default [];\n",
			"packages/b/src/index.ts": "export const b = 1;\n",
		});
	}

	it("type-checks and lints the installed package and marks the other unavailable", () => {
		// ESLint is configured per package (config files) and not declared, so the
		// root has no linter and lint runs project by project.
		const dir = monorepo({ typescript: "^5" });
		// pnpm links each package's own dependencies into its own node_modules.
		install(join(dir, "packages/a"), ["typescript", "eslint"]);
		const workspace = detectWorkspace(dir);
		const stack = detectStack(dir, workspace);
		expect(stack.linter).toBe("none");

		const types = runTypeCheck(dir, false, workspace);
		expect(types.details.unavailable).toBeUndefined();
		expect(types.details).toMatchObject({
			projects: [expect.objectContaining({ path: "packages/a" })],
			unavailableProjects: [expect.objectContaining({ path: "packages/b", reason: "dependencies not installed — run `pnpm install`" })],
		});

		const lint = runLint(dir, stack, workspace);
		expect(lint.details.unavailable).toBeUndefined();
		expect(lint.details).toMatchObject({
			linter: "project-scoped",
			projects: expect.arrayContaining([
				expect.objectContaining({ path: "packages/a", linter: "eslint", issues: 1 }),
				expect.objectContaining({ path: "packages/b", unavailable: true }),
			]),
		});

		const attempted = npxCalls().map((c) => c.cwd);
		expect(attempted).toEqual([join(dir, "packages/a"), join(dir, "packages/a")]);
	});

	it("does not let root ESLint fetch a bare ESLint when only the packages declare it", () => {
		// Packages declare eslint, so the root stack detects eslint and lints from
		// the root — where, uninstalled, `npx eslint` would download ESLint and
		// crash on the packages' configs, scoring zero issues.
		const dir = monorepo({ typescript: "^5", eslint: "^9" });
		const workspace = detectWorkspace(dir);
		const stack = detectStack(dir, workspace);
		expect(stack.linter).toBe("eslint");

		const lint = runLint(dir, stack, workspace);
		expect(lint.details).toMatchObject({ unavailable: true, linter: "eslint" });
		expect(String(lint.details.reason)).toMatch(/^dependencies not installed — run `pnpm install`/);
		expect(npxCalls()).toEqual([]);
	});
});
