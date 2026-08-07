import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import defaultExclusions from "./data/default-exclusions.json" with { type: "json" };
import { detectWorkspace } from "./detect.js";
import { buildFileInventory } from "./file-inventory.js";
import { buildEffectiveScanPolicy, evaluatePath, scanPolicySummary } from "./scan-policy.js";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "vcqa-inventory-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("effective scan policy and file inventory", () => {
	it("keeps the default exclusion registry reason-coded and unique", () => {
		const knownReasonCodes = new Set([
			"agent-artifact",
			"build-output",
			"dependency",
			"framework-cache",
			"generated-file",
			"lockfile",
			"runtime-cache",
			"test-output",
			"vcqa",
			"vcs",
		]);
		const registryTokens = [
			...defaultExclusions.directoryNames,
			...defaultExclusions.generatedPathPrefixes,
			...defaultExclusions.filePatterns,
		];
		const reasonEntries = Object.entries(defaultExclusions.reasons);
		const reasonTokens = reasonEntries.flatMap(([, tokens]) => tokens);
		const duplicateRegistryTokens = registryTokens.filter((token, index) => registryTokens.indexOf(token) !== index);
		const unknownReasonCodes = reasonEntries.map(([reason]) => reason).filter((reason) => !knownReasonCodes.has(reason));
		const unreasonedTokens = registryTokens.filter(
			(token) => !reasonTokens.some((known) => token === known || token.startsWith(`${known}/`)),
		);

		expect(duplicateRegistryTokens).toEqual([]);
		expect(unknownReasonCodes).toEqual([]);
		expect(unreasonedTokens).toEqual([]);
	});

	it("records default, config, env, and gitignore ignore inputs", () => {
		writeFileSync(join(dir, ".gitignore"), "tmp-output/\n");
		const policy = buildEffectiveScanPolicy(dir, { ignore: ["custom/**"] }, { ignoreNames: ["local-cache"], envIgnore: "env-cache" });
		const summary = scanPolicySummary(policy);

		expect(policy.defaultDirectoryNames).toContain("node_modules");
		expect(policy.configIgnorePatterns).toEqual(["custom/**"]);
		expect(policy.userIgnoreNames).toEqual(["local-cache"]);
		expect(policy.envIgnoreNames).toEqual(["env-cache"]);
		expect(policy.gitignoreDirectoryNames).toEqual(["tmp-output"]);
		expect(summary).toMatchObject({
			configIgnorePatterns: 1,
			userIgnoreNames: 1,
			envIgnoreNames: 1,
			gitignoreDirectoryNames: 1,
			securitySensitiveOverride: { enabled: true },
		});
		expect(evaluatePath(policy, "custom/report.html")).toMatchObject({
			action: "exclude",
			ignored: true,
			excluded: true,
			reasons: ["config-ignore"],
			evidence: [expect.objectContaining({ source: "config-ignore", value: "custom/**", reason: "config-ignore" })],
		});
	});

	it("makes precedence and security-sensitive overrides explicit", () => {
		writeFileSync(join(dir, ".gitignore"), ["tmp-output/", ".env", "secrets.pem"].join("\n"));
		const policy = buildEffectiveScanPolicy(
			dir,
			{ ignore: [".env", "custom/**"] },
			{ ignoreNames: ["local-cache"], envIgnore: "env-cache" },
		);

		expect(evaluatePath(policy, ".env")).toMatchObject({
			action: "include-security-sensitive",
			ignored: true,
			excluded: false,
			securitySensitive: true,
			includedBySecurityOverride: true,
			classification: "security-sensitive",
			reasons: ["config-ignore", "security-sensitive"],
		});
		expect(evaluatePath(policy, ".claude/worktrees/agent-a/.env")).toMatchObject({
			action: "exclude",
			excluded: true,
			generated: true,
			securitySensitive: true,
			includedBySecurityOverride: false,
			classification: "generated",
			reasons: ["agent-artifact", "security-sensitive"],
		});
		expect(evaluatePath(policy, "tmp-output/report.html")).toMatchObject({
			action: "exclude",
			reasons: ["gitignore-directory"],
			evidence: [expect.objectContaining({ source: "gitignore-directory", value: "tmp-output" })],
		});
		expect(evaluatePath(policy, "local-cache/file.ts")).toMatchObject({ action: "exclude", reasons: ["user-ignore"] });
		expect(evaluatePath(policy, "env-cache/file.ts")).toMatchObject({ action: "exclude", reasons: ["env-ignore"] });
		expect(evaluatePath(policy, "pnpm-lock.yaml")).toMatchObject({
			action: "exclude",
			classification: "lockfile",
			generated: false,
			reasons: ["lockfile"],
		});
		expect(evaluatePath(policy, "src/app.min.js")).toMatchObject({
			action: "exclude",
			classification: "generated",
			generated: true,
			reasons: ["generated-file"],
		});
		expect(evaluatePath(policy, "src/app.ts")).toMatchObject({ action: "include", ignored: false, reasons: [] });
	});

	it("classifies common generated caches, reports, build outputs, and static artifacts from the registry", () => {
		const policy = buildEffectiveScanPolicy(dir, {});

		expect(evaluatePath(policy, ".angular/cache/vite/deps/chunk.js")).toMatchObject({
			action: "exclude",
			classification: "generated",
			generated: true,
			reasons: ["framework-cache"],
		});
		expect(evaluatePath(policy, ".pytest_cache/v/cache/nodeids")).toMatchObject({
			action: "exclude",
			classification: "generated",
			generated: true,
			reasons: ["runtime-cache"],
		});
		expect(evaluatePath(policy, "reports/junit/index.html")).toMatchObject({
			action: "exclude",
			classification: "generated",
			generated: true,
			reasons: ["test-output"],
		});
		expect(evaluatePath(policy, "target/classes/App.class")).toMatchObject({
			action: "exclude",
			classification: "generated",
			generated: true,
			reasons: ["build-output"],
		});
		expect(evaluatePath(policy, "src/proto/user.pb.go")).toMatchObject({
			action: "exclude",
			classification: "generated",
			generated: true,
			reasons: ["generated-file"],
		});
		expect(evaluatePath(policy, "src/components/Button.generated.ts")).toMatchObject({
			action: "exclude",
			classification: "generated",
			generated: true,
			reasons: ["generated-file"],
		});
		expect(evaluatePath(policy, "coverage-final.json")).toMatchObject({
			action: "exclude",
			classification: "generated",
			generated: true,
			reasons: ["test-output"],
		});
		expect(evaluatePath(policy, "Gemfile.lock")).toMatchObject({
			action: "exclude",
			classification: "lockfile",
			generated: false,
			reasons: ["lockfile"],
		});
	});

	it("classifies files once and omits ignored generated artifacts", () => {
		mkdirSync(join(dir, "src"), { recursive: true });
		mkdirSync(join(dir, ".claude", "worktrees", "agent-a"), { recursive: true });
		mkdirSync(join(dir, "dist"), { recursive: true });
		writeFileSync(join(dir, "package.json"), "{}");
		writeFileSync(join(dir, "src", "index.ts"), "export const x = 1;\n");
		writeFileSync(join(dir, "src", "index.test.ts"), "test('x', () => {});\n");
		writeFileSync(join(dir, "index.html"), "<html></html>\n");
		writeFileSync(join(dir, ".env"), "TOKEN=secret\n");
		writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
		writeFileSync(join(dir, ".claude", "worktrees", "agent-a", "screenshot.html"), "<html></html>\n");
		writeFileSync(join(dir, "dist", "index.html"), "<html></html>\n");

		const inventory = buildFileInventory(dir, detectWorkspace(dir), buildEffectiveScanPolicy(dir, {}));

		expect(inventory.files.map((file) => file.path).sort()).toEqual([
			".env",
			"index.html",
			"package.json",
			"src/index.test.ts",
			"src/index.ts",
		]);
		expect(inventory.summary.byKind).toMatchObject({ env: 1, html: 1, source: 1, test: 1 });
		expect(inventory.summary.ignoredDirectories).toBeGreaterThanOrEqual(2);
		expect(inventory.summary.securitySensitiveFiles).toBe(1);
	});

	it("detects static site roots, public roots, and output roots with evidence", () => {
		mkdirSync(join(dir, "apps", "web", "public"), { recursive: true });
		mkdirSync(join(dir, "apps", "marketing", "static"), { recursive: true });
		mkdirSync(join(dir, "apps", "next", "public"), { recursive: true });
		mkdirSync(join(dir, "workers", "pages"), { recursive: true });
		mkdirSync(join(dir, "site"), { recursive: true });
		mkdirSync(join(dir, "docs"), { recursive: true });
		mkdirSync(join(dir, "dist"), { recursive: true });
		writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n  - workers/*\n");
		writeFileSync(join(dir, "package.json"), "{}");
		writeFileSync(join(dir, "apps", "web", "package.json"), JSON.stringify({ name: "web" }));
		writeFileSync(
			join(dir, "apps", "web", "vite.config.ts"),
			"export default { publicDir: 'public', build: { outDir: 'dist/client' } };\n",
		);
		writeFileSync(join(dir, "apps", "web", "index.html"), "<!doctype html><html></html>\n");
		writeFileSync(join(dir, "apps", "web", "public", "robots.txt"), "User-agent: *\nAllow: /\n");
		writeFileSync(join(dir, "apps", "marketing", "package.json"), JSON.stringify({ name: "marketing" }));
		writeFileSync(join(dir, "apps", "marketing", "astro.config.mjs"), "export default { publicDir: 'static', outDir: 'build/site' };\n");
		writeFileSync(join(dir, "apps", "marketing", "index.html"), "<!doctype html><html></html>\n");
		writeFileSync(join(dir, "apps", "next", "package.json"), JSON.stringify({ name: "next" }));
		writeFileSync(join(dir, "apps", "next", "next.config.mjs"), "export default {};\n");
		writeFileSync(join(dir, "apps", "next", "index.html"), "<!doctype html><html></html>\n");
		writeFileSync(join(dir, "workers", "pages", "package.json"), JSON.stringify({ name: "pages" }));
		writeFileSync(join(dir, "workers", "pages", "wrangler.toml"), 'name = "pages"\npages_build_output_dir = "dist"\n');
		writeFileSync(join(dir, "dist", "index.html"), "<!doctype html><html></html>\n");
		writeFileSync(join(dir, "site", "index.html"), "<!doctype html><html></html>\n");
		writeFileSync(join(dir, "docs", "index.html"), "<!doctype html><html></html>\n");

		const inventory = buildFileInventory(dir, detectWorkspace(dir), buildEffectiveScanPolicy(dir, {}));
		const byRoot = new Map(inventory.staticSites.map((site) => [site.rootPath, site]));

		expect(inventory.summary.staticSiteRoots).toBeGreaterThanOrEqual(6);
		expect(byRoot.get("apps/web")).toMatchObject({
			publicRoots: [expect.objectContaining({ path: "apps/web/public" })],
			outputRoots: [expect.objectContaining({ path: "apps/web/dist/client" })],
			evidence: [expect.objectContaining({ source: "html-index" }), expect.objectContaining({ source: "vite-config" })],
		});
		expect(byRoot.get("apps/marketing")).toMatchObject({
			publicRoots: [expect.objectContaining({ path: "apps/marketing/static" })],
			outputRoots: [expect.objectContaining({ path: "apps/marketing/build/site" })],
			evidence: [expect.objectContaining({ source: "html-index" }), expect.objectContaining({ source: "astro-config" })],
		});
		expect(byRoot.get("apps/next")?.publicRoots.map((root) => root.path)).toContain("apps/next/public");
		expect(byRoot.get("workers/pages/dist")).toMatchObject({
			outputRoots: [expect.objectContaining({ path: "workers/pages/dist" })],
			evidence: [expect.objectContaining({ source: "cloudflare-pages" })],
		});
		expect(byRoot.get("site")?.evidence.some((item) => item.source === "convention")).toBe(true);
		expect(byRoot.get("docs")?.evidence.some((item) => item.source === "convention")).toBe(true);
		expect(inventory.files.some((file) => file.path === "dist/index.html")).toBe(false);
	});
});
