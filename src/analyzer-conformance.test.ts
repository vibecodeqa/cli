import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scan } from "./core.js";
import { detectWorkspace } from "./detect.js";
import { buildFileInventory, type FileInventory } from "./file-inventory.js";
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
		".vcqa.json": JSON.stringify({ ignore: ["src/generated/**", "store/docs/**"] }),
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
			'import { randomUUID } from "node:crypto";\nexport default { fetch(_req: Request, env: { PUBLIC_FLAG: string }) { return new Response(`${env.PUBLIC_FLAG}:${randomUUID()}`); } };\n',
		"src/App.tsx": 'export function App() { return <img src="/hero.jpg" alt="hero" />; }\n',
		"src/Card.tsx": 'export function Card() { return <div style={{ backgroundColor: "#123456" }}>card</div>; }\n',
		"src/generated/Bad.tsx": 'export function Bad() { return <img src="/generated.jpg" style={{ color: "#abcdef" }} />; }\n',
		"store/docs/bad.html": "<html><head></head><body><img src='bad.jpg'></body></html>\n",
		".claude/worktrees/agent-a/Bad.tsx": 'export function Bad() { return <img src="/agent.jpg" style={{ color: "#abcdef" }} />; }\n',
		".claude/worktrees/agent-a/bad.html": "<html><head></head><body><img src='bad.jpg'></body></html>\n",
		"node_modules/pkg/Bad.tsx": 'export function Bad() { return <img src="/dep.jpg" style={{ color: "#abcdef" }} />; }\n',
		"dist/Bad.tsx": 'export function Bad() { return <img src="/dist.jpg" style={{ color: "#abcdef" }} />; }\n',
		"coverage/Bad.tsx": 'export function Bad() { return <img src="/coverage.jpg" style={{ color: "#abcdef" }} />; }\n',
		"playwright-report/Bad.tsx": 'export function Bad() { return <img src="/report.jpg" style={{ color: "#abcdef" }} />; }\n',
		".vibe-check/Bad.tsx": 'export function Bad() { return <img src="/vcqa.jpg" style={{ color: "#abcdef" }} />; }\n',
	});
	return makeInventory(["src/generated/**", "store/docs/**"]);
}

const FORBIDDEN_PATH = /^(?:src\/generated\/|store\/docs\/|\.claude\/|node_modules\/|dist\/|coverage\/|playwright-report\/|\.vibe-check\/)/;

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
