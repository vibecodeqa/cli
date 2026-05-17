import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectStack, detectWorkspace } from "./detect.js";

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
	});
});
