/** Page renderers for the HTML report. */

import { getCheckMeta } from "../check-meta.js";
import { loadHistory } from "../history.js";
import { generateArchSVG, generateDSM, generatePackageDiagram, generateSequenceDiagram } from "../runners/architecture.js";
import type { CheckResult, VibeReport } from "../types.js";
import { det, e, gc, pc } from "./components.js";
import { buildPyramid, buildRadar, buildRing, buildTimeline } from "./svg.js";

export interface CatScore {
	id: string;
	label: string;
	file?: string;
	checks: CheckResult[];
	avg: number;
}

export interface FileEntry {
	file: string;
	total: number;
	errors: number;
	warnings: number;
	checks: string[];
}

type FL = (path: string, line?: number) => string;

// ── Overview ──────────────────────────────────────────────────────────

export function overviewPage(
	report: VibeReport,
	active: CheckResult[],
	totalIssues: number,
	catScores: CatScore[],
	allChecks: CheckResult[],
	topFiles: FileEntry[],
	fl: FL,
	historyDir?: string,
): string {
	const hero = `<div class="hero">
    ${buildRing(report.score, gc(report.grade))}
    <div class="hc">
      <span class="hg" style="color:${gc(report.grade)}">${report.grade}</span>
      <span class="hs" style="color:${gc(report.grade)}">${report.score}/100</span>
      <span class="hd">${active.length} checks \u00b7 ${totalIssues} issues \u00b7 ${report.meta.duration}ms</span>
    </div>
  </div>`;

	const scoredCats = catScores.filter((cs) => cs.checks.some((c) => !det(c).skipped && !det(c).comingSoon));
	const radarSvg = scoredCats.length >= 3 ? buildRadar(scoredCats.map((cs) => ({ label: cs.label, score: cs.avg }))) : "";

	const catCards = catScores
		.map((cs) => {
			const clr = gc(cs.avg >= 90 ? "A" : cs.avg >= 75 ? "B" : cs.avg >= 60 ? "C" : cs.avg >= 40 ? "D" : "F");
			const mini = cs.checks
				.map((c) => {
					const sk = det(c).skipped;
					return `<span class="mc" style="color:${sk ? "#555" : gc(c.grade)}" title="${e(c.name)}: ${sk ? "skip" : c.score}">${sk ? "\u2014" : c.grade}</span>`;
				})
				.join("");
			const href = cs.file || `${cs.id}.html`;
			return `<a class="cc" href="${href}"><div class="cc-s" style="color:${clr}">${cs.avg}</div><div class="cc-l">${cs.label}</div><div class="cc-m">${mini}</div></a>`;
		})
		.join("");

	let timelineSection = "";
	if (historyDir) {
		const history = loadHistory(historyDir);
		if (history.length >= 2) {
			const timelineSvg = buildTimeline(history.map((h) => ({ score: h.score, timestamp: h.timestamp })));
			timelineSection = `<div class="ov-section"><h3>Score Timeline</h3><div class="timeline">${timelineSvg}</div></div>`;
		}
	}

	const barChart = active
		.sort((a, b) => a.score - b.score)
		.map((c) => {
			return `<div class="brow"><span class="bl">${e(c.name)}</span><div class="bb"><div class="bf" style="width:${c.score}%;background:${gc(c.grade)}"></div></div><span class="bv" style="color:${gc(c.grade)}">${c.grade} ${c.score}</span></div>`;
		})
		.join("");

	const allIssues = allChecks.flatMap((c) => c.issues.map((i) => ({ check: c.name, ...i })));
	const sortedIssues = allIssues
		.sort(
			(a, b) =>
				(a.severity === "error" ? 0 : a.severity === "warning" ? 1 : 2) - (b.severity === "error" ? 0 : b.severity === "warning" ? 1 : 2),
		)
		.slice(0, 10);

	let topIssuesHtml = "";
	if (sortedIssues.length > 0) {
		const rows = sortedIssues
			.map((i) => {
				const loc = i.file ? fl(i.file.split(":")[0]!, i.line) : "";
				return `<div class="ov-issue ${i.severity}"><span class="is">${i.severity[0]!.toUpperCase()}</span><span class="ov-check">${e(i.check)}</span>${loc ? `<span class="ov-loc">${loc}</span>` : ""}<span class="ov-msg">${e(i.message)}</span></div>`;
			})
			.join("");
		const viewAll = allIssues.length > 10 ? `<a class="ov-link" href="issues.html">View all ${allIssues.length} issues \u2192</a>` : "";
		topIssuesHtml = `<div class="ov-section"><h3>Top Issues</h3>${rows}${viewAll}</div>`;
	}

	let fileHotspotsHtml = "";
	if (topFiles.length > 0) {
		const fileRows = topFiles
			.slice(0, 5)
			.map((f) => {
				const pct = Math.min(100, f.total * 5);
				return `<div class="fr"><span class="ff">${fl(f.file)}</span><div class="fb"><div class="fbf" style="width:${pct}%;background:${f.errors > 0 ? "var(--fail)" : "var(--warn)"}"></div></div><span class="fv">${f.errors}E ${f.warnings}W</span></div>`;
			})
			.join("");
		const viewAll = topFiles.length > 5 ? `<a class="ov-link" href="files.html">View all ${topFiles.length} files \u2192</a>` : "";
		fileHotspotsHtml = `<div class="ov-section"><h3>File Hotspots</h3>${fileRows}${viewAll}</div>`;
	}

	const stackHtml = Object.entries(report.meta.stack)
		.filter(([, v]) => v !== "none" && v !== "unknown")
		.map(([k, v]) => `<span>${k}: <b>${v}</b></span>`)
		.join("");

	return `
<div class="dash">
  ${hero}
  <div class="radar">${radarSvg}</div>
</div>
<div class="cats">${catCards}</div>
${timelineSection}
<div class="ov-section"><h3>All Checks</h3><div class="bars">${barChart}</div></div>
${topIssuesHtml}
${fileHotspotsHtml}
<div class="stack">${stackHtml}</div>`;
}

// ── Single category page ──────────────────────────────────────────

export function categoryPage(cs: CatScore, fl: FL): string {
	const subNav = cs.checks
		.map((c, i) => {
			const sk = det(c).skipped;
			const premium = det(c).comingSoon;
			const badge = premium ? "PRO" : sk ? "\u2014" : c.grade;
			const clr = premium ? "#6366f1" : sk ? "#555" : gc(c.grade);
			return `<a class="sn${i === 0 ? " active" : ""}${premium ? " sn-pro" : ""}" data-sub="${cs.id}-${c.name}" onclick="sub(this,'${cs.id}')">${e(c.name)} <span style="color:${clr}">${badge}</span></a>`;
		})
		.join("");

	const subPages = cs.checks
		.map((c, i) => {
			const meta = getCheckMeta(c.name);
			const sk = det(c).skipped;
			const premium = det(c).comingSoon;
			const detailsFiltered = Object.entries(c.details)
				.filter(([k]) => k !== "skipped" && k !== "reason" && k !== "graph")
				.map(([k, v]) => {
					const d = Array.isArray(v) ? v.join(", ") : typeof v === "object" ? JSON.stringify(v) : String(v);
					return `<div class="kv"><span class="k">${e(k)}</span><span class="v">${e(d)}</span></div>`;
				})
				.join("");

			const byFile = new Map<string, typeof c.issues>();
			const noFile: typeof c.issues = [];
			for (const iss of c.issues) {
				const f = iss.file?.split(":")[0];
				if (f) {
					const arr = byFile.get(f) || [];
					arr.push(iss);
					byFile.set(f, arr);
				} else {
					noFile.push(iss);
				}
			}

			let issuesHtml = "";
			for (const [file, issues] of byFile) {
				issuesHtml += `<div class="fg"><div class="fn">${fl(file)} <span class="fc">${issues.length}</span></div>`;
				for (const iss of issues) {
					const prompt = `Fix this issue in ${file}${iss.line ? `:${iss.line}` : ""}\n${iss.severity}: ${iss.message}${iss.rule ? ` (${iss.rule})` : ""}\nCheck: ${c.name}`;
					issuesHtml += `<div class="ir ${iss.severity}"><span class="is">${iss.severity[0]!.toUpperCase()}</span>${iss.line ? `<span class="il">${iss.line}</span>` : ""}<span class="im">${e(iss.message)}</span>${iss.rule ? `<span class="iru">${e(iss.rule)}</span>` : ""}<button class="cp-btn" data-prompt="${e(prompt)}" title="Copy fix prompt">\ud83d\udccb</button></div>`;
				}
				issuesHtml += `</div>`;
			}
			if (noFile.length > 0) {
				issuesHtml += `<div class="fg"><div class="fn">General</div>`;
				for (const iss of noFile) {
					issuesHtml += `<div class="ir ${iss.severity}"><span class="is">${iss.severity[0]!.toUpperCase()}</span><span class="im">${e(iss.message)}</span>${iss.rule ? `<span class="iru">${e(iss.rule)}</span>` : ""}</div>`;
				}
				issuesHtml += `</div>`;
			}

			if (premium) {
				const d = c.details as Record<string, unknown>;
				const desc = (d.description as string) || meta.description;
				const detailKvs = Object.entries(d)
					.filter(([k]) => !["premium", "comingSoon", "reason", "description"].includes(k))
					.map(
						([k, v]) =>
							`<div class="kv"><span class="k">${e(k)}</span><span class="v">${e(Array.isArray(v) ? v.join(", ") : String(v))}</span></div>`,
					)
					.join("");

				return `<div class="sp${i === 0 ? " active" : ""}" data-sub="${cs.id}-${c.name}">
<div class="pro-card">
<div class="pro-badge">PRO</div>
<h3 style="margin-bottom:0.5rem;color:var(--text)">${e(meta.label)}</h3>
<p class="pro-desc">${e(desc)}</p>
${meta.risk ? `<div class="info-panel"><div class="ip-row"><span class="ip-label">Risk</span><span>${e(meta.risk)}</span></div></div>` : ""}
${detailKvs ? `<div class="kvs" style="margin-top:0.8rem">${detailKvs}</div>` : ""}
<p class="pro-cta">Coming soon with VibeCode QA Pro</p>
</div>
</div>`;
			}

			return `<div class="sp${i === 0 ? " active" : ""}" data-sub="${cs.id}-${c.name}">
<div class="ch-head"><span class="ch-g" style="color:${sk ? "#555" : gc(c.grade)}">${sk ? "\u2014" : c.grade}</span><div><b>${e(meta.label)}</b><span class="ch-s">${sk ? "skipped" : `${c.score}/100`} \u00b7 weight ${meta.weight}% \u00b7 ${c.duration}ms \u00b7 ${c.issues.length} issues</span></div><span class="pri" style="color:${pc(meta.priority)}">${meta.priority}</span></div>
${meta.description ? `<div class="info-panel"><div class="ip-row"><span class="ip-label">What</span><span>${e(meta.description)}</span></div><div class="ip-row"><span class="ip-label">Risk</span><span>${e(meta.risk)}</span></div><div class="ip-row"><span class="ip-label">Fix</span><span>${e(meta.recommendation)}</span></div></div>` : ""}
${sk ? `<p class="skip-r">${e(det(c).reason || "skipped")}</p>` : ""}
${c.name === "architecture" && !sk ? `${(c.details as Record<string, unknown>).containerSvg ? `<h3 style="margin-top:1.5rem">Container Diagram</h3><div class="arch-svg">${(c.details as Record<string, unknown>).containerSvg}</div>` : ""}<h3 style="margin-top:1.5rem">Dependency Graph</h3><div class="arch-svg">${generateArchSVG(c.details)}</div><h3 style="margin-top:1.5rem">Sequence Diagram</h3><div class="arch-svg">${generateSequenceDiagram(c.details)}</div><h3 style="margin-top:1.5rem">Package Diagram</h3><div class="arch-svg">${generatePackageDiagram(c.details)}</div><h3 style="margin-top:1.5rem">Dependency Matrix (DSM)</h3><div class="arch-svg">${generateDSM(c.details)}</div>` : ""}
${c.name === "testing" && !sk && det(c).pyramid ? `<div class="arch-svg">${buildPyramid(det(c).pyramid as { unit: number; integration: number; component: number; e2e: number })}</div>` : ""}
${detailsFiltered ? `<div class="kvs">${detailsFiltered}</div>` : ""}
${issuesHtml ? `<div class="iss-list">${issuesHtml}</div>` : '<p style="color:var(--muted);font-size:0.8rem;margin-top:1rem">No issues found.</p>'}
</div>`;
		})
		.join("");

	const clr = gc(cs.avg >= 90 ? "A" : cs.avg >= 75 ? "B" : cs.avg >= 60 ? "C" : cs.avg >= 40 ? "D" : "F");
	return `
<div class="cat-head"><span style="color:${clr};font-size:1.8rem;font-weight:900">${cs.avg}</span><span style="color:${clr}">/100</span><span style="color:var(--muted);margin-left:0.5rem">${cs.label}</span></div>
<div class="bar2"><div class="bf2" style="width:${cs.avg}%;background:${clr}"></div></div>
<div class="sub-nav">${subNav}</div>
${subPages}`;
}

// ── Issues view ──────────────────────────────────────────

export function issuesPage(allChecks: CheckResult[], totalIssues: number, fl: FL): string {
	const allIssues = allChecks.flatMap((c) => c.issues.map((i) => ({ check: c.name, ...i })));
	const errorCount = allIssues.filter((i) => i.severity === "error").length;
	const warnCount = allIssues.filter((i) => i.severity === "warning").length;
	const infoCount = allIssues.filter((i) => i.severity === "info").length;

	const issueRows = allIssues
		.sort(
			(a, b) =>
				(a.severity === "error" ? 0 : a.severity === "warning" ? 1 : 2) - (b.severity === "error" ? 0 : b.severity === "warning" ? 1 : 2),
		)
		.slice(0, 200)
		.map((i) => {
			const loc = i.file ? fl(i.file.split(":")[0]!, i.line) : "";
			return `<tr class="${i.severity}"><td class="is2">${i.severity[0]!.toUpperCase()}</td><td class="ic2">${e(i.check)}</td><td class="il2">${loc}</td><td>${e(i.message)}</td><td class="iru2">${e(i.rule || "")}</td></tr>`;
		})
		.join("");

	return `
<h2>All Issues <span style="color:var(--muted);font-weight:400">${totalIssues}</span></h2>
<div class="isf"><span style="color:var(--fail)">${errorCount} errors</span> \u00b7 <span style="color:var(--warn)">${warnCount} warnings</span>${infoCount > 0 ? ` \u00b7 <span style="color:var(--info)">${infoCount} info</span>` : ""}</div>
<table class="it"><thead><tr><th></th><th>Check</th><th>Location</th><th>Message</th><th>Rule</th></tr></thead><tbody>${issueRows}</tbody></table>
${allIssues.length > 200 ? `<p style="color:var(--muted);text-align:center;margin-top:1rem">Showing 200 of ${allIssues.length}</p>` : ""}`;
}

// ── Files view ───────────────────────────────────────────

export function filesPage(
	topFiles: FileEntry[],
	fileIssues: Map<string, { errors: number; warnings: number; checks: Set<string> }>,
	fl: FL,
): string {
	if (topFiles.length === 0) {
		return `<h2>File Health</h2><p style="color:var(--muted)">No file-level issues found.</p>`;
	}

	const maxIssues = Math.max(...topFiles.map((f) => f.total));
	const heatmapRows = topFiles
		.slice(0, 30)
		.map((f) => {
			const intensity = maxIssues > 0 ? f.total / maxIssues : 0;
			const r = Math.round(239 * intensity);
			const g = Math.round(68 * (1 - intensity) + 197 * (f.errors === 0 ? 0.3 : 0));
			const color = `rgb(${r},${g},30)`;
			const barW = Math.max(4, Math.round(intensity * 200));
			return `<div class="hm-row"><span class="hm-name">${fl(f.file)}</span><div class="hm-bar" style="width:${barW}px;background:${color}" title="${f.total} issues (${f.checks.join(", ")})"></div><span class="hm-count">${f.errors}E ${f.warnings}W</span><span class="hm-checks">${f.checks.join(", ")}</span></div>`;
		})
		.join("");

	return `
<h2>File Health</h2>
<p style="color:var(--muted);font-size:0.78rem;margin-bottom:1rem">${fileIssues.size} files with issues across ${
		topFiles.reduce((s, f) => {
			for (const c of f.checks) s.add(c);
			return s;
		}, new Set<string>()).size
	} checks.</p>
${heatmapRows}`;
}

// ── Trends page ──────────────────────────────────────────

export function trendsPage(historyDir: string | undefined): string {
	if (!historyDir) {
		return `<h2>Trends</h2><p class="muted">No history data yet. Run the scanner multiple times to see trends.</p>`;
	}

	const history = loadHistory(historyDir);
	if (history.length < 2) {
		return `<h2>Trends</h2><p class="muted">Need at least 2 scans to show trends. Run the scanner again.</p>`;
	}

	// Overall score timeline (large)
	const overallChart = buildTimeline(
		history.map((h) => ({ score: h.score, timestamp: h.timestamp })),
		{ width: 700, height: 150 },
	);

	// Collect all check names from latest entry
	const latest = history[history.length - 1];
	const checkNames = [...latest.checkScores.keys()];

	// Per-check mini charts
	const checkCharts = checkNames
		.map((name) => {
			const data = history
				.map((h) => ({ score: h.checkScores.get(name) ?? 0, timestamp: h.timestamp }))
				.filter((d) => d.score > 0);
			if (data.length < 2) return "";

			const current = data[data.length - 1].score;
			const prev = data[data.length - 2].score;
			const delta = current - prev;
			const deltaStr = delta > 0 ? `<span style="color:var(--pass)">+${delta}</span>` : delta < 0 ? `<span style="color:var(--fail)">${delta}</span>` : `<span class="muted">=</span>`;
			const color = current >= 90 ? "var(--pass)" : current >= 75 ? "#84cc16" : current >= 60 ? "var(--warn)" : "var(--fail)";

			const chart = buildTimeline(data, { width: 300, height: 60 });

			return `<div class="trend-card">
<div class="trend-header"><span class="trend-name">${name}</span><span class="trend-score" style="color:${color}">${current}</span>${deltaStr}</div>
<div class="trend-chart">${chart}</div>
</div>`;
		})
		.filter(Boolean)
		.join("");

	// Score delta table
	const deltaRows = checkNames
		.map((name) => {
			const scores = history.map((h) => h.checkScores.get(name) ?? 0);
			const first = scores.find((s) => s > 0) ?? 0;
			const last = scores[scores.length - 1];
			const delta = last - first;
			if (first === 0 && last === 0) return "";
			return { name, first, last, delta };
		})
		.filter(Boolean)
		.sort((a, b) => (b as { delta: number }).delta - (a as { delta: number }).delta) as { name: string; first: number; last: number; delta: number }[];

	const deltaTable = deltaRows
		.map((r) => {
			const clr = r.delta > 0 ? "var(--pass)" : r.delta < 0 ? "var(--fail)" : "var(--muted)";
			return `<div class="trend-row"><span class="trend-row-name">${r.name}</span><span class="trend-row-val">${r.first}</span><span class="trend-row-arrow">\u2192</span><span class="trend-row-val">${r.last}</span><span class="trend-row-delta" style="color:${clr}">${r.delta > 0 ? "+" : ""}${r.delta}</span></div>`;
		})
		.join("");

	return `
<h2>Trends</h2>
<p class="muted" style="font-size:0.78rem;margin-bottom:1.5rem">${history.length} scans from ${history[0].timestamp.split("T")[0]} to ${latest.timestamp.split("T")[0]}</p>

<h3>Overall Score</h3>
<div class="timeline">${overallChart}</div>

<h3 style="margin-top:2rem">Score Changes (first \u2192 latest)</h3>
<div class="trend-table">${deltaTable}</div>

<h3 style="margin-top:2rem">Per-Check Trends</h3>
<div class="trend-grid">${checkCharts}</div>`;
}
