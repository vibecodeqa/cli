import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildReportHistorySnapshot } from "../report-contract.js";
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

describe("actions page delta (#107)", () => {
	const unavailable: CheckResult = {
		name: "lint",
		score: 100,
		grade: "A",
		details: { skipped: true, unavailable: true, status: "unavailable" },
		issues: [],
		duration: 1,
	};
	const scored: CheckResult = { name: "lint", score: 72, grade: "C", details: { status: "failed" }, issues: [], duration: 1 };
	(unavailable as CheckResult & { status: string }).status = "unavailable";
	(scored as CheckResult & { status: string }).status = "failed";

	it("shows the status transition and no 100 → 72 score change", () => {
		const dir = mkdtempSync(join(tmpdir(), "vcqa-report-"));
		const html = generatePages(makeReport(dir, [scored]), undefined, makeReport(dir, [unavailable])).get("actions.html")!;
		expect(html).toContain("Status changes:");
		expect(html).toContain("lint: unavailable → 72");
		expect(html).not.toContain("lint -28");
	});

	it("does not show removing the tool as an improvement", () => {
		const dir = mkdtempSync(join(tmpdir(), "vcqa-report-"));
		const html = generatePages(makeReport(dir, [unavailable]), undefined, makeReport(dir, [{ ...scored, score: 64 }])).get("actions.html")!;
		expect(html).toContain("lint: 64 → unavailable");
		expect(html).not.toContain("lint +36");
	});
});

describe("trends page with not-run checks (#107)", () => {
	function writeHistory(dir: string, entries: { timestamp: string; checks: CheckResult[] }[]): string {
		const historyDir = join(dir, "history");
		mkdirSync(historyDir, { recursive: true });
		for (const { timestamp, checks } of entries) {
			const report = { ...makeReport(dir, checks), timestamp };
			writeFileSync(join(historyDir, `${timestamp}.json`), JSON.stringify(buildReportHistorySnapshot(report)));
		}
		return historyDir;
	}
	const lint = (score: number): CheckResult => ({
		name: "lint",
		score,
		grade: "C",
		details: { status: "failed" },
		issues: [],
		duration: 1,
	});
	const lintUnavailable: CheckResult = {
		name: "lint",
		score: 100,
		grade: "A",
		details: { skipped: true, unavailable: true, status: "unavailable" },
		issues: [],
		duration: 1,
	};
	const structure = (score: number): CheckResult => ({ name: "structure", score, grade: "B", details: {}, issues: [], duration: 1 });
	const trendRows = (html: string) =>
		[...html.matchAll(/<div class="trend-row">(.*?)<\/div>/g)].map((m) =>
			m[1]
				.replace(/<[^>]+>/g, " ")
				.replace(/\s+/g, " ")
				.trim(),
		);

	it("shows uninstalling a tool as a transition, not +36", () => {
		const dir = mkdtempSync(join(tmpdir(), "vcqa-report-"));
		const historyDir = writeHistory(dir, [
			{ timestamp: "2026-10-01T00:00:00.000Z", checks: [lint(64), structure(80)] },
			{ timestamp: "2026-10-02T00:00:00.000Z", checks: [lint(70), structure(84)] },
			{ timestamp: "2026-10-03T00:00:00.000Z", checks: [lintUnavailable, structure(86)] },
		]);
		const r2 = makeReport(dir, [lintUnavailable, structure(86)]);
		const html = generatePages(r2, historyDir).get("trends.html")!;
		const rows = trendRows(html);
		expect(rows).toContain("structure 80 → 86 +6");
		expect(rows).toContain("lint 64 → unavailable status");
		expect(html).not.toContain("+36");
		expect(rows.join("\n")).not.toMatch(/lint.*100/);
		// The lint card plots only the scans where lint ran and labels its current state.
		expect(html).toMatch(/<span class="trend-name">lint<\/span><span class="trend-status muted">unavailable<\/span>/);
	});

	it("shows installing a tool, and a dropped check, as transitions (legacy details flags)", () => {
		const dir = mkdtempSync(join(tmpdir(), "vcqa-report-"));
		const legacySkipped: CheckResult = { name: "lint", score: 100, grade: "A", details: { skipped: true }, issues: [], duration: 1 };
		const historyDir = writeHistory(dir, [
			{ timestamp: "2026-10-01T00:00:00.000Z", checks: [legacySkipped, structure(80)] },
			{ timestamp: "2026-10-02T00:00:00.000Z", checks: [lint(72)] },
			{ timestamp: "2026-10-03T00:00:00.000Z", checks: [lint(75)] },
		]);
		const html = generatePages(makeReport(dir, [lint(75)]), historyDir).get("trends.html")!;
		const rows = trendRows(html);
		expect(rows).toContain("lint skipped → 75 status");
		expect(rows).toContain("structure 80 → not present status");
		expect(html).not.toContain("-25");
	});
});

describe("crashed runner on the actions and trends pages (#107)", () => {
	// core.ts's stub for a runner that threw: status failed, a placeholder 0/F.
	const crashed: CheckResult = {
		name: "lint",
		score: 0,
		grade: "F",
		details: { skipped: true, status: "failed", reason: "runner error: boom" },
		issues: [],
		duration: 0,
	};
	(crashed as CheckResult & { status: string }).status = "failed";
	const lint = (score: number): CheckResult => ({
		name: "lint",
		score,
		grade: "C",
		details: { status: "failed" },
		issues: [],
		duration: 1,
	});
	const structure = (score: number): CheckResult => ({ name: "structure", score, grade: "B", details: {}, issues: [], duration: 1 });
	const trendRows = (html: string) =>
		[...html.matchAll(/<div class="trend-row">(.*?)<\/div>/g)].map((m) =>
			m[1]
				.replace(/<[^>]+>/g, " ")
				.replace(/\s+/g, " ")
				.trim(),
		);
	function writeHistory(dir: string, entries: { timestamp: string; checks: CheckResult[] }[]): string {
		const historyDir = join(dir, "history");
		mkdirSync(historyDir, { recursive: true });
		for (const { timestamp, checks } of entries) {
			const report = { ...makeReport(dir, checks), timestamp };
			writeFileSync(join(historyDir, `${timestamp}.json`), JSON.stringify(buildReportHistorySnapshot(report)));
		}
		return historyDir;
	}

	it("actions page: 72 → runner error is a status change, not lint -72", () => {
		const dir = mkdtempSync(join(tmpdir(), "vcqa-report-"));
		const html = generatePages(makeReport(dir, [crashed]), undefined, makeReport(dir, [lint(72)])).get("actions.html")!;
		expect(html).toContain("lint: 72 → failed (runner error)");
		expect(html).not.toContain("lint -72");
	});

	it("actions page: runner error → 72 is a status change, not lint +72", () => {
		const dir = mkdtempSync(join(tmpdir(), "vcqa-report-"));
		const html = generatePages(makeReport(dir, [lint(72)]), undefined, makeReport(dir, [crashed])).get("actions.html")!;
		expect(html).toContain("lint: failed (runner error) → 72");
		expect(html).not.toContain("lint +72");
	});

	it("trends page: a crashed scan is a gap in the chart and a transition in the table", () => {
		const dir = mkdtempSync(join(tmpdir(), "vcqa-report-"));
		const historyDir = writeHistory(dir, [
			{ timestamp: "2026-10-01T00:00:00.000Z", checks: [lint(64), structure(80)] },
			{ timestamp: "2026-10-02T00:00:00.000Z", checks: [lint(72), structure(84)] },
			{ timestamp: "2026-10-03T00:00:00.000Z", checks: [crashed, structure(86)] },
		]);
		// The snapshot keeps the crash only in details (no top-level status).
		const snapshot = JSON.parse(readFileSync(join(historyDir, "2026-10-03T00:00:00.000Z.json"), "utf-8"));
		expect(snapshot.checks[0]).not.toHaveProperty("status");
		expect(snapshot.checks[0].details.reason).toBe("runner error: boom");

		const html = generatePages(makeReport(dir, [crashed, structure(86)]), historyDir).get("trends.html")!;
		const rows = trendRows(html);
		expect(rows).toContain("lint 64 → failed (runner error) status");
		expect(rows).toContain("structure 80 → 86 +6");
		expect(html).not.toContain("-64");
		expect(html).not.toContain("-72");
		// The lint card plots only the two scans that produced a score, and labels the crash.
		expect(html).toMatch(/<span class="trend-name">lint<\/span><span class="trend-status muted">failed \(runner error\)<\/span>/);
		const lintCard = html.slice(html.indexOf('<span class="trend-name">lint</span>')).split('<div class="trend-card">')[0];
		expect(lintCard).toContain("<title>2026-10-01 — 64</title>");
		expect(lintCard).toContain("<title>2026-10-02 — 72</title>");
		expect(lintCard).not.toContain("2026-10-03");
	});

	it("trends page: runner error → 72 is a transition, not +72", () => {
		const dir = mkdtempSync(join(tmpdir(), "vcqa-report-"));
		const historyDir = writeHistory(dir, [
			{ timestamp: "2026-10-01T00:00:00.000Z", checks: [crashed] },
			{ timestamp: "2026-10-02T00:00:00.000Z", checks: [lint(70)] },
			{ timestamp: "2026-10-03T00:00:00.000Z", checks: [lint(72)] },
		]);
		const html = generatePages(makeReport(dir, [lint(72)]), historyDir).get("trends.html")!;
		expect(trendRows(html)).toContain("lint failed (runner error) → 72 status");
		expect(html).not.toContain("+72");
	});
});
