import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scan } from "./core.js";
import { detectWorkspace } from "./detect.js";
import { buildFileInventory, type FileInventory, inventoryHas } from "./file-inventory.js";
import { setGlobalIgnore, setGlobalIgnoreNames, setGlobalSrcRoots } from "./fs-utils.js";
import { runCloudflareWorkers } from "./runners/cloudflare-workers.js";
import { runFrontendHealth } from "./runners/frontend-health.js";
import { runHtmlQuality } from "./runners/html-quality.js";
import { parseBiomeLint, parseEslintJson } from "./runners/lint.js";
import { runSecrets } from "./runners/secrets.js";
import { parseEslintSecurityJson } from "./runners/security.js";
import { runStyling } from "./runners/styling.js";
import { parseTscOutput } from "./runners/types-check.js";
import { buildEffectiveScanPolicy, policyIgnoreNames } from "./scan-policy.js";
import type { CheckResult, Issue, WorkspaceInfo } from "./types.js";

let dir: string;

function writeProject(files: Record<string, string>): void {
	for (const [name, content] of Object.entries(files)) {
		const full = join(dir, name);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, content);
	}
}

function makeInventory(ignore: string[] = []): { inventory: FileInventory; workspace: WorkspaceInfo } {
	const workspace = detectWorkspace(dir);
	const policy = buildEffectiveScanPolicy(dir, { ignore });
	setGlobalIgnore(ignore);
	setGlobalIgnoreNames(policyIgnoreNames(policy));
	return { inventory: buildFileInventory(dir, workspace, policy), workspace };
}

function conformanceFixture(): { inventory: FileInventory; workspace: WorkspaceInfo } {
	writeProject({
		".vcqa.json": JSON.stringify({ ignore: ["src/generated/**", "site/generated-docs/**"] }),
		"package.json": JSON.stringify({
			name: "conformance-fixture",
			dependencies: { react: "^19.0.0" },
			devDependencies: {},
		}),
		"robots.txt": "User-agent: *\nAllow: /\n",
		"sitemap.xml": "<urlset></urlset>\n",
		"wrangler.toml": 'name = "worker"\nmain = "src/index.ts"\ncompatibility_date = "2026-01-01"\n[vars]\nPUBLIC_FLAG = "true"\n',
		"index.html":
			'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="description" content="Conformance fixture page"><meta property="og:title" content="Conformance"><link rel="canonical" href="https://example.test/"><link rel="icon" href="/favicon.ico"></head><body><h1>Fixture</h1></body></html>\n',
		"src/index.ts":
			'import { randomUUID } from "node:crypto";\nexport default { fetch(_req: Request, env: { PUBLIC_FLAG: string }) { return new Response(`$' +
			"{env.PUBLIC_FLAG}:$" +
			"{randomUUID()}`); } };\n",
		"src/App.tsx": 'export function App() { return <img src="/hero.jpg" alt="hero" />; }\n',
		"src/Card.tsx": 'export function Card() { return <div style={{ backgroundColor: "#123456" }}>card</div>; }\n',
		"src/generated/Bad.tsx": 'export function Bad() { return <img src="/generated.jpg" style={{ color: "#abcdef" }} />; }\n',
		"site/generated-docs/bad.html": "<html><head></head><body><img src='bad.jpg'></body></html>\n",
		".claude/worktrees/agent-a/Bad.tsx": 'export function Bad() { return <img src="/agent.jpg" style={{ color: "#abcdef" }} />; }\n',
		".claude/worktrees/agent-a/bad.html": "<html><head></head><body><img src='bad.jpg'></body></html>\n",
		"node_modules/pkg/Bad.tsx": 'export function Bad() { return <img src="/dep.jpg" style={{ color: "#abcdef" }} />; }\n',
		"dist/Bad.tsx": 'export function Bad() { return <img src="/dist.jpg" style={{ color: "#abcdef" }} />; }\n',
		"coverage/Bad.tsx": 'export function Bad() { return <img src="/coverage.jpg" style={{ color: "#abcdef" }} />; }\n',
		"playwright-report/Bad.tsx": 'export function Bad() { return <img src="/report.jpg" style={{ color: "#abcdef" }} />; }\n',
		".vibe-check/Bad.tsx": 'export function Bad() { return <img src="/vcqa.jpg" style={{ color: "#abcdef" }} />; }\n',
	});
	return makeInventory(["src/generated/**", "site/generated-docs/**"]);
}

const FORBIDDEN_PATH =
	/^(?:src\/generated\/|site\/generated-docs\/|\.claude\/|node_modules\/|dist\/|coverage\/|playwright-report\/|\.vibe-check\/)/;

/** Repo-level markers a check may name as "the place to fix" even when the file
 *  does not exist and so cannot be in the inventory (e.g. env-validation telling
 *  you to add `.env` to a `.gitignore` you do not have yet). Everything else must
 *  be a file the inventory actually holds. Keep this list short and boring — it is
 *  the escape hatch, and a growing escape hatch means a runner is walking on its
 *  own again. */
const REPO_LEVEL_PATHS = new Set([
	".gitignore",
	".env.example",
	"package.json",
	"README.md",
	"CHANGELOG.md",
	"CONTRIBUTING.md",
	"LICENSE",
	"tsconfig.json",
]);

function forbiddenIssues(analyzer: string, result: CheckResult): Array<{ analyzer: string; file: string; rule?: string }> {
	return result.issues
		.filter((issue) => issue.file && FORBIDDEN_PATH.test(issue.file))
		.map((issue) => ({ analyzer, file: issue.file!, rule: issue.rule }));
}

const FILE_DISCOVERY_CONFORMANCE_ANALYZERS: Array<{
	name: string;
	run: (workspace: WorkspaceInfo, inventory: FileInventory) => CheckResult;
	expectedRule: string;
}> = [
	{
		name: "cloudflare-workers",
		run: (workspace, inventory) => runCloudflareWorkers(dir, workspace, inventory),
		expectedRule: "node-import-no-compat",
	},
	{
		name: "frontend-health",
		run: (workspace, inventory) => runFrontendHealth(dir, workspace, inventory),
		expectedRule: "unoptimized-image",
	},
	{
		name: "html-quality",
		run: (_workspace, inventory) => runHtmlQuality(dir, inventory),
		expectedRule: "missing-title",
	},
	{
		name: "styling",
		run: (workspace, inventory) => runStyling(dir, workspace, inventory),
		expectedRule: "hardcoded-color",
	},
];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "vcqa-conformance-"));
});

afterEach(() => {
	setGlobalIgnore(undefined);
	setGlobalIgnoreNames([]);
	setGlobalSrcRoots(undefined);
	rmSync(dir, { recursive: true, force: true });
});

describe("analyzer file-policy conformance", () => {
	it("covers neutral repo hierarchy shapes in the shared file inventory", () => {
		writeProject({
			"pnpm-workspace.yaml":
				"packages:\n  - apps/*\n  - packages/*\n  - services/*\n  - workers/*\n  - functions/*\n  - jobs/*\n  - tools/*\n  - site/*\n",
			"package.json": JSON.stringify({ name: "hierarchy-matrix" }),
			"apps/web/package.json": JSON.stringify({ name: "web", dependencies: { react: "^19.0.0" } }),
			"apps/web/src/App.tsx": "export function App() { return null; }\n",
			"packages/core/package.json": JSON.stringify({ name: "core" }),
			"packages/core/src/index.ts": "export const core = true;\n",
			"services/api/package.json": JSON.stringify({ name: "api" }),
			"services/api/src/index.ts": "export const api = true;\n",
			"workers/edge/package.json": JSON.stringify({ name: "edge" }),
			"workers/edge/src/index.ts": "export default { fetch() { return new Response('ok'); } };\n",
			"functions/handler/package.json": JSON.stringify({ name: "handler" }),
			"functions/handler/src/index.ts": "export const handler = true;\n",
			"jobs/sync/package.json": JSON.stringify({ name: "sync" }),
			"jobs/sync/src/index.ts": "export const sync = true;\n",
			"tools/cli/package.json": JSON.stringify({ name: "cli" }),
			"tools/cli/src/index.ts": "export const cli = true;\n",
			"site/docs/package.json": JSON.stringify({ name: "docs-site" }),
			"site/docs/index.html": "<!doctype html><html lang='en'><head><title>Docs</title></head><body></body></html>\n",
		});

		const { inventory, workspace } = makeInventory();
		const expectedProjectPaths = [
			".",
			"apps/web",
			"functions/handler",
			"jobs/sync",
			"packages/core",
			"services/api",
			"site/docs",
			"tools/cli",
			"workers/edge",
		];

		expect(workspace.projects?.map((project) => project.path).sort()).toEqual(expectedProjectPaths);
		expect(
			inventory.files
				.filter((file) => file.path !== "package.json" && !file.path.endsWith("/package.json"))
				.map((file) => `${file.path}:${file.projectPath}:${file.kind}`)
				.sort(),
		).toEqual([
			"apps/web/src/App.tsx:apps/web:source",
			"functions/handler/src/index.ts:functions/handler:source",
			"jobs/sync/src/index.ts:jobs/sync:source",
			"packages/core/src/index.ts:packages/core:source",
			"pnpm-workspace.yaml:.:config",
			"services/api/src/index.ts:services/api:source",
			"site/docs/index.html:site/docs:html",
			"tools/cli/src/index.ts:tools/cli:source",
			"workers/edge/src/index.ts:workers/edge:source",
		]);
	});

	it("keeps ignored and generated paths out of inventory-backed source-quality analyzers", () => {
		const { inventory, workspace } = conformanceFixture();
		const results = FILE_DISCOVERY_CONFORMANCE_ANALYZERS.map(({ name, run, expectedRule }) => {
			const result = run(workspace, inventory);
			expect(
				result.issues.some((issue) => issue.rule === expectedRule),
				`${name} should run against the valid source fixture before policy filtering is asserted`,
			).toBe(true);
			return { name, result };
		});

		const violations = results.flatMap(({ name, result }) => forbiddenIssues(name, result));

		expect(violations).toEqual([]);
	});

	it("normalizes external tool diagnostics to repo-root paths and drops ignored outputs", () => {
		setGlobalIgnore(["src/generated/**"]);
		setGlobalIgnoreNames([]);

		const biome = parseBiomeLint(
			JSON.stringify({
				diagnostics: [
					{
						severity: "error",
						description: "keep",
						category: "lint/keep",
						location: { path: "src/App.tsx" },
					},
					{
						severity: "error",
						description: "ignored generated",
						category: "lint/generated",
						location: { path: "../../.claude/worktrees/agent-a/src/App.tsx" },
					},
				],
			}),
			{ repoCwd: "/repo", toolCwd: "/repo/packages/web" },
		);
		const eslint = parseEslintJson(
			JSON.stringify([
				{
					filePath: "src/App.tsx",
					messages: [{ severity: 2, message: "keep", line: 3, ruleId: "react/no-unknown-property" }],
				},
				{
					filePath: "/repo/src/generated/Bad.tsx",
					messages: [{ severity: 2, message: "ignored", line: 1, ruleId: "no-restricted-syntax" }],
				},
			]),
			{ repoCwd: "/repo", toolCwd: "/repo/packages/web" },
		);
		const tsc: Issue[] = [];
		parseTscOutput(
			"src/App.tsx(7,1): error TS2322: keep\n/repo/src/generated/Bad.tsx(1,1): error TS2304: ignored",
			tsc,
			"/repo",
			"/repo/packages/web",
		);
		const security = parseEslintSecurityJson(
			JSON.stringify([
				{
					filePath: "src/server.ts",
					messages: [{ severity: 2, message: "keep", line: 5, ruleId: "security/detect-child-process" }],
				},
				{
					filePath: "../../.claude/worktrees/agent-a/src/server.ts",
					messages: [{ severity: 2, message: "ignored", line: 1, ruleId: "security/detect-eval-with-expression" }],
				},
			]),
			"/repo",
			"/repo/packages/web",
		);

		const grouped = {
			biome: biome ?? [],
			eslint,
			tsc,
			security: security ?? [],
		};
		const violations = Object.entries(grouped).flatMap(([analyzer, issues]) =>
			issues
				.filter((issue) => !issue.file?.startsWith("packages/web/src/") || FORBIDDEN_PATH.test(issue.file))
				.map((issue) => ({ analyzer, file: issue.file, rule: issue.rule })),
		);

		expect(grouped.biome.map((issue) => issue.file)).toEqual(["packages/web/src/App.tsx"]);
		expect(grouped.eslint.map((issue) => issue.file)).toEqual(["packages/web/src/App.tsx"]);
		expect(grouped.tsc.map((issue) => issue.file)).toEqual(["packages/web/src/App.tsx"]);
		expect(grouped.security.map((issue) => issue.file)).toEqual(["packages/web/src/server.ts"]);
		expect(violations).toEqual([]);
	});

	it("keeps skipped analyzers free of unrelated tool logs and console output", async () => {
		writeProject({
			"package.json": JSON.stringify({ name: "skip-conformance" }),
			"src/index.ts": "export const x = 1;\n",
		});
		const originalLog = console.log;
		const originalWrite = process.stdout.write;
		let output = "";
		console.log = (...args: unknown[]) => {
			output += args.join(" ");
		};
		process.stdout.write = ((chunk: unknown) => {
			output += String(chunk);
			return true;
		}) as typeof process.stdout.write;
		try {
			const report = await scan(dir, {
				skipTests: true,
				checks: ["docs"],
				config: { checks: { docs: { enabled: false } } },
			});
			const docs = report.checks[0]!;
			expect((docs as any).status).toBe("skipped");
			expect(docs.issues).toEqual([]);
			expect((docs.details as Record<string, unknown>).toolRuns).toBeUndefined();
			expect(output).toBe("");
		} finally {
			console.log = originalLog;
			process.stdout.write = originalWrite;
		}
	});

	it("keeps every finding in a full scan traceable to the one FileInventory", async () => {
		writeProject({
			".vcqa.json": JSON.stringify({ ignore: ["src/generated/**"] }),
			".gitignore": ".env\n",
			"package.json": JSON.stringify({ name: "inventory-trace", dependencies: { react: "^19.0.0" } }),
			"index.html": "<html><head></head><body><img src='hero.jpg'></body></html>\n",
			"src/App.tsx": 'export function App() { try { risky() } catch {} return <div style={{ color: "#123456" }} />; }\n',
			"src/index.ts": "export const x: any = 1;\n",
			"src/App.test.ts": "it('x', () => { expect(1).toBe(1); });\n",
			// Every one of these is a path some runner used to reach with its own walk.
			"src/generated/Bad.tsx": 'export function Bad() { try { risky() } catch {} return <img src="/g.jpg" />; }\n',
			"src/app.min.js": 'var a=1;try{b()}catch(e){};var k="sk-proj-AAAAAAAAAAAAAAAAAAAAAA";\n',
			"dist/Bad.tsx": 'export function Bad() { try { risky() } catch {} return <img src="/d.jpg" />; }\n',
			"dist/index.html": "<html><head></head><body><img src='d.jpg'></body></html>\n",
			"coverage/Bad.tsx": 'export function Bad() { try { risky() } catch {} return <img src="/c.jpg" />; }\n',
			"playwright-report/Bad.tsx": 'export function Bad() { try { risky() } catch {} return <img src="/p.jpg" />; }\n',
			"node_modules/pkg/Bad.tsx": 'export function Bad() { try { risky() } catch {} return <img src="/n.jpg" />; }\n',
			".claude/worktrees/agent-a/Bad.tsx": 'export function Bad() { try { risky() } catch {} return <img src="/a.jpg" />; }\n',
			".claude/worktrees/agent-a/index.html": "<html><head></head><body><img src='a.jpg'></body></html>\n",
			"pnpm-lock.yaml": "lockfileVersion: 9\n",
			".env": "OPENAI_API_KEY=sk-proj-ABCDEFGHIJKLMNOPQRSTUV\n",
		});

		const report = await scan(dir, { skipTests: true });
		const { inventory } = makeInventory(["src/generated/**"]);
		const findings = report.checks.flatMap((check) =>
			check.issues
				.filter((issue) => typeof issue.file === "string" && issue.file)
				.map((issue) => ({ check: check.name, file: issue.file! })),
		);

		// Nothing the policy excluded may be named by any finding, from any check,
		// however that check discovers its files.
		expect(findings.filter((finding) => FORBIDDEN_PATH.test(finding.file))).toEqual([]);
		// And every remaining finding names a file the inventory actually holds, or
		// one of the repo-level markers a check may point at even when absent.
		expect(findings.filter((finding) => !inventoryHas(inventory, finding.file) && !REPO_LEVEL_PATHS.has(finding.file))).toEqual([]);
		// The scan must still have found the real defects — otherwise "no forbidden
		// findings" would pass on an empty result set.
		expect(findings.some((finding) => finding.file === "src/App.tsx")).toBe(true);
		expect(findings.some((finding) => finding.file === "index.html")).toBe(true);
		// The config-ignored .env stays visible to secrets: the security override.
		expect(
			report.checks
				.find((check) => check.name === "secrets")
				?.issues.some((issue) => issue.file === ".env" && issue.rule === "env-secret-value"),
		).toBe(true);

		const summary = report.meta.fileInventory as {
			byKind: Record<string, number>;
			ignoredByReason: Record<string, number>;
			ignoredFiles: number;
			ignoredDirectories: number;
		};
		expect(summary.byKind).toMatchObject({ source: 2, test: 1, html: 1, env: 1, config: 1 });
		expect(summary.ignoredByReason).toMatchObject({ lockfile: 1, "generated-file": 1, "config-ignore": 1 });
		expect(summary.ignoredByReason["build-output"]).toBeGreaterThanOrEqual(1);
		expect(summary.ignoredByReason["agent-artifact"]).toBeGreaterThanOrEqual(1);
		expect(summary.ignoredByReason.dependency).toBeGreaterThanOrEqual(1);
		expect(summary.ignoredByReason["test-output"]).toBeGreaterThanOrEqual(2);
		// Rejected files inside walked directories are retained with their reasons.
		// Ignored directories are pruned whole and never enumerated — which is why
		// dist/ and src/generated/ contribute no entries here, only one reason count.
		expect(inventory.ignoredFiles.map((file) => file.path).sort()).toEqual(["pnpm-lock.yaml", "src/app.min.js"]);
		expect(inventory.ignoredFiles.map((file) => file.reasons)).toEqual([["lockfile"], ["generated-file"]]);
		expect(inventory.ignoredFiles.some((file) => FORBIDDEN_PATH.test(file.path))).toBe(false);
	}, 120_000);

	it("allows security-sensitive .env exceptions while keeping generated agent artifacts ignored", async () => {
		writeProject({
			".gitignore": ".env\n",
			".vcqa.json": JSON.stringify({ ignore: [".env", ".claude/**"] }),
			"package.json": JSON.stringify({ name: "security-exception" }),
			".env": "OPENAI_API_KEY=sk-proj-ABCDEFGHIJKLMNOPQRSTUV\n",
			".claude/worktrees/agent-a/leak.ts": 'export const token = "sk-proj-ZZZZZZZZZZZZZZZZZZZZZZ";\n',
		});
		const { inventory } = makeInventory([".env", ".claude/**"]);
		const envFile = inventory.files.find((file) => file.path === ".env");
		const result = await runSecrets(dir);

		expect(envFile).toMatchObject({
			path: ".env",
			kind: "env",
			securitySensitive: true,
			reasons: ["config-ignore", "security-sensitive"],
		});
		expect(inventory.files.some((file) => file.path.startsWith(".claude/"))).toBe(false);
		expect(result.issues.some((issue) => issue.file === ".env" && issue.rule === "env-secret-value")).toBe(true);
		expect(result.issues.some((issue) => issue.file?.startsWith(".claude/"))).toBe(false);
	});
});
