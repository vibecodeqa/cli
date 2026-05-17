/** Dependency graph SVG + DSM matrix — module-level visualizations. */

import { basename, extname } from "node:path";

export function generateArchSVG(details: Record<string, unknown>): string {
	const graph = details.graph as Record<string, { imports: string[]; importedBy: string[]; dir: string }> | undefined;
	if (!graph || Object.keys(graph).length === 0) return "";

	const nodes = Object.entries(graph);
	const nodeCount = nodes.length;
	if (nodeCount > 120)
		return `<div style="color:#6b7280;font-size:0.75rem">${nodeCount} modules — too many to render. Consider splitting into smaller packages.</div>`;

	// Detect cycles for highlighting
	const cycleEdges = new Set<string>();
	const cycles = details.circularDeps as number;
	if (cycles > 0) {
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

	const dirEntries = [...dirs.entries()];
	const isLarge = nodeCount > 50;
	const W = isLarge ? 1000 : 800;
	const padding = isLarge ? 30 : 50;
	const dirWidth = (W - padding * 2) / Math.max(dirEntries.length, 1);
	const nodeSpacing = isLarge ? 22 : 38;

	// Position nodes
	const positions = new Map<string, { x: number; y: number }>();
	let dirIdx = 0;
	for (const [, paths] of dirEntries) {
		const x0 = padding + dirIdx * dirWidth + dirWidth / 2;
		for (let i = 0; i < paths.length; i++) {
			positions.set(paths[i]!, { x: x0, y: padding + 55 + i * nodeSpacing });
		}
		dirIdx++;
	}

	const maxGroupLen = Math.max(...[...dirs.values()].map((p) => p.length));
	const H = Math.max(320, padding * 2 + 55 + maxGroupLen * nodeSpacing + 50);

	const defs = `<defs>
<marker id="dg-ah" viewBox="0 0 10 7" refX="10" refY="3.5" markerWidth="8" markerHeight="6" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#818cf850"/></marker>
<marker id="dg-ah-cross" viewBox="0 0 10 7" refX="10" refY="3.5" markerWidth="8" markerHeight="6" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#ef444460"/></marker>
<marker id="dg-ah-cycle" viewBox="0 0 10 7" refX="10" refY="3.5" markerWidth="8" markerHeight="6" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#f97316"/></marker>
</defs>`;

	const bg = `<rect width="${W}" height="${H}" rx="8" fill="none"/>`;

	// Edges
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
			const marker = isCycle ? "url(#dg-ah-cycle)" : isCross ? "url(#dg-ah-cross)" : "url(#dg-ah)";
			const width = isCycle ? "2" : "1.2";
			const dash = isCycle ? ' stroke-dasharray="5,3"' : "";
			const dx = to.x - from.x;
			const dy = to.y - from.y;
			const cx1 = from.x + dx * 0.3 + (dy === 0 ? 0 : Math.sign(dx) * 15);
			const cy1 = from.y + dy * 0.3;
			const cx2 = to.x - dx * 0.3 + (dy === 0 ? 0 : Math.sign(dx) * 15);
			const cy2 = to.y - dy * 0.3;
			edgesSvg += `<path d="M${from.x},${from.y} C${cx1},${cy1} ${cx2},${cy2} ${to.x},${to.y}" fill="none" stroke="${color}" stroke-width="${width}" marker-end="${marker}"${dash}/>`;
		}
	}

	// Directory groups
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

	// Nodes
	let nodesSvg = "";
	const godThreshold = Math.max(3, Math.floor(nodeCount * 0.5));
	for (const [path] of nodes) {
		const pos = positions.get(path);
		if (!pos) continue;
		const name = basename(path, extname(path));
		const info = graph[path]!;
		const fanIn = info.importedBy.length;
		const fanOut = info.imports.length;

		const isGod = fanIn >= godThreshold;
		const isOrphan = fanIn === 0 && !["index", "main", "cli", "App"].includes(name);
		const isHighFanOut = fanOut > 10;
		const isInCycle = [...cycleEdges].some((e) => e.startsWith(`${path}->`) || e.endsWith(`->${path}`));

		let nodeColor = "#6d78d0";
		if (isInCycle) nodeColor = "#d97706";
		else if (isGod) nodeColor = "#dc2626";
		else if (isOrphan) nodeColor = "#4b5563";
		else if (isHighFanOut) nodeColor = "#ca8a04";

		const size = isLarge ? Math.min(6, 2 + Math.floor(fanIn * 0.5)) : Math.min(9, 3 + Math.floor(fanIn * 0.8));
		const fontSize = isLarge ? 7 : 9;

		if (isGod || isInCycle) {
			nodesSvg += `<circle cx="${pos.x}" cy="${pos.y}" r="${size + 3}" fill="${nodeColor}" opacity="0.15"/>`;
		}
		nodesSvg += `<circle cx="${pos.x}" cy="${pos.y}" r="${size}" fill="${nodeColor}" data-path="${path}" data-fan-in="${fanIn}" data-fan-out="${fanOut}" class="node"/>`;

		const labelColor = isOrphan ? "#4b5563" : "#9ca3af";
		if (!isLarge || isGod || isInCycle || isHighFanOut || fanIn > 3) {
			nodesSvg += `<text x="${pos.x + size + 3}" y="${pos.y + 3}" fill="${labelColor}" font-size="${fontSize}" font-weight="${isGod ? "700" : "400"}">${name}</text>`;
		}

		if (!isLarge && (fanIn > 2 || fanOut > 5)) {
			nodesSvg += `<text x="${pos.x + size + 5}" y="${pos.y + 13}" fill="#555" font-size="7">${fanIn}\u2190 ${fanOut}\u2192</text>`;
		}
	}

	// Legend
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

	// Interactive script — click node to highlight its imports/importers
	const script = `<script type="text/javascript"><![CDATA[
(function(){
var svg=document.currentScript.parentElement;
svg.querySelectorAll('.node').forEach(function(n){
n.style.cursor='pointer';
n.addEventListener('click',function(){
var p=n.dataset.path;
var info=document.getElementById('arch-info');
if(info)info.textContent=p+' ('+n.dataset.fanIn+'\\u2190 '+n.dataset.fanOut+'\\u2192)';
var cx=n.getAttribute('cx'),cy=n.getAttribute('cy');
var coord=cx+','+cy;
svg.querySelectorAll('path[d]').forEach(function(e){
var d=e.getAttribute('d');
if(d.indexOf('M'+coord)===0||d.lastIndexOf(coord)===d.length-coord.length)e.style.opacity='1';
else e.style.opacity='0.1';
});
});
});
svg.addEventListener('dblclick',function(){svg.querySelectorAll('path[d]').forEach(function(e){e.style.opacity='1'})});
})();
]]></script>`;

	return `<div id="arch-info" style="font-size:0.7rem;color:#6b7280;min-height:1.2em;margin-bottom:0.3rem">Click a node to highlight its connections. Double-click to reset.</div><svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;max-width:${W}px">${defs}${bg}${groupsSvg}${edgesSvg}${nodesSvg}${legend}${script}</svg>`;
}

export function generateDSM(details: Record<string, unknown>): string {
	const graph = details.graph as Record<string, { imports: string[]; importedBy: string[]; dir: string }> | undefined;
	if (!graph || Object.keys(graph).length === 0) return "";
	const entries = Object.entries(graph);
	if (entries.length > 100)
		return `<div style="color:#6b7280;font-size:0.75rem">${entries.length} modules — too many for matrix view.</div>`;
	if (entries.length < 3) return "";

	entries.sort((a, b) => `${a[1].dir}/${a[0]}`.localeCompare(`${b[1].dir}/${b[0]}`));
	const paths = entries.map(([p]) => p);
	const idx = new Map(paths.map((p, i) => [p, i]));
	const n = paths.length;

	const cell = n > 50 ? 8 : n > 30 ? 10 : 14;
	const labelW = n > 50 ? 80 : 110;
	const W = labelW + n * cell + 10;
	const H = labelW + n * cell + 10;

	const matrix: boolean[][] = Array.from({ length: n }, () => Array(n).fill(false));
	for (const [path, info] of entries) {
		const from = idx.get(path)!;
		for (const imp of info.imports) {
			const to = idx.get(imp);
			if (to !== undefined) matrix[from][to] = true;
		}
	}

	let svg = "";
	const ox = labelW, oy = labelW;

	// Grid
	for (let i = 0; i <= n; i++) {
		svg += `<line x1="${ox}" y1="${oy + i * cell}" x2="${ox + n * cell}" y2="${oy + i * cell}" stroke="#1e1e24" stroke-width="0.5"/>`;
		svg += `<line x1="${ox + i * cell}" y1="${oy}" x2="${ox + i * cell}" y2="${oy + n * cell}" stroke="#1e1e24" stroke-width="0.5"/>`;
	}

	// Cells
	for (let r = 0; r < n; r++) {
		for (let c = 0; c < n; c++) {
			if (r === c) {
				svg += `<rect x="${ox + c * cell}" y="${oy + r * cell}" width="${cell}" height="${cell}" fill="#818cf808"/>`;
			} else if (matrix[r][c]) {
				const mutual = matrix[c][r];
				const color = mutual ? "#d97706" : "#6d78d0";
				svg += `<rect x="${ox + c * cell + 1}" y="${oy + r * cell + 1}" width="${cell - 2}" height="${cell - 2}" rx="1" fill="${color}" opacity="0.7" class="dsm-cell" data-row="${r}" data-col="${c}"/>`;
			}
		}
	}

	// Directory bands
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

	// Labels
	const labelFont = n > 50 ? 5 : n > 30 ? 6 : 7;
	for (let i = 0; i < n; i++) {
		const name = basename(paths[i], extname(paths[i]));
		svg += `<text x="${ox - 4}" y="${oy + i * cell + cell / 2 + 2}" text-anchor="end" fill="#9ca3af" font-size="${labelFont}">${name}</text>`;
		svg += `<text x="${ox + i * cell + cell / 2}" y="${oy - 4}" text-anchor="start" fill="#9ca3af" font-size="${labelFont}" transform="rotate(-60 ${ox + i * cell + cell / 2} ${oy - 4})">${name}</text>`;
	}

	// Legend
	svg += `<g transform="translate(${ox}, ${oy + n * cell + 16})" font-size="7" fill="#6b7280">`;
	svg += `<rect x="0" y="-4" width="8" height="8" rx="2" fill="#6d78d0" opacity="0.7"/><text x="12" y="3">imports</text>`;
	svg += `<rect x="60" y="-4" width="8" height="8" rx="2" fill="#d97706" opacity="0.7"/><text x="72" y="3">mutual (cycle)</text>`;
	svg += `</g>`;

	// Interactive: hover to highlight row/col
	const script = `<script type="text/javascript"><![CDATA[
(function(){
var svg=document.currentScript.parentElement;
svg.querySelectorAll('.dsm-cell').forEach(function(c){
c.style.cursor='pointer';
c.addEventListener('mouseenter',function(){
var r=c.dataset.row,col=c.dataset.col;
svg.querySelectorAll('.dsm-cell').forEach(function(x){
if(x.dataset.row===r||x.dataset.col===col)x.setAttribute('opacity','1');
else x.setAttribute('opacity','0.3');
});
});
});
svg.addEventListener('mouseleave',function(){
svg.querySelectorAll('.dsm-cell').forEach(function(x){x.setAttribute('opacity','0.7')});
});
})();
]]></script>`;

	return `<svg viewBox="0 0 ${W} ${H + 30}" xmlns="http://www.w3.org/2000/svg" style="width:100%;max-width:${W}px">${svg}${script}</svg>`;
}
