import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CheckResult, VibeReport } from "../types.js";

// We test categoryPage indirectly through generatePages
import { generatePages } from "./html.js";

function makeReport(cwd: string, checks: CheckResult[]): VibeReport {
	return {
		version: "0.1.0",
		timestamp: new Date().toISOString(),
		score: 80,
		grade: "B",
		checks,
		meta: {
			cwd,
			node: "v22",
			duration: 100,
			stack: { language: "typescript", framework: "react", bundler: "vite", testRunner: "vitest", linter: "biome", packageManager: "pnpm" },
			repoUrl: null,
			branch: "main",
		},
	};
}

describe("report generation", () => {
	it("generates all expected pages", () => {
		const dir = mkdtempSync(join(tmpdir(), "vcqa-report-"));
		const report = makeReport(dir, [
			{ name: "structure", score: 100, grade: "A", details: {}, issues: [], duration: 10 },
			{ name: "lint", score: 90, grade: "A", details: {}, issues: [], duration: 10 },
		]);
		const pages = generatePages(report);
		expect(pages.has("index.html")).toBe(true);
		expect(pages.has("foundations.html")).toBe(true);
		expect(pages.has("issues.html")).toBe(true);
		expect(pages.has("files.html")).toBe(true);
		expect(pages.has("trends.html")).toBe(true);
		expect(pages.has("feature-map.html")).toBe(true);
		expect(pages.has("scan-scope.html")).toBe(true);
	});

	it("shows deterministic scan scope evidence", () => {
		const dir = mkdtempSync(join(tmpdir(), "vcqa-report-"));
		const report = makeReport(dir, []);
		report.meta.filesScanned = 12;
		report.meta.workspace = {
			isMonorepo: true,
			tool: "pnpm",
			packages: [{ name: "web", path: "apps/web", hasSrc: true, hasRootCode: false, hasTests: true, hasLinter: true }],
			srcRoots: ["apps/web/src"],
			discovery: {
				mode: "manifest",
				evidence: [
					{ kind: "manifest", file: "pnpm-workspace.yaml", description: "pnpm workspace manifest defines package globs" },
					{
						kind: "rejected",
						path: "apps/prototype",
						description: "Convention candidate rejected because no supported project manifest was found",
					},
				],
			},
			projects: [
				{
					id: "apps-web",
					name: "web",
					path: "apps/web",
					kind: "app",
					stack: {
						language: "typescript",
						framework: "react",
						bundler: "vite",
						testRunner: "vitest",
						linter: "biome",
						packageManager: "pnpm",
					},
					srcRoots: ["apps/web/src"],
					testRoots: ["apps/web/tests"],
					configFiles: ["apps/web/tsconfig.json"],
					manifestFiles: ["apps/web/package.json"],
					evidence: [
						{ kind: "source", path: "apps/web", description: "Workspace package selected as a scan project" },
						{ kind: "manifest", file: "apps/web/package.json", description: "Project manifest found" },
					],
					confidence: 0.9,
					toolCommands: {
						lint: [{ tool: "biome", cwd: "apps/web", command: ["npx", "biome", "check", "."] }],
					},
				},
			],
		};
		report.meta.scanPolicy = {
			version: 1,
			ignoreHiddenDirectories: true,
			defaultDirectoryNameValues: ["node_modules", "dist"],
			defaultFilePatternValues: ["*.min.js"],
			generatedPathPrefixValues: ["generated"],
			configIgnorePatternValues: ["fixtures/**"],
			userIgnoreNameValues: ["tmp"],
			envIgnoreNameValues: ["coverage"],
			gitignoreDirectoryNameValues: ["build"],
		};
		report.meta.fileInventory = {
			totalFiles: 20,
			includedFiles: 12,
			ignoredFiles: 3,
			ignoredDirectories: 2,
			generatedFiles: 1,
			securitySensitiveFiles: 1,
			byKind: { source: 8, test: 4 },
		};

		const pages = generatePages(report);
		const scope = pages.get("scan-scope.html") || "";
		expect(scope).toContain("Accepted Projects");
		expect(scope).toContain("apps/web");
		expect(scope).toContain("Why scanned");
		expect(scope).toContain("Workspace package selected as a scan project");
		expect(scope).toContain("Rejected Candidates");
		expect(scope).toContain("apps/prototype");
		expect(scope).toContain("skipped / unavailable");
		expect(scope).toContain("Effective Scan Policy");
		expect(scope).toContain("node_modules");
		expect(scope).toContain("generated");
		expect(scope).toContain("Copy JSON");
		expect(scope).toContain("&quot;scanPolicy&quot;");
		const index = pages.get("index.html") || "";
		expect(index).toContain("scan-scope.html");
		expect(index).toContain("Scan Scope");
	});

	it("includes source snippets when file exists", () => {
		const dir = mkdtempSync(join(tmpdir(), "vcqa-report-"));
		mkdirSync(join(dir, "src"), { recursive: true });
		writeFileSync(join(dir, "src/auth.ts"), `function login() {\n  // do stuff\n  return true;\n}\n`);

		const report = makeReport(dir, [
			{
				name: "standards",
				score: 80,
				grade: "B",
				details: {},
				duration: 10,
				issues: [{ severity: "warning", message: "console.log found", file: "src/auth.ts", line: 2, rule: "no-console" }],
			},
		]);
		const pages = generatePages(report);
		const foundationsPage = pages.get("foundations.html") || "";
		expect(foundationsPage).toContain("src-block");
		expect(foundationsPage).toContain("src-hl");
		expect(foundationsPage).toContain("// do stuff");
		expect(foundationsPage).toContain("Copy fix prompt");
	});

	it("handles missing source files gracefully", () => {
		const dir = mkdtempSync(join(tmpdir(), "vcqa-report-"));
		const report = makeReport(dir, [
			{
				name: "standards",
				score: 80,
				grade: "B",
				details: {},
				duration: 10,
				issues: [{ severity: "warning", message: "issue", file: "src/missing.ts", line: 5, rule: "test" }],
			},
		]);
		// Should not throw
		const pages = generatePages(report);
		const page = pages.get("foundations.html") || "";
		expect(page).not.toContain('<div class="src-block">'); // no snippet for missing file
		expect(page).toContain("issue"); // issue still shown
	});

	it("escapes HTML in source snippets", () => {
		const dir = mkdtempSync(join(tmpdir(), "vcqa-report-"));
		mkdirSync(join(dir, "src"), { recursive: true });
		writeFileSync(join(dir, "src/xss.ts"), `const x = "<script>alert(1)</script>";\n`);

		const report = makeReport(dir, [
			{
				name: "security",
				score: 50,
				grade: "C",
				details: {},
				duration: 10,
				issues: [{ severity: "error", message: "XSS", file: "src/xss.ts", line: 1, rule: "CWE-79" }],
			},
		]);
		const pages = generatePages(report);
		const page = pages.get("security.html") || "";
		expect(page).toContain("&lt;script&gt;"); // escaped, not raw
		expect(page).not.toContain("<script>alert");
	});

	it("feature map page shows teaser without Pro", () => {
		const dir = mkdtempSync(join(tmpdir(), "vcqa-report-"));
		const report = makeReport(dir, [
			{ name: "dead-patterns", score: 0, grade: "F", details: { premium: true, comingSoon: true }, issues: [], duration: 0 },
		]);
		const pages = generatePages(report);
		const fm = pages.get("feature-map.html") || "";
		expect(fm).toContain("fm-teaser");
		expect(fm).toContain("VCQA_PRO_KEY");
	});

	it("includes preferences button in nav", () => {
		const dir = mkdtempSync(join(tmpdir(), "vcqa-report-"));
		const report = makeReport(dir, []);
		const pages = generatePages(report);
		const index = pages.get("index.html") || "";
		expect(index).toContain("prefs-btn");
		expect(index).toContain("setTheme");
		expect(index).toContain("setFont");
		expect(index).toContain("vcqa-theme");
	});

	it("includes Feature Map in nav", () => {
		const dir = mkdtempSync(join(tmpdir(), "vcqa-report-"));
		const report = makeReport(dir, []);
		const pages = generatePages(report);
		const index = pages.get("index.html") || "";
		expect(index).toContain("feature-map.html");
		expect(index).toContain("Feature Map");
	});
});
