import { describe, expect, it } from "vitest";
import { parseBiomeLint, parseEslintJson, scoreLint } from "./lint.js";

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
					location: { path: "../../agents/coder/web/src/b.ts" },
				},
			],
		});
		const issues = parseBiomeLint(out, { repoCwd: "/repo", toolCwd: "/repo/store/console" })!;

		expect(issues[0]).toMatchObject({
			file: "store/console/src/a.ts",
			details: {
				repoRelativePath: "store/console/src/a.ts",
				toolRelativePath: "src/a.ts",
				toolCwd: "/repo/store/console",
				pathStatus: "normalized",
			},
		});
		expect(issues[1]).toMatchObject({
			file: "agents/coder/web/src/b.ts",
			details: {
				repoRelativePath: "agents/coder/web/src/b.ts",
				toolRelativePath: "../../agents/coder/web/src/b.ts",
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
				filePath: "../../agents/coder/web/src/CopilotView.tsx",
				messages: [{ severity: 1, message: "warn", line: 2, ruleId: "no-console" }],
			},
		]);

		const issues = parseEslintJson(out, { repoCwd: "/repo", toolCwd: "/repo/store/console" });

		expect(issues[0]).toMatchObject({
			severity: "error",
			file: "store/console/src/App.tsx",
			details: {
				repoRelativePath: "store/console/src/App.tsx",
				toolRelativePath: "src/App.tsx",
				toolCwd: "/repo/store/console",
			},
		});
		expect(issues[1]).toMatchObject({
			severity: "warning",
			file: "agents/coder/web/src/CopilotView.tsx",
			details: {
				repoRelativePath: "agents/coder/web/src/CopilotView.tsx",
				toolRelativePath: "../../agents/coder/web/src/CopilotView.tsx",
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

		const issues = parseEslintJson(out, { repoCwd: "/repo", toolCwd: "/repo/store/console" });

		expect(issues[0].file).toBeUndefined();
		expect((issues[0] as any).details).toMatchObject({
			toolRelativePath: "../../../../outside.ts",
			toolCwd: "/repo/store/console",
			pathStatus: "outside-repo",
		});
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
