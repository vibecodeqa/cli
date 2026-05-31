import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
	});

	it("includes source snippets when file exists", () => {
		const dir = mkdtempSync(join(tmpdir(), "vcqa-report-"));
		mkdirSync(join(dir, "src"), { recursive: true });
		writeFileSync(join(dir, "src/auth.ts"), `function login() {\n  // do stuff\n  return true;\n}\n`);

		const report = makeReport(dir, [
			{
				name: "standards", score: 80, grade: "B", details: {}, duration: 10,
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
				name: "standards", score: 80, grade: "B", details: {}, duration: 10,
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
				name: "security", score: 50, grade: "C", details: {}, duration: 10,
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
