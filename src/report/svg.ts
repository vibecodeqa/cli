/** SVG builders for the HTML report (score ring, radar chart). */

export function buildRing(score: number, color: string): string {
	const r = 42;
	const c = 2 * Math.PI * r;
	const off = c - (score / 100) * c;
	return `<svg viewBox="0 0 100 100" style="width:100px;height:100px"><circle cx="50" cy="50" r="${r}" fill="none" stroke="#444" stroke-width="7"/><circle cx="50" cy="50" r="${r}" fill="none" stroke="${color}" stroke-width="7" stroke-dasharray="${c}" stroke-dashoffset="${off}" stroke-linecap="round" transform="rotate(-90 50 50)"/></svg>`;
}

export function buildRadar(items: { label: string; score: number }[]): string {
	const n = items.length;
	if (n < 3) return "";
	const cx = 120,
		cy = 120,
		r = 90;
	const step = (2 * Math.PI) / n;
	let grid = "";
	for (const pct of [25, 50, 75, 100]) {
		const rr = (pct / 100) * r;
		const pts = items
			.map((_, i) => `${cx + rr * Math.cos(i * step - Math.PI / 2)},${cy + rr * Math.sin(i * step - Math.PI / 2)}`)
			.join(" ");
		grid += `<polygon points="${pts}" fill="none" stroke="#444" stroke-width="0.7"/>`;
	}
	let axes = "";
	for (let i = 0; i < n; i++) {
		const a = i * step - Math.PI / 2;
		axes += `<line x1="${cx}" y1="${cy}" x2="${cx + r * Math.cos(a)}" y2="${cy + r * Math.sin(a)}" stroke="#444" stroke-width="0.7"/>`;
		const lx = cx + (r + 16) * Math.cos(a);
		const ly = cy + (r + 16) * Math.sin(a);
		axes += `<text x="${lx}" y="${ly}" text-anchor="middle" dominant-baseline="middle" fill="#6b7280" font-size="9" font-weight="600">${items[i].label}</text>`;
	}
	const dataPts = items
		.map((c, i) => {
			const a = i * step - Math.PI / 2;
			const rr = (c.score / 100) * r;
			return `${cx + rr * Math.cos(a)},${cy + rr * Math.sin(a)}`;
		})
		.join(" ");
	let dots = "";
	for (let i = 0; i < n; i++) {
		const a = i * step - Math.PI / 2;
		const rr = (items[i].score / 100) * r;
		dots += `<circle cx="${cx + rr * Math.cos(a)}" cy="${cy + rr * Math.sin(a)}" r="3.5" fill="#818cf8"/>`;
	}
	return `<svg viewBox="0 0 240 240">${grid}${axes}<polygon points="${dataPts}" fill="#818cf825" stroke="#818cf8" stroke-width="1.5"/>${dots}</svg>`;
}

let _timelineCounter = 0;

/** Score timeline — larger chart showing score history over last N runs. */
export function buildTimeline(entries: { score: number; timestamp: string }[], opts?: { width?: number; height?: number }): string {
	const gradId = `tlg${++_timelineCounter}`;
	const width = opts?.width ?? 600;
	const height = opts?.height ?? 120;
	const pad = { top: 20, right: 20, bottom: 25, left: 35 };
	const w = width - pad.left - pad.right;
	const h = height - pad.top - pad.bottom;

	if (entries.length === 0) return "";

	// Y axis: 0-100 always
	const yScale = (v: number) => pad.top + h - (v / 100) * h;
	const xScale = (i: number) => pad.left + (entries.length === 1 ? w / 2 : (i / (entries.length - 1)) * w);

	// Grid lines at 25, 50, 75
	let grid = "";
	for (const v of [25, 50, 75]) {
		const y = yScale(v).toFixed(1);
		grid += `<line x1="${pad.left}" y1="${y}" x2="${pad.left + w}" y2="${y}" stroke="#444" stroke-width="0.7"/>`;
		grid += `<text x="${pad.left - 6}" y="${y}" text-anchor="end" dominant-baseline="middle" fill="#888" font-size="8">${v}</text>`;
	}

	// Score line + dots
	const points = entries.map((e, i) => `${xScale(i).toFixed(1)},${yScale(e.score).toFixed(1)}`).join(" ");

	// Grade colors per dot
	const dots = entries
		.map((e, i) => {
			const color =
				e.score >= 90 ? "#22c55e" : e.score >= 75 ? "#84cc16" : e.score >= 60 ? "#eab308" : e.score >= 40 ? "#f97316" : "#ef4444";
			return `<circle cx="${xScale(i).toFixed(1)}" cy="${yScale(e.score).toFixed(1)}" r="3" fill="${color}"><title>${e.timestamp.split("T")[0]} — ${e.score}</title></circle>`;
		})
		.join("");

	// X-axis labels (first, middle, last)
	let xLabels = "";
	const labelIndices = entries.length <= 3 ? entries.map((_, i) => i) : [0, Math.floor(entries.length / 2), entries.length - 1];
	for (const i of labelIndices) {
		const label = entries[i]!.timestamp.split("T")[0]!.slice(5); // MM-DD
		xLabels += `<text x="${xScale(i).toFixed(1)}" y="${height - 4}" text-anchor="middle" fill="#888" font-size="7">${label}</text>`;
	}

	// Gradient fill under the line
	const areaPoints = `${xScale(0).toFixed(1)},${yScale(0).toFixed(1)} ${points} ${xScale(entries.length - 1).toFixed(1)},${yScale(0).toFixed(1)}`;

	return `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
<defs><linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#818cf8" stop-opacity="0.3"/><stop offset="100%" stop-color="#818cf8" stop-opacity="0.02"/></linearGradient></defs>
${grid}
<polygon points="${areaPoints}" fill="url(#${gradId})"/>
<polyline points="${points}" fill="none" stroke="#818cf8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
${dots}${xLabels}
</svg>`;
}

/** Testing pyramid — proportional triangle showing test layer distribution. */
export function buildPyramid(layers: { unit: number; integration: number; component: number; e2e: number }): string {
	const total = layers.unit + layers.integration + layers.component + layers.e2e;
	if (total === 0) return "";

	const w = 200,
		h = 160;
	const cx = w / 2;

	// Pyramid: e2e at top (smallest), unit at bottom (largest)
	// Each layer gets proportional height
	const items = [
		{ label: "E2E", count: layers.e2e, color: "#ef4444" },
		{ label: "Component", count: layers.component, color: "#f97316" },
		{ label: "Integration", count: layers.integration, color: "#eab308" },
		{ label: "Unit", count: layers.unit, color: "#22c55e" },
	];

	const layerH = (h - 20) / 4;
	let svg = "";

	for (let i = 0; i < 4; i++) {
		const item = items[i]!;
		const y = 10 + i * layerH;
		// Trapezoid: wider at bottom
		const topW = ((i + 0.5) / 4) * (w - 40);
		const botW = ((i + 1.5) / 4) * (w - 40);
		const opacity = item.count > 0 ? 1 : 0.2;

		const x1t = cx - topW / 2,
			x2t = cx + topW / 2;
		const x1b = cx - botW / 2,
			x2b = cx + botW / 2;

		svg += `<polygon points="${x1t},${y} ${x2t},${y} ${x2b},${y + layerH} ${x1b},${y + layerH}" fill="${item.color}" opacity="${opacity * 0.25}" stroke="${item.color}" stroke-opacity="${opacity * 0.6}" stroke-width="1"/>`;
		svg += `<text x="${cx}" y="${y + layerH / 2 + 3}" text-anchor="middle" fill="${item.count > 0 ? "#e5e5e5" : "#555"}" font-size="9" font-weight="600">${item.label} (${item.count})</text>`;
	}

	return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${svg}</svg>`;
}

/** Badge SVG — shields.io-style badge for README embedding. */
export function buildBadge(score: number, grade: string): string {
	const color = score >= 90 ? "#22c55e" : score >= 75 ? "#84cc16" : score >= 60 ? "#eab308" : score >= 40 ? "#f97316" : "#ef4444";
	const label = "vcqa";
	const value = `${grade} ${score}`;
	const labelW = 36,
		valueW = 44,
		totalW = labelW + valueW;
	const h = 20,
		r = 3;

	return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="${h}">
<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
<clipPath id="r"><rect width="${totalW}" height="${h}" rx="${r}" fill="#fff"/></clipPath>
<g clip-path="url(#r)">
<rect width="${labelW}" height="${h}" fill="#888"/>
<rect x="${labelW}" width="${valueW}" height="${h}" fill="${color}"/>
<rect width="${totalW}" height="${h}" fill="url(#s)"/>
</g>
<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
<text x="${labelW / 2}" y="14" fill="#010101" fill-opacity=".3">${label}</text>
<text x="${labelW / 2}" y="13">${label}</text>
<text x="${labelW + valueW / 2}" y="14" fill="#010101" fill-opacity=".3">${value}</text>
<text x="${labelW + valueW / 2}" y="13">${value}</text>
</g>
</svg>`;
}

/** Sparkline — mini line chart for trend display. */
export function buildSparkline(values: number[], opts?: { width?: number; height?: number; color?: string }): string {
	const width = opts?.width ?? 120;
	const height = opts?.height ?? 30;
	const color = opts?.color ?? "#818cf8";
	if (values.length === 0) return "";
	if (values.length === 1) {
		const y = (height / 2).toFixed(1);
		return `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"><polyline points="${(width / 2).toFixed(1)},${y}" fill="none" stroke="${color}" stroke-width="1.5"/><circle cx="${(width / 2).toFixed(1)}" cy="${y}" r="1.5" fill="${color}"/></svg>`;
	}
	const max = Math.max(...values, 1);
	const min = Math.min(...values, 0);
	const range = max - min || 1;
	const step = width / (values.length - 1);

	const points = values.map((v, i) => `${(i * step).toFixed(1)},${(height - ((v - min) / range) * (height - 4) - 2).toFixed(1)}`).join(" ");

	const dots = values
		.map((v, i) => {
			const x = (i * step).toFixed(1);
			const y = (height - ((v - min) / range) * (height - 4) - 2).toFixed(1);
			return `<circle cx="${x}" cy="${y}" r="1.5" fill="${color}"/>`;
		})
		.join("");

	return `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"><polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round"/>${dots}</svg>`;
}
