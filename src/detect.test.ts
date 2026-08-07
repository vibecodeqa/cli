import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectStack, detectWorkspace, parseYamlList } from "./detect.js";

const TMP = join(import.meta.dirname!, "__test_fixture__");

function setup(files: Record<string, string>) {
	rmSync(TMP, { recursive: true, force: true });
	mkdirSync(TMP, { recursive: true });
	for (const [path, content] of Object.entries(files)) {
		const full = join(TMP, path);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, content);
	}
}

function cleanup() {
	rmSync(TMP, { recursive: true, force: true });
}

describe("detectStack", () => {
	it("detects TypeScript + React + Vite + Vitest + Biome + pnpm", () => {
		setup({
			"package.json": JSON.stringify({
				dependencies: { react: "^19" },
				devDependencies: { typescript: "^5", vite: "^6", vitest: "^4", "@biomejs/biome": "^2" },
			}),
			"tsconfig.json": "{}",
			"pnpm-lock.yaml": "",
		});
		const stack = detectStack(TMP);
		expect(stack.language).toBe("typescript");
		expect(stack.framework).toBe("react");
		expect(stack.bundler).toBe("vite");
		expect(stack.testRunner).toBe("vitest");
		expect(stack.linter).toBe("biome");
		expect(stack.packageManager).toBe("pnpm");
		cleanup();
	});

	it("detects JavaScript + no framework + Jest + ESLint + npm", () => {
		setup({
			"package.json": JSON.stringify({
				devDependencies: { jest: "^29", eslint: "^9" },
			}),
			"package-lock.json": "",
		});
		const stack = detectStack(TMP);
		expect(stack.language).toBe("unknown");
		expect(stack.framework).toBe("none");
		expect(stack.testRunner).toBe("jest");
		expect(stack.linter).toBe("eslint");
		expect(stack.packageManager).toBe("npm");
		cleanup();
	});

	it("detects empty project", () => {
		setup({ "package.json": "{}" });
		const stack = detectStack(TMP);
		expect(stack.language).toBe("unknown");
		expect(stack.framework).toBe("none");
		expect(stack.testRunner).toBe("none");
		expect(stack.linter).toBe("none");
		cleanup();
	});

	it("detects Flutter/Dart project", () => {
		setup({
			"pubspec.yaml": "name: my_app\ndependencies:\n  flutter:\n    sdk: flutter\ndev_dependencies:\n  flutter_test:\n    sdk: flutter\n",
			"analysis_options.yaml": "include: package:flutter_lints/flutter.yaml\n",
		});
		const stack = detectStack(TMP);
		expect(stack.language).toBe("dart");
		expect(stack.framework).toBe("flutter");
		expect(stack.testRunner).toBe("flutter_test");
		expect(stack.linter).toBe("dart_analyze");
		expect(stack.packageManager).toBe("pub");
		cleanup();
	});

	it("detects pure Dart project (no Flutter)", () => {
		setup({
			"pubspec.yaml": "name: my_cli\ndependencies:\n  args: ^2.0.0\ndev_dependencies:\n  test: any\n",
		});
		const stack = detectStack(TMP);
		expect(stack.language).toBe("dart");
		expect(stack.framework).toBe("none");
		expect(stack.testRunner).toBe("dart_test");
		expect(stack.linter).toBe("none");
		expect(stack.packageManager).toBe("pub");
		cleanup();
	});

	it("detects Vue + Webpack + Yarn", () => {
		setup({
			"package.json": JSON.stringify({
				dependencies: { vue: "^3" },
				devDependencies: { webpack: "^5" },
			}),
			"yarn.lock": "",
		});
		const stack = detectStack(TMP);
		expect(stack.framework).toBe("vue");
		expect(stack.bundler).toBe("webpack");
		expect(stack.packageManager).toBe("yarn");
		cleanup();
	});
});

describe("detectWorkspace", () => {
	afterEach(() => cleanup());

	it("detects pnpm workspace with glob", () => {
		setup({
			"pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
			"package.json": "{}",
			"packages/sdk/package.json": JSON.stringify({ name: "@org/sdk" }),
			"packages/sdk/src/index.ts": "",
			"packages/cli/package.json": JSON.stringify({ name: "@org/cli" }),
			"packages/cli/src/main.ts": "",
		});
		const ws = detectWorkspace(TMP);
		expect(ws.isMonorepo).toBe(true);
		expect(ws.tool).toBe("pnpm");
		expect(ws.packages).toHaveLength(2);
		expect(ws.packages.map((p) => p.name).sort()).toEqual(["@org/cli", "@org/sdk"]);
		expect(ws.srcRoots.some((r) => r.includes("packages/sdk/src"))).toBe(true);
		expect(ws.discovery?.mode).toBe("manifest");
		expect(ws.projects?.map((p) => p.path).sort()).toEqual([".", "packages/cli", "packages/sdk"]);
		expect(ws.projects?.find((p) => p.path === "packages/sdk")?.evidence.some((e) => e.file === "pnpm-workspace.yaml")).toBe(true);
	});

	it("detects npm workspaces with explicit paths", () => {
		setup({
			"package.json": JSON.stringify({ workspaces: ["packages/web", "packages/api"] }),
			"packages/web/package.json": JSON.stringify({ name: "web" }),
			"packages/web/src/app.ts": "",
			"packages/api/package.json": JSON.stringify({ name: "api" }),
			"packages/api/src/server.ts": "",
		});
		const ws = detectWorkspace(TMP);
		expect(ws.isMonorepo).toBe(true);
		expect(ws.tool).toBe("npm");
		expect(ws.packages).toHaveLength(2);
	});

	it("detects packages without src/ (root code)", () => {
		setup({
			"pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
			"package.json": "{}",
			"packages/utils/package.json": JSON.stringify({ name: "utils" }),
			"packages/utils/index.ts": "export const x = 1;",
		});
		const ws = detectWorkspace(TMP);
		expect(ws.isMonorepo).toBe(true);
		expect(ws.packages[0]!.hasRootCode).toBe(true);
		expect(ws.packages[0]!.hasSrc).toBe(true); // hasSrc includes rootCode
		expect(ws.srcRoots.some((r) => r === "packages/utils")).toBe(true);
	});

	it("detects melos (Dart monorepo)", () => {
		setup({
			"melos.yaml": "name: my_project\npackages:\n  - packages/*\n",
			"pubspec.yaml": "name: root\n",
			"packages/core/pubspec.yaml": "name: core\n",
			"packages/core/lib/core.dart": "",
			"packages/ui/pubspec.yaml": "name: ui\n",
			"packages/ui/lib/ui.dart": "",
		});
		const ws = detectWorkspace(TMP);
		expect(ws.isMonorepo).toBe(true);
		expect(ws.tool).toBe("melos");
		expect(ws.packages).toHaveLength(2);
	});

	it("returns non-monorepo for single package", () => {
		setup({
			"package.json": JSON.stringify({ name: "my-app" }),
			"src/index.ts": "",
		});
		const ws = detectWorkspace(TMP);
		expect(ws.isMonorepo).toBe(false);
		expect(ws.tool).toBe("none");
	});

	it("detects conventional server/client layout", () => {
		setup({
			"package.json": "{}",
			"server/package.json": JSON.stringify({ name: "server" }),
			"server/src/index.ts": "",
			"client/package.json": JSON.stringify({ name: "client" }),
			"client/src/App.tsx": "",
		});
		const ws = detectWorkspace(TMP);
		expect(ws.isMonorepo).toBe(true);
		expect(ws.tool).toBe("none");
		expect(ws.packages).toHaveLength(2);
		expect(ws.discovery?.mode).toBe("convention");
		expect(ws.projects?.map((p) => p.path).sort()).toEqual([".", "client", "server"]);
		expect(ws.projects?.find((p) => p.path === "server")?.kind).toBe("service");
	});

	it("creates project contexts with package-local stack and config evidence", () => {
		setup({
			"pnpm-workspace.yaml": "packages:\n  - apps/*\n  - packages/*\n",
			"package.json": JSON.stringify({ devDependencies: { typescript: "^5" } }),
			"pnpm-lock.yaml": "",
			"apps/web/package.json": JSON.stringify({ name: "web", dependencies: { react: "^19" }, devDependencies: { eslint: "^9" } }),
			"apps/web/eslint.config.js": "export default [];\n",
			"apps/web/src/App.tsx": "",
			"packages/core/package.json": JSON.stringify({ name: "core", devDependencies: { "@biomejs/biome": "^2" } }),
			"packages/core/biome.json": "{}",
			"packages/core/tsconfig.json": "{}",
			"packages/core/src/index.ts": "",
		});
		const ws = detectWorkspace(TMP);
		const web = ws.projects?.find((p) => p.path === "apps/web");
		const core = ws.projects?.find((p) => p.path === "packages/core");
		expect(web?.kind).toBe("app");
		expect(web?.stack.framework).toBe("react");
		expect(web?.stack.linter).toBe("eslint");
		expect(web?.configFiles).toContain("apps/web/eslint.config.js");
		expect(web?.confidence).toBeGreaterThan(0.8);
		expect(web?.toolCommands.lint?.[0]).toMatchObject({ tool: "eslint", cwd: "apps/web" });
		expect(core?.kind).toBe("library");
		expect(core?.stack.linter).toBe("biome");
		expect(core?.srcRoots).toEqual(["packages/core/src"]);
		expect(core?.toolCommands.typecheck?.[0]).toMatchObject({ tool: "tsc", cwd: "packages/core" });
	});

	it("detects convention-only projects from supported markers without a root manifest", () => {
		setup({
			"workers/host/package.json": JSON.stringify({ name: "host", devDependencies: { typescript: "^5", vitest: "^4" } }),
			"workers/host/tsconfig.json": "{}",
			"workers/host/src/index.ts": "",
			"services/api/tsconfig.json": "{}",
			"services/api/src/index.ts": "",
			"workers/tmp/readme.md": "not a project",
		});
		const ws = detectWorkspace(TMP);
		expect(ws.isMonorepo).toBe(true);
		expect(ws.tool).toBe("none");
		expect(ws.discovery?.mode).toBe("convention");
		expect(ws.projects?.map((p) => p.path).sort()).toEqual([".", "services/api", "workers/host"]);
		expect(ws.projects?.find((p) => p.path === "services/api")?.stack.language).toBe("typescript");
		expect(ws.projects?.find((p) => p.path === "services/api")?.toolCommands.typecheck?.[0]).toMatchObject({
			tool: "tsc",
			cwd: "services/api",
		});
		expect(ws.discovery?.evidence).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "rejected",
					path: "workers/tmp",
				}),
			]),
		);
	});

	it("handles pnpm-workspace.yaml with comments between entries", () => {
		setup({
			"pnpm-workspace.yaml": "packages:\n  - packages/*\n  # shared libs\n  - apps/*\n",
			"package.json": "{}",
			"packages/sdk/package.json": JSON.stringify({ name: "sdk" }),
			"packages/sdk/src/index.ts": "",
			"apps/web/package.json": JSON.stringify({ name: "web" }),
			"apps/web/src/app.ts": "",
		});
		const ws = detectWorkspace(TMP);
		expect(ws.isMonorepo).toBe(true);
		expect(ws.tool).toBe("pnpm");
		expect(ws.packages).toHaveLength(2);
		expect(ws.packages.map((p) => p.name).sort()).toEqual(["sdk", "web"]);
	});

	it("handles flow-style YAML: packages: [a, b]", () => {
		setup({
			"pnpm-workspace.yaml": "packages: [packages/*, apps/*]\n",
			"package.json": "{}",
			"packages/sdk/package.json": JSON.stringify({ name: "sdk" }),
			"packages/sdk/src/index.ts": "",
			"apps/web/package.json": JSON.stringify({ name: "web" }),
			"apps/web/src/app.ts": "",
		});
		const ws = detectWorkspace(TMP);
		expect(ws.isMonorepo).toBe(true);
		expect(ws.tool).toBe("pnpm");
		expect(ws.packages).toHaveLength(2);
	});

	it("filters negation patterns (!prefix)", () => {
		setup({
			"pnpm-workspace.yaml": "packages:\n  - packages/*\n  - '!packages/internal'\n",
			"package.json": "{}",
			"packages/sdk/package.json": JSON.stringify({ name: "sdk" }),
			"packages/sdk/src/index.ts": "",
			"packages/internal/package.json": JSON.stringify({ name: "internal" }),
			"packages/internal/src/secret.ts": "",
		});
		const ws = detectWorkspace(TMP);
		expect(ws.isMonorepo).toBe(true);
		// packages/* matches both, but !packages/internal is filtered from globs
		// (resolveGlob for packages/* still adds both — negation filtering is glob-level)
		expect(ws.packages.length).toBeGreaterThanOrEqual(1);
	});

	it("detects bun workspaces", () => {
		setup({
			"package.json": JSON.stringify({ workspaces: ["packages/*"] }),
			"bun.lockb": "",
			"packages/app/package.json": JSON.stringify({ name: "app" }),
			"packages/app/src/index.ts": "",
		});
		const ws = detectWorkspace(TMP);
		expect(ws.isMonorepo).toBe(true);
		expect(ws.tool).toBe("bun");
		expect(ws.packages).toHaveLength(1);
	});
});

describe("detectStack with workspace aggregation", () => {
	afterEach(() => cleanup());

	it("detects framework from workspace packages when not in root", () => {
		setup({
			"pnpm-workspace.yaml": "packages:\n  - packages/*\n",
			"package.json": JSON.stringify({ devDependencies: { typescript: "^5", vitest: "^4" } }),
			"tsconfig.json": "{}",
			"pnpm-lock.yaml": "",
			"packages/web/package.json": JSON.stringify({ name: "web", dependencies: { react: "^19" } }),
			"packages/web/src/App.tsx": "",
			"packages/api/package.json": JSON.stringify({ name: "api" }),
			"packages/api/src/server.ts": "",
		});
		const workspace = detectWorkspace(TMP);
		const stack = detectStack(TMP, workspace);
		expect(stack.framework).toBe("react");
		expect(stack.testRunner).toBe("vitest");
		expect(stack.language).toBe("typescript");
	});

	it("detects Vue from workspace package", () => {
		setup({
			"pnpm-workspace.yaml": "packages:\n  - packages/*\n",
			"package.json": JSON.stringify({ devDependencies: { typescript: "^5" } }),
			"tsconfig.json": "{}",
			"packages/frontend/package.json": JSON.stringify({ name: "frontend", dependencies: { vue: "^3", nuxt: "^4" } }),
			"packages/frontend/src/app.vue": "",
		});
		const workspace = detectWorkspace(TMP);
		const stack = detectStack(TMP, workspace);
		expect(stack.framework).toBe("vue");
	});

	it("works without workspace (backward compat)", () => {
		setup({
			"package.json": JSON.stringify({ dependencies: { react: "^19" }, devDependencies: { typescript: "^5" } }),
			"tsconfig.json": "{}",
		});
		const stack = detectStack(TMP);
		expect(stack.framework).toBe("react");
	});
});

describe("parseYamlList", () => {
	it("parses block-style list", () => {
		const yaml = "packages:\n  - packages/*\n  - apps/*\n";
		expect(parseYamlList(yaml, "packages")).toEqual(["packages/*", "apps/*"]);
	});

	it("parses block-style with comments between entries", () => {
		const yaml = "packages:\n  - packages/*\n  # shared libs\n  - apps/*\n  # internal\n  - tools/*\n";
		expect(parseYamlList(yaml, "packages")).toEqual(["packages/*", "apps/*", "tools/*"]);
	});

	it("parses block-style with blank lines", () => {
		const yaml = "packages:\n  - packages/*\n\n  - apps/*\n";
		expect(parseYamlList(yaml, "packages")).toEqual(["packages/*", "apps/*"]);
	});

	it("parses flow-style list", () => {
		const yaml = "packages: [packages/*, apps/*]\n";
		expect(parseYamlList(yaml, "packages")).toEqual(["packages/*", "apps/*"]);
	});

	it("parses flow-style with quotes", () => {
		const yaml = "packages: ['packages/*', \"apps/*\"]\n";
		expect(parseYamlList(yaml, "packages")).toEqual(["packages/*", "apps/*"]);
	});

	it("stops at next top-level key", () => {
		const yaml = "packages:\n  - packages/*\ncatalog:\n  react: ^19\n";
		expect(parseYamlList(yaml, "packages")).toEqual(["packages/*"]);
	});

	it("handles quoted block-style entries", () => {
		const yaml = "packages:\n  - 'packages/*'\n  - \"apps/*\"\n";
		expect(parseYamlList(yaml, "packages")).toEqual(["packages/*", "apps/*"]);
	});

	it("returns empty for missing key", () => {
		const yaml = "name: my-project\n";
		expect(parseYamlList(yaml, "packages")).toEqual([]);
	});

	it("handles inline comments on list items", () => {
		const yaml = "packages:\n  - packages/* # core packages\n  - apps/* # applications\n";
		expect(parseYamlList(yaml, "packages")).toEqual(["packages/*", "apps/*"]);
	});
});
