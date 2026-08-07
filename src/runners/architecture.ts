/** Architecture analysis — import graph, circular deps, coupling metrics, god modules.
 *
 * Produces:
 *   1. Import graph (adjacency list)
 *   2. Circular dependency detection
 *   3. Fan-in / fan-out metrics per file (coupling)
 *   4. God modules (imported by >50% of files)
 *   5. Orphan files (not imported by anyone, not an entrypoint)
 *   6. Layer violations (optional: detect cross-layer imports)
 *   7. SVG architecture diagram
 */

import { existsSync } from "node:fs";
import { basename, dirname, extname } from "node:path";
import { cruise } from "dependency-cruiser";
import type { FileInventory } from "../file-inventory.js";
import { inventorySourceFiles } from "../file-inventory.js";
import { getProductionFiles, type SourceFile } from "../fs-utils.js";
import type { CheckResult, Issue, WorkspaceInfo } from "../types.js";
import { gradeFromScore } from "../types.js";
import { generateContainerDiagram } from "./diagrams.js";

interface ModuleNode {
	path: string;
	imports: string[]; // resolved relative paths
	importedBy: string[]; // reverse edges
	dir: string; // directory (for grouping)
	exports: number;
}

interface GraphBuild {
	nodes: Map<string, ModuleNode>;
	typeOnlyEdgesIgnored: number;
	dynamicEdgesIgnored: number;
	typeOnlyNodes: Map<string, ModuleNode>;
	dynamicNodes: Map<string, ModuleNode>;
}

export interface ArchGraph {
	nodes: Map<string, ModuleNode>;
	cycles: string[][];
	godModules: string[];
	orphans: string[];
}

export async function runArchitecture(cwd: string, workspace?: WorkspaceInfo, inventory?: FileInventory): Promise<CheckResult> {
	const start = Date.now();
	const issues: Issue[] = [];
	const files = inventory ? inventorySourceFiles(inventory) : getProductionFiles(cwd);

	if (files.length < 2) {
		return {
			name: "architecture",
			score: 100,
			grade: "A",
			details: { skipped: true, reason: "fewer than 2 source files", source: inventory ? "file-inventory" : "legacy-walk" },
			issues: [],
			duration: Date.now() - start,
		};
	}

	// Prefer dependency-cruiser (real module resolution incl. tsconfig paths) and
	// fall back to the built-in resolver when it can't cover the project (e.g. SFC-
	// heavy or monorepos where cross-package imports use bare specifiers).
	const cruised = await buildGraphViaCruise(cwd, files);
	const graph = cruised ?? buildGraph(files);
	const tool = cruised ? "dependency-cruiser" : "built-in";

	// ── Circular dependencies ──
	const cycles = findCycles(graph.nodes);
	const typeOnlyCycles = findCycles(graph.typeOnlyNodes);
	const dynamicCycles = findCycles(graph.dynamicNodes);
	for (const cycle of cycles.slice(0, 5)) {
		issues.push({
			severity: "error",
			message: `Static runtime circular dependency: ${cycle.map(short).join(" \u2192 ")}`,
			file: cycle[0],
			rule: "circular-dep",
		});
	}
	if (cycles.length > 5) {
		issues.push({ severity: "error", message: `...and ${cycles.length - 5} more cycles`, rule: "circular-dep" });
	}
	for (const cycle of typeOnlyCycles.slice(0, 3)) {
		issues.push({
			severity: "info",
			message: `Type-only dependency cycle ignored for runtime scoring: ${cycle.map(short).join(" \u2192 ")}`,
			file: cycle[0],
			rule: "type-only-cycle",
		});
	}
	for (const cycle of dynamicCycles.slice(0, 3)) {
		issues.push({
			severity: "info",
			message: `Deferred dynamic import cycle ignored for runtime scoring: ${cycle.map(short).join(" \u2192 ")}`,
			file: cycle[0],
			rule: "dynamic-import-cycle",
		});
	}

	// ── God modules (imported by >50% of files) ──
	const threshold = Math.max(3, Math.floor(files.length * 0.5));
	const godModules: string[] = [];
	for (const [path, node] of graph.nodes) {
		if (node.importedBy.length >= threshold) {
			godModules.push(path);
			issues.push({
				severity: "warning",
				message: `God module: imported by ${node.importedBy.length}/${files.length} files — consider splitting`,
				file: path,
				rule: "god-module",
			});
		}
	}

	// ── Orphan files (not imported by anyone) ──
	// Skip in monorepos — cross-package imports use package names (not relative paths)
	// so the graph is incomplete and would produce many false positives.
	const entrypoints = new Set([
		"index.ts",
		"index.tsx",
		"index.js",
		"index.jsx",
		"main.ts",
		"main.tsx",
		"main.js",
		"main.dart",
		"cli.ts",
		"cli.js",
		"App.tsx",
		"App.ts",
		"App.vue",
		"App.svelte",
		"app.ts",
		"app.tsx",
		"app.dart",
		"+page.svelte",
		"+layout.svelte",
		"+server.ts",
		"page.tsx",
		"layout.tsx",
	]);
	const orphans: string[] = [];
	if (!workspace?.isMonorepo) {
		for (const [path, node] of graph.nodes) {
			const isEntry = entrypoints.has(basename(path));
			if (node.importedBy.length === 0 && !isEntry) {
				orphans.push(path);
				issues.push({ severity: "warning", message: `Orphan: not imported by any file (dead module?)`, file: path, rule: "orphan-module" });
			}
		}
	}

	// ── High fan-out (file imports too many modules) ──
	let highFanOut = 0;
	for (const [path, node] of graph.nodes) {
		if (node.imports.length > 10) {
			highFanOut++;
			issues.push({
				severity: "warning",
				message: `High fan-out: imports ${node.imports.length} modules — hard to test in isolation`,
				file: path,
				rule: "high-fan-out",
			});
		}
	}

	// ── High fan-in + fan-out (connector files) ──
	let connectors = 0;
	for (const [path, node] of graph.nodes) {
		if (node.imports.length > 5 && node.importedBy.length > 5) {
			connectors++;
			issues.push({
				severity: "warning",
				message: `Connector: ${node.imports.length} imports, ${node.importedBy.length} importers — high coupling`,
				file: path,
				rule: "connector-module",
			});
		}
	}

	// ── Score ── proportional to module count
	const totalModules = graph.nodes.size || 1;
	const cyclePenalty = Math.min(30, cycles.length * Math.max(5, 30 / Math.sqrt(totalModules)));
	const godPenalty = Math.min(15, (godModules.length / totalModules) * 100);
	const orphanPenalty = Math.min(10, (orphans.length / totalModules) * 50);
	const fanOutPenalty = Math.min(15, (highFanOut / totalModules) * 80);
	const connectorPenalty = Math.min(10, (connectors / totalModules) * 60);
	const score = Math.max(0, Math.min(100, Math.round(100 - cyclePenalty - godPenalty - orphanPenalty - fanOutPenalty - connectorPenalty)));

	// ── Build details with graph data for visualization ──
	const graphData: Record<string, { imports: string[]; importedBy: string[]; dir: string }> = {};
	for (const [path, node] of graph.nodes) {
		graphData[path] = { imports: node.imports, importedBy: node.importedBy, dir: node.dir };
	}

	// ── Architecture Assessment ──
	const assessment = assessArchitecture(graph.nodes, files.length);

	return {
		name: "architecture",
		score,
		grade: gradeFromScore(score),
		details: {
			totalModules: graph.nodes.size,
			circularDeps: cycles.length,
			typeOnlyCycles: typeOnlyCycles.length,
			dynamicCycles: dynamicCycles.length,
			godModules: godModules.length,
			orphans: orphans.length,
			highFanOut,
			connectors,
			graph: graphData,
			containerSvg: generateContainerDiagram(cwd),
			assessment,
			tool,
			source: inventory ? "file-inventory" : "legacy-walk",
			typeOnlyEdgesIgnored: graph.typeOnlyEdgesIgnored,
			dynamicEdgesIgnored: graph.dynamicEdgesIgnored,
		},
		issues,
		duration: Date.now() - start,
	};
}

// ── Graph building ──

/** Build the import graph with dependency-cruiser (real module resolution,
 *  tsconfig path aliases, transitive TS deps). Returns null — so the caller
 *  falls back to the built-in resolver — if it errors or covers too little of
 *  the project (e.g. .vue/.svelte SFCs it can't resolve, or monorepo bare imports). */
async function buildGraphViaCruise(cwd: string, files: SourceFile[]): Promise<GraphBuild | null> {
	// .vue/.svelte single-file components need our SFC-aware resolver; dependency-cruiser
	// doesn't resolve them without a bundler plugin, so hand those projects to the built-in.
	if (files.some((f) => f.ext === ".vue" || f.ext === ".svelte")) return null;

	const fileSet = new Set(files.map((f) => f.path));
	const roots = [...new Set(files.map((f) => f.path.split("/")[0]).filter(Boolean))];
	if (roots.length === 0) return null;

	const prevCwd = process.cwd();
	try {
		process.chdir(cwd); // dependency-cruiser resolves relative to process.cwd()
		const options: Parameters<typeof cruise>[1] = {
			doNotFollow: { path: "node_modules" },
			exclude: { path: "(\\.test\\.|\\.spec\\.|/node_modules/|/dist/|/\\.vibe-check/)" },
			tsPreCompilationDeps: true,
		};
		if (existsSync("tsconfig.json")) options.tsConfig = { fileName: "tsconfig.json" };

		const result = await cruise(roots, options);
		const output = result.output;
		if (typeof output === "string") return null;
		const modules = output.modules ?? [];

		const nodes = new Map<string, ModuleNode>();
		const typeOnlyNodes = emptyGraphNodes(files);
		const dynamicNodes = emptyGraphNodes(files);
		let typeOnlyEdgesIgnored = 0;
		let dynamicEdgesIgnored = 0;
		for (const m of modules) {
			if (fileSet.has(m.source)) {
				nodes.set(m.source, { path: m.source, imports: [], importedBy: [], dir: dirname(m.source), exports: 0 });
			}
		}
		for (const m of modules) {
			const node = nodes.get(m.source);
			if (!node) continue;
			const seen = new Set<string>();
			for (const d of m.dependencies ?? []) {
				if (d.coreModule || !d.resolved || d.resolved === m.source) continue;
				if (!fileSet.has(d.resolved) || seen.has(d.resolved)) continue;
				const depTypes = d.dependencyTypes ?? [];
				if (d.typeOnly || depTypes.includes("type-only") || depTypes.includes("type-import")) {
					typeOnlyEdgesIgnored++;
					addGraphEdge(typeOnlyNodes, m.source, d.resolved);
					continue;
				}
				if (d.dynamic || depTypes.includes("dynamic-import")) {
					dynamicEdgesIgnored++;
					addGraphEdge(dynamicNodes, m.source, d.resolved);
					continue;
				}
				seen.add(d.resolved);
				node.imports.push(d.resolved);
				addGraphEdge(typeOnlyNodes, m.source, d.resolved);
				addGraphEdge(dynamicNodes, m.source, d.resolved);
			}
		}
		for (const [path, node] of nodes) {
			for (const imp of node.imports) nodes.get(imp)?.importedBy.push(path);
		}

		// Too little coverage → the built-in resolver is a better bet for this project.
		if (nodes.size < files.length * 0.5) return null;
		return { nodes, typeOnlyEdgesIgnored, dynamicEdgesIgnored, typeOnlyNodes, dynamicNodes };
	} catch {
		return null;
	} finally {
		process.chdir(prevCwd);
	}
}

function buildGraph(files: SourceFile[]): GraphBuild {
	const filePaths = new Set(files.map((f) => f.path));
	const nodes = new Map<string, ModuleNode>();
	const typeOnlyNodes = emptyGraphNodes(files);
	const dynamicNodes = emptyGraphNodes(files);
	let typeOnlyEdgesIgnored = 0;
	let dynamicEdgesIgnored = 0;

	// Initialize nodes
	for (const f of files) {
		nodes.set(f.path, {
			path: f.path,
			imports: [],
			importedBy: [],
			dir: dirname(f.path),
			exports: (f.content.match(/\bexport\s+/g) || []).length,
		});
	}

	// Parse imports and build edges
	for (const f of files) {
		const parsed = parseImports(f.content);
		typeOnlyEdgesIgnored += parsed.typeOnlyEdgesIgnored;
		dynamicEdgesIgnored += parsed.dynamicEdgesIgnored;
		const node = nodes.get(f.path)!;

		for (const imp of parsed.imports) {
			const resolved = resolveImport(f.path, imp, filePaths);
			if (resolved && resolved !== f.path) {
				node.imports.push(resolved);
				const target = nodes.get(resolved);
				if (target) target.importedBy.push(f.path);
				addGraphEdge(typeOnlyNodes, f.path, resolved);
				addGraphEdge(dynamicNodes, f.path, resolved);
			}
		}
		for (const imp of parsed.typeOnlyImports) {
			const resolved = resolveImport(f.path, imp, filePaths);
			if (resolved && resolved !== f.path) {
				addGraphEdge(typeOnlyNodes, f.path, resolved);
			}
		}
		for (const imp of parsed.dynamicImports) {
			const resolved = resolveImport(f.path, imp, filePaths);
			if (resolved && resolved !== f.path) {
				addGraphEdge(dynamicNodes, f.path, resolved);
			}
		}
	}

	return { nodes, typeOnlyEdgesIgnored, dynamicEdgesIgnored, typeOnlyNodes, dynamicNodes };
}

function emptyGraphNodes(files: SourceFile[]): Map<string, ModuleNode> {
	const nodes = new Map<string, ModuleNode>();
	for (const f of files) {
		nodes.set(f.path, {
			path: f.path,
			imports: [],
			importedBy: [],
			dir: dirname(f.path),
			exports: (f.content.match(/\bexport\s+/g) || []).length,
		});
	}
	return nodes;
}

function addGraphEdge(nodes: Map<string, ModuleNode>, from: string, to: string): void {
	const source = nodes.get(from);
	const target = nodes.get(to);
	if (!source || !target || source.imports.includes(to)) return;
	source.imports.push(to);
	target.importedBy.push(from);
}

function parseImports(content: string): {
	imports: string[];
	typeOnlyImports: string[];
	dynamicImports: string[];
	typeOnlyEdgesIgnored: number;
	dynamicEdgesIgnored: number;
} {
	const imports: string[] = [];
	const typeOnlyImports: string[] = [];
	const dynamicImports: string[] = [];
	let typeOnlyEdgesIgnored = 0;
	let dynamicEdgesIgnored = 0;
	// Match both imports and re-exports (export { ... } from '...')
	const regex = /\b(import|export)\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;
	for (const match of content.matchAll(regex)) {
		const clause = match[2].trim();
		const specifier = match[3];
		if (!specifier.startsWith(".")) continue;
		if (clause === "type" || clause.startsWith("type ")) {
			typeOnlyEdgesIgnored++;
			typeOnlyImports.push(specifier);
			continue;
		}
		imports.push(specifier);
	}
	for (const match of content.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
		const specifier = match[1];
		if (!specifier.startsWith(".")) continue;
		dynamicEdgesIgnored++;
		dynamicImports.push(specifier);
	}
	return { imports, typeOnlyImports, dynamicImports, typeOnlyEdgesIgnored, dynamicEdgesIgnored };
}

function resolveImport(fromPath: string, importPath: string, knownFiles: Set<string>): string | null {
	const fromDir = dirname(fromPath);
	let resolved = importPath;

	if (importPath.startsWith("./")) {
		resolved = fromDir ? `${fromDir}/${importPath.slice(2)}` : importPath.slice(2);
	} else if (importPath.startsWith("../")) {
		const parts = fromDir.split("/");
		let imp = importPath;
		while (imp.startsWith("../")) {
			parts.pop();
			imp = imp.slice(3);
		}
		resolved = [...parts, imp].filter(Boolean).join("/");
	}

	// Strip known extensions
	resolved = resolved.replace(/\.(js|ts|tsx|jsx|vue|svelte)$/, "");

	// Try known extensions (including SFC)
	for (const ext of [".ts", ".tsx", ".js", ".jsx", ".vue", ".svelte"]) {
		if (knownFiles.has(resolved + ext)) return resolved + ext;
	}
	// Try index files
	for (const ext of [".ts", ".tsx"]) {
		if (knownFiles.has(`${resolved}/index${ext}`)) return `${resolved}/index${ext}`;
	}
	return null;
}

// ── Cycle detection (DFS with path tracking) ──

function findCycles(nodes: Map<string, ModuleNode>): string[][] {
	const cycles: string[][] = [];
	const visited = new Set<string>();
	const inStack = new Set<string>();
	const path: string[] = [];
	const seen = new Set<string>(); // dedup cycles

	function dfs(node: string): void {
		if (inStack.has(node)) {
			const cycleStart = path.indexOf(node);
			if (cycleStart >= 0) {
				const cycle = path.slice(cycleStart);
				const key = cycle.map(short).sort().join(",");
				if (!seen.has(key)) {
					seen.add(key);
					cycles.push([...cycle, node]); // full paths
				}
			}
			return;
		}
		if (visited.has(node)) return;

		visited.add(node);
		inStack.add(node);
		path.push(node);

		const n = nodes.get(node);
		if (n) {
			for (const dep of n.imports) {
				dfs(dep);
			}
		}

		path.pop();
		inStack.delete(node);
	}

	for (const node of nodes.keys()) {
		dfs(node);
	}

	return cycles;
}

function short(path: string): string {
	return basename(path, extname(path));
}

// ── Architecture Assessment ─────────────────────────────────────────
// Categorizes the architecture pattern and rates its quality.

interface ArchAssessment {
	pattern: string;
	patternDescription: string;
	layering: "clean" | "mixed" | "tangled";
	stability: { package: string; instability: number; role: string }[];
	crossCoupling: number; // % of edges that cross directory boundaries
	cohesion: number; // average internal cohesion across directories
	rating: "excellent" | "good" | "fair" | "poor";
	insights: string[];
}

function assessArchitecture(nodes: Map<string, ModuleNode>, fileCount: number): ArchAssessment {
	// Group by directory
	const dirs = new Map<string, ModuleNode[]>();
	for (const [, node] of nodes) {
		const dir = node.dir || ".";
		const arr = dirs.get(dir) || [];
		arr.push(node);
		dirs.set(dir, arr);
	}

	// Detect pattern
	let pattern = "flat";
	let patternDescription = "All files in one directory — no clear separation of concerns.";
	const dirCount = dirs.size;
	const hasRunners = [...dirs.keys()].some((d) => d.includes("runner") || d.includes("plugin") || d.includes("check"));
	const hasReport = [...dirs.keys()].some((d) => d.includes("report") || d.includes("output") || d.includes("view"));
	if (hasRunners && dirCount >= 3) {
		pattern = "plugin";
		patternDescription = "Plugin architecture — core defines interfaces, plugins implement independently.";
	} else if (dirCount >= 4 && hasReport) {
		pattern = "layered";
		patternDescription = "Layered architecture — clear separation between input, processing, and output.";
	} else if (dirCount >= 3) {
		pattern = "modular";
		patternDescription = "Modular architecture — code organized by feature/responsibility.";
	} else if (dirCount === 2) {
		pattern = "two-tier";
		patternDescription = "Two-tier — main code + one sub-package (e.g., src + lib).";
	}

	// Stability per directory (Robert Martin's instability metric)
	const stability: ArchAssessment["stability"] = [];
	for (const [dir, dirNodes] of dirs) {
		let ce = 0; // efferent (outgoing deps)
		let ca = 0; // afferent (incoming deps)
		for (const node of dirNodes) {
			ce += node.imports.length;
			ca += node.importedBy.length;
		}
		const instability = ce / Math.max(1, ce + ca);
		const role = instability > 0.7 ? "unstable (easy to change)" : instability < 0.3 ? "stable (hard to change)" : "balanced";
		stability.push({ package: dir, instability: Math.round(instability * 100) / 100, role });
	}

	// Cross-coupling: what % of imports cross directory boundaries?
	// Exclude imports TO stable core (types, utils) — those are expected in plugin arch.
	let totalEdges = 0;
	let crossEdges = 0;
	const stableDirs = stability.filter((s) => s.instability < 0.35).map((s) => s.package);
	for (const [, node] of nodes) {
		for (const imp of node.imports) {
			totalEdges++;
			const impNode = nodes.get(imp);
			if (impNode && impNode.dir !== node.dir) {
				// Importing FROM stable core is expected, don't count as coupling
				if (!stableDirs.includes(impNode.dir || ".")) {
					crossEdges++;
				}
			}
		}
	}
	const crossCoupling = totalEdges > 0 ? Math.round((crossEdges / totalEdges) * 100) : 0;

	// Cohesion: average % of internal edges per directory
	let totalCohesion = 0;
	let dirsCounted = 0;
	for (const [dir, dirNodes] of dirs) {
		if (dirNodes.length < 2) continue;
		let internal = 0;
		let total = 0;
		for (const node of dirNodes) {
			for (const imp of node.imports) {
				total++;
				const impNode = nodes.get(imp);
				if (impNode && impNode.dir === dir) internal++;
			}
		}
		if (total > 0) {
			totalCohesion += internal / total;
			dirsCounted++;
		}
	}
	const cohesion = dirsCounted > 0 ? Math.round((totalCohesion / dirsCounted) * 100) : 0;

	// Layering: check if dependencies flow in one direction
	// Violations = importing from peer/sibling packages (not from stable core)
	let violations = 0;
	for (const [, node] of nodes) {
		for (const imp of node.imports) {
			const impNode = nodes.get(imp);
			if (impNode && impNode.dir !== node.dir) {
				// Importing from stable core = fine
				if (stableDirs.includes(impNode.dir || ".")) continue;
				// Two unstable packages importing each other = violation
				const myStability = stability.find((s) => s.package === (node.dir || "."));
				const impStability = stability.find((s) => s.package === (impNode.dir || "."));
				if (myStability && impStability && myStability.instability > 0.5 && impStability.instability > 0.5) {
					violations++;
				}
			}
		}
	}
	const layering: ArchAssessment["layering"] = violations === 0 ? "clean" : violations < 5 ? "mixed" : "tangled";

	// Overall rating
	let rating: ArchAssessment["rating"] = "excellent";
	if (crossCoupling > 80 || layering === "tangled") rating = "poor";
	else if (crossCoupling > 60 || layering === "mixed") rating = "fair";
	else if (crossCoupling > 40 || cohesion < 20) rating = "good";

	// Generate insights
	const insights: string[] = [];
	if (pattern === "plugin") insights.push("Plugin pattern detected — runners are independent and interchangeable.");
	if (layering === "clean") insights.push("Clean layering — dependencies flow in one direction without violations.");
	if (crossCoupling < 40) insights.push(`Low cross-coupling (${crossCoupling}%) — packages are well-isolated.`);
	else insights.push(`High cross-coupling (${crossCoupling}%) — packages depend heavily on each other.`);
	if (stability.some((s) => s.instability < 0.3)) insights.push("Stable foundation detected — core modules rarely change.");
	const godCount = [...nodes.values()].filter((n) => n.importedBy.length > fileCount * 0.5).length;
	if (godCount === 0) insights.push("No god modules — healthy dependency distribution.");
	else insights.push(`${godCount} god module(s) — consider splitting into focused interfaces.`);

	return { pattern, patternDescription, layering, stability, crossCoupling, cohesion, rating, insights };
}

// Diagram generators extracted to diagrams.ts for file size
export { generateArchSVG, generateDSM, generateLayerDiagram, generatePackageDiagram, generateSequenceDiagram } from "./diagrams.js";
