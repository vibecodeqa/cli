import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectWorkspace } from "../detect.js";
import type { Issue } from "../types.js";
import { buildTypeCheckPlan, parseTscOutput, runTypeCheck, typeCheckTargets } from "./types-check.js";

const TMP = join(import.meta.dirname!, "__types_check_fixture__");

function setup(files: Record<string, string>) {
	rmSync(TMP, { recursive: true, force: true });
	mkdirSync(TMP, { recursive: true });
	for (const [path, content] of Object.entries(files)) {
		const full = join(TMP, path);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, content);
	}
}

afterEach(() => {
	rmSync(TMP, { recursive: true, force: true });
});

describe("parseTscOutput", () => {
	it("normalizes package-relative diagnostics to repo-root paths", () => {
		const issues: Issue[] = [];
		parseTscOutput("src/CopilotView.tsx(135,12): error TS2339: Property 'x' does not exist.", issues, "/repo", "/repo/packages/web");

		expect(issues[0]).toMatchObject({
			file: "packages/web/src/CopilotView.tsx",
			line: 135,
			rule: "TS2339",
			details: {
				repoRelativePath: "packages/web/src/CopilotView.tsx",
				toolRelativePath: "src/CopilotView.tsx",
				toolCwd: "/repo/packages/web",
				pathStatus: "normalized",
			},
		});
	});

	it("normalizes parent-relative diagnostics that resolve inside the repo", () => {
		const issues: Issue[] = [];
		parseTscOutput("../../packages/web/src/App.tsx(4,2): error TS2304: Cannot find name 'x'.", issues, "/repo", "/repo/apps/console");

		expect(issues[0]).toMatchObject({
			file: "packages/web/src/App.tsx",
			details: {
				repoRelativePath: "packages/web/src/App.tsx",
				toolRelativePath: "../../packages/web/src/App.tsx",
				toolCwd: "/repo/apps/console",
			},
		});
	});

	it("marks diagnostics outside the repo as non-clickable", () => {
		const issues: Issue[] = [];
		parseTscOutput("../../../../outside.ts(1,1): error TS2304: Cannot find name 'x'.", issues, "/repo", "/repo/packages/web");

		expect(issues[0].file).toBeUndefined();
		expect((issues[0] as any).details).toMatchObject({
			toolRelativePath: "../../../../outside.ts",
			toolCwd: "/repo/packages/web",
			pathStatus: "outside-repo",
		});
	});

	it("drops diagnostics from ignored generated paths", () => {
		const issues: Issue[] = [];
		parseTscOutput(".claude/worktrees/agent-a/src/App.tsx(1,1): error TS2304: Cannot find name 'x'.", issues, "/repo", "/repo");
		expect(issues).toHaveLength(0);
	});
});

describe("typeCheckTargets", () => {
	it("runs package-local tsconfigs even when the repo root has no tsconfig", () => {
		setup({
			"pnpm-workspace.yaml": "packages:\n  - packages/*\n",
			"package.json": "{}",
			"packages/api/package.json": JSON.stringify({ name: "api", devDependencies: { typescript: "^5" } }),
			"packages/api/tsconfig.json": "{}",
			"packages/api/src/index.ts": "",
			"packages/web/package.json": JSON.stringify({ name: "web", dependencies: { react: "^19" }, devDependencies: { typescript: "^5" } }),
			"packages/web/tsconfig.json": "{}",
			"packages/web/src/App.tsx": "",
		});
		const workspace = detectWorkspace(TMP);
		const targets = typeCheckTargets(TMP, false, workspace);
		expect(targets.map((t) => t.projectPath).sort()).toEqual(["packages/api", "packages/web"]);
		expect(targets.every((t) => t.cwd.startsWith(TMP))).toBe(true);
	});

	it("excludes the non-authoritative root fallback when monorepo package targets exist", () => {
		setup({
			"pnpm-workspace.yaml": "packages:\n  - packages/*\n",
			"package.json": JSON.stringify({ private: true, devDependencies: { typescript: "^5" } }),
			"tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, include: ["packages/**/*.tsx"] }),
			"packages/web/package.json": JSON.stringify({ name: "web", dependencies: { react: "^19" }, devDependencies: { typescript: "^5" } }),
			"packages/web/tsconfig.json": JSON.stringify({
				compilerOptions: { jsx: "preserve", noEmit: true, strict: true },
				include: ["src/**/*.tsx"],
			}),
			"packages/web/src/App.tsx": "declare namespace JSX { interface IntrinsicElements { div: any } }\nexport const App = <div />;\n",
		});
		const workspace = detectWorkspace(TMP);
		const plan = buildTypeCheckPlan(TMP, false, workspace);

		expect(plan.strategy).toBe("monorepo-project-targets");
		expect(plan.targets.map((t) => t.projectPath)).toEqual(["packages/web"]);
		expect(plan.excluded).toEqual([
			expect.objectContaining({
				projectPath: ".",
				command: "npx tsc --noEmit",
				reason: expect.stringContaining("project typecheck targets are authoritative"),
			}),
		]);
	});

	it("does not let a failing monorepo root fallback poison passing package typechecks", () => {
		setup({
			"pnpm-workspace.yaml": "packages:\n  - packages/*\n",
			"package.json": JSON.stringify({ private: true, devDependencies: { typescript: "^5" } }),
			"tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, include: ["packages/**/*.tsx"] }),
			"packages/web/package.json": JSON.stringify({ name: "web", dependencies: { react: "^19" }, devDependencies: { typescript: "^5" } }),
			"packages/web/tsconfig.json": JSON.stringify({
				compilerOptions: { jsx: "preserve", noEmit: true, strict: true },
				include: ["src/**/*.tsx"],
			}),
			"packages/web/src/App.tsx": "declare namespace JSX { interface IntrinsicElements { div: any } }\nexport const App = <div />;\n",
		});
		const workspace = detectWorkspace(TMP);
		const result = runTypeCheck(TMP, false, workspace);

		expect(result.score).toBe(100);
		expect(result.issues).toEqual([]);
		expect(result.details).toMatchObject({
			ok: true,
			excludedRootFallback: true,
			strategy: "monorepo-project-targets",
			projects: [expect.objectContaining({ path: "packages/web", command: "npx tsc --noEmit", authoritative: true })],
			excluded: [expect.objectContaining({ projectPath: ".", command: "npx tsc --noEmit" })],
		});
	}, 30_000);

	it("preserves root fallback failures for single-project repositories", () => {
		setup({
			"package.json": JSON.stringify({ private: true, devDependencies: { typescript: "^5" } }),
			"tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, include: ["src/**/*.tsx"] }),
			"src/App.tsx": "declare namespace JSX { interface IntrinsicElements { div: any } }\nexport const App = <div />;\n",
		});
		const workspace = detectWorkspace(TMP);
		const result = runTypeCheck(TMP, false, workspace);

		expect(result.score).toBeLessThan(100);
		expect(result.issues.some((issue) => issue.rule === "TS17004")).toBe(true);
		expect(result.details).toMatchObject({
			excludedRootFallback: false,
			strategy: "project-targets",
			projects: [expect.objectContaining({ path: ".", command: "npx tsc --noEmit", authoritative: true })],
		});
	}, 30_000);

	it("prefers an explicit root typecheck script over a root npx tsc fallback", () => {
		setup({
			"package.json": JSON.stringify({ private: true, scripts: { typecheck: "tsc --noEmit" }, devDependencies: { typescript: "^5" } }),
			"pnpm-lock.yaml": "",
			"tsconfig.json": JSON.stringify({ compilerOptions: { strict: true }, include: ["src/**/*.ts"] }),
			"src/index.ts": "export const ok = true;\n",
		});
		const workspace = detectWorkspace(TMP);
		const plan = buildTypeCheckPlan(TMP, false, workspace);

		expect(plan.strategy).toBe("root-typecheck-script");
		expect(plan.targets).toEqual([expect.objectContaining({ projectPath: ".", mode: "script", command: "pnpm typecheck" })]);
	});

	it("uses root build mode when project references are configured", () => {
		setup({
			"pnpm-workspace.yaml": "packages:\n  - packages/*\n",
			"package.json": "{}",
			"tsconfig.json": JSON.stringify({ files: [], references: [{ path: "packages/api" }] }),
			"packages/api/package.json": JSON.stringify({ name: "api", devDependencies: { typescript: "^5" } }),
			"packages/api/tsconfig.json": "{}",
			"packages/api/src/index.ts": "",
		});
		const workspace = detectWorkspace(TMP);
		expect(typeCheckTargets(TMP, false, workspace)).toEqual([
			expect.objectContaining({ cwd: TMP, projectId: "root", projectPath: ".", mode: "build", tool: "tsc" }),
		]);
	});

	it("plans dart analysis per Flutter/Dart project context", () => {
		setup({
			"app/pubspec.yaml": "name: app\ndependencies:\n  flutter:\n    sdk: flutter\n",
			"app/lib/main.dart": "",
			"shared/pubspec.yaml": "name: shared\n",
			"shared/lib/core.dart": "",
		});
		const workspace = detectWorkspace(TMP);
		const targets = typeCheckTargets(TMP, true, workspace);
		expect(targets.map((t) => t.projectPath).sort()).toEqual(["app", "shared"]);
		expect(targets.every((t) => t.tool === "dart")).toBe(true);
	});
});
