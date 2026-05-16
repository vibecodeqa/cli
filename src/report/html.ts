/** Generate a multi-page HTML report as separate files.
 *
 * Layout:
 *   Top nav:    Logo | Overview | Foundations | Quality | ... | Issues | Files  (scrollable)
 *   Sidebar:    Score + dimension tree with individual check grades + views links
 *   Content:    Page-specific content (offset by sidebar width)
 *   Mobile:     Hamburger button toggles both top nav links and sidebar
 *
 * Each file is a standalone HTML document with consistent nav + sidebar + CSS.
 */

import { getCheckMeta } from "../check-meta.js";
import type { CheckResult, VibeReport } from "../types.js";
import { e, fileLink, gc } from "./components.js";
import { categoryPage, filesPage, issuesPage, overviewPage, type CatScore } from "./pages.js";
import { CSS } from "./styles.js";

export const GROUPS: { id: string; label: string; file: string; checks: string[] }[] = [
	{ id: "foundations", label: "Foundations", file: "foundations.html", checks: ["structure", "lint", "types", "type-safety", "standards"] },
	{ id: "quality", label: "Quality", file: "quality.html", checks: ["complexity", "duplication", "error-handling", "react", "accessibility", "docs"] },
	{ id: "testing", label: "Testing", file: "testing.html", checks: ["testing"] },
	{ id: "arch", label: "Architecture", file: "architecture.html", checks: ["architecture", "performance"] },
	{ id: "security", label: "Security", file: "security.html", checks: ["secrets", "security", "dependencies"] },
	{ id: "llm", label: "AI Readiness", file: "ai-readiness.html", checks: ["confusion", "context"] },
	{ id: "ai", label: "AI Analysis", file: "ai-analysis.html", checks: ["doc-coherence", "code-coherence"] },
];

/** Generate all HTML pages. Returns Map<filename, html>. */
export function generatePages(report: VibeReport, historyDir?: string): Map<string, string> {
	const pages = new Map<string, string>();
	const allChecks = report.checks;
	const checkMap = new Map(allChecks.map((c) => [c.name, c]));
	const active = allChecks.filter((c) => !(c.details as any).skipped && !(c.details as any).comingSoon);
	const ru = report.meta.repoUrl;
	const br = report.meta.branch;
	const fl = (path: string, line?: number) => fileLink(path, line, ru, br);
	const totalIssues = allChecks.reduce((s, c) => s + c.issues.length, 0);
	const proj = report.meta.cwd.split("/").pop() || "project";

	// ── Aggregate file issues ──
	const fileIssues = new Map<string, { errors: number; warnings: number; checks: Set<string> }>();
	for (const c of allChecks) {
		for (const iss of c.issues) {
			if (!iss.file) continue;
			const f = iss.file.split(":")[0]!;
			const entry = fileIssues.get(f) || { errors: 0, warnings: 0, checks: new Set() };
			if (iss.severity === "error") entry.errors++;
			else entry.warnings++;
			entry.checks.add(c.name);
			fileIssues.set(f, entry);
		}
	}
	const topFiles = [...fileIssues.entries()]
		.map(([file, d]) => ({ file, total: d.errors + d.warnings, errors: d.errors, warnings: d.warnings, checks: [...d.checks] }))
		.sort((a, b) => b.total - a.total)
		.slice(0, 30);

	// ── Category scores ──
	const catScores: CatScore[] = GROUPS.map((g) => {
		const checks = g.checks.map((n) => checkMap.get(n)).filter(Boolean) as CheckResult[];
		const scored = checks.filter((c) => !(c.details as any).skipped);
		const avg = scored.length > 0 ? Math.round(scored.reduce((s, c) => s + c.score, 0) / scored.length) : 0;
		return { ...g, avg, checks };
	});

	// ── Build sidebar HTML (shared across all pages) ──
	const sidebar = buildSidebar(report, catScores, totalIssues, fileIssues.size);

	// ── Generate pages ──
	const w = (id: string, content: string) => wrap(proj, id, report, totalIssues, sidebar, content);

	pages.set("index.html", w("overview",
		overviewPage(report, active, totalIssues, catScores, allChecks, topFiles, fl, historyDir)));

	for (let i = 0; i < GROUPS.length; i++) {
		const g = GROUPS[i];
		const cs = catScores[i];
		pages.set(g.file, w(g.id, categoryPage(cs, fl)));
	}

	pages.set("issues.html", w("issues", issuesPage(allChecks, totalIssues, fl)));
	pages.set("files.html", w("files", filesPage(topFiles, fileIssues, fl)));

	return pages;
}

/** For backwards compat — generate single file with all pages embedded. */
export function generateHTML(report: VibeReport, historyDir?: string): string {
	const pages = generatePages(report, historyDir);
	return pages.get("index.html")!;
}

// ── Sidebar builder ──

function buildSidebar(report: VibeReport, catScores: CatScore[], totalIssues: number, fileCount: number): string {
	const sidebarDims = catScores
		.map((cs) => {
			const isPremium = cs.checks.every((c) => (c.details as any).comingSoon);
			const clr = isPremium ? "#6366f1" : gc(cs.avg >= 90 ? "A" : cs.avg >= 75 ? "B" : cs.avg >= 60 ? "C" : cs.avg >= 40 ? "D" : "F");
			const scoreLabel = isPremium
				? `<span class="pro-badge" style="font-size:0.5rem;padding:0.08rem 0.35rem">PRO</span>`
				: `<span style="color:${clr}">${cs.avg}</span>`;
			const checkLinks = cs.checks
				.map((c) => {
					const sk = (c.details as any).skipped;
					const premium = (c.details as any).comingSoon;
					const meta = getCheckMeta(c.name);
					const badge = premium ? `<span style="color:#6366f1">PRO</span>` : `<span style="color:${sk ? "#555" : gc(c.grade)}">${sk ? "\u2014" : c.grade}</span>`;
					return `<a class="side-check" href="${cs.file}" title="${e(meta.label)}">${badge} ${e(meta.label)}</a>`;
				})
				.join("");
			return `<div class="side-section"><a class="side-cat" href="${cs.file}">${cs.label} ${scoreLabel}</a>${checkLinks}</div>`;
		})
		.join("");

	const sidebarViews = `<div class="side-section side-views"><div class="side-views-label">Views</div><a class="side-check" href="issues.html">Issues <span style="color:var(--muted)">${totalIssues}</span></a><a class="side-check" href="files.html">Files <span style="color:var(--muted)">${fileCount}</span></a></div>`;

	return `
  <div class="side-section">Score<div class="side-score" style="color:${gc(report.grade)}">${report.grade} ${report.score}</div></div>
  ${sidebarDims}
  ${sidebarViews}`;
}

// ── Page wrapper ──

function wrap(proj: string, currentId: string, report: VibeReport, totalIssues: number, sidebar: string, content: string): string {
	const navItems = [
		{ id: "overview", label: "Overview", file: "index.html" },
		...GROUPS.map((g) => ({ id: g.id, label: g.label, file: g.file })),
		{ id: "issues", label: `Issues (${totalIssues})`, file: "issues.html" },
		{ id: "files", label: "Files", file: "files.html" },
	];

	const nav = navItems
		.map((t) => `<a class="tn${t.id === currentId ? " active" : ""}" href="${t.file}">${t.label}</a>`)
		.join("");

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>VibeCode QA \u2014 ${e(proj)}</title>
<style>${CSS}</style>
</head>
<body>

<nav class="top">
  <a class="logo" href="index.html"><span>VibeCode</span> QA</a>
  <button class="hamburger" onclick="toggleMenu()" aria-label="Menu">&#9776;</button>
  <div class="nav-scroll">${nav}</div>
</nav>

<aside class="side" id="sidebar">${sidebar}</aside>

<div class="content">
  ${content}
  <div class="footer">Generated by <a href="https://vibecodeqa.online">VibeCode QA</a> v${report.version} &mdash; <code>npx @vibecodeqa/cli</code></div>
</div>

<script>
function toggleMenu(){
  document.querySelector('.nav-scroll').classList.toggle('open');
  document.getElementById('sidebar').classList.toggle('open');
}
function sub(el,cat){
  const id=el.dataset.sub;
  el.parentElement.querySelectorAll('.sn').forEach(n=>n.classList.remove('active'));
  el.classList.add('active');
  document.querySelectorAll('.sp').forEach(s=>{s.classList.toggle('active',s.dataset.sub===id)});
}
document.addEventListener('click',function(ev){
  var btn=ev.target.closest('.cp-btn');
  if(!btn)return;
  var text=btn.dataset.prompt||'';
  try{navigator.clipboard.writeText(text)}catch(e){var ta=document.createElement('textarea');ta.value=text;ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta)}
  btn.textContent='\\u2713';setTimeout(function(){btn.textContent='\\ud83d\\udccb'},1000);
});
</script>
</body></html>`;
}
