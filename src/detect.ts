/** Auto-detect project stack, workspace layout, and git repo from files in the working directory. */

import { execSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { StackInfo, WorkspaceInfo, WorkspacePackage } from "./types.js";

export function detectStack(cwd: string, workspace?: WorkspaceInfo): StackInfo {
	const has = (f: string) => existsSync(join(cwd, f));
	const read = (f: string) => {
		try {
			return readFileSync(join(cwd, f), "utf-8");
		} catch {
			return "";
		}
	};

	// ── Dart/Flutter detection ──
	// Check root pubspec, OR workspace packages (melos monorepos have pubspec in packages, not root)
	let pubspec = read("pubspec.yaml");
	if (!pubspec && workspace?.tool === "melos") {
		for (const wp of workspace.packages) {
			const ps = read(join(wp.path, "pubspec.yaml"));
			if (ps) {
				pubspec = ps;
				break;
			}
		}
	}
	if (pubspec || has("pubspec.lock")) {
		const isFlutter = pubspec.includes("flutter:") || pubspec.includes("flutter_test:");
		const hasTest = pubspec.includes("test:") || pubspec.includes("flutter_test:");
		const hasAnalysis =
			has("analysis_options.yaml") || workspace?.packages.some((p) => existsSync(join(cwd, p.path, "analysis_options.yaml")));
		return {
			language: "dart",
			framework: isFlutter ? "flutter" : "none",
			bundler: "none",
			testRunner: isFlutter ? (hasTest ? "flutter_test" : "none") : hasTest ? "dart_test" : "none",
			linter: hasAnalysis ? "dart_analyze" : "none",
			packageManager: "pub",
		};
	}

	// ── Node.js/TypeScript detection ──
	const pkg = read("package.json");
	let allDeps: Record<string, string> = {};
	try {
		const deps = pkg ? JSON.parse(pkg) : {};
		allDeps = { ...deps.dependencies, ...deps.devDependencies };
	} catch {
		// invalid package.json
	}

	// Aggregate deps from workspace packages (monorepo: framework may live in packages, not root)
	if (workspace?.isMonorepo) {
		for (const wp of workspace.packages) {
			const pkgContent = read(join(wp.path, "package.json"));
			if (!pkgContent) continue;
			try {
				const parsed = JSON.parse(pkgContent);
				allDeps = { ...allDeps, ...parsed.dependencies, ...parsed.devDependencies };
			} catch {
				/* invalid json */
			}
		}
	}

	const language =
		has("tsconfig.json") || has("tsconfig.app.json") || has("tsconfig.base.json") || allDeps.typescript
			? "typescript"
			: allDeps.react || allDeps.vue || allDeps.svelte
				? "javascript"
				: "unknown";

	// Framework detection — order matters (meta-frameworks before base)
	let framework: StackInfo["framework"] = "none";
	if (allDeps.next || allDeps.react) framework = "react";
	else if (allDeps.nuxt || allDeps.vue) framework = "vue";
	else if (allDeps["@sveltejs/kit"] || allDeps.svelte) framework = "svelte";

	// Bundler — meta-frameworks use their own bundler
	let bundler: StackInfo["bundler"] = "none";
	if (allDeps.next || allDeps.nuxt)
		bundler = "vite"; // Next/Nuxt handle bundling
	else if (allDeps.vite || allDeps["@sveltejs/kit"]) bundler = "vite";
	else if (allDeps.webpack) bundler = "webpack";
	else if (allDeps.esbuild) bundler = "esbuild";

	const testRunner: StackInfo["testRunner"] = allDeps.vitest ? "vitest" : allDeps.jest ? "jest" : "none";

	const linter: StackInfo["linter"] = allDeps["@biomejs/biome"] ? "biome" : allDeps.eslint ? "eslint" : "none";

	const packageManager: StackInfo["packageManager"] = has("pnpm-lock.yaml")
		? "pnpm"
		: has("bun.lockb") || has("bun.lock")
			? "bun"
			: has("yarn.lock")
				? "yarn"
				: "npm";

	return { language, framework, bundler, testRunner, linter, packageManager };
}

/**
 * Parse a YAML list under a given key. Handles:
 * - Block-style with comments/blank lines between entries
 * - Flow-style: `key: [item1, item2]`
 * - Quoted and unquoted items
 * Zero-dep — no YAML parser needed.
 */
export function parseYamlList(content: string, key: string): string[] {
	// Flow-style: `key: [item1, item2]`
	const flowMatch = content.match(new RegExp(`^${key}:\\s*\\[([^\\]]*)]`, "m"));
	if (flowMatch) {
		return flowMatch[1]
			.split(",")
			.map((s) => s.trim().replace(/['"]/g, ""))
			.filter(Boolean);
	}

	// Block-style: find the key, then collect indented lines until next top-level key
	const lines = content.split("\n");
	let inSection = false;
	const items: string[] = [];
	for (const line of lines) {
		if (inSection) {
			// Stop at next top-level key (non-indented, non-comment, non-blank)
			if (/^\S/.test(line) && !line.startsWith("#")) break;
			// Extract list items: `  - value` or `  - 'value'` or `  - "value"`
			const itemMatch = line.match(/^\s+-\s+['"]?([^\s'"#]+)['"]?\s*(?:#.*)?$/);
			if (itemMatch) items.push(itemMatch[1]);
			// Skip comments and blank lines within the section
		} else if (new RegExp(`^${key}:\\s*$`).test(line)) {
			inSection = true;
		}
	}
	return items;
}

/** Detect monorepo / workspace layout. */
export function detectWorkspace(cwd: string): WorkspaceInfo {
	const has = (f: string) => existsSync(join(cwd, f));
	const read = (f: string) => {
		try {
			return readFileSync(join(cwd, f), "utf-8");
		} catch {
			return "";
		}
	};

	// Detect workspace tool
	let tool: WorkspaceInfo["tool"] = "none";
	let globs: string[] = [];

	// ── Dart/Flutter monorepo (melos) ──
	if (has("melos.yaml")) {
		tool = "melos";
		globs = parseYamlList(read("melos.yaml"), "packages");
		if (globs.length === 0) globs = ["packages/*"];
	}

	// ── Node.js workspace configs ──
	if (tool === "none" && has("pnpm-workspace.yaml")) {
		tool = "pnpm";
		globs = parseYamlList(read("pnpm-workspace.yaml"), "packages");
	}

	if (tool === "none") {
		const pkg = read("package.json");
		if (pkg) {
			try {
				const parsed = JSON.parse(pkg);
				if (parsed.workspaces) {
					const ws = Array.isArray(parsed.workspaces) ? parsed.workspaces : parsed.workspaces.packages || [];
					if (ws.length > 0) {
						tool = has("bun.lockb") || has("bun.lock") ? "bun" : has("yarn.lock") ? "yarn" : "npm";
						globs = ws;
					}
				}
			} catch {
				/* invalid json */
			}
		}
	}

	if (has("lerna.json") && tool === "none") {
		tool = "lerna";
		const lerna = read("lerna.json");
		try {
			const parsed = JSON.parse(lerna);
			globs = parsed.packages || ["packages/*"];
		} catch {
			globs = ["packages/*"];
		}
	}

	// Detect orchestration tools (overlay on top of workspace tool)
	if (has("turbo.json") && tool !== "none" && tool !== "melos") tool = "turborepo";
	if (has("nx.json") && tool !== "none" && tool !== "melos") tool = "nx";

	// Filter out negation patterns (pnpm !prefix exclusions)
	globs = globs.filter((g) => !g.startsWith("!"));

	if (tool === "none" || globs.length === 0) {
		// No workspace config — check for conventional multi-dir layouts
		return detectConventionalLayout(cwd);
	}

	// Resolve workspace entries to actual package directories
	const packages: WorkspacePackage[] = [];
	for (const glob of globs) {
		resolveGlob(cwd, glob, packages);
	}

	// For melos monorepos: also detect sibling directories with package.json
	// (e.g. functions/ in a Flutter + Node.js monorepo)
	if (tool === "melos") {
		const knownPaths = new Set(packages.map((p) => p.path));
		for (const entry of readdirSync(cwd)) {
			if (knownPaths.has(entry)) continue;
			if (entry === "node_modules" || entry === ".git" || entry === "dist" || entry === "build" || entry.startsWith(".")) continue;
			const full = join(cwd, entry);
			try {
				if (!statSync(full).isDirectory()) continue;
			} catch {
				continue;
			}
			if (existsSync(join(full, "package.json"))) {
				addPackage(entry, full, packages);
			}
		}
	}

	const srcRoots = buildSrcRoots(cwd, packages);
	return { isMonorepo: true, tool, packages, srcRoots };
}

/** Resolve a workspace glob/path to package directories. */
function resolveGlob(cwd: string, pattern: string, packages: WorkspacePackage[]): void {
	if (pattern.includes("**")) {
		// Recursive glob — e.g. "packages/**"
		const base = pattern.replace(/\/?\*\*.*$/, "");
		const baseDir = join(cwd, base);
		if (!existsSync(baseDir) || !statSync(baseDir).isDirectory()) return;
		walkForPackages(cwd, baseDir, base, packages);
	} else if (pattern.includes("*")) {
		// Single-level glob — e.g. "packages/*"
		const base = pattern.replace(/\/?\*.*$/, "");
		const baseDir = join(cwd, base);
		if (!existsSync(baseDir) || !statSync(baseDir).isDirectory()) return;
		for (const entry of readdirSync(baseDir)) {
			const pkgDir = join(baseDir, entry);
			if (!statSync(pkgDir).isDirectory()) continue;
			addPackage(`${base}/${entry}`, pkgDir, packages);
		}
	} else {
		// Explicit path — e.g. "packages/sdk"
		const pkgDir = join(cwd, pattern);
		if (existsSync(pkgDir) && statSync(pkgDir).isDirectory()) {
			addPackage(pattern, pkgDir, packages);
		}
	}
}

/** Walk recursively for packages (for ** globs). */
function walkForPackages(cwd: string, dir: string, relBase: string, packages: WorkspacePackage[]): void {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry === "node_modules" || entry === ".git" || entry === "dist" || entry === "build") continue;
		const full = join(dir, entry);
		try {
			if (lstatSync(full).isSymbolicLink() || !statSync(full).isDirectory()) continue;
		} catch {
			continue;
		}
		const relPath = relBase ? `${relBase}/${entry}` : entry;

		// If this dir has a package.json or pubspec.yaml, it's a package
		if (existsSync(join(full, "package.json")) || existsSync(join(full, "pubspec.yaml"))) {
			addPackage(relPath, full, packages);
		} else {
			// Keep looking deeper
			walkForPackages(cwd, full, relPath, packages);
		}
	}
}

/** Add a single package to the list, detecting its capabilities. */
function addPackage(relPath: string, pkgDir: string, packages: WorkspacePackage[]): void {
	// Accept packages with or without package.json (some workspaces use them loosely)
	const pkgJsonPath = join(pkgDir, "package.json");
	let name = relPath.split("/").pop() || relPath;
	if (existsSync(pkgJsonPath)) {
		try {
			const parsed = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
			name = parsed.name || name;
		} catch {
			/* use dir name */
		}
	}

	const hasSrc = existsSync(join(pkgDir, "src")) || existsSync(join(pkgDir, "app")) || existsSync(join(pkgDir, "lib"));
	// Some packages have code at root (no src/ dir) — check for .ts/.dart files
	const hasRootCode =
		!hasSrc &&
		readdirSync(pkgDir).some(
			(f) => f.endsWith(".ts") || f.endsWith(".tsx") || f.endsWith(".js") || f.endsWith(".jsx") || f.endsWith(".dart"),
		);
	const hasTests = existsSync(join(pkgDir, "test")) || existsSync(join(pkgDir, "tests")) || existsSync(join(pkgDir, "__tests__")) || hasSrc; // tests often live alongside src in monorepos
	const hasLinter =
		existsSync(join(pkgDir, "biome.json")) ||
		existsSync(join(pkgDir, "biome.jsonc")) ||
		existsSync(join(pkgDir, ".eslintrc.json")) ||
		existsSync(join(pkgDir, ".eslintrc.js")) ||
		existsSync(join(pkgDir, "eslint.config.js")) ||
		existsSync(join(pkgDir, "eslint.config.ts")) ||
		existsSync(join(pkgDir, "eslint.config.mjs"));

	packages.push({ name, path: relPath, hasSrc: hasSrc || hasRootCode, hasRootCode, hasTests, hasLinter });
}

/** Build srcRoots from resolved packages. */
function buildSrcRoots(cwd: string, packages: WorkspacePackage[]): string[] {
	const srcRoots: string[] = [];
	const seen = new Set<string>();

	function add(dir: string) {
		if (seen.has(dir)) return;
		seen.add(dir);
		if (existsSync(join(cwd, dir))) srcRoots.push(dir);
	}

	for (const pkg of packages) {
		if (pkg.hasRootCode) {
			// Source at package root — add the package itself
			add(pkg.path);
		} else {
			// Source in subdirectories
			for (const srcDir of ["src", "app", "lib"]) {
				add(join(pkg.path, srcDir));
			}
		}
		// Test directories
		for (const testDir of ["test", "tests", "__tests__", "e2e"]) {
			add(join(pkg.path, testDir));
		}
	}

	// Also include root-level dirs if they exist
	for (const d of ["src", "web/src", "lib", "app"]) add(d);

	return srcRoots;
}

/**
 * Detect conventional multi-directory layouts that aren't formal workspaces
 * but still have a multi-root structure (e.g. server/ + client/, apps/ + libs/).
 */
function detectConventionalLayout(cwd: string): WorkspaceInfo {
	const none: WorkspaceInfo = { isMonorepo: false, tool: "none", packages: [], srcRoots: ["src", "web/src", "lib", "app"] };

	// Check for common multi-app layouts
	const conventions = [
		["apps", "packages"], // Turborepo/Nx convention
		["apps", "libs"], // Nx convention
		["services", "packages"], // Microservices
		["server", "client"], // Fullstack split
		["backend", "frontend"], // Fullstack split
	];

	for (const dirs of conventions) {
		const existing = dirs.filter((d) => existsSync(join(cwd, d)) && statSync(join(cwd, d)).isDirectory());
		if (existing.length < 2) continue;

		// Found a conventional layout — treat like a monorepo
		const packages: WorkspacePackage[] = [];
		for (const dir of existing) {
			const entries = readdirSync(join(cwd, dir));
			const subDirs = entries.filter((e) => {
				try {
					return statSync(join(cwd, dir, e)).isDirectory();
				} catch {
					return false;
				}
			});
			const hasPkgJson = subDirs.some((e) => existsSync(join(cwd, dir, e, "package.json")));

			if (hasPkgJson) {
				for (const entry of subDirs) {
					addPackage(`${dir}/${entry}`, join(cwd, dir, entry), packages);
				}
			} else {
				// The directory itself is a "package" (server/, client/)
				// Only if it has a package.json or source files
				const dirPath = join(cwd, dir);
				const hasManifest = existsSync(join(dirPath, "package.json")) || existsSync(join(dirPath, "pubspec.yaml"));
				const hasCode = readdirSync(dirPath).some(
					(f) => f.endsWith(".ts") || f.endsWith(".tsx") || f.endsWith(".js") || f.endsWith(".dart"),
				);
				if (hasManifest || hasCode) {
					addPackage(dir, dirPath, packages);
				}
			}
		}

		if (packages.length > 0) {
			return { isMonorepo: true, tool: "none", packages, srcRoots: buildSrcRoots(cwd, packages) };
		}
	}

	return none;
}

/** Detect GitHub/GitLab repo URL from git remote. */
export function detectRepoUrl(cwd: string): { repoUrl: string | null; branch: string } {
	try {
		const remote = execSync("git remote get-url origin", { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
		const branch = execSync("git branch --show-current", { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim() || "main";
		// Convert SSH to HTTPS
		const url = remote
			.replace(/^git@github\.com:/, "https://github.com/")
			.replace(/^git@gitlab\.com:/, "https://gitlab.com/")
			.replace(/^git@bitbucket\.org:/, "https://bitbucket.org/")
			.replace(/^ssh:\/\/git@github\.com\//, "https://github.com/")
			.replace(/^ssh:\/\/git@gitlab\.com\//, "https://gitlab.com/")
			.replace(/\.git$/, "");
		return { repoUrl: url, branch };
	} catch {
		return { repoUrl: null, branch: "main" };
	}
}
