/** Context Locality — measures how self-contained code is for LLM consumption.
 *
 * Research backing:
 * - "Lost in the Middle" (Liu et al. 2023): 30%+ accuracy drop for mid-context info
 * - "Context Rot" (Chroma 2025): all frontier models degrade with input length
 * - "Codified Context" (Vassilev 2025): 108K-line codebase needs 24.2% context overhead
 *
 * Sub-checks:
 *   1. Import depth — how many files does each file transitively depend on?
 *   2. Token density — estimated tokens per file (high = expensive for LLM context)
 *   3. File self-containment — ratio of local symbols to imported symbols
 *   4. Circular dependencies — import cycles that confuse navigation
 */

import { getProductionFiles } from "../fs-utils.js";
import type { CheckResult, Issue } from "../types.js";
import { gradeFromScore } from "../types.js";

const MAX_FILE_TOKENS = 4000; // ~400 lines; beyond this LLMs lose mid-context info
const MAX_IMPORTS = 15; // files importing >15 modules are hard to reason about
const CHARS_PER_TOKEN = 3.5; // empirical average for code

export function runContext(cwd: string): CheckResult {
	const start = Date.now();
	const issues: Issue[] = [];

	// Collect source files with imports
	const sourceFiles = getProductionFiles(cwd);
	const files = sourceFiles.map((sf) => ({
		path: sf.path,
		content: sf.content,
		imports: parseImports(sf.content),
		tokens: Math.round(sf.content.length / CHARS_PER_TOKEN),
	}));

	if (files.length === 0) {
		return {
			name: "context",
			score: 100,
			grade: "A",
			details: { skipped: true, reason: "no source files" },
			issues: [],
			duration: Date.now() - start,
		};
	}

	let highTokenFiles = 0;
	let heavyImportFiles = 0;
	let circularDeps = 0;
	let totalImports = 0;
	let totalTokens = 0;

	// ── 1. Token density per file ──
	for (const f of files) {
		totalTokens += f.tokens;
		if (f.tokens > MAX_FILE_TOKENS) {
			highTokenFiles++;
			issues.push({
				severity: "warning",
				message: `~${f.tokens} tokens (>${MAX_FILE_TOKENS}) — large context cost for LLMs`,
				file: f.path,
				rule: "high-token-count",
			});
		}
	}

	// ── 2. Import count per file ──
	for (const f of files) {
		totalImports += f.imports.length;
		if (f.imports.length > MAX_IMPORTS) {
			heavyImportFiles++;
			issues.push({
				severity: "warning",
				message: `${f.imports.length} imports (>${MAX_IMPORTS}) — consider splitting or co-locating`,
				file: f.path,
				rule: "heavy-imports",
			});
		}
	}

	// ── 3. Circular dependency detection ──
	const importGraph = new Map<string, Set<string>>();
	for (const f of files) {
		const deps = new Set<string>();
		for (const imp of f.imports) {
			// Resolve relative import to file path
			const resolved = resolveImport(f.path, imp);
			if (resolved && files.some((ff) => ff.path === resolved)) {
				deps.add(resolved);
			}
		}
		importGraph.set(f.path, deps);
	}

	const cycles = findCycles(importGraph);
	circularDeps = cycles.length;
	for (const cycle of cycles.slice(0, 5)) {
		issues.push({ severity: "error", message: `Circular dependency: ${cycle.join(" → ")}`, rule: "circular-dependency" });
	}
	if (cycles.length > 5) {
		issues.push({ severity: "error", message: `...and ${cycles.length - 5} more circular dependencies`, rule: "circular-dependency" });
	}

	// ── 4. Self-containment heuristic ──
	// Files with many imports and few exports are "context sinks" — hard to understand in isolation
	let contextSinks = 0;
	for (const f of files) {
		const exportCount = (f.content.match(/\bexport\s+/g) || []).length;
		if (f.imports.length > 8 && exportCount <= 1) {
			contextSinks++;
			issues.push({
				severity: "warning",
				message: `${f.imports.length} imports but only ${exportCount} export — hard to understand in isolation`,
				file: f.path,
				rule: "context-sink",
			});
		}
	}

	// ── Score ──
	const avgImports = files.length > 0 ? totalImports / files.length : 0;
	const avgTokens = files.length > 0 ? totalTokens / files.length : 0;
	// Proportional scoring — penalize based on percentage of problematic files
	const totalFiles = files.length || 1;
	const highTokenPct = (highTokenFiles / totalFiles) * 100;
	const heavyImportPct = (heavyImportFiles / totalFiles) * 100;
	const penalty = highTokenPct * 1.5 + heavyImportPct * 1 + Math.min(circularDeps, 5) * 8 + contextSinks * 3;
	const score = Math.max(0, Math.min(100, Math.round(100 - penalty)));

	return {
		name: "context",
		score,
		grade: gradeFromScore(score),
		details: {
			filesScanned: files.length,
			totalTokens,
			avgTokensPerFile: Math.round(avgTokens),
			avgImportsPerFile: Math.round(avgImports * 10) / 10,
			highTokenFiles,
			heavyImportFiles,
			circularDeps,
			contextSinks,
		},
		issues,
		duration: Date.now() - start,
	};
}

// ── Import parsing ──

function parseImports(content: string): string[] {
	const imports: string[] = [];
	const regex = /import\s+(?:[\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;
	for (const match of content.matchAll(regex)) {
		const path = match[1];
		// Only count local imports (starting with . or /)
		if (path.startsWith(".") || path.startsWith("/")) {
			imports.push(path);
		}
	}
	return imports;
}

function resolveImport(fromPath: string, importPath: string): string | null {
	// Simple resolution: join directory of fromPath with importPath
	const dir = fromPath.includes("/") ? fromPath.replace(/\/[^/]+$/, "") : "";
	let resolved = importPath;
	if (importPath.startsWith("./")) {
		resolved = dir ? `${dir}/${importPath.slice(2)}` : importPath.slice(2);
	} else if (importPath.startsWith("../")) {
		const parts = dir.split("/");
		parts.pop();
		resolved = [...parts, importPath.slice(3)].join("/");
	}
	// Strip known extension if present, then default to .ts
	resolved = resolved.replace(/\.(js|ts|tsx|jsx)$/, "");
	return `${resolved}.ts`;
}

// ── Cycle detection (DFS) ──

function findCycles(graph: Map<string, Set<string>>): string[][] {
	const cycles: string[][] = [];
	const visited = new Set<string>();
	const inStack = new Set<string>();
	const path: string[] = [];

	function dfs(node: string): void {
		if (inStack.has(node)) {
			// Found cycle — extract it
			const cycleStart = path.indexOf(node);
			if (cycleStart >= 0) {
				cycles.push([...path.slice(cycleStart), node]);
			}
			return;
		}
		if (visited.has(node)) return;

		visited.add(node);
		inStack.add(node);
		path.push(node);

		const deps = graph.get(node);
		if (deps) {
			for (const dep of deps) {
				dfs(dep);
			}
		}

		path.pop();
		inStack.delete(node);
	}

	for (const node of graph.keys()) {
		dfs(node);
	}

	return cycles;
}
