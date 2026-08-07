/** Shared filesystem utilities — eliminates duplicate file-walking across runners. */

import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import defaultExclusions from "./data/default-exclusions.json" with { type: "json" };
import { discoveryConventions } from "./discovery-conventions.js";

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

const DEFAULT_EXCLUDED_DIR_NAMES = new Set(defaultExclusions.directoryNames);
const DEFAULT_EXCLUDED_FILE_PATTERNS = defaultExclusions.filePatterns;
const DEFAULT_EXCLUDED_PATH_PREFIXES = defaultExclusions.generatedPathPrefixes;
const IGNORE_HIDDEN_DIRECTORIES = Boolean(defaultExclusions.ignoreHiddenDirectories);
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

let _globalIgnore: string[] | undefined;
export function setGlobalIgnore(patterns: string[] | undefined): void {
	_globalIgnore = patterns;
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
}
function matchesIgnoreSubpath(relPath: string): boolean {
	if (_globalIgnoreSubpaths.length === 0) return false;
	const bounded = `/${relPath}/`;
	return _globalIgnoreSubpaths.some((sp) => bounded.includes(`/${sp}/`));
}
/** Parse VCQA_IGNORE (comma/newline/whitespace separated segment names). */
export function readEnvIgnoreNames(env: string | undefined): string[] {
	if (!env) return [];
	return [
		...new Set(
			env
				.split(/[\s,]+/)
				.map((s) => s.trim())
				.filter(Boolean),
		),
	];
}

/** Read directory entries from the repo's .gitignore. File ignores are not
 *  merged globally because security checks may still need to inspect ignored
 *  secret files such as .env. */
export function readGitIgnoreDirectoryNames(cwd: string): string[] {
	let raw: string;
	try {
		raw = readFileSync(join(cwd, ".gitignore"), "utf-8");
	} catch {
		return [];
	}
	const names = raw
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith("#") && !line.startsWith("!"))
		.filter((line) => line.endsWith("/"))
		.map((line) => line.replace(/^\/+|\/+$/g, ""))
		.filter(Boolean);
	return [...new Set(names)];
}

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

function shouldIgnore(relPath: string): boolean {
	if (!_globalIgnore) return false;
	return _globalIgnore.some((pattern) => {
		// Simple glob: "generated/**" matches "generated/foo.ts"
		// "*.generated.ts" matches "foo.generated.ts"
		if (pattern.endsWith("/**")) {
			const prefix = pattern.slice(0, -3);
			return relPath.startsWith(`${prefix}/`) || relPath === prefix;
		}
		if (pattern.startsWith("*")) {
			return relPath.endsWith(pattern.slice(1));
		}
		return relPath.startsWith(pattern);
	});
}

/** Whether a path (relative to the scan root) is excluded by the active ignore
 *  config — the same rules the file walker applies. External tools (biome, tsc,
 *  eslint) scan the filesystem directly and don't know our ignore, so a runner
 *  filters the paths they report through this to stay consistent with the walk. */
export function isIgnoredPath(relPath: string): boolean {
	if (shouldIgnore(relPath) || matchesIgnoreSubpath(relPath) || matchesDefaultPathPrefix(relPath) || matchesDefaultFilePattern(relPath))
		return true;
	// A segment is ignored if it's a default exclusion, a configured ignore name, or
	// matches the explicit hidden-directory mode from the default policy. The walker
	// uses the same rule so external tools like Biome do not score files the rest of
	// the scan never saw.
	return relPath.split("/").some((seg) => {
		if (seg === "." || seg === "..") return false;
		return (IGNORE_HIDDEN_DIRECTORIES && seg.startsWith(".")) || DEFAULT_EXCLUDED_DIR_NAMES.has(seg) || _globalIgnoreNames.has(seg);
	});
}

function matchesDefaultPathPrefix(relPath: string): boolean {
	const clean = relPath.replace(/^\/+|\/+$/g, "");
	return DEFAULT_EXCLUDED_PATH_PREFIXES.some((prefix) => clean === prefix || clean.startsWith(`${prefix}/`));
}

function matchesDefaultFilePattern(relPath: string): boolean {
	const fileName = basename(relPath);
	return DEFAULT_EXCLUDED_FILE_PATTERNS.some((pattern) => matchesPathPattern(relPath, fileName, pattern));
}

function matchesPathPattern(relPath: string, fileName: string, pattern: string): boolean {
	if (pattern.startsWith("*.") || pattern.startsWith("*")) return fileName.endsWith(pattern.slice(1));
	if (pattern.endsWith("*")) return fileName.startsWith(pattern.slice(0, -1));
	const star = pattern.indexOf("*");
	if (star >= 0) {
		const before = pattern.slice(0, star);
		const after = pattern.slice(star + 1);
		return fileName.startsWith(before) && fileName.endsWith(after);
	}
	return relPath === pattern || fileName === pattern;
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
	if (shouldSkipEntryName(entry)) return;
	const full = join(dir, entry);
	const relPath = full.replace(`${cwd}/`, "");
	if (shouldIgnore(relPath) || matchesIgnoreSubpath(relPath) || matchesDefaultPathPrefix(relPath) || matchesDefaultFilePattern(relPath))
		return;
	try {
		// Skip symlinks to prevent traversal attacks (H3)
		if (lstatSync(full).isSymbolicLink()) return;
		const stat = statSync(full);
		if (stat.isDirectory()) {
			if (!shouldSkipDirectoryName(entry)) walk(full, cwd, out, exts, seen);
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

function shouldSkipEntryName(entry: string): boolean {
	return DEFAULT_EXCLUDED_DIR_NAMES.has(entry) || _globalIgnoreNames.has(entry);
}

function shouldSkipDirectoryName(entry: string): boolean {
	return IGNORE_HIDDEN_DIRECTORIES && entry.startsWith(".");
}
