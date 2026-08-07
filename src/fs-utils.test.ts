import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	collectAllFiles,
	collectSourceFiles,
	getProductionFiles,
	getTestFiles,
	isIgnoredPath,
	normalizeToolPath,
	readDeps,
	readEnvIgnoreNames,
	readGitIgnoreDirectoryNames,
	readSafe,
	setGlobalIgnore,
	setGlobalIgnoreNames,
	setGlobalSrcRoots,
} from "./fs-utils.js";

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

	it("skips framework build/cache output (.wrangler, .vercel, .svelte-kit)", () => {
		const dir = makeProject({
			"src/app.ts": "export const x = 1;",
			".wrangler/tmp/bundle-abc/middleware-loader.entry.ts": "export const x = 1;",
			".vercel/output/fn.ts": "bad",
			".svelte-kit/generated/root.ts": "bad",
		});
		const files = collectSourceFiles(dir);
		expect(files).toHaveLength(1);
		expect(files[0]!.path).toBe("src/app.ts");
		rmSync(dir, { recursive: true });
	});

	it("skips explicit generated dot directories, but keeps meaningful repo config visible", () => {
		const dir = makeProject({
			"src/app.ts": "export const x = 1;",
			".provision/demo/src/app.ts": "export const x = 1;",
			".claude/worktrees/copy.ts": "export const y = 2;",
			".github/workflows/build.ts": "export const z = 3;",
		});
		const sourceFiles = collectSourceFiles(dir);
		expect(sourceFiles.map((f) => f.path)).toEqual(["src/app.ts"]);
		const allFiles = collectAllFiles(dir, { extraExts: true });
		expect(allFiles.map((f) => f.path).sort()).toEqual([".github/workflows/build.ts", "package.json", "src/app.ts"]);
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

	it("honors extra ignore names (the monitor's VCQA_IGNORE list)", () => {
		const dir = makeProject({
			"src/app.ts": "export const x = 1;",
			"src/fixtures/big.ts": "export const y = 2;",
			"generated/g.ts": "export const z = 3;",
		});
		setGlobalIgnoreNames(["fixtures", "generated"]);
		try {
			const files = collectSourceFiles(dir);
			expect(files.map((f) => f.path)).toEqual(["src/app.ts"]);
		} finally {
			setGlobalIgnoreNames([]); // reset module state so other tests are unaffected
			rmSync(dir, { recursive: true });
		}
	});

	it("honors multi-segment ignore entries as slash-bounded sub-paths", () => {
		const dir = makeProject({
			"src/app.ts": "export const x = 1;",
			"src/generated/api.ts": "export const y = 2;",
			"src/other/keep.ts": "export const z = 3;",
		});
		setGlobalIgnoreNames(["src/generated"]);
		try {
			const files = collectSourceFiles(dir)
				.map((f) => f.path)
				.sort();
			expect(files).toEqual(["src/app.ts", "src/other/keep.ts"]);
		} finally {
			setGlobalIgnoreNames([]);
			rmSync(dir, { recursive: true });
		}
	});
});

describe("readEnvIgnoreNames", () => {
	it("splits on commas/whitespace, trims, dedupes, and tolerates empty/undefined", () => {
		expect(readEnvIgnoreNames("node_modules, .wrangler\n dist  dist")).toEqual(["node_modules", ".wrangler", "dist"]);
		expect(readEnvIgnoreNames("")).toEqual([]);
		expect(readEnvIgnoreNames(undefined)).toEqual([]);
	});
});

describe("readGitIgnoreDirectoryNames", () => {
	it("returns directory ignores but not file ignores", () => {
		const dir = makeProject({
			".gitignore": ["store/docs/", ".env", "package-lock.json", "!keep/", "# comment", "dist/"].join("\n"),
		});
		expect(readGitIgnoreDirectoryNames(dir)).toEqual(["store/docs", "dist"]);
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

describe("collectSourceFiles with monorepo srcRoots", () => {
	it("finds files across workspace packages via srcRoots", () => {
		const dir = makeProject({
			"packages/sdk/src/index.ts": "export const x = 1;",
			"packages/sdk/src/utils.ts": "export const y = 2;",
			"packages/cli/src/main.ts": "console.log('hi');",
		});
		const files = collectSourceFiles(dir, { srcRoots: ["packages/sdk/src", "packages/cli/src"] });
		expect(files).toHaveLength(3);
		expect(files.map((f) => f.path).sort()).toEqual(["packages/cli/src/main.ts", "packages/sdk/src/index.ts", "packages/sdk/src/utils.ts"]);
		rmSync(dir, { recursive: true });
	});

	it("finds files via setGlobalSrcRoots", () => {
		const dir = makeProject({
			"packages/sdk/src/index.ts": "export const x = 1;",
			"packages/cli/src/main.ts": "console.log('hi');",
		});
		setGlobalSrcRoots(["packages/sdk/src", "packages/cli/src"]);
		const files = collectSourceFiles(dir);
		expect(files).toHaveLength(2);
		setGlobalSrcRoots(undefined); // reset
		rmSync(dir, { recursive: true });
	});

	it("collects each file once when roots overlap (app/src nested under app)", () => {
		// Mirrors real monorepo detection, which emits both `app/src` and a
		// catch-all `app`. Without dedup, app/src/** files appear twice and every
		// downstream check (duplication, confusion, architecture) double-counts.
		const dir = makeProject({
			"app/src/pages/ProjectForm.tsx": "export function ProjectForm() {}",
			"app/functions/api.ts": "export const handler = 1;",
		});
		setGlobalSrcRoots(["app/src", "app"]);
		const files = collectSourceFiles(dir);
		expect(files).toHaveLength(2);
		const paths = files.map((f) => f.path).sort();
		expect(paths).toEqual(["app/functions/api.ts", "app/src/pages/ProjectForm.tsx"]);
		// The nested root must not drop coverage the broad root provides.
		expect(paths).toContain("app/functions/api.ts");
		setGlobalSrcRoots(undefined);
		rmSync(dir, { recursive: true });
	});

	it("falls back to DEFAULT_SRC_DIRS when no srcRoots set", () => {
		const dir = makeProject({
			"src/app.ts": "export const x = 1;",
			"packages/sdk/src/index.ts": "export const y = 2;",
		});
		setGlobalSrcRoots(undefined);
		const files = collectSourceFiles(dir);
		expect(files).toHaveLength(1);
		expect(files[0]!.path).toBe("src/app.ts");
		rmSync(dir, { recursive: true });
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

describe("isIgnoredPath — external-tool paths honor the scan's ignore", () => {
	it("matches config glob patterns and skip-dirs, leaves others alone", () => {
		setGlobalIgnore(["src/vendor/**"]);
		setGlobalIgnoreNames([]);
		expect(isIgnoredPath("src/vendor/lib.ts")).toBe(true);
		expect(isIgnoredPath("node_modules/foo/index.js")).toBe(true); // skip-dir segment
		expect(isIgnoredPath("src/app.ts")).toBe(false);
		setGlobalIgnore(undefined);
	});

	it("matches bare ignore names on any path segment", () => {
		setGlobalIgnore(undefined);
		setGlobalIgnoreNames(["generated"]);
		expect(isIgnoredPath("src/generated/api.ts")).toBe(true);
		expect(isIgnoredPath("src/app.ts")).toBe(false);
		setGlobalIgnoreNames([]);
	});

	it("ignores configured/generated dot directories, but not every hidden directory", () => {
		setGlobalIgnore(undefined);
		setGlobalIgnoreNames([]);
		expect(isIgnoredPath(".github/scripts/deploy.ts")).toBe(false);
		expect(isIgnoredPath("src/.storybook/preview.ts")).toBe(false);
		expect(isIgnoredPath(".claude/worktrees/copy.ts")).toBe(true);
		expect(isIgnoredPath(".wrangler/tmp/bundle.ts")).toBe(true);
		expect(isIgnoredPath("src/app.ts")).toBe(false);
		// A leading "./" or ".." segment must not swallow the whole path.
		expect(isIgnoredPath("./src/app.ts")).toBe(false);
	});

	it("matches default generated file patterns from policy data", () => {
		setGlobalIgnore(undefined);
		setGlobalIgnoreNames([]);
		expect(isIgnoredPath("assets/store/screenshot-1-chat.html")).toBe(true);
		expect(isIgnoredPath("src/app.min.js")).toBe(true);
		expect(isIgnoredPath("pnpm-lock.yaml")).toBe(true);
		expect(isIgnoredPath("src/app.ts")).toBe(false);
	});
});

describe("normalizeToolPath", () => {
	it("normalizes nested package paths to repo-root-relative paths", () => {
		expect(normalizeToolPath("/repo", "/repo/agents/coder/web", "src/CopilotView.tsx")).toBe("agents/coder/web/src/CopilotView.tsx");
	});

	it("normalizes absolute paths inside the repo", () => {
		expect(normalizeToolPath("/repo", "/repo/agents/coder/web", "/repo/store/console/src/App.tsx")).toBe("store/console/src/App.tsx");
	});

	it("keeps outside-repo paths unchanged", () => {
		expect(normalizeToolPath("/repo", "/repo/agents/coder/web", "../../../../outside.ts")).toBe("../../../../outside.ts");
	});
});
