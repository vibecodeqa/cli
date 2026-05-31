/** Shared filesystem utilities — eliminates duplicate file-walking across runners. */

import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";

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

const SKIP_DIRS = new Set([
	"node_modules",
	"dist",
	".git",
	".vibe-check",
	"coverage",
	"test-results",
	"__pycache__",
	".dart_tool",
	"build",
	".flutter-plugins",
	".next",
	".nuxt",
	".output",
	"vendor",
	"third_party",
]);
const CODE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".dart", ".vue", ".svelte"]);
const ALL_EXTS = new Set([...CODE_EXTS, ".json", ".env", ".yaml", ".yml", ".toml"]);

/** Default source directories for single-package repos */
const DEFAULT_SRC_DIRS = ["src", "web/src", "lib", "app"];

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

/** Walk source directories and return all code files. */
export function collectSourceFiles(cwd: string, opts?: { includeTests?: boolean; extraExts?: boolean; srcRoots?: string[] }): SourceFile[] {
	const files: SourceFile[] = [];
	const dirs = [...(opts?.srcRoots || _globalSrcRoots || DEFAULT_SRC_DIRS)];
	if (opts?.includeTests && !opts?.srcRoots && !_globalSrcRoots) dirs.push("test", "tests", "__tests__");
	for (const dir of dirs) {
		try {
			walk(join(cwd, dir), cwd, files, opts?.extraExts ? ALL_EXTS : CODE_EXTS);
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
	walk(cwd, cwd, files, opts?.extraExts ? ALL_EXTS : CODE_EXTS);
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
			return relPath.startsWith(prefix + "/") || relPath === prefix;
		}
		if (pattern.startsWith("*")) {
			return relPath.endsWith(pattern.slice(1));
		}
		return relPath.startsWith(pattern);
	});
}

function walk(dir: string, cwd: string, out: SourceFile[], exts: Set<string>): void {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return; // directory doesn't exist, permission denied, or broken symlink
	}
	for (const entry of entries) {
		if (SKIP_DIRS.has(entry)) continue;
		const full = join(dir, entry);
		const relPath = full.replace(`${cwd}/`, "");
		if (shouldIgnore(relPath)) continue;
		try {
			// Skip symlinks to prevent traversal attacks (H3)
			if (lstatSync(full).isSymbolicLink()) continue;
			const stat = statSync(full);
			if (stat.isDirectory()) {
				walk(full, cwd, out, exts);
				continue;
			}
			const ext = extname(entry);
			if (!exts.has(ext)) continue;
			// Skip files over 1MB to prevent memory issues (M1)
			if (stat.size > 1_000_000) continue;
			const fileContent = readFileSync(full, "utf-8");
			const isSFC = ext === ".vue" || ext === ".svelte";
			// For SFCs, extract <script> block for logic analysis; keep raw for template checks
			const content = isSFC ? extractScript(fileContent) : fileContent;
			const rawContent = isSFC ? fileContent : undefined;
			const isTest =
				entry.includes(".test.") ||
				entry.includes(".spec.") ||
				entry.endsWith("_test.dart") ||
				relPath.includes("__tests__/") ||
				relPath.includes("/test/") ||
				relPath.startsWith("test/") ||
				relPath.includes("/tests/") ||
				relPath.startsWith("tests/");
			out.push({
				path: relPath,
				fullPath: full,
				base: basename(entry, ext),
				ext,
				content,
				rawContent,
				lines: content.split("\n").length,
				isTest,
			});
		} catch {
			continue; // broken symlink, deleted file, or permission denied
		}
	}
}
