/** Shared filesystem utilities — eliminates duplicate file-walking across runners. */

import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { discoveryConventions } from "./discovery-conventions.js";
import type { EffectiveScanPolicy } from "./scan-policy.js";
import { evaluatePath, scanPolicyFromInputs } from "./scan-policy.js";

export interface SourceFile {
	path: string; // relative to cwd
	fullPath: string;
	base: string; // filename without extension
	ext: string;
	content: string; // for SFCs: extracted <script> content; for others: full file
	rawContent?: string; // for SFCs: full file including template (used by a11y checks)
	lines: number;
	isTest: boolean;
}

const CODE_EXTS = new Set(discoveryConventions.sourceFileExtensions);
const ALL_EXTS = new Set([...CODE_EXTS, ".json", ".env", ".yaml", ".yml", ".toml", ".html", ".htm", ".md", ".mdx", ".txt", ".sh"]);

/** Default source directories for single-package repos */
const DEFAULT_SRC_DIRS = discoveryConventions.rootSourceRoots;

/**
 * Set global source roots (called once from cli.ts after workspace detection).
 * All subsequent calls to collectSourceFiles / getProductionFiles use these
 * unless overridden per-call.
 */
let _globalSrcRoots: string[] | undefined;
export function setGlobalSrcRoots(roots: string[] | undefined): void {
	_globalSrcRoots = roots;
}

// Every ignore decision in this module — the walkers and the external-tool path
// filter alike — is answered by one engine: scan-policy's evaluatePath(). This
// module holds no second copy of the matching rules (#71). The scan installs the
// real EffectiveScanPolicy via setGlobalScanPolicy(); callers that never ran a
// full scan get an equivalent policy derived from the loose globals below.
let _installedPolicy: EffectiveScanPolicy | undefined;
let _derivedPolicy: EffectiveScanPolicy | undefined;

/** Install the scan's EffectiveScanPolicy as the one the shared walkers use.
 *  Call after setGlobalIgnore/setGlobalIgnoreNames — those reset it. */
export function setGlobalScanPolicy(policy: EffectiveScanPolicy | undefined): void {
	_installedPolicy = policy;
	_derivedPolicy = undefined;
}

export function activeScanPolicy(): EffectiveScanPolicy {
	if (_installedPolicy) return _installedPolicy;
	_derivedPolicy ??= scanPolicyFromInputs({ ignore: _globalIgnore, ignoreNames: [..._globalIgnoreNames, ..._globalIgnoreSubpaths] });
	return _derivedPolicy;
}

let _globalIgnore: string[] | undefined;
export function setGlobalIgnore(patterns: string[] | undefined): void {
	_globalIgnore = patterns;
	setGlobalScanPolicy(undefined);
}

// Extra directory/file *names* to skip, matched per path segment exactly like
// the default exclusion policy (not globs). This is the channel the desktop monitor uses to push
// its user-configurable "Ignored paths" into the scan, so the watcher, the
// graphs, and the report all exclude the same folders. Populated from the
// VCQA_IGNORE env var (see readEnvIgnoreNames) or setGlobalIgnoreNames().
let _globalIgnoreNames: Set<string> = new Set();
let _globalIgnoreSubpaths: string[] = [];
export function setGlobalIgnoreNames(names: Iterable<string> | undefined): void {
	const all = [...(names ?? [])];
	// Bare names are matched per path segment (like the default exclusion policy); entries containing
	// a slash are matched as a slash-bounded sub-path against the relative path.
	_globalIgnoreNames = new Set(all.filter((n) => !n.includes("/")));
	_globalIgnoreSubpaths = all.filter((n) => n.includes("/")).map((n) => n.replace(/^\/+|\/+$/g, ""));
	setGlobalScanPolicy(undefined);
}

export { readEnvIgnoreNames, readGitIgnoreDirectoryNames } from "./scan-policy.js";

/**
 * Drop any root nested inside another root in the same list, and collapse exact
 * duplicates. Monorepo detection can emit overlapping roots (e.g. `app/src` plus
 * a catch-all `app`); without this, `app/src/**` would be walked once per root and
 * every file collected twice — making files look duplicated against themselves.
 */
function pruneNestedRoots(dirs: string[]): string[] {
	const seen = new Set<string>();
	const uniq = dirs
		.map((d) => d.replace(/\/+$/, ""))
		.filter((d) => {
			if (seen.has(d)) return false;
			seen.add(d);
			return true;
		});
	return uniq.filter((d) => !uniq.some((other) => other !== d && `${d}/`.startsWith(`${other}/`)));
}

/** Walk source directories and return all code files (deduplicated by absolute path). */
export function collectSourceFiles(cwd: string, opts?: { includeTests?: boolean; extraExts?: boolean; srcRoots?: string[] }): SourceFile[] {
	const files: SourceFile[] = [];
	const dirs = [...(opts?.srcRoots || _globalSrcRoots || DEFAULT_SRC_DIRS)];
	if (opts?.includeTests && !opts?.srcRoots && !_globalSrcRoots) dirs.push("test", "tests", "__tests__");
	// A single seen-set across all roots guarantees each file is collected once
	// even if the roots overlap or a symlink points back into the tree.
	const seen = new Set<string>();
	for (const dir of pruneNestedRoots(dirs)) {
		try {
			walk(join(cwd, dir), cwd, files, opts?.extraExts ? ALL_EXTS : CODE_EXTS, seen);
		} catch {
			/* dir doesn't exist */
		}
	}
	return files;
}

/** Get only production source files (no tests). */
export function getProductionFiles(cwd: string, srcRoots?: string[]): SourceFile[] {
	return collectSourceFiles(cwd, { srcRoots }).filter((f) => !f.isTest);
}

/** Get only test files. */
export function getTestFiles(cwd: string): SourceFile[] {
	return collectSourceFiles(cwd).filter((f) => f.isTest);
}

/** Read a file relative to cwd, return empty string on error. */
export function readSafe(cwd: string, path: string): string {
	try {
		return readFileSync(join(cwd, path), "utf-8");
	} catch {
		return "";
	}
}

/** Parse package.json dependencies. */
export function readDeps(cwd: string): Record<string, string> {
	const pkg = readSafe(cwd, "package.json");
	if (!pkg) return {};
	try {
		const parsed = JSON.parse(pkg);
		return { ...parsed.dependencies, ...parsed.devDependencies };
	} catch {
		return {};
	}
}

/** Walk from cwd root (not just src/) — for checks like secrets that scan all project files. */
export function collectAllFiles(cwd: string, opts?: { extraExts?: boolean }): SourceFile[] {
	const files: SourceFile[] = [];
	walk(cwd, cwd, files, opts?.extraExts ? ALL_EXTS : CODE_EXTS, new Set());
	return files;
}

/** Extract <script> content from Vue/Svelte SFC files. Returns all script blocks concatenated. */
function extractScript(content: string): string {
	const scripts: string[] = [];
	// Match <script ...> ... </script> blocks (including <script setup>, <script lang="ts">)
	for (const match of content.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)) {
		if (match[1]) scripts.push(match[1]);
	}
	return scripts.length > 0 ? scripts.join("\n") : content;
}

/** Whether a path (relative to the scan root) is excluded by the active scan
 *  policy — the same decision, from the same engine, that the file walker
 *  applies. External tools (biome, tsc, eslint, gitleaks) scan the filesystem
 *  directly and don't know our ignore, so a runner filters the paths they report
 *  through this to stay consistent with the walk.
 *
 *  Security-sensitive files that are only ignored by project/user config are NOT
 *  reported as ignored here: the policy's security override keeps them visible to
 *  narrow security checks (see docs/exclusion-policy.md). */
export function isIgnoredPath(relPath: string): boolean {
	return evaluatePath(activeScanPolicy(), relPath).excluded;
}

/** Normalize a file path emitted by an external tool into a repo-root-relative
 *  path. Tool output is usually relative to the tool cwd, which is often a
 *  workspace package rather than the scan root. */
export function normalizeToolPath(cwd: string, toolCwd: string, rawPath: string): string {
	const clean = rawPath.replace(/\\/g, "/").trim();
	if (!clean) return clean;
	const absolute = isAbsolute(clean) ? clean : resolve(toolCwd, clean);
	const rel = relative(cwd, absolute).replace(/\\/g, "/");
	if (!rel || rel === ".") return clean;
	if (rel.startsWith("../") || rel === "..") return clean;
	return rel;
}

function walk(dir: string, cwd: string, out: SourceFile[], exts: Set<string>, seen: Set<string>): void {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return; // directory doesn't exist, permission denied, or broken symlink
	}
	for (const entry of entries) {
		walkEntry(dir, entry, cwd, out, exts, seen);
	}
}

function walkEntry(dir: string, entry: string, cwd: string, out: SourceFile[], exts: Set<string>, seen: Set<string>): void {
	const full = join(dir, entry);
	const relPath = full.replace(`${cwd}/`, "");
	// One engine decides. A path the policy excludes is never walked and never
	// collected, whichever rule matched it.
	if (evaluatePath(activeScanPolicy(), relPath).excluded) return;
	try {
		// Skip symlinks to prevent traversal attacks (H3)
		if (lstatSync(full).isSymbolicLink()) return;
		const stat = statSync(full);
		if (stat.isDirectory()) {
			walk(full, cwd, out, exts, seen);
			return;
		}
		pushSourceFile(entry, full, relPath, stat.size, out, exts, seen);
	} catch {
		/* broken symlink, deleted file, or permission denied */
	}
}

function pushSourceFile(
	entry: string,
	full: string,
	relPath: string,
	size: number,
	out: SourceFile[],
	exts: Set<string>,
	seen: Set<string>,
): void {
	const ext = extname(entry);
	if (!exts.has(ext) || size > 1_000_000 || seen.has(full)) return;
	seen.add(full);
	const fileContent = readFileSync(full, "utf-8");
	const isSFC = ext === ".vue" || ext === ".svelte";
	// For SFCs, extract <script> block for logic analysis; keep raw for template checks
	const content = isSFC ? extractScript(fileContent) : fileContent;
	const rawContent = isSFC ? fileContent : undefined;
	out.push({
		path: relPath,
		fullPath: full,
		base: basename(entry, ext),
		ext,
		content,
		rawContent,
		lines: content.split("\n").length,
		isTest: isTestPath(entry, relPath),
	});
}

function isTestPath(entry: string, relPath: string): boolean {
	return (
		entry.includes(".test.") ||
		entry.includes(".spec.") ||
		entry.endsWith("_test.dart") ||
		relPath.includes("__tests__/") ||
		relPath.includes("/test/") ||
		relPath.startsWith("test/") ||
		relPath.includes("/tests/") ||
		relPath.startsWith("tests/")
	);
}
