import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { StackInfo } from "../types.js";
import { parseBiomeLint, parseEslintJson, scoreLint, zeroConfigLintPlan } from "./lint.js";

describe("parseBiomeLint", () => {
	it("returns null on non-JSON (biome absent / crashed)", () => {
		expect(parseBiomeLint("")).toBeNull();
		expect(parseBiomeLint("biome: command not found")).toBeNull();
		// Valid JSON but not a biome report → still null (no diagnostics array).
		expect(parseBiomeLint('{"ok":true}')).toBeNull();
	});

	it("maps diagnostics to issues with severity, file and rule", () => {
		const out = JSON.stringify({
			diagnostics: [
				{ severity: "error", description: "unused var", category: "lint/correctness/noUnusedVariables", location: { path: "src/a.ts" } },
				{ severity: "warning", description: "use const", category: "lint/style/useConst", location: { path: { file: "src/b.ts" } } },
			],
		});
		const issues = parseBiomeLint(out)!;
		expect(issues).toHaveLength(2);
		expect(issues[0]).toMatchObject({ severity: "error", file: "src/a.ts", rule: "lint/correctness/noUnusedVariables" });
		// path can be an object form depending on biome version.
		expect(issues[1]).toMatchObject({ severity: "warning", file: "src/b.ts" });
	});

	it("normalizes package-relative Biome paths with tool metadata", () => {
		const out = JSON.stringify({
			diagnostics: [
				{ severity: "error", description: "unused var", category: "lint/correctness/noUnusedVariables", location: { path: "src/a.ts" } },
				{
					severity: "warning",
					description: "cross package",
					category: "lint/style/useConst",
					location: { path: "../../packages/web/src/b.ts" },
				},
			],
		});
		const issues = parseBiomeLint(out, { repoCwd: "/repo", toolCwd: "/repo/apps/console" })!;

		expect(issues[0]).toMatchObject({
			file: "apps/console/src/a.ts",
			details: {
				repoRelativePath: "apps/console/src/a.ts",
				toolRelativePath: "src/a.ts",
				toolCwd: "/repo/apps/console",
				pathStatus: "normalized",
			},
		});
		expect(issues[1]).toMatchObject({
			file: "packages/web/src/b.ts",
			details: {
				repoRelativePath: "packages/web/src/b.ts",
				toolRelativePath: "../../packages/web/src/b.ts",
			},
		});
	});

	it("skips generated files (node_modules, .vibe-check)", () => {
		const out = JSON.stringify({
			diagnostics: [
				{ severity: "error", description: "x", category: "lint/x", location: { path: "node_modules/foo/index.js" } },
				{ severity: "error", description: "y", category: "lint/y", location: { path: ".vibe-check/report.json" } },
				{ severity: "error", description: "z", category: "lint/z", location: { path: "src/keep.ts" } },
			],
		});
		const issues = parseBiomeLint(out)!;
		expect(issues.map((i) => i.file)).toEqual(["src/keep.ts"]);
	});

	it("returns [] for a clean project (empty diagnostics)", () => {
		expect(parseBiomeLint('{"diagnostics":[]}')).toEqual([]);
	});

	it("collapses multiple parse errors in one file to a single issue", () => {
		const out = JSON.stringify({
			diagnostics: [
				{ severity: "error", description: "parse 1", category: "parse", location: { path: "src/bad.ts" } },
				{ severity: "error", description: "parse 2", category: "parse", location: { path: "src/bad.ts" } },
				{ severity: "error", description: "parse 3", category: "parse", location: { path: "src/bad.ts" } },
				{ severity: "warning", description: "real lint", category: "lint/style/useConst", location: { path: "src/bad.ts" } },
			],
		});
		const issues = parseBiomeLint(out)!;
		// One collapsed parse issue for the file + the one genuine lint warning.
		expect(issues.filter((i) => i.rule === "parse")).toHaveLength(1);
		expect(issues).toHaveLength(2);
	});
});

describe("parseEslintJson", () => {
	it("normalizes ESLint filePath from nested tool cwd", () => {
		const out = JSON.stringify([
			{
				filePath: "src/App.tsx",
				messages: [{ severity: 2, message: "broken", line: 7, ruleId: "react/no-unknown-property" }],
			},
			{
				filePath: "../../packages/web/src/CopilotView.tsx",
				messages: [{ severity: 1, message: "warn", line: 2, ruleId: "no-console" }],
			},
		]);

		const issues = parseEslintJson(out, { repoCwd: "/repo", toolCwd: "/repo/apps/console" });

		expect(issues[0]).toMatchObject({
			severity: "error",
			file: "apps/console/src/App.tsx",
			details: {
				repoRelativePath: "apps/console/src/App.tsx",
				toolRelativePath: "src/App.tsx",
				toolCwd: "/repo/apps/console",
			},
		});
		expect(issues[1]).toMatchObject({
			severity: "warning",
			file: "packages/web/src/CopilotView.tsx",
			details: {
				repoRelativePath: "packages/web/src/CopilotView.tsx",
				toolRelativePath: "../../packages/web/src/CopilotView.tsx",
			},
		});
	});

	it("marks ESLint paths outside the repo as non-clickable", () => {
		const out = JSON.stringify([
			{
				filePath: "../../../../outside.ts",
				messages: [{ severity: 2, message: "outside", line: 1, ruleId: "no-restricted-imports" }],
			},
		]);

		const issues = parseEslintJson(out, { repoCwd: "/repo", toolCwd: "/repo/apps/console" });

		expect(issues[0].file).toBeUndefined();
		expect((issues[0] as any).details).toMatchObject({
			toolRelativePath: "../../../../outside.ts",
			toolCwd: "/repo/apps/console",
			pathStatus: "outside-repo",
		});
	});
});

/** Issue #92: the zero-config Biome fallback ran on any project that configured
 *  no linter — including Dart, Go and Python trees Biome cannot parse. It walked
 *  past every file, reported zero diagnostics, exited 0, and that scored A/100
 *  with `status: "passed"` — a positive assertion about code no linter read. */
describe("zeroConfigLintPlan", () => {
	function project(files: Record<string, string>): string {
		const dir = mkdtempSync(join(tmpdir(), "vcqa-lint-"));
		for (const [name, content] of Object.entries(files)) {
			const full = join(dir, name);
			mkdirSync(dirname(full), { recursive: true });
			writeFileSync(full, content);
		}
		return dir;
	}

	const stack = (language: string): StackInfo =>
		({
			language,
			framework: "none",
			bundler: "none",
			testRunner: "none",
			linter: "none",
			packageManager: "npm",
		}) as StackInfo;

	it("runs Biome where there is JavaScript/TypeScript to lint", () => {
		const dir = project({ "src/index.js": "export const x = 1;\n" });
		expect(zeroConfigLintPlan(dir, stack("javascript"), "src/")).toEqual({ kind: "biome" });
	});

	it("lints SFC projects — Biome reads the embedded <script>", () => {
		const dir = project({ "src/App.vue": "<script setup>const a = 1;</script>\n" });
		expect(zeroConfigLintPlan(dir, stack("javascript"), "src/")).toEqual({ kind: "biome" });
	});

	it("refuses to score a Dart tree and names the language", () => {
		const dir = project({ "pubspec.yaml": "name: app\n", "lib/main.dart": "void main() {}\n" });
		const plan = zeroConfigLintPlan(dir, stack("dart"), ".");
		expect(plan.kind).toBe("unavailable");
		expect(plan.kind === "unavailable" && plan.reason).toContain("Dart");
	});

	it("refuses to score a Go tree", () => {
		const dir = project({ "go.mod": "module example.com/a\n", "cmd/app/main.go": "package main\n" });
		const plan = zeroConfigLintPlan(dir, stack("go"), ".");
		expect(plan.kind).toBe("unavailable");
		expect(plan.kind === "unavailable" && plan.reason).toContain("Go");
	});

	it("does not count a stray package.json or stylesheet as lintable code", () => {
		// The trap from the issue: Biome happily lints a JSON file in a Flutter
		// repo while having nothing to say about the Dart.
		const dir = project({ "package.json": "{}\n", "web/styles.css": "body{color:red}\n", "lib/main.dart": "void main() {}\n" });
		expect(zeroConfigLintPlan(dir, stack("dart"), ".").kind).toBe("unavailable");
	});

	it("falls back to the repo root when the lint target itself has no scripts", () => {
		// `src/` exists and holds only assets, but the project is still JavaScript.
		const dir = project({ "src/logo.svg": "<svg/>", "scripts/build.js": "console.log(1);\n" });
		expect(zeroConfigLintPlan(dir, stack("javascript"), "src/")).toEqual({ kind: "biome" });
	});
});

describe("scoreLint", () => {
	it("is 100/A when there are no issues", () => {
		expect(scoreLint([])).toEqual({ score: 100, errors: 0, warnings: 0 });
	});

	it("penalizes errors more than warnings", () => {
		const withErrors = scoreLint([
			{ severity: "error", message: "a" },
			{ severity: "error", message: "b" },
		]);
		const withWarnings = scoreLint([
			{ severity: "warning", message: "a" },
			{ severity: "warning", message: "b" },
		]);
		expect(withErrors.errors).toBe(2);
		expect(withWarnings.warnings).toBe(2);
		expect(withErrors.score).toBeLessThan(withWarnings.score);
	});

	it("never drops below 0", () => {
		const many = Array.from({ length: 200 }, () => ({ severity: "error" as const, message: "x" }));
		expect(scoreLint(many).score).toBeGreaterThanOrEqual(0);
	});
});
