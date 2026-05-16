/** Generate a multi-page HTML report as separate files.
 *
 * Produces:
 *   index.html          — Overview dashboard
 *   foundations.html     — Foundations checks
 *   quality.html         — Quality checks
 *   testing.html         — Testing check
 *   architecture.html    — Architecture + Performance checks
 *   security.html        — Security checks
 *   ai-readiness.html    — LLM readiness checks
 *   ai-analysis.html     — Premium AI checks
 *   issues.html          — All issues table
 *   files.html           — File health heatmap
 *
 * Each file is a standalone HTML document with shared nav + CSS.
 * No sidebar — top nav is the only navigation.
 */

import type { CheckResult, VibeReport } from "../types.js";
import { e, fileLink } from "./components.js";
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

	// ── Generate pages ──
	pages.set("index.html", wrap(proj, "overview", report, totalIssues,
		overviewPage(report, active, totalIssues, catScores, allChecks, topFiles, fl, historyDir)));

	for (let i = 0; i < GROUPS.length; i++) {
		const g = GROUPS[i];
		const cs = catScores[i];
		pages.set(g.file, wrap(proj, g.id, report, totalIssues, categoryPage(cs, fl)));
	}

	pages.set("issues.html", wrap(proj, "issues", report, totalIssues, issuesPage(allChecks, totalIssues, fl)));
	pages.set("files.html", wrap(proj, "files", report, totalIssues, filesPage(topFiles, fileIssues, fl)));

	return pages;
}

/** For backwards compat — generate single file with all pages embedded. */
export function generateHTML(report: VibeReport, historyDir?: string): string {
	const pages = generatePages(report, historyDir);
	return pages.get("index.html")!;
}

function wrap(proj: string, currentId: string, report: VibeReport, totalIssues: number, content: string): string {
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
  <div class="nav-scroll">${nav}</div>
</nav>

<div class="content">
  ${content}
  <div class="footer">Generated by <a href="https://vibecodeqa.online">VibeCode QA</a> v${report.version} &mdash; <code>npx @vibecodeqa/cli</code></div>
</div>

<script>
function sub(el,cat){
  const id=el.dataset.sub;
  el.parentElement.querySelectorAll('.sn').forEach(n=>n.classList.remove('active'));
  el.classList.add('active');
  document.querySelectorAll('.sp').forEach(s=>{s.classList.toggle('active',s.dataset.sub===id)});
}
// Copy-prompt buttons
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
