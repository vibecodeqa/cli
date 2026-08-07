/** Auto-detect project stack, workspace layout, and git repo from files in the working directory. */

import { execSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { discoveryConventions, projectMarkerFiles } from "./discovery-conventions.js";
import type { ProjectContext, ProjectDiscoveryEvidence, ProjectToolCommand, StackInfo, WorkspaceInfo, WorkspacePackage } from "./types.js";

/** Detect infrastructure/data components (open vocabulary — see schema's StackInfo.components).
 *  Looks at the root and workspace package dirs for wrangler config and migration dirs. */
export function detectComponents(cwd: string, workspace?: WorkspaceInfo): string[] {
	const found = new Set<string>();
	const dirs = [cwd, ...(workspace?.packages.map((p) => join(cwd, p.path)) ?? [])];
	for (const dir of dirs) {
		let wrangler = "";
		for (const name of discoveryConventions.componentConfigFiles) {
			const f = join(dir, name);
			if (existsSync(f)) {
				try {
					wrangler = readFileSync(f, "utf-8");
				} catch {
					/* unreadable — skip */
				}
				break;
			}
		}
		if (wrangler) {
			found.add(wrangler.includes("pages_build_output_dir") ? "cloudflare-pages" : "cloudflare-workers");
			if (/d1_databases/.test(wrangler)) found.add("sqlite-d1");
			if (/kv_namespaces/.test(wrangler)) found.add("cloudflare-kv");
			if (/r2_buckets/.test(wrangler)) found.add("cloudflare-r2");
			if (/durable_objects/.test(wrangler)) found.add("durable-objects");
		}
		// SQL migrations without a wrangler binding still mean a SQLite-family DB in play
		const mig = join(dir, "migrations");
		if (!found.has("sqlite-d1") && existsSync(mig)) {
			try {
				if (readdirSync(mig).some((f) => f.endsWith(".sql"))) found.add("sqlite-d1");
			} catch {
				/* unreadable */
			}
		}
	}
	return [...found].sort();
}

export function detectStack(cwd: string, workspace?: WorkspaceInfo): StackInfo {
	const components = detectComponents(cwd, workspace);
	const withComponents = (stack: StackInfo): StackInfo => (components.length > 0 ? { ...stack, components } : stack);
	const has = (f: string) => existsSync(join(cwd, f));
	const read = (f: string) => {
		try {
			return readFileSync(join(cwd, f), "utf-8");
		} catch {
			return "";
		}
	};

	// ── Dart/Flutter detection ──
	// Check root pubspec, OR workspace packages. Some Flutter repos are
	// convention-only multi-package roots (app/, admin/, shared/) without melos.
	let pubspec = read("pubspec.yaml");
	if (!pubspec && workspace?.isMonorepo) {
		for (const wp of workspace.packages) {
			const ps = read(join(wp.path, "pubspec.yaml"));
			if (ps) {
				pubspec += `\n${ps}`;
			}
		}
	}
	if (pubspec || has("pubspec.lock")) {
		const isFlutter = pubspec.includes("flutter:") || pubspec.includes("flutter_test:");
		const hasTest = pubspec.includes("test:") || pubspec.includes("flutter_test:");
		const hasAnalysis =
			has("analysis_options.yaml") || workspace?.packages.some((p) => existsSync(join(cwd, p.path, "analysis_options.yaml")));
		return withComponents({
			language: "dart",
			framework: isFlutter ? "flutter" : "none",
			bundler: "none",
			testRunner: isFlutter ? (hasTest ? "flutter_test" : "none") : hasTest ? "dart_test" : "none",
			linter: hasAnalysis ? "dart_analyze" : "none",
			packageManager: "pub",
		});
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

	return withComponents({ language, framework, bundler, testRunner, linter, packageManager });
}

function detectProjectStack(projectDir: string, rootCwd: string): StackInfo {
	const has = (f: string) => existsSync(join(projectDir, f));
	const read = (f: string) => {
		try {
			return readFileSync(join(projectDir, f), "utf-8");
		} catch {
			return "";
		}
	};

	const pubspec = read("pubspec.yaml");
	if (pubspec || has("pubspec.lock")) {
		const isFlutter = pubspec.includes("flutter:") || pubspec.includes("flutter_test:");
		const hasTest = pubspec.includes("test:") || pubspec.includes("flutter_test:");
		return {
			language: "dart",
			framework: isFlutter ? "flutter" : "none",
			bundler: "none",
			testRunner: isFlutter ? (hasTest ? "flutter_test" : "none") : hasTest ? "dart_test" : "none",
			linter: has("analysis_options.yaml") ? "dart_analyze" : "none",
			packageManager: "pub",
			components: detectComponents(projectDir),
		};
	}

	let allDeps: Record<string, string> = {};
	const pkg = read("package.json");
	try {
		const parsed = pkg ? JSON.parse(pkg) : {};
		allDeps = { ...parsed.dependencies, ...parsed.devDependencies };
	} catch {
		/* invalid package.json */
	}

	const language =
		has("tsconfig.json") ||
		has("tsconfig.app.json") ||
		has("tsconfig.base.json") ||
		allDeps.typescript ||
		readSafeEntries(projectDir).some((f) => f.endsWith(".ts") || f.endsWith(".tsx"))
			? "typescript"
			: allDeps.react || allDeps.vue || allDeps.svelte
				? "javascript"
				: "unknown";

	let framework: StackInfo["framework"] = "none";
	if (allDeps.next || allDeps.react) framework = "react";
	else if (allDeps.nuxt || allDeps.vue) framework = "vue";
	else if (allDeps["@sveltejs/kit"] || allDeps.svelte) framework = "svelte";

	let bundler: StackInfo["bundler"] = "none";
	if (allDeps.next || allDeps.nuxt) bundler = "vite";
	else if (allDeps.vite || allDeps["@sveltejs/kit"]) bundler = "vite";
	else if (allDeps.webpack) bundler = "webpack";
	else if (allDeps.esbuild) bundler = "esbuild";

	const hasBiomeConfig = has("biome.json") || has("biome.jsonc");
	const hasEslintConfig =
		has(".eslintrc") ||
		has(".eslintrc.json") ||
		has(".eslintrc.js") ||
		has(".eslintrc.cjs") ||
		has(".eslintrc.yml") ||
		has(".eslintrc.yaml") ||
		has("eslint.config.js") ||
		has("eslint.config.ts") ||
		has("eslint.config.mjs") ||
		has("eslint.config.cjs");
	const linter: StackInfo["linter"] =
		allDeps["@biomejs/biome"] || hasBiomeConfig ? "biome" : allDeps.eslint || hasEslintConfig ? "eslint" : "none";
	const packageManager: StackInfo["packageManager"] =
		has("pnpm-lock.yaml") || existsSync(join(rootCwd, "pnpm-lock.yaml"))
			? "pnpm"
			: has("bun.lockb") || has("bun.lock") || existsSync(join(rootCwd, "bun.lockb")) || existsSync(join(rootCwd, "bun.lock"))
				? "bun"
				: has("yarn.lock") || existsSync(join(rootCwd, "yarn.lock"))
					? "yarn"
					: "npm";
	const components = detectComponents(projectDir);
	const stack: StackInfo = {
		language,
		framework,
		bundler,
		testRunner: allDeps.vitest ? "vitest" : allDeps.jest ? "jest" : "none",
		linter,
		packageManager,
	};
	return components.length > 0 ? { ...stack, components } : stack;
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
	const discoveryEvidence: ProjectDiscoveryEvidence[] = [];

	// ── Dart/Flutter monorepo (melos) ──
	const melos = discoveryConventions.workspaceManifestDefaults.melos;
	if (has(melos.file)) {
		tool = "melos";
		globs = parseYamlList(read(melos.file), melos.listKey ?? "packages");
		if (globs.length === 0) globs = melos.defaultGlobs;
		discoveryEvidence.push({ kind: "manifest", file: melos.file, description: "Melos workspace manifest defines package globs" });
	}

	// ── Node.js workspace configs ──
	const pnpm = discoveryConventions.workspaceManifestDefaults.pnpm;
	if (tool === "none" && has(pnpm.file)) {
		tool = "pnpm";
		globs = parseYamlList(read(pnpm.file), pnpm.listKey ?? "packages");
		discoveryEvidence.push({ kind: "manifest", file: pnpm.file, description: "pnpm workspace manifest defines package globs" });
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
						discoveryEvidence.push({ kind: "manifest", file: "package.json", description: "package.json workspaces define package globs" });
					}
				}
			} catch {
				/* invalid json */
			}
		}
	}

	const lerna = discoveryConventions.workspaceManifestDefaults.lerna;
	if (has(lerna.file) && tool === "none") {
		tool = "lerna";
		const lernaContent = read(lerna.file);
		discoveryEvidence.push({ kind: "manifest", file: lerna.file, description: "Lerna workspace manifest defines package globs" });
		try {
			const parsed = JSON.parse(lernaContent);
			globs = parsed[lerna.jsonField ?? "packages"] || lerna.defaultGlobs;
		} catch {
			globs = lerna.defaultGlobs;
		}
	}

	// Detect orchestration tools (overlay on top of workspace tool)
	if (has("turbo.json") && tool !== "none" && tool !== "melos") {
		tool = "turborepo";
		discoveryEvidence.push({ kind: "tooling", file: "turbo.json", description: "Turborepo config overlays the workspace" });
	}
	if (has("nx.json") && tool !== "none" && tool !== "melos") {
		tool = "nx";
		discoveryEvidence.push({ kind: "tooling", file: "nx.json", description: "Nx config overlays the workspace" });
	}

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
			if (shouldSkipConventionEntry(entry)) continue;
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
	return {
		isMonorepo: true,
		tool,
		packages,
		srcRoots,
		projects: buildProjectContexts(cwd, packages, discoveryEvidence, true),
		discovery: { mode: "manifest", evidence: discoveryEvidence },
	};
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
			// A broken symlink under the glob dir would make statSync throw and abort
			// the whole scan — skip unreadable entries and symlinks like walkForPackages.
			try {
				if (lstatSync(pkgDir).isSymbolicLink() || !statSync(pkgDir).isDirectory()) continue;
			} catch {
				continue;
			}
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
		if (discoveryConventions.ignoredConventionEntries.includes(entry)) continue;
		const full = join(dir, entry);
		try {
			if (lstatSync(full).isSymbolicLink() || !statSync(full).isDirectory()) continue;
		} catch {
			continue;
		}
		const relPath = relBase ? `${relBase}/${entry}` : entry;

		// If this dir has a supported manifest/config marker, it's a package.
		if (hasSupportedProjectMarker(full)) {
			addPackage(relPath, full, packages);
		} else {
			// Keep looking deeper
			walkForPackages(cwd, full, relPath, packages);
		}
	}
}

/** readdirSync that returns [] instead of throwing on an unreadable dir. */
function readSafeEntries(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
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

	const hasSrc = discoveryConventions.sourceRoots.some((root) => existsSync(join(pkgDir, root)));
	// Some packages have code at root (no src/ dir) — check for .ts/.dart files.
	// Guard readdirSync: an unreadable package dir must not abort detection.
	const hasRootCode = !hasSrc && readSafeEntries(pkgDir).some((f) => hasSourceExtension(f));
	const hasTests = discoveryConventions.testRoots.some((root) => existsSync(join(pkgDir, root))) || hasSrc; // tests often live alongside src in monorepos
	const hasLinter = discoveryConventions.linterConfigFiles.some((file) => existsSync(join(pkgDir, file)));

	packages.push({ name, path: relPath, hasSrc: hasSrc || hasRootCode, hasRootCode, hasTests, hasLinter });
}

function projectId(path: string): string {
	return path === "." ? "root" : path.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";
}

function projectKind(path: string): ProjectContext["kind"] {
	if (path === ".") return "root";
	const first = path.split("/")[0] ?? "";
	const rules = discoveryConventions.projectKindRules;
	if (rules.appRoots.includes(first)) return "app";
	if (rules.serviceRoots.includes(first) || rules.servicePathIncludes.some((needle) => path.includes(needle))) return "service";
	if (rules.libraryRoots.includes(first) || rules.libraryPathIncludes.some((needle) => path.includes(needle))) return "library";
	return "package";
}

function existingRelativeFiles(cwd: string, basePath: string, candidates: string[]): string[] {
	const base = basePath === "." ? cwd : join(cwd, basePath);
	return candidates.filter((f) => existsSync(join(base, f))).map((f) => (basePath === "." ? f : join(basePath, f)));
}

function projectRoots(cwd: string, basePath: string, dirs: string[]): string[] {
	const base = basePath === "." ? cwd : join(cwd, basePath);
	return dirs.filter((d) => existsSync(join(base, d))).map((d) => (basePath === "." ? d : join(basePath, d)));
}

function projectConfidence(
	manifestFiles: string[],
	configFiles: string[],
	srcRoots: string[],
	evidence: ProjectDiscoveryEvidence[],
): number {
	const scoring = discoveryConventions.confidenceScoring;
	let confidence = scoring.base;
	if (manifestFiles.length > 0) confidence += scoring.manifestFileBonus;
	if (configFiles.length > 0) confidence += scoring.configFileBonus;
	if (srcRoots.length > 0) confidence += scoring.sourceRootBonus;
	if (evidence.some((item) => item.kind === "manifest")) confidence += scoring.manifestEvidenceBonus;
	if (evidence.some((item) => item.kind === "convention")) confidence -= scoring.conventionEvidencePenalty;
	return Math.max(0, Math.min(1, Number(confidence.toFixed(2))));
}

function projectToolCommands(project: {
	path: string;
	stack: StackInfo;
	configFiles: string[];
	manifestFiles: string[];
	testRoots: string[];
}): ProjectContext["toolCommands"] {
	const cwd = project.path;
	const hasConfig = (name: string) => project.configFiles.some((file) => file === name || file.endsWith(`/${name}`));
	const hasManifest = (name: string) => project.manifestFiles.some((file) => file === name || file.endsWith(`/${name}`));
	const commands: ProjectContext["toolCommands"] = {};
	const add = (kind: keyof ProjectContext["toolCommands"], command: ProjectToolCommand) => {
		commands[kind] = [...(commands[kind] ?? []), command];
	};

	if (project.stack.linter === "biome") add("lint", { tool: "biome", cwd, command: ["npx", "biome", "check", "."] });
	if (project.stack.linter === "eslint") add("lint", { tool: "eslint", cwd, command: ["npx", "eslint", "."] });
	if (project.stack.linter === "dart_analyze") add("lint", { tool: "dart", cwd, command: ["dart", "analyze"] });
	if (hasConfig("tsconfig.json")) add("typecheck", { tool: "tsc", cwd, command: ["npx", "tsc", "--noEmit"] });
	if (hasManifest("pubspec.yaml")) add("typecheck", { tool: "dart", cwd, command: ["dart", "analyze"] });
	if (project.stack.testRunner === "vitest") add("test", { tool: "vitest", cwd, command: ["npx", "vitest", "run"] });
	if (project.stack.testRunner === "jest") add("test", { tool: "jest", cwd, command: ["npx", "jest", "--json"] });
	if (project.stack.testRunner === "flutter_test") add("test", { tool: "flutter", cwd, command: ["flutter", "test"] });
	if (project.stack.testRunner === "dart_test") add("test", { tool: "dart", cwd, command: ["dart", "test"] });
	if (project.stack.packageManager !== "pub" && hasManifest("package.json")) {
		add("audit", { tool: project.stack.packageManager, cwd, command: [project.stack.packageManager, "audit"] });
	}
	return commands;
}

function createProjectContext(cwd: string, pkg: WorkspacePackage | null, evidence: ProjectDiscoveryEvidence[]): ProjectContext {
	const path = pkg?.path ?? ".";
	const dir = path === "." ? cwd : join(cwd, path);
	const manifestFiles = existingRelativeFiles(cwd, path, discoveryConventions.projectManifestFiles);
	const configFiles = existingRelativeFiles(cwd, path, discoveryConventions.projectConfigFiles);
	const srcRoots = pkg?.hasRootCode ? [path] : projectRoots(cwd, path, discoveryConventions.sourceRoots);
	const testRoots = projectRoots(cwd, path, discoveryConventions.testRoots);
	const stack = detectProjectStack(dir, cwd);
	const projectEvidence = [
		...evidence,
		...manifestFiles.map((file) => ({ kind: "manifest", file, description: "Project manifest found" }) satisfies ProjectDiscoveryEvidence),
		...configFiles.map((file) => ({ kind: "config", file, description: "Project config found" }) satisfies ProjectDiscoveryEvidence),
	];
	const toolCommands = projectToolCommands({ path, stack, configFiles, manifestFiles, testRoots });
	return {
		id: projectId(path),
		name: pkg?.name ?? "root",
		path,
		kind: projectKind(path),
		stack,
		srcRoots,
		testRoots,
		configFiles,
		manifestFiles,
		evidence: projectEvidence,
		confidence: projectConfidence(manifestFiles, configFiles, srcRoots, projectEvidence),
		toolCommands,
	};
}

function buildProjectContexts(
	cwd: string,
	packages: WorkspacePackage[],
	discoveryEvidence: ProjectDiscoveryEvidence[],
	includeRoot: boolean,
): ProjectContext[] {
	const projects: ProjectContext[] = [];
	if (includeRoot) {
		projects.push(createProjectContext(cwd, null, [{ kind: "source", path: ".", description: "Repository root scanned as a project" }]));
	}
	for (const pkg of packages) {
		projects.push(
			createProjectContext(cwd, pkg, [
				...discoveryEvidence,
				{ kind: "source", path: pkg.path, description: "Workspace package selected as a scan project" },
			]),
		);
	}
	return projects;
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
			for (const srcDir of discoveryConventions.sourceRoots) {
				add(join(pkg.path, srcDir));
			}
		}
		// Test directories
		for (const testDir of discoveryConventions.testRoots) {
			add(join(pkg.path, testDir));
		}
	}

	// Also include root-level dirs if they exist
	for (const d of discoveryConventions.rootSourceRoots) add(d);

	return srcRoots;
}

/**
 * Detect conventional multi-directory layouts that aren't formal workspaces
 * but still have a multi-root structure (e.g. server/ + client/, apps/ + libs/).
 */
function detectConventionalLayout(cwd: string): WorkspaceInfo {
	const singleEvidence: ProjectDiscoveryEvidence[] = [
		{ kind: "source", path: ".", description: "No workspace manifest found; repository root scanned as a single project" },
	];
	const rejectedEvidence: ProjectDiscoveryEvidence[] = [];
	const none: WorkspaceInfo = {
		isMonorepo: false,
		tool: "none",
		packages: [],
		srcRoots: discoveryConventions.rootSourceRoots,
		projects: buildProjectContexts(cwd, [], singleEvidence, true),
		discovery: { mode: "single", evidence: singleEvidence },
	};

	for (const dirs of discoveryConventions.pairedConventionLayouts) {
		const existing = dirs.filter((d) => existsSync(join(cwd, d)) && statSync(join(cwd, d)).isDirectory());
		if (existing.length < 2) continue;
		const conventionRejectedEvidence: ProjectDiscoveryEvidence[] = [];
		const conventionEvidence: ProjectDiscoveryEvidence[] = [
			{
				kind: "convention",
				path: existing.join(" + "),
				description: "Conventional multi-root layout detected without a workspace manifest",
			},
		];

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
					const childPath = `${dir}/${entry}`;
					const childDir = join(cwd, dir, entry);
					if (hasSupportedProjectMarker(childDir)) {
						addPackage(childPath, childDir, packages);
					} else {
						conventionRejectedEvidence.push({
							kind: "rejected",
							path: childPath,
							description: "Convention candidate rejected because no supported project manifest was found",
						});
					}
				}
			} else {
				// The directory itself is a "package" (server/, client/)
				// Only if it has a package.json or source files
				const dirPath = join(cwd, dir);
				const hasManifest = hasSupportedProjectMarker(dirPath);
				const hasCode = readdirSync(dirPath).some((f) => hasSourceExtension(f));
				if (hasManifest || hasCode) {
					addPackage(dir, dirPath, packages);
				} else {
					conventionRejectedEvidence.push({
						kind: "rejected",
						path: dir,
						description: "Convention candidate rejected because no supported project manifest or root source file was found",
					});
				}
			}
		}

		if (packages.length > 0) {
			const evidence = [...conventionEvidence, ...conventionRejectedEvidence];
			return {
				isMonorepo: true,
				tool: "none",
				packages,
				srcRoots: buildSrcRoots(cwd, packages),
				projects: buildProjectContexts(cwd, packages, conventionEvidence, true),
				discovery: { mode: "convention", evidence },
			};
		}
	}

	// Convention-only package roots. This covers Flutter layouts like
	// platform/app, platform/admin, platform/shared where each child owns a
	// pubspec.yaml but the repo root has no melos.yaml or root pubspec.yaml.
	const packages: WorkspacePackage[] = [];
	for (const entry of readdirSync(cwd)) {
		if (shouldSkipConventionEntry(entry)) continue;
		const full = join(cwd, entry);
		try {
			if (lstatSync(full).isSymbolicLink() || !statSync(full).isDirectory()) continue;
		} catch {
			continue;
		}
		if (hasSupportedProjectMarker(full)) {
			addPackage(entry, full, packages);
			continue;
		}
		if (!discoveryConventions.conventionalContainerRoots.includes(entry)) continue;
		// detectWorkspace runs outside the per-runner try/catch, so an unreadable
		// child directory (EACCES) here would abort the whole scan — skip it.
		let children: string[];
		try {
			children = readdirSync(full);
		} catch {
			continue;
		}
		for (const child of children) {
			const childFull = join(full, child);
			try {
				if (lstatSync(childFull).isSymbolicLink() || !statSync(childFull).isDirectory()) continue;
			} catch {
				continue;
			}
			if (hasSupportedProjectMarker(childFull)) {
				addPackage(`${entry}/${child}`, childFull, packages);
			} else {
				rejectedEvidence.push({
					kind: "rejected",
					path: `${entry}/${child}`,
					description: "Nested convention candidate rejected because no supported project manifest was found",
				});
			}
		}
	}

	if (packages.length >= 2) {
		const conventionEvidence: ProjectDiscoveryEvidence[] = [
			{
				kind: "convention",
				path: packages.map((p) => p.path).join(", "),
				description: "Multiple child manifests detected without a workspace manifest",
			},
		];
		return {
			isMonorepo: true,
			tool: "none",
			packages,
			srcRoots: buildSrcRoots(cwd, packages),
			projects: buildProjectContexts(cwd, packages, conventionEvidence, true),
			discovery: { mode: "convention", evidence: [...conventionEvidence, ...rejectedEvidence] },
		};
	}

	return rejectedEvidence.length > 0
		? { ...none, discovery: { mode: "single", evidence: [...singleEvidence, ...rejectedEvidence] } }
		: none;
}

function hasSupportedProjectMarker(dir: string): boolean {
	return projectMarkerFiles.some((marker) => existsSync(join(dir, marker)));
}

function hasSourceExtension(fileName: string): boolean {
	return discoveryConventions.sourceFileExtensions.some((ext) => fileName.endsWith(ext));
}

function shouldSkipConventionEntry(entry: string): boolean {
	return discoveryConventions.ignoredConventionEntries.includes(entry) || entry.startsWith(".");
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
