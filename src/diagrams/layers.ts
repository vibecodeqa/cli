/** Layer + package + sequence diagrams — structural visualizations. */

import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";

export function generatePackageDiagram(details: Record<string, unknown>): string {
	const graph = details.graph as Record<string, { imports: string[]; importedBy: string[]; dir: string }> | undefined;
	if (!graph || Object.keys(graph).length === 0) return "";
	const entries = Object.entries(graph);
	if (entries.length > 120)
		return `<div style="color:#6b7280;font-size:0.75rem">${entries.length} modules — too many for package view.</div>`;

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
		const prevRowsH = row * 300;
		const x = gap + col * colW;
		let y = gap + prevRowsH;
		const boxH = headerH + files.length * fileH + 8;

		svg += `<rect x="${x}" y="${y}" width="${boxW}" height="${boxH}" rx="6" fill="#ffffff04" stroke="#ffffff10"/>`;
		svg += `<rect x="${x}" y="${y}" width="${Math.min(boxW * 0.6, 100)}" height="${headerH}" rx="4" fill="#ffffff08" stroke="#ffffff10"/>`;
		const label = dir === "." ? "root" : dir.replace(/^src\//, "");
		svg += `<text x="${x + 8}" y="${y + 16}" fill="#9ca3af" font-size="10" font-weight="700">${label}/</text>`;
		svg += `<text x="${x + boxW - 8}" y="${y + 16}" text-anchor="end" fill="#4b5563" font-size="8">${files.length}</text>`;

		y += headerH + 4;
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

export function generateSequenceDiagram(details: Record<string, unknown>): string {
	const graph = details.graph as Record<string, { imports: string[]; importedBy: string[]; dir: string }> | undefined;
	if (!graph || Object.keys(graph).length < 3) return "";

	const entries = Object.entries(graph);
	const entryPoint = entries.find(([path, info]) => {
		const name = basename(path, extname(path));
		return info.importedBy.length === 0 && ["index", "main", "cli", "App", "app", "server"].includes(name);
	});
	if (!entryPoint) return "";

	const roles: { name: string; dir: string; modules: number }[] = [];
	const dirs = new Map<string, number>();
	for (const [, info] of entries) {
		const dir = info.dir || ".";
		dirs.set(dir, (dirs.get(dir) || 0) + 1);
	}

	const entryName = basename(entryPoint[0], extname(entryPoint[0]));
	roles.push({ name: entryName, dir: "entry", modules: 1 });

	const dirArr = [...dirs.entries()]
		.filter(([d]) => d !== (entryPoint[1].dir || "."))
		.sort((a, b) => {
			const aFanIn = entries.filter(([, i]) => i.dir === a[0]).reduce((s, [, i]) => s + i.importedBy.length, 0) / a[1];
			const bFanIn = entries.filter(([, i]) => i.dir === b[0]).reduce((s, [, i]) => s + i.importedBy.length, 0) / b[1];
			return bFanIn - aFanIn;
		});

	for (const [dir, count] of dirArr) {
		const label = dir.replace("src/", "").replace("lib/", "") || "core";
		roles.push({ name: label, dir, modules: count });
	}

	if (roles.length < 3) return "";
	const maxRoles = Math.min(roles.length, 6);
	const displayRoles = roles.slice(0, maxRoles);

	const messages: { from: number; to: number; label: string }[] = [];
	const entryImports = entryPoint[1].imports;

	for (let i = 1; i < displayRoles.length; i++) {
		const role = displayRoles[i];
		const importsFromRole = entryImports.filter((imp) => {
			const impInfo = graph[imp];
			return impInfo && (impInfo.dir || ".") === role.dir;
		});
		if (importsFromRole.length > 0) {
			const funcNames = importsFromRole.map((p) => basename(p, extname(p))).slice(0, 2).join(", ");
			messages.push({ from: 0, to: i, label: funcNames });
		}
	}

	for (let i = 1; i < displayRoles.length; i++) {
		for (let j = 1; j < displayRoles.length; j++) {
			if (i === j) continue;
			const fromDir = displayRoles[i].dir;
			const toDir = displayRoles[j].dir;
			const crossImports = entries.filter(
				([, info]) => (info.dir || ".") === fromDir && info.imports.some((imp) => graph[imp] && (graph[imp].dir || ".") === toDir),
			);
			if (crossImports.length > 0 && messages.length < 10) {
				messages.push({ from: i, to: j, label: `${crossImports.length} calls` });
			}
		}
	}

	if (messages.length < 2) return "";

	const lifelineSpacing = 130;
	const W = displayRoles.length * lifelineSpacing + 40;
	const messageH = 40;
	const headerH = 55;
	const H = headerH + messages.length * messageH + 30;

	let svg = "";
	for (let i = 0; i < displayRoles.length; i++) {
		const x = 20 + i * lifelineSpacing + lifelineSpacing / 2;
		const role = displayRoles[i];
		const subtitle = role.modules > 1 ? `(${role.modules})` : "";
		const boxW = Math.max(70, role.name.length * 7 + 20);
		svg += `<rect x="${x - boxW / 2}" y="6" width="${boxW}" height="${subtitle ? 30 : 22}" rx="4" fill="#ffffff08" stroke="#ffffff15"/>`;
		svg += `<text x="${x}" y="20" text-anchor="middle" fill="#e5e5e5" font-size="9" font-weight="700">${role.name}</text>`;
		if (subtitle) svg += `<text x="${x}" y="31" text-anchor="middle" fill="#4b5563" font-size="7">${subtitle}</text>`;
		svg += `<line x1="${x}" y1="${subtitle ? 36 : 28}" x2="${x}" y2="${H - 10}" stroke="#ffffff10" stroke-width="1" stroke-dasharray="4,3"/>`;
	}

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		const fromX = 20 + msg.from * lifelineSpacing + lifelineSpacing / 2;
		const toX = 20 + msg.to * lifelineSpacing + lifelineSpacing / 2;
		const y = headerH + i * messageH;
		const isReturn = msg.to < msg.from;
		const color = isReturn ? "#4b5563" : "#6d78d0";
		const dash = isReturn ? ' stroke-dasharray="4,2"' : "";
		svg += `<line x1="${fromX}" y1="${y}" x2="${toX + (toX > fromX ? -6 : 6)}" y2="${y}" stroke="${color}" stroke-width="1.5" marker-end="url(#seq-arrow)"${dash}/>`;
		svg += `<text x="${(fromX + toX) / 2}" y="${y - 6}" text-anchor="middle" fill="#6b7280" font-size="7">${msg.label}</text>`;
	}

	const defs = `<defs><marker id="seq-arrow" viewBox="0 0 10 7" refX="10" refY="3.5" markerWidth="7" markerHeight="5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#6d78d0"/></marker></defs>`;
	return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;max-width:${W}px">${defs}${svg}</svg>`;
}

export function generateLayerDiagram(details: Record<string, unknown>): string {
	const graph = details.graph as Record<string, { imports: string[]; importedBy: string[]; dir: string }> | undefined;
	if (!graph || Object.keys(graph).length < 5) return "";

	const entries = Object.entries(graph);
	type Layer = "entry" | "view" | "service" | "data" | "model";
	const layerDefs: { id: Layer; label: string; color: string }[] = [
		{ id: "entry", label: "Entry / Controller", color: "#6d78d0" },
		{ id: "view", label: "View / Output", color: "#06b6d4" },
		{ id: "service", label: "Service / Logic", color: "#22c55e" },
		{ id: "data", label: "Data / IO", color: "#d97706" },
		{ id: "model", label: "Model / Types", color: "#8b5cf6" },
	];

	const moduleLayer = new Map<string, Layer>();
	for (const [path, info] of entries) {
		const name = basename(path, extname(path));
		const fanIn = info.importedBy.length;
		const fanOut = info.imports.length;

		let layer: Layer = "service";
		if (fanIn === 0 && fanOut > 5) layer = "entry";
		else if (fanIn > 10 && fanOut === 0) layer = "model";
		else if (fanIn > 5 && fanOut <= 1) layer = "model";
		else if (path.includes("report") || path.includes("html") || path.includes("svg") || path.includes("page") || path.includes("style") || path.includes("component")) layer = "view";
		else if (name === "types" || name === "check-meta" || path.includes("types")) layer = "model";
		else if (name === "exec" || name === "detect" || name.includes("fs-") || path.includes("history")) layer = "data";
		else if (path.includes("runner") || path.includes("check")) layer = "service";
		else if (fanOut > fanIn * 2) layer = "entry";

		moduleLayer.set(path, layer);
	}

	const layerCounts = new Map<Layer, string[]>();
	for (const [path, layer] of moduleLayer) {
		const arr = layerCounts.get(layer) || [];
		arr.push(basename(path, extname(path)));
		layerCounts.set(layer, arr);
	}

	const layerOrder: Layer[] = ["entry", "view", "service", "data", "model"];
	let violations = 0;
	for (const [path, info] of entries) {
		const myLayer = moduleLayer.get(path)!;
		const myIdx = layerOrder.indexOf(myLayer);
		for (const imp of info.imports) {
			const impLayer = moduleLayer.get(imp);
			if (impLayer && impLayer !== myLayer) {
				const impIdx = layerOrder.indexOf(impLayer);
				if (impIdx < myIdx) violations++;
			}
		}
	}

	const W = 600;
	const layerH = 50;
	const gap = 6;
	const padding = 20;
	const activeLayers = layerDefs.filter((l) => (layerCounts.get(l.id)?.length || 0) > 0);
	const H = padding * 2 + activeLayers.length * (layerH + gap) + 40;

	let svg = "";
	let y = padding;
	svg += `<text x="${W / 2}" y="${y}" text-anchor="middle" fill="#9ca3af" font-size="10" font-weight="700">Application Layers</text>`;
	y += 20;

	for (const layer of activeLayers) {
		const modules = layerCounts.get(layer.id) || [];
		const moduleList = modules.slice(0, 8).join(", ") + (modules.length > 8 ? ` +${modules.length - 8}` : "");

		svg += `<rect x="${padding}" y="${y}" width="${W - padding * 2}" height="${layerH}" rx="6" fill="${layer.color}10" stroke="${layer.color}40" class="layer-band" data-layer="${layer.id}"/>`;
		svg += `<text x="${padding + 12}" y="${y + 20}" fill="${layer.color}" font-size="10" font-weight="700">${layer.label}</text>`;
		svg += `<text x="${padding + 12}" y="${y + 36}" fill="#6b7280" font-size="8">${moduleList}</text>`;
		svg += `<text x="${W - padding - 12}" y="${y + 20}" text-anchor="end" fill="#4b5563" font-size="9">${modules.length}</text>`;

		if (activeLayers.indexOf(layer) < activeLayers.length - 1) {
			const arrowY = y + layerH + gap / 2;
			svg += `<line x1="${W / 2}" y1="${y + layerH}" x2="${W / 2}" y2="${arrowY + gap / 2}" stroke="#ffffff15" stroke-width="1" marker-end="url(#layer-arrow)"/>`;
		}
		y += layerH + gap;
	}

	if (violations > 0) {
		svg += `<text x="${W / 2}" y="${y + 10}" text-anchor="middle" fill="var(--warn)" font-size="8">${violations} layer violation${violations > 1 ? "s" : ""} (imports going UP the stack)</text>`;
	} else {
		svg += `<text x="${W / 2}" y="${y + 10}" text-anchor="middle" fill="var(--pass)" font-size="8">Clean layering \u2014 all dependencies flow downward</text>`;
	}

	const defs = `<defs><marker id="layer-arrow" viewBox="0 0 10 7" refX="5" refY="3.5" markerWidth="6" markerHeight="4" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#ffffff30"/></marker></defs>`;
	return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;max-width:${W}px">${defs}${svg}</svg>`;
}

export function generateContainerDiagram(cwd: string): string {
	const has = (f: string) => existsSync(join(cwd, f));
	const containers: { name: string; type: string; tech: string }[] = [];

	const hasFrontend = has("src/App.tsx") || has("src/App.vue") || has("src/App.svelte") || has("web/src/App.tsx") || has("app/page.tsx");
	if (hasFrontend) {
		const tech = has("src/App.tsx") || has("app/page.tsx") ? "React" : has("src/App.vue") ? "Vue" : "Svelte";
		containers.push({ name: "Frontend", type: "webapp", tech });
	}
	if (has("wrangler.toml") || has("wrangler.json")) {
		containers.push({ name: "Worker", type: "worker", tech: "Cloudflare Workers" });
	}
	if (has("Dockerfile") || has("server.ts") || has("src/server.ts")) {
		containers.push({ name: "API Server", type: "api", tech: "Node.js" });
	}
	if (has("prisma/schema.prisma") || has("drizzle.config.ts")) {
		const tech = has("prisma/schema.prisma") ? "Prisma" : "Drizzle";
		containers.push({ name: "Database", type: "db", tech });
	}
	if (has("firebase.json") || has(".firebaserc")) containers.push({ name: "Firebase", type: "baas", tech: "Firebase" });
	if (has("supabase/config.toml") || has(".supabase")) containers.push({ name: "Supabase", type: "baas", tech: "Supabase" });
	if (has("pubspec.yaml")) containers.push({ name: "Mobile App", type: "mobile", tech: "Flutter" });

	// Monorepo: detect containers from workspace packages
	if (containers.length < 2) {
		const pkgDirs = ["packages", "apps", "services"];
		for (const dir of pkgDirs) {
			if (!has(dir)) continue;
			try {
				for (const entry of readdirSync(join(cwd, dir))) {
					const pkgPath = join(cwd, dir, entry);
					if (!statSync(pkgPath).isDirectory()) continue;
					if (existsSync(join(pkgPath, "wrangler.toml"))) {
						containers.push({ name: entry, type: "worker", tech: "CF Worker" });
					} else if (existsSync(join(pkgPath, "src/App.tsx")) || existsSync(join(pkgPath, "src/App.vue"))) {
						containers.push({ name: entry, type: "webapp", tech: "React" });
					}
				}
			} catch { /* skip */ }
		}
	}

	if (has("package.json") && !containers.length) containers.push({ name: "Application", type: "app", tech: "Node.js" });
	if (containers.length < 2) return "";

	const boxW = 140;
	const boxH = 60;
	const gap = 30;
	const W = containers.length * (boxW + gap) + gap;
	const H = 120;

	const typeColors: Record<string, string> = { webapp: "#6d78d0", worker: "#d97706", api: "#22c55e", db: "#8b5cf6", baas: "#ec4899", mobile: "#06b6d4", app: "#6d78d0" };

	let svg = "";
	for (let i = 0; i < containers.length; i++) {
		const c = containers[i];
		const x = gap + i * (boxW + gap);
		const y = (H - boxH) / 2;
		const color = typeColors[c.type] || "#6d78d0";

		svg += `<rect x="${x}" y="${y}" width="${boxW}" height="${boxH}" rx="8" fill="${color}15" stroke="${color}50"/>`;
		svg += `<text x="${x + boxW / 2}" y="${y + 24}" text-anchor="middle" fill="#e5e5e5" font-size="10" font-weight="700">${c.name}</text>`;
		svg += `<text x="${x + boxW / 2}" y="${y + 40}" text-anchor="middle" fill="#6b7280" font-size="8">[${c.tech}]</text>`;

		if (i < containers.length - 1) {
			const ax = x + boxW;
			const bx = ax + gap;
			svg += `<line x1="${ax}" y1="${H / 2}" x2="${bx}" y2="${H / 2}" stroke="#ffffff20" stroke-width="1.5" marker-end="url(#cont-arrow)"/>`;
		}
	}

	const defs = `<defs><marker id="cont-arrow" viewBox="0 0 10 7" refX="10" refY="3.5" markerWidth="7" markerHeight="5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#ffffff40"/></marker></defs>`;
	return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;max-width:${W}px">${defs}${svg}</svg>`;
}
