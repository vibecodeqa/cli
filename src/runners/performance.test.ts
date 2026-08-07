import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scan } from "../core.js";
import { detectWorkspace } from "../detect.js";
import { buildFileInventory } from "../file-inventory.js";
import { setGlobalSrcRoots } from "../fs-utils.js";
import { buildEffectiveScanPolicy } from "../scan-policy.js";
import { deadCodeCheckFromPerformance, hasKnipConfig, knipRoots, parseKnipJson, runPerformance } from "./performance.js";

function makeProject(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "vcqa-perf-"));
	for (const [name, content] of Object.entries(files)) {
		const full = join(dir, name);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, content);
	}
	return dir;
}

function makeInventory(dir: string) {
	return buildFileInventory(dir, detectWorkspace(dir), buildEffectiveScanPolicy(dir, {}));
}

afterEach(() => setGlobalSrcRoots(undefined));

describe("runPerformance", { timeout: 45_000 }, () => {
	it("detects barrel files", () => {
		const dir = makeProject({
			"package.json": "{}",
			"src/index.ts": ["export { a } from './a';", "export { b } from './b';", "export { c } from './c';", "export { d } from './d';"].join(
				"\n",
			),
			"src/a.ts": "export const a = 1;",
			"src/b.ts": "export const b = 2;",
			"src/c.ts": "export const c = 3;",
			"src/d.ts": "export const d = 4;",
		});
		const result = runPerformance(dir);
		expect(result.issues.some((i) => i.rule === "barrel-import")).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("detects heavy dependencies", () => {
		const dir = makeProject({
			"package.json": JSON.stringify({ dependencies: { moment: "^2.29", lodash: "^4.17" } }),
			"src/app.ts": "export const x = 1;\n",
		});
		const result = runPerformance(dir);
		expect(result.issues.filter((i) => i.rule === "heavy-dependency")).toHaveLength(2);
		rmSync(dir, { recursive: true });
	});

	it("detects runtime CSS-in-JS", () => {
		const dir = makeProject({
			"package.json": JSON.stringify({ dependencies: { "styled-components": "^6" } }),
			"src/app.ts": "export const x = 1;\n",
		});
		const result = runPerformance(dir);
		expect(result.issues.some((i) => i.rule === "runtime-css")).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("returns perfect score for clean project", () => {
		const dir = makeProject({
			// `main` makes src/app.ts an entry point, so Knip (if installed) sees a
			// genuinely clean project rather than one orphan file. Without this the
			// result differs between a machine with Knip and one without.
			"package.json": '{"main":"src/app.ts"}',
			"src/app.ts": "export function greet(name: string) { return 'Hello ' + name; }\n",
		});
		const result = runPerformance(dir);
		expect(result.score).toBe(100);
		rmSync(dir, { recursive: true });
	});

	it("handles empty project", () => {
		const dir = makeProject({ "package.json": "{}" });
		const result = runPerformance(dir);
		expect(result.score).toBe(100);
		expect(result.details.skipped).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("detects lodash without lodash-es", () => {
		const dir = makeProject({
			"package.json": JSON.stringify({ dependencies: { lodash: "^4.17" } }),
			"src/app.ts": "export const x = 1;\n",
		});
		const result = runPerformance(dir);
		expect(result.issues.some((i) => i.rule === "non-esm-dep")).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("filters generated Knip findings before dead-code counts", () => {
		const dir = makeProject({
			"package.json": "{}",
			"src/app.ts": "export const app = 1;\n",
		});
		const binDir = join(dir, "bin");
		mkdirSync(binDir, { recursive: true });
		const fakeNpx = join(binDir, "npx");
		writeFileSync(
			fakeNpx,
			`#!/bin/sh
cat <<'JSON'
{"issues":[{"file":".claude/worktrees/agent-a/src/generated.ts","files":[{"name":".claude/worktrees/agent-a/src/generated.ts"}]},{"file":"src/dead.ts","files":[{"name":"src/dead.ts"}]}]}
JSON
`,
		);
		chmodSync(fakeNpx, 0o755);
		const oldPath = process.env.PATH;
		process.env.PATH = `${binDir}:${oldPath ?? ""}`;
		try {
			const result = runPerformance(dir);
			const details = result.details as Record<string, any>;

			expect(details.unusedFiles).toBe(1);
			expect(details.excludedDeadCodeItems).toBe(1);
			expect(details.deadCode.files).toEqual([expect.objectContaining({ file: "src/dead.ts" })]);
		} finally {
			process.env.PATH = oldPath;
			rmSync(dir, { recursive: true });
		}
	});

	it("normalizes Knip findings from package cwd to repo-root paths", () => {
		const dir = makeProject({
			"package.json": "{}",
			"src/app.ts": "export const app = 1;\n",
			"apps/console/package.json": "{}",
			"apps/console/knip.json": '{"entry":["src/index.ts"]}',
		});
		const binDir = join(dir, "bin");
		mkdirSync(binDir, { recursive: true });
		const fakeNpx = join(binDir, "npx");
		writeFileSync(
			fakeNpx,
			`#!/bin/sh
cat <<'JSON'
{"issues":[{"file":"src/dead.ts","files":[{"name":"src/dead.ts"}]},{"file":"../../packages/web/src/orphan.ts","files":[{"name":"../../packages/web/src/orphan.ts"}]}]}
JSON
`,
		);
		chmodSync(fakeNpx, 0o755);
		const oldPath = process.env.PATH;
		process.env.PATH = `${binDir}:${oldPath ?? ""}`;
		try {
			const result = runPerformance(dir, {
				isMonorepo: true,
				tool: "pnpm",
				srcRoots: [],
				packages: [{ name: "console", path: "apps/console", hasSrc: true, hasRootCode: false, hasTests: false, hasLinter: false }],
			});
			const files = ((result.details as any).deadCode.files as any[]).map((item) => item.file);

			expect(files).toEqual(["apps/console/src/dead.ts", "packages/web/src/orphan.ts"]);
			expect((result.details as any).deadCode.files[0].details).toMatchObject({
				repoRelativePath: "apps/console/src/dead.ts",
				toolRelativePath: "src/dead.ts",
				toolCwd: join(dir, "apps/console"),
				pathStatus: "normalized",
			});
			expect((result.details as any).deadCode.files[1].details).toMatchObject({
				repoRelativePath: "packages/web/src/orphan.ts",
				toolRelativePath: "../../packages/web/src/orphan.ts",
			});
		} finally {
			process.env.PATH = oldPath;
			rmSync(dir, { recursive: true });
		}
	});

	it("uses FileInventory through scan and omits generated source outputs", async () => {
		const dir = makeProject({
			"package.json": "{}",
			"src/app.ts": "export const app = 1;\n",
			"dist/index.ts": [
				"export { a } from './a';",
				"export { b } from './b';",
				"export { c } from './c';",
				"export { d } from './d';",
			].join("\n"),
			"dist/a.ts": "export const a = 1;\n",
			"dist/b.ts": "export const b = 1;\n",
			"dist/c.ts": "export const c = 1;\n",
			"dist/d.ts": "export const d = 1;\n",
		});

		const report = await scan(dir, { skipTests: true, checks: ["performance"] });
		const result = report.checks[0]!;

		expect(result.details).toMatchObject({ source: "file-inventory", filesScanned: 1 });
		expect(result.issues.some((issue) => issue.rule === "barrel-import" && issue.file?.startsWith("dist/"))).toBe(false);
		rmSync(dir, { recursive: true });
	});

	it("uses FileInventory directly and skips generated source and CSS outputs", () => {
		const dir = makeProject({
			"package.json": "{}",
			"src/app.ts": "export const app = 1;\n",
			"src/app.css": ".app { display: block; }\n",
			"dist/index.ts": [
				"export { a } from './a';",
				"export { b } from './b';",
				"export { c } from './c';",
				"export { d } from './d';",
			].join("\n"),
			"dist/a.ts": "export const a = 1;\n",
			"dist/b.ts": "export const b = 1;\n",
			"dist/c.ts": "export const c = 1;\n",
			"dist/d.ts": "export const d = 1;\n",
			"dist/app.css": ".dist { width: 960px !important; }\n",
			".claude/worktrees/agent-a/src/index.ts": [
				"export { a } from './a';",
				"export { b } from './b';",
				"export { c } from './c';",
				"export { d } from './d';",
			].join("\n"),
			".claude/worktrees/agent-a/src/app.css": ".agent { width: 960px !important; }\n",
		});
		const result = runPerformance(dir, undefined, makeInventory(dir));

		expect(result.details).toMatchObject({ source: "file-inventory", filesScanned: 1 });
		expect(result.issues.some((issue) => issue.file?.startsWith("dist/") || issue.file?.includes(".claude/worktrees"))).toBe(false);
		expect(result.issues.some((issue) => issue.rule === "barrel-import" || issue.rule === "css-important")).toBe(false);
		rmSync(dir, { recursive: true });
	});
});

describe("parseKnipJson", () => {
	it("parses the modern { issues: [...] } shape", () => {
		const json = JSON.stringify({
			issues: [
				{ file: "src/orphan.ts", files: [{ name: "src/orphan.ts" }] },
				{ file: "package.json", dependencies: [{ name: "lodash" }] },
				{ file: "src/lib.ts", exports: [{ name: "deadExport", line: 1, col: 37 }] },
				{ file: "src/t.ts", types: [{ name: "DeadType", line: 5, col: 1 }] },
			],
		});
		const r = parseKnipJson(json);
		expect(r?.unusedFiles.map((f) => f.name)).toEqual(["src/orphan.ts"]);
		expect(r?.unusedDeps.map((d) => d.name)).toEqual(["lodash"]);
		expect(r?.unusedExports[0]).toMatchObject({ file: "src/lib.ts", name: "deadExport", line: 1 });
		expect(r?.unusedTypes.map((t) => t.name)).toEqual(["DeadType"]);
	});

	it("still parses the legacy flat shape", () => {
		const r = parseKnipJson(JSON.stringify({ files: ["a.ts"], exports: [{ name: "x" }], dependencies: ["dep"] }));
		expect(r?.unusedFiles).toHaveLength(1);
		expect(r?.unusedExports).toHaveLength(1);
		expect(r?.unusedDeps.map((d) => d.name)).toEqual(["dep"]);
	});

	it("returns null on non-JSON (knip absent)", () => {
		expect(parseKnipJson("")).toBeNull();
		expect(parseKnipJson("knip: command not found")).toBeNull();
	});

	it("yields empty lists for a clean project", () => {
		const r = parseKnipJson(JSON.stringify({ issues: [] }));
		expect(r).toEqual({ unusedFiles: [], unusedExports: [], unusedTypes: [], unusedDeps: [] });
	});
});

describe("knipRoots — run knip where its config lives", () => {
	it("uses the cwd when it configures knip", () => {
		const dir = makeProject({ "package.json": "{}", "knip.json": '{"entry":["src/index.ts"]}' });
		expect(knipRoots(dir)).toEqual([{ dir, rel: "", configured: true }]);
		rmSync(dir, { recursive: true });
	});

	it("descends to the workspace package that owns the config", () => {
		// Regression: a monorepo whose knip config lives in a package. Running at
		// the root gave knip no entry points and it called 42 live Cloudflare
		// Pages Function modules "unused files".
		const dir = makeProject({ "package.json": "{}", "app/package.json": "{}", "app/knip.config.ts": "export default {};" });
		const roots = knipRoots(dir, {
			isMonorepo: true,
			tool: "pnpm",
			srcRoots: [],
			packages: [{ name: "app", path: "app", hasSrc: true, hasRootCode: false, hasTests: false, hasLinter: false }],
		});
		expect(roots).toHaveLength(1);
		expect(roots[0].rel).toBe("app");
		expect(roots[0].configured).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("marks the result unconfigured when nothing configures knip", () => {
		const dir = makeProject({ "package.json": "{}" });
		const roots = knipRoots(dir);
		expect(roots[0].configured).toBe(false);
		rmSync(dir, { recursive: true });
	});

	it("recognises a knip key in package.json", () => {
		const dir = makeProject({ "package.json": '{"knip":{"entry":["a.ts"]}}' });
		expect(hasKnipConfig(dir)).toBe(true);
		rmSync(dir, { recursive: true });
	});
});

describe("deadCodeCheckFromPerformance", () => {
	it("gates unconfigured Knip as low-confidence instead of a hard F", () => {
		const result = deadCodeCheckFromPerformance({
			name: "performance",
			score: 85,
			grade: "B",
			details: {
				deadCodeTool: "knip",
				deadCodeConfigured: false,
				deadCodeConfidence: "low",
				unusedFiles: 20,
				unusedDeps: 1,
				deadExports: 100,
				deadCode: { files: [], exports: [], types: [], deps: [] },
			},
			issues: [
				{ severity: "info", rule: "dead-code-config-missing", message: "Knip is not configured" },
				{ severity: "info", rule: "dead-files", message: "20 unused files detected by Knip" },
			],
			duration: 1,
		});

		expect(result.score).toBeGreaterThanOrEqual(60);
		expect((result.details as Record<string, unknown>).deadCodeConfidence).toBe("low");
		expect(result.issues.every((i) => i.severity !== "error")).toBe(true);
	});
});
