/** Generate a multi-page HTML report as separate files.
 *
 * Layout:
 *   Top nav:    Logo | Overview | Foundations | Quality | ... | Issues | Files
 *               Page-level navigation. Scrollable on mobile.
 *   Sidebar:    CONTEXTUAL to current page — NOT a duplicate of top nav.
 *               Overview: score + category scores
 *               Category: individual checks with grades (click to jump)
 *               Issues: severity breakdown
 *               Files: summary stats
 *   Mobile:     Hamburger toggles both top nav dropdown and sidebar panel.
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

	const catScores: CatScore[] = GROUPS.map((g) => {
		const checks = g.checks.map((n) => checkMap.get(n)).filter(Boolean) as CheckResult[];
		const scored = checks.filter((c) => !(c.details as any).skipped);
		const avg = scored.length > 0 ? Math.round(scored.reduce((s, c) => s + c.score, 0) / scored.length) : 0;
		return { ...g, avg, checks };
	});

	const w = (id: string, sidebar: string, content: string) => wrap(proj, id, report, totalIssues, sidebar, content);

	// ── Overview: sidebar shows score + category summary ──
	const overviewSidebar = sidebarScore(report)
		+ catScores.map((cs) => {
			const isPremium = cs.checks.every((c) => (c.details as any).comingSoon);
			const clr = isPremium ? "#6366f1" : gc(cs.avg >= 90 ? "A" : cs.avg >= 75 ? "B" : cs.avg >= 60 ? "C" : cs.avg >= 40 ? "D" : "F");
			const label = isPremium
				? `<span class="pro-badge" style="font-size:0.5rem;padding:0.08rem 0.35rem">PRO</span>`
				: `<span style="color:${clr}">${cs.avg}</span>`;
			return `<a class="side-cat" href="${cs.file}">${cs.label} ${label}</a>`;
		}).join("")
		+ sidebarViews(totalIssues, fileIssues.size);

	pages.set("index.html", w("overview", overviewSidebar,
		overviewPage(report, active, totalIssues, catScores, allChecks, topFiles, fl, historyDir)));

	// ── Category pages: sidebar shows the checks within this category ──
	for (let i = 0; i < GROUPS.length; i++) {
		const g = GROUPS[i];
		const cs = catScores[i];
		const catSidebar = sidebarScore(report)
			+ `<div class="side-section"><div class="side-cat-title">${cs.label}</div>`
			+ cs.checks.map((c) => {
				const sk = (c.details as any).skipped;
				const premium = (c.details as any).comingSoon;
				const meta = getCheckMeta(c.name);
				const badge = premium ? `<span style="color:#6366f1">PRO</span>` : `<span style="color:${sk ? "#555" : gc(c.grade)}">${sk ? "\u2014" : c.grade} ${sk ? "" : c.score}</span>`;
				return `<a class="side-check" onclick="var t=document.querySelector('[data-sub=\\'${cs.id}-${c.name}\\']');if(t)sub(t,'${cs.id}')" title="${e(meta.label)}">${badge} ${e(meta.label)}</a>`;
			}).join("")
			+ `</div>`
			+ sidebarViews(totalIssues, fileIssues.size);
		pages.set(g.file, w(g.id, catSidebar, categoryPage(cs, fl)));
	}

	// ── Issues: sidebar shows severity breakdown ──
	const allIssuesList = allChecks.flatMap((c) => c.issues);
	const errCount = allIssuesList.filter((i) => i.severity === "error").length;
	const warnCount = allIssuesList.filter((i) => i.severity === "warning").length;
	const infoCount = allIssuesList.filter((i) => i.severity === "info").length;
	const issuesSidebar = sidebarScore(report)
		+ `<div class="side-section"><div class="side-cat-title">Breakdown</div>`
		+ `<div class="side-stat"><span style="color:var(--fail)">${errCount}</span> errors</div>`
		+ `<div class="side-stat"><span style="color:var(--warn)">${warnCount}</span> warnings</div>`
		+ `<div class="side-stat"><span style="color:var(--info)">${infoCount}</span> info</div>`
		+ `</div>`
		+ sidebarViews(totalIssues, fileIssues.size);
	pages.set("issues.html", w("issues", issuesSidebar, issuesPage(allChecks, totalIssues, fl)));

	// ── Files: sidebar shows file stats ──
	const filesSidebar = sidebarScore(report)
		+ `<div class="side-section"><div class="side-cat-title">File Health</div>`
		+ `<div class="side-stat"><span style="color:var(--text)">${fileIssues.size}</span> files with issues</div>`
		+ `<div class="side-stat"><span style="color:var(--fail)">${topFiles.filter(f => f.errors > 0).length}</span> with errors</div>`
		+ `</div>`
		+ sidebarViews(totalIssues, fileIssues.size);
	pages.set("files.html", w("files", filesSidebar, filesPage(topFiles, fileIssues, fl)));

	return pages;
}

export function generateHTML(report: VibeReport, historyDir?: string): string {
	return generatePages(report, historyDir).get("index.html")!;
}

// ── Sidebar fragments ──

function sidebarScore(report: VibeReport): string {
	return `<div class="side-section"><div class="side-label">Score</div><div class="side-score" style="color:${gc(report.grade)}">${report.grade} ${report.score}</div></div>`;
}

function sidebarViews(totalIssues: number, fileCount: number): string {
	return `<div class="side-section side-views"><div class="side-label" style="margin-top:0.3rem">Views</div><a class="side-check" href="issues.html">Issues <span style="color:var(--muted)">${totalIssues}</span></a><a class="side-check" href="files.html">Files <span style="color:var(--muted)">${fileCount}</span></a></div>`;
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
