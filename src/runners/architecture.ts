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

import { basename, dirname, extname } from "node:path";
import { getProductionFiles, type SourceFile } from "../fs-utils.js";
import type { CheckResult, Issue } from "../types.js";
import { gradeFromScore } from "../types.js";

interface ModuleNode {
	path: string;
	imports: string[]; // resolved relative paths
	importedBy: string[]; // reverse edges
	dir: string; // directory (for grouping)
	exports: number;
}

export interface ArchGraph {
	nodes: Map<string, ModuleNode>;
	cycles: string[][];
	godModules: string[];
	orphans: string[];
}

export function runArchitecture(cwd: string): CheckResult {
	const start = Date.now();
	const issues: Issue[] = [];
	const files = getProductionFiles(cwd);

	if (files.length < 2) {
		return {
			name: "architecture",
			score: 100,
			grade: "A",
			details: { skipped: true, reason: "fewer than 2 source files" },
			issues: [],
			duration: Date.now() - start,
		};
	}

	const graph = buildGraph(files);

	// ── Circular dependencies ──
	const cycles = findCycles(graph.nodes);
	for (const cycle of cycles.slice(0, 5)) {
		issues.push({ severity: "error", message: `Circular: ${cycle.map(short).join(" → ")}`, rule: "circular-dep" });
	}
	if (cycles.length > 5) {
		issues.push({ severity: "error", message: `...and ${cycles.length - 5} more cycles`, rule: "circular-dep" });
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
	const entrypoints = new Set(["index.ts", "index.tsx", "main.ts", "main.tsx", "cli.ts", "App.tsx", "App.ts"]);
	const orphans: string[] = [];
	for (const [path, node] of graph.nodes) {
		const isEntry = entrypoints.has(basename(path));
		if (node.importedBy.length === 0 && !isEntry) {
			orphans.push(path);
			issues.push({ severity: "warning", message: `Orphan: not imported by any file (dead module?)`, file: path, rule: "orphan-module" });
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

	// ── Score ──
	const penalty = cycles.length * 15 + godModules.length * 5 + orphans.length * 2 + highFanOut * 3 + connectors * 4;
	const score = Math.max(0, Math.min(100, 100 - penalty));

	// ── Build details with graph data for visualization ──
	const graphData: Record<string, { imports: string[]; importedBy: string[]; dir: string }> = {};
	for (const [path, node] of graph.nodes) {
		graphData[path] = { imports: node.imports, importedBy: node.importedBy, dir: node.dir };
	}

	return {
		name: "architecture",
		score,
		grade: gradeFromScore(score),
		details: {
			totalModules: graph.nodes.size,
			circularDeps: cycles.length,
			godModules: godModules.length,
			orphans: orphans.length,
			highFanOut,
			connectors,
			graph: graphData,
		},
		issues,
		duration: Date.now() - start,
	};
}

// ── Graph building ──

function buildGraph(files: SourceFile[]): { nodes: Map<string, ModuleNode> } {
	const filePaths = new Set(files.map((f) => f.path));
	const nodes = new Map<string, ModuleNode>();

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
		const imports = parseImports(f.content);
		const node = nodes.get(f.path)!;

		for (const imp of imports) {
			const resolved = resolveImport(f.path, imp, filePaths);
			if (resolved && resolved !== f.path) {
				node.imports.push(resolved);
				const target = nodes.get(resolved);
				if (target) target.importedBy.push(f.path);
			}
		}
	}

	return { nodes };
}

function parseImports(content: string): string[] {
	const imports: string[] = [];
	const regex = /import\s+(?:[\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;
	let match;
	while ((match = regex.exec(content)) !== null) {
		if (match[1].startsWith(".")) imports.push(match[1]);
	}
	return imports;
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

	// Strip .js/.ts extension
	resolved = resolved.replace(/\.(js|ts|tsx|jsx)$/, "");

	// Try known extensions
	for (const ext of [".ts", ".tsx", ".js", ".jsx"]) {
		if (knownFiles.has(resolved + ext)) return resolved + ext;
	}
	// Try index
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
				const cycle = path.slice(cycleStart).map(short);
				const key = [...cycle].sort().join(",");
				if (!seen.has(key)) {
					seen.add(key);
					cycles.push([...cycle, short(node)]);
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

// ── SVG Architecture Diagram ──

export function generateArchSVG(details: Record<string, unknown>): string {
	const graph = details.graph as Record<string, { imports: string[]; importedBy: string[]; dir: string }> | undefined;
	if (!graph || Object.keys(graph).length === 0) return "";

	const nodes = Object.entries(graph);
	const nodeCount = nodes.length;
	if (nodeCount > 50)
		return `<div style="color:#6b7280;font-size:0.75rem">${nodeCount} modules — too many to render. Consider splitting into smaller packages.</div>`;

	// Detect cycles for highlighting
	const cycleEdges = new Set<string>();
	const cycles = details.circularDeps as number;
	if (cycles > 0) {
		// Mark edges that participate in cycles (simplified: mutual imports)
		for (const [path, info] of nodes) {
			for (const imp of info.imports) {
				if (graph[imp]?.imports.includes(path)) {
					cycleEdges.add(`${path}->${imp}`);
					cycleEdges.add(`${imp}->${path}`);
				}
			}
		}
	}

	// Group by directory
	const dirs = new Map<string, string[]>();
	for (const [path, info] of nodes) {
		const dir = info.dir || ".";
		const arr = dirs.get(dir) || [];
		arr.push(path);
		dirs.set(dir, arr);
	}

	const W = 800,
		padding = 50;
	const dirEntries = [...dirs.entries()];
	const dirWidth = (W - padding * 2) / Math.max(dirEntries.length, 1);
	const nodeSpacing = 38;

	// Position nodes
	const positions = new Map<string, { x: number; y: number }>();
	let dirIdx = 0;
	for (const [, paths] of dirEntries) {
		const x0 = padding + dirIdx * dirWidth + dirWidth / 2;
		for (let i = 0; i < paths.length; i++) {
			const y = padding + 55 + i * nodeSpacing;
			positions.set(paths[i]!, { x: x0, y });
		}
		dirIdx++;
	}

	const maxGroupLen = Math.max(...[...dirs.values()].map((p) => p.length));
	const H = Math.max(320, padding * 2 + 55 + maxGroupLen * nodeSpacing + 50);

	// ── Defs: arrowhead marker, glow filter ──
	const defs = `<defs>
<marker id="ah" viewBox="0 0 10 7" refX="10" refY="3.5" markerWidth="8" markerHeight="6" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#818cf850"/></marker>
<marker id="ah-cross" viewBox="0 0 10 7" refX="10" refY="3.5" markerWidth="8" markerHeight="6" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#ef444460"/></marker>
<marker id="ah-cycle" viewBox="0 0 10 7" refX="10" refY="3.5" markerWidth="8" markerHeight="6" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#f97316"/></marker>
</defs>`;

	// ── Background — transparent, inherits page dark bg ──
	const bg = `<rect width="${W}" height="${H}" rx="8" fill="none"/>`;

	// ── Draw edges (curved bezier paths with arrows) ──
	let edgesSvg = "";
	for (const [path, info] of nodes) {
		const from = positions.get(path);
		if (!from) continue;
		for (const imp of info.imports) {
			const to = positions.get(imp);
			if (!to) continue;

			const isCycle = cycleEdges.has(`${path}->${imp}`);
			const isCross = info.dir !== graph[imp]?.dir;
			const color = isCycle ? "#f9731680" : isCross ? "#ef444435" : "#818cf820";
			const marker = isCycle ? "url(#ah-cycle)" : isCross ? "url(#ah-cross)" : "url(#ah)";
			const width = isCycle ? "2" : "1.2";
			const dash = isCycle ? ' stroke-dasharray="5,3"' : "";

			// Bezier curve: offset control point sideways to avoid straight-line overlap
			const dx = to.x - from.x;
			const dy = to.y - from.y;
			const cx1 = from.x + dx * 0.3 + (dy === 0 ? 0 : Math.sign(dx) * 15);
			const cy1 = from.y + dy * 0.3;
			const cx2 = to.x - dx * 0.3 + (dy === 0 ? 0 : Math.sign(dx) * 15);
			const cy2 = to.y - dy * 0.3;

			edgesSvg += `<path d="M${from.x},${from.y} C${cx1},${cy1} ${cx2},${cy2} ${to.x},${to.y}" fill="none" stroke="${color}" stroke-width="${width}" marker-end="${marker}"${dash}/>`;
		}
	}

	// ── Draw directory groups ──
	let groupsSvg = "";
	dirIdx = 0;
	for (const [dName, paths] of dirEntries) {
		const x = padding + dirIdx * dirWidth;
		const h = paths.length * nodeSpacing + 24;
		groupsSvg += `<rect x="${x + 5}" y="${padding + 32}" width="${dirWidth - 10}" height="${h}" rx="8" fill="#ffffff06" stroke="#ffffff10"/>`;
		const label = dName === "." ? "root" : dName.split("/").pop();
		groupsSvg += `<text x="${x + dirWidth / 2}" y="${padding + 24}" text-anchor="middle" fill="#6b7280" font-size="10" font-weight="700" letter-spacing="0.03em">${label}</text>`;
		dirIdx++;
	}

	// ── Draw nodes ──
	let nodesSvg = "";
	const godThreshold = Math.max(3, Math.floor(nodeCount * 0.5));
	for (const [path] of nodes) {
		const pos = positions.get(path);
		if (!pos) continue;
		const name = basename(path, extname(path));
		const info = graph[path]!;
		const fanIn = info.importedBy.length;
		const fanOut = info.imports.length;

		// Node color based on health
		const isGod = fanIn >= godThreshold;
		const isOrphan = fanIn === 0 && !["index", "main", "cli", "App"].includes(name);
		const isHighFanOut = fanOut > 10;
		const isInCycle = [...cycleEdges].some((e) => e.startsWith(path + "->") || e.endsWith("->" + path));

		let nodeColor = "#6d78d0"; // default: softer accent
		if (isInCycle)
			nodeColor = "#d97706"; // amber for cycle participant
		else if (isGod)
			nodeColor = "#dc2626"; // red for god module
		else if (isOrphan)
			nodeColor = "#4b5563"; // dim for orphan
		else if (isHighFanOut) nodeColor = "#ca8a04"; // yellow for high fan-out

		const size = Math.min(9, 3 + Math.floor(fanIn * 0.8));

		// Node circle with subtle glow for important nodes
		if (isGod || isInCycle) {
			nodesSvg += `<circle cx="${pos.x}" cy="${pos.y}" r="${size + 4}" fill="${nodeColor}" opacity="0.15"/>`;
		}
		nodesSvg += `<circle cx="${pos.x}" cy="${pos.y}" r="${size}" fill="${nodeColor}"/>`;

		// Label
		const labelColor = isOrphan ? "#4b5563" : "#9ca3af";
		nodesSvg += `<text x="${pos.x + size + 5}" y="${pos.y + 3}" fill="${labelColor}" font-size="9" font-weight="${isGod ? "700" : "400"}">${name}</text>`;

		// Fan-in/fan-out badge (only for notable nodes)
		if (fanIn > 2 || fanOut > 5) {
			nodesSvg += `<text x="${pos.x + size + 5}" y="${pos.y + 13}" fill="#555" font-size="7">${fanIn}\u2190 ${fanOut}\u2192</text>`;
		}
	}

	// ── Legend ──
	const legendY = H - 30;
	const legend = `<g transform="translate(${padding}, ${legendY})" font-size="8" fill="#6b7280">
<circle cx="0" cy="0" r="4" fill="#6d78d0"/><text x="8" y="3">module</text>
<circle cx="60" cy="0" r="4" fill="#dc2626"/><text x="68" y="3">god module</text>
<circle cx="140" cy="0" r="4" fill="#d97706"/><text x="148" y="3">in cycle</text>
<circle cx="200" cy="0" r="4" fill="#ca8a04"/><text x="208" y="3">high fan-out</text>
<circle cx="280" cy="0" r="4" fill="#4b5563"/><text x="288" y="3">orphan</text>
<line x1="330" y1="0" x2="350" y2="0" stroke="#ef444440" stroke-width="1.2"/><text x="354" y="3">cross-dir</text>
<line x1="410" y1="0" x2="430" y2="0" stroke="#d97706" stroke-width="1.5" stroke-dasharray="5,3"/><text x="434" y="3">circular</text>
</g>`;

	return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;max-width:${W}px">${defs}${bg}${groupsSvg}${edgesSvg}${nodesSvg}${legend}</svg>`;
}

// ── Dependency Matrix (DSM) ──────────────────────────────────────────
// Standard software architecture visualization. Rows and columns are modules,
// cells show import relationships. Clusters on the diagonal = well-structured packages.

export function generateDSM(details: Record<string, unknown>): string {
	const graph = details.graph as Record<string, { imports: string[]; importedBy: string[]; dir: string }> | undefined;
	if (!graph || Object.keys(graph).length === 0) return "";
	const entries = Object.entries(graph);
	if (entries.length > 40)
		return `<div style="color:#6b7280;font-size:0.75rem">${entries.length} modules — too many for matrix view.</div>`;
	if (entries.length < 3) return "";

	// Sort by directory then name for clustering
	entries.sort((a, b) => `${a[1].dir}/${a[0]}`.localeCompare(`${b[1].dir}/${b[0]}`));
	const paths = entries.map(([p]) => p);
	const idx = new Map(paths.map((p, i) => [p, i]));
	const n = paths.length;

	const cell = 14;
	const labelW = 110;
	const W = labelW + n * cell + 10;
	const H = labelW + n * cell + 10;

	// Build adjacency
	const matrix: boolean[][] = Array.from({ length: n }, () => Array(n).fill(false));
	for (const [path, info] of entries) {
		const from = idx.get(path)!;
		for (const imp of info.imports) {
			const to = idx.get(imp);
			if (to !== undefined) matrix[from][to] = true;
		}
	}

	let svg = "";
	const ox = labelW,
		oy = labelW;

	// Grid
	for (let i = 0; i <= n; i++) {
		svg += `<line x1="${ox}" y1="${oy + i * cell}" x2="${ox + n * cell}" y2="${oy + i * cell}" stroke="#1e1e24" stroke-width="0.5"/>`;
		svg += `<line x1="${ox + i * cell}" y1="${oy}" x2="${ox + i * cell}" y2="${oy + n * cell}" stroke="#1e1e24" stroke-width="0.5"/>`;
	}

	// Cells — row imports col
	for (let r = 0; r < n; r++) {
		for (let c = 0; c < n; c++) {
			if (r === c) {
				// Diagonal — highlight
				svg += `<rect x="${ox + c * cell}" y="${oy + r * cell}" width="${cell}" height="${cell}" fill="#818cf808"/>`;
			} else if (matrix[r][c]) {
				const mutual = matrix[c][r]; // circular?
				const color = mutual ? "#d97706" : "#6d78d0";
				svg += `<rect x="${ox + c * cell + 2}" y="${oy + r * cell + 2}" width="${cell - 4}" height="${cell - 4}" rx="2" fill="${color}" opacity="0.7"/>`;
			}
		}
	}

	// Directory bands (background stripe per dir group)
	let prevDir = "";
	let bandStart = 0;
	const dirColors = ["#ffffff04", "#ffffff08"];
	let dirIdx2 = 0;
	for (let i = 0; i <= n; i++) {
		const dir = i < n ? entries[i][1].dir : "__end__";
		if (dir !== prevDir && i > 0) {
			const fill = dirColors[dirIdx2 % 2];
			svg += `<rect x="${ox}" y="${oy + bandStart * cell}" width="${n * cell}" height="${(i - bandStart) * cell}" fill="${fill}"/>`;
			svg += `<rect x="${ox + bandStart * cell}" y="${oy}" width="${(i - bandStart) * cell}" height="${n * cell}" fill="${fill}"/>`;
			dirIdx2++;
			bandStart = i;
		}
		prevDir = dir;
	}

	// Row labels (left) and column labels (top, rotated)
	for (let i = 0; i < n; i++) {
		const name = basename(paths[i], extname(paths[i]));
		svg += `<text x="${ox - 4}" y="${oy + i * cell + cell / 2 + 3}" text-anchor="end" fill="#9ca3af" font-size="7">${name}</text>`;
		svg += `<text x="${ox + i * cell + cell / 2}" y="${oy - 4}" text-anchor="start" fill="#9ca3af" font-size="7" transform="rotate(-60 ${ox + i * cell + cell / 2} ${oy - 4})">${name}</text>`;
	}

	// Legend
	svg += `<g transform="translate(${ox}, ${oy + n * cell + 16})" font-size="7" fill="#6b7280">`;
	svg += `<rect x="0" y="-4" width="8" height="8" rx="2" fill="#6d78d0" opacity="0.7"/><text x="12" y="3">imports</text>`;
	svg += `<rect x="60" y="-4" width="8" height="8" rx="2" fill="#d97706" opacity="0.7"/><text x="72" y="3">mutual (cycle)</text>`;
	svg += `</g>`;

	return `<svg viewBox="0 0 ${W} ${H + 30}" xmlns="http://www.w3.org/2000/svg" style="width:100%;max-width:${W}px">${svg}</svg>`;
}

// ── Package Nesting Diagram ──────────────────────────────────────────
// UML-style Package diagram: directories as nested boxes, files as items inside.

export function generatePackageDiagram(details: Record<string, unknown>): string {
	const graph = details.graph as Record<string, { imports: string[]; importedBy: string[]; dir: string }> | undefined;
	if (!graph || Object.keys(graph).length === 0) return "";
	const entries = Object.entries(graph);
	if (entries.length > 50)
		return `<div style="color:#6b7280;font-size:0.75rem">${entries.length} modules — too many for package view.</div>`;

	// Group by directory
	const dirs = new Map<string, { path: string; fanIn: number; fanOut: number }[]>();
	for (const [path, info] of entries) {
		const dir = info.dir || ".";
		const arr = dirs.get(dir) || [];
		arr.push({ path, fanIn: info.importedBy.length, fanOut: info.imports.length });
		dirs.set(dir, arr);
	}

	const dirEntries = [...dirs.entries()].sort((a, b) => a[0].localeCompare(b[0]));
	const boxW = 180;
	const fileH = 18;
	const headerH = 24;
	const gap = 16;
	const cols = Math.min(dirEntries.length, 4);
	const colW = boxW + gap;

	let svg = "";
	let maxH = 0;

	for (let i = 0; i < dirEntries.length; i++) {
		const [dir, files] = dirEntries[i];
		const col = i % cols;
		const row = Math.floor(i / cols);
		const prevRowsH = row * 300; // rough estimate, will adjust
		const x = gap + col * colW;
		let y = gap + prevRowsH;

		const boxH = headerH + files.length * fileH + 8;

		// Package box
		svg += `<rect x="${x}" y="${y}" width="${boxW}" height="${boxH}" rx="6" fill="#ffffff04" stroke="#ffffff10"/>`;
		// Package tab (UML-style)
		svg += `<rect x="${x}" y="${y}" width="${Math.min(boxW * 0.6, 100)}" height="${headerH}" rx="4" fill="#ffffff08" stroke="#ffffff10"/>`;
		const label = dir === "." ? "root" : dir.replace(/^src\//, "");
		svg += `<text x="${x + 8}" y="${y + 16}" fill="#9ca3af" font-size="10" font-weight="700">${label}/</text>`;
		svg += `<text x="${x + boxW - 8}" y="${y + 16}" text-anchor="end" fill="#4b5563" font-size="8">${files.length}</text>`;

		y += headerH + 4;

		// Files inside package
		for (const f of files) {
			const name = basename(f.path, extname(f.path));
			const health = f.fanIn > 5 ? "#d97706" : f.fanOut > 8 ? "#ca8a04" : "#6d78d0";
			svg += `<circle cx="${x + 12}" cy="${y + 7}" r="3" fill="${health}"/>`;
			svg += `<text x="${x + 20}" y="${y + 10}" fill="#9ca3af" font-size="8">${name}</text>`;
			svg += `<text x="${x + boxW - 8}" y="${y + 10}" text-anchor="end" fill="#4b5563" font-size="7">${f.fanIn}\u2190 ${f.fanOut}\u2192</text>`;
			y += fileH;
		}

		maxH = Math.max(maxH, y + 8);
	}

	const W = gap + cols * colW;
	const H = maxH + gap;

	return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;max-width:${W}px">${svg}</svg>`;
}
