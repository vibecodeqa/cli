/** Page renderers for the HTML report. */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type CheckMeta, getCheckMeta } from "../check-meta.js";
import { suggestFix } from "../commands/shared.js";
import type { ScanDelta } from "../delta.js";
import { buildCoverageMapInput, generateCoverageMap } from "../diagrams/coverage.js";
import { loadHistory } from "../history.js";
import {
	generateArchSVG,
	generateDSM,
	generateLayerDiagram,
	generatePackageDiagram,
	generateSequenceDiagram,
} from "../runners/architecture.js";
import type { FeatureCluster } from "../runners/dead-patterns.js";
import type { CheckResult, ProjectContext, ProjectDiscoveryEvidence, VibeReport } from "../types.js";
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

function scoreModeLabel(check: CheckResult, meta: CheckMeta): string {
	const mode = det(check).scoreMode;
	if (mode === "not-applicable") return "not applicable";
	if (mode === "unavailable") return "unavailable";
	if (mode === "available-unscored") return "advisory";
	if (mode === "available-scored") return `scored · weight ${meta.weight}%`;
	if (meta.weight <= 0) return "advisory";
	return `scored · weight ${meta.weight}%`;
}

function stackLabel(project: ProjectContext): string {
	return [project.stack.language, project.stack.framework, project.stack.bundler, project.stack.testRunner, project.stack.linter]
		.filter((v) => v && v !== "none" && v !== "unknown")
		.join(" · ");
}

function evidenceLocation(ev: ProjectDiscoveryEvidence): string {
	return ev.file ?? ev.path ?? ev.value ?? "";
}

function renderEvidenceChips(evidence: ProjectDiscoveryEvidence[]): string {
	return evidence
		.map((ev) => {
			const loc = evidenceLocation(ev);
			return `<span class="ws-ev${ev.kind === "rejected" ? " ws-ev-rejected" : ""}"><b>${e(ev.kind)}</b>${loc ? `<code>${e(loc)}</code>` : ""}<small>${e(ev.description)}</small></span>`;
		})
		.join("");
}

function renderScopeValue(value: unknown): string {
	if (Array.isArray(value)) {
		if (value.length === 0) return `<span class="scope-empty">none</span>`;
		return value.map((item) => `<code>${e(String(item))}</code>`).join("");
	}
	if (value === undefined || value === null || value === "") return `<span class="scope-empty">none</span>`;
	return `<span>${e(String(value))}</span>`;
}

function renderScopeRow(label: string, value: unknown): string {
	return `<div class="scope-row"><span class="scope-k">${e(label)}</span><span class="scope-v">${renderScopeValue(value)}</span></div>`;
}

function scopePayload(report: VibeReport): string {
	const workspace = report.meta.workspace;
	const projects = workspace?.projects ?? [];
	return JSON.stringify(
		{
			timestamp: report.timestamp,
			cwd: report.meta.cwd,
			stack: report.meta.stack,
			filesScanned: report.meta.filesScanned,
			workspace: workspace
				? {
						isMonorepo: workspace.isMonorepo,
						tool: workspace.tool,
						srcRoots: workspace.srcRoots,
						packages: workspace.packages,
						discovery: workspace.discovery,
						projects: projects.map((project) => ({
							id: project.id,
							name: project.name,
							path: project.path,
							kind: project.kind,
							stack: project.stack,
							srcRoots: project.srcRoots,
							testRoots: project.testRoots,
							configFiles: project.configFiles,
							manifestFiles: project.manifestFiles,
							confidence: project.confidence,
							evidence: project.evidence,
							toolCommands: project.toolCommands,
						})),
					}
				: null,
			scanPolicy: report.meta.scanPolicy ?? null,
			fileInventory: report.meta.fileInventory ?? null,
		},
		null,
		2,
	);
}

/** Read source lines around an issue for inline display in the report. */
function readSourceSnippet(cwd: string, file: string, line: number, radius = 4): string | null {
	try {
		const fullPath = join(cwd, file);
		if (!existsSync(fullPath)) return null;
		const content = readFileSync(fullPath, "utf-8");
		const lines = content.split("\n");
		const target = line - 1;
		const start = Math.max(0, target - radius);
		const end = Math.min(lines.length, target + radius + 1);
		let html = "";
		for (let i = start; i < end; i++) {
			const num = String(i + 1).padStart(4);
			const hl = i === target;
			const cls = hl ? "src-hl" : "src-ln";
			html += `<div class="${cls}"><span class="src-num">${num}</span>${e(lines[i])}</div>`;
		}
		return html;
	} catch {
		return null;
	}
}

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
					return `<span class="mc" style="color:${sk ? "var(--dim)" : gc(c.grade)}" title="${e(c.name)}: ${sk ? "skip" : c.score}">${sk ? "\u2014" : c.grade}</span>`;
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
				const loc = i.file && typeof i.file === "string" ? fl(i.file.split(":")[0]!, i.line) : "";
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

	// Workspace / repo understanding section
	let repoUnderstandingHtml = "";
	const ws = report.meta.workspace;
	if (ws?.projects?.length) {
		const mode = ws.discovery?.mode ?? (ws.isMonorepo ? "manifest" : "single");
		const evidenceRows = (ws.discovery?.evidence ?? [])
			.map((ev) => {
				const loc = ev.file ?? ev.path ?? ev.value ?? "";
				return `<span class="ws-ev"><b>${e(ev.kind)}</b>${loc ? `<code>${e(loc)}</code>` : ""}<small>${e(ev.description)}</small></span>`;
			})
			.join("");
		const projectRows = ws.projects
			.slice(0, 12)
			.map((p) => {
				const stack = [p.stack.language, p.stack.framework, p.stack.bundler, p.stack.testRunner, p.stack.linter]
					.filter((v) => v && v !== "none" && v !== "unknown")
					.join(" · ");
				const meta = `${p.manifestFiles.length} manifest · ${p.configFiles.length} config · ${p.srcRoots.length} src`;
				return `<div class="ws-project"><span class="ws-path">${e(p.path === "." ? "repo root" : p.path)}</span><span class="ws-name">${e(p.kind)}</span><span class="ws-stack">${e(stack || "unknown")}</span><span class="ws-flags">${e(meta)}</span></div>`;
			})
			.join("");
		const more = ws.projects.length > 12 ? `<div class="ws-more">...and ${ws.projects.length - 12} more projects</div>` : "";
		repoUnderstandingHtml = `<div class="ov-section"><h3>Repository Structure</h3>
<div class="ws-info">
  <div class="ws-badge">${ws.isMonorepo ? "Monorepo" : "Single Project"}</div>
  <span>Discovery: <b>${e(mode)}</b></span>
  <span>Tool: <b>${ws.tool}</b></span>
  <span>Projects: <b>${ws.projects.length}</b></span>
  <span>Source roots: <b>${ws.srcRoots.length}</b></span>
</div>
${evidenceRows ? `<div class="ws-evidence">${evidenceRows}</div>` : ""}
<div class="ws-pkgs">${projectRows}${more}</div></div>`;
	} else if (ws?.isMonorepo) {
		const pkgRows = ws.packages
			.slice(0, 12)
			.map((p) => {
				const flags = [p.hasSrc && "src", p.hasTests && "tests", p.hasLinter && "linter"].filter(Boolean).join(", ");
				return `<div class="ws-pkg"><span class="ws-path">${e(p.path)}</span><span class="ws-name">${e(p.name)}</span><span class="ws-flags">${flags || "empty"}</span></div>`;
			})
			.join("");
		const more = ws.packages.length > 12 ? `<div class="ws-more">...and ${ws.packages.length - 12} more packages</div>` : "";
		repoUnderstandingHtml = `<div class="ov-section"><h3>Repository Structure</h3>
<div class="ws-info">
  <div class="ws-badge">Monorepo</div>
  <span>Tool: <b>${ws.tool}</b></span>
  <span>Packages: <b>${ws.packages.length}</b></span>
  <span>Source roots: <b>${ws.srcRoots.length}</b></span>
</div>
<div class="ws-pkgs">${pkgRows}${more}</div></div>`;
	} else {
		repoUnderstandingHtml = `<div class="ov-section"><h3>Repository Structure</h3>
<div class="ws-info"><div class="ws-badge">Single Package</div></div></div>`;
	}

	return `
<div class="dash">
  ${hero}
  <div class="radar">${radarSvg}</div>
</div>
<div class="cats">${catCards}</div>
${repoUnderstandingHtml}
${timelineSection}
<div class="ov-section"><h3>All Checks</h3><div class="bars">${barChart}</div></div>
${topIssuesHtml}
${fileHotspotsHtml}
<div class="stack">${stackHtml}</div>`;
}

// ── Scan scope / discovery evidence page ──────────────────────────

export function scanScopePage(report: VibeReport): string {
	const ws = report.meta.workspace;
	const projects = ws?.projects ?? [];
	const discoveryEvidence = ws?.discovery?.evidence ?? [];
	const acceptedEvidence = discoveryEvidence.filter((ev) => ev.kind !== "rejected");
	const rejectedEvidence = discoveryEvidence.filter((ev) => ev.kind === "rejected");
	const policy = report.meta.scanPolicy ?? {};
	const inventory = report.meta.fileInventory ?? {};
	const payload = scopePayload(report);

	const overviewRows = [
		renderScopeRow("Discovery mode", ws?.discovery?.mode ?? (ws?.isMonorepo ? "manifest" : "single")),
		renderScopeRow("Workspace tool", ws?.tool ?? "none"),
		renderScopeRow("Projects accepted", projects.length),
		renderScopeRow("Packages", ws?.packages.length ?? 0),
		renderScopeRow("Source roots", ws?.srcRoots ?? []),
		renderScopeRow("Files scanned", report.meta.filesScanned ?? "unknown"),
	].join("");

	const acceptedRows = acceptedEvidence.length
		? `<div class="ws-evidence scope-evidence">${renderEvidenceChips(acceptedEvidence)}</div>`
		: `<p class="muted scope-note">No workspace-level acceptance evidence was recorded.</p>`;

	const projectCards = projects.length
		? projects.map((project) => renderProjectScopeCard(project)).join("")
		: `<p class="muted scope-note">No project contexts were recorded.</p>`;

	const rejectedRows = rejectedEvidence.length
		? rejectedEvidence
				.map((ev) => {
					const loc = evidenceLocation(ev) || "unknown";
					return `<div class="scope-rejected"><span class="scope-path">${e(loc)}</span><span class="scope-status scope-unavailable">skipped / unavailable</span><span class="scope-reason">${e(ev.description)}</span></div>`;
				})
				.join("")
		: `<p class="muted scope-note">No rejected discovery candidates were recorded.</p>`;

	const policyRows = [
		renderScopeRow("Policy version", policy["version"]),
		renderScopeRow("Ignore hidden directories", policy["ignoreHiddenDirectories"]),
		renderScopeRow(
			"Default directory excludes",
			policy["defaultDirectoryNameValues"] ?? `${policy["defaultDirectoryNames"] ?? 0} configured`,
		),
		renderScopeRow("Default file excludes", policy["defaultFilePatternValues"] ?? `${policy["defaultFilePatterns"] ?? 0} configured`),
		renderScopeRow("Generated path prefixes", policy["generatedPathPrefixValues"] ?? `${policy["generatedPathPrefixes"] ?? 0} configured`),
		renderScopeRow("Config ignores", policy["configIgnorePatternValues"] ?? `${policy["configIgnorePatterns"] ?? 0} configured`),
		renderScopeRow("User ignores", policy["userIgnoreNameValues"] ?? `${policy["userIgnoreNames"] ?? 0} configured`),
		renderScopeRow("Env ignores", policy["envIgnoreNameValues"] ?? `${policy["envIgnoreNames"] ?? 0} configured`),
		renderScopeRow(
			"Gitignore directory excludes",
			policy["gitignoreDirectoryNameValues"] ?? `${policy["gitignoreDirectoryNames"] ?? 0} configured`,
		),
	].join("");

	const inventoryRows = [
		renderScopeRow("Total files", inventory["totalFiles"]),
		renderScopeRow("Included files", inventory["includedFiles"]),
		renderScopeRow("Ignored files", inventory["ignoredFiles"]),
		renderScopeRow("Ignored directories", inventory["ignoredDirectories"]),
		renderScopeRow("Generated files", inventory["generatedFiles"]),
		renderScopeRow("Security-sensitive files", inventory["securitySensitiveFiles"]),
		renderScopeRow("Kinds", inventory["byKind"] ? JSON.stringify(inventory["byKind"]) : undefined),
	].join("");

	return `
<div class="scope-head">
  <div>
    <h2>Scan Scope</h2>
    <p class="muted">Deterministic repository discovery evidence, accepted projects, skipped candidates, and effective scan settings.</p>
  </div>
  <button class="cp-btn scope-copy" data-prompt="${e(payload)}" title="Copy deterministic discovery evidence JSON">Copy JSON</button>
</div>

<section class="scope-section">
  <h3>Discovery Summary</h3>
  <div class="scope-table">${overviewRows}</div>
  ${acceptedRows}
</section>

<section class="scope-section">
  <h3>Accepted Projects</h3>
  <div class="scope-projects">${projectCards}</div>
</section>

<section class="scope-section">
  <h3>Rejected Candidates</h3>
  <div class="scope-rejected-list">${rejectedRows}</div>
</section>

<section class="scope-section">
  <h3>Effective Scan Policy</h3>
  <div class="scope-table">${policyRows}</div>
</section>

<section class="scope-section">
  <h3>File Inventory</h3>
  <div class="scope-table">${inventoryRows}</div>
</section>

<section class="scope-section">
  <h3>Evidence Payload</h3>
  <pre class="scope-json">${e(payload)}</pre>
</section>`;
}

function renderProjectScopeCard(project: ProjectContext): string {
	const stack = stackLabel(project);
	const status =
		project.stack.language === "unknown"
			? `<span class="scope-status scope-unavailable">unsupported / unavailable</span>`
			: `<span class="scope-status scope-scanned">scanned</span>`;
	const evidence = project.evidence.filter((ev) => ev.kind !== "rejected");
	const commands = Object.entries(project.toolCommands)
		.flatMap(([kind, items]) =>
			(items ?? []).map((cmd) => `<span><b>${e(kind)}</b> <code>${e(cmd.cwd)}</code> ${e(cmd.command.join(" "))}</span>`),
		)
		.join("");
	return `<article class="scope-project">
  <div class="scope-project-head">
    <div><span class="scope-path">${e(project.path === "." ? "repo root" : project.path)}</span><span class="scope-kind">${e(project.kind)}</span></div>
    ${status}
  </div>
  <div class="scope-meta">${e(project.name)} · confidence ${Math.round(project.confidence * 100)}% · ${e(stack || "unknown stack")}</div>
  <div class="scope-table scope-project-table">
    ${renderScopeRow("Why scanned", evidence.length ? renderEvidenceText(evidence) : "No evidence recorded")}
    ${renderScopeRow("Source roots", project.srcRoots)}
    ${renderScopeRow("Test roots", project.testRoots)}
    ${renderScopeRow("Manifests", project.manifestFiles)}
    ${renderScopeRow("Configs", project.configFiles)}
  </div>
  ${evidence.length ? `<div class="ws-evidence scope-evidence">${renderEvidenceChips(evidence)}</div>` : ""}
  ${commands ? `<div class="scope-commands">${commands}</div>` : ""}
</article>`;
}

function renderEvidenceText(evidence: ProjectDiscoveryEvidence[]): string {
	return evidence.map((ev) => `${ev.kind}: ${evidenceLocation(ev) || ev.description}`).join("; ");
}

// ── Single category page ──────────────────────────────────────────

export function categoryPage(cs: CatScore, fl: FL, allChecks?: CheckResult[], cwd?: string): string {
	const checkSections = cs.checks
		.map((c) => {
			const meta = getCheckMeta(c.name);
			const sk = det(c).skipped;
			const premium = det(c).comingSoon;
			const detailsFiltered = Object.entries(c.details)
				.filter(([k]) => k !== "skipped" && k !== "reason" && k !== "graph" && k !== "containerSvg" && k !== "assessment")
				.map(([k, v]) => {
					const d = Array.isArray(v) ? v.join(", ") : typeof v === "object" ? JSON.stringify(v) : String(v);
					return `<div class="kv"><span class="k">${e(k)}</span><span class="v">${e(d)}</span></div>`;
				})
				.join("");

			const byFile = new Map<string, typeof c.issues>();
			const noFile: typeof c.issues = [];
			for (const iss of c.issues) {
				const f = typeof iss.file === "string" ? iss.file.split(":")[0] : undefined;
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
					const snippetBtn = iss.snippet
						? `<button class="cp-btn" data-prompt="${e(iss.snippet)}" title="Copy snippet to search">\ud83d\udd0d</button>`
						: "";
					// Source code snippet (collapsible)
					let srcBlock = "";
					if (cwd && iss.line && typeof iss.file === "string") {
						const src = readSourceSnippet(cwd, iss.file, iss.line);
						if (src) {
							const fixPrompt = `Fix this ${iss.severity} in ${iss.file}:${iss.line}\n${iss.message}${iss.rule ? ` (${iss.rule})` : ""}\nCheck: ${c.name}\n\nAnalyze the code, explain the issue, and provide the fix.`;
							srcBlock = `<div class="src-block">${src}<div class="src-prompt"><button class="cp-btn src-fix-btn" data-prompt="${e(fixPrompt)}" title="Copy fix prompt with source context">Copy fix prompt</button></div></div>`;
						}
					}
					issuesHtml += `<div class="ir ${iss.severity}"><span class="is">${iss.severity[0]!.toUpperCase()}</span>${iss.line ? `<span class="il">${iss.line}</span>` : ""}<span class="im">${e(iss.message)}</span>${iss.rule ? `<span class="iru">${e(iss.rule)}</span>` : ""}${snippetBtn}<button class="cp-btn" data-prompt="${e(prompt)}" title="Copy fix prompt">\ud83d\udccb</button></div>${srcBlock}`;
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
				return `<section class="check-section" id="${c.name}">
<div class="pro-card">
<div class="pro-badge">PRO</div>
<h3 style="margin-bottom:0.5rem;color:var(--text)">${e(meta.label)}</h3>
<p class="pro-desc">${e(desc)}</p>
${meta.risk ? `<div class="info-panel"><div class="ip-row"><span class="ip-label">Risk</span><span>${e(meta.risk)}</span></div></div>` : ""}
<p class="pro-cta">Coming soon with VibeCode QA Pro</p>
</div>
</section>`;
			}

			return `<section class="check-section" id="${c.name}">
<div class="ch-head"><span class="ch-g" style="color:${sk ? "var(--dim)" : gc(c.grade)}">${sk ? "\u2014" : c.grade}</span><div><b>${e(meta.label)}</b><span class="ch-s">${sk ? "skipped" : `${c.score}/100`} \u00b7 ${e(scoreModeLabel(c, meta))} \u00b7 ${c.duration}ms \u00b7 ${c.issues.length} issues</span></div><span class="pri" style="color:${pc(meta.priority)}">${meta.priority}</span></div>
${meta.description ? `<div class="info-panel"><div class="ip-row"><span class="ip-label">What</span><span>${e(meta.description)}</span></div><div class="ip-row"><span class="ip-label">Risk</span><span>${e(meta.risk)}</span></div><div class="ip-row"><span class="ip-label">Fix</span><span>${e(meta.recommendation)}</span></div>${meta.deeperTools?.length ? `<div class="ip-row"><span class="ip-label">Go deeper</span><span class="deeper-tools">${meta.deeperTools.map((t) => `<code>${e(t)}</code>`).join(" ")}</span></div>` : ""}</div>` : ""}
${sk ? `<p class="skip-r">${e(det(c).reason || "skipped")}</p>` : ""}
${c.name === "architecture" && !sk ? renderArchSection(c.details) : ""}
${c.name === "testing" && !sk && det(c).pyramid ? `<div class="arch-svg">${buildPyramid(det(c).pyramid as { unit: number; integration: number; component: number; e2e: number })}</div>` : ""}
${c.name === "testing" && !sk && allChecks ? renderCoverageMap(allChecks) : ""}
${detailsFiltered ? `<div class="kvs">${detailsFiltered}</div>` : ""}
${issuesHtml ? `<div class="iss-list">${issuesHtml}</div>` : '<p style="color:var(--muted);font-size:0.8rem;margin-top:1rem">No issues found.</p>'}
</section>`;
		})
		.join("");

	const clr = gc(cs.avg >= 90 ? "A" : cs.avg >= 75 ? "B" : cs.avg >= 60 ? "C" : cs.avg >= 40 ? "D" : "F");
	return `
<div class="cat-head"><span style="color:${clr};font-size:1.8rem;font-weight:900">${cs.avg}</span><span style="color:${clr}">/100</span><span style="color:var(--muted);margin-left:0.5rem">${cs.label}</span></div>
<div class="bar2"><div class="bf2" style="width:${cs.avg}%;background:${clr}"></div></div>
${checkSections}`;
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
			const loc = i.file && typeof i.file === "string" ? fl(i.file.split(":")[0]!, i.line) : "";
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

// ── Coverage map renderer ─────────────────────────────────

function renderCoverageMap(checks: CheckResult[]): string {
	const archCheck = checks.find((c) => c.name === "architecture");
	const testingCheck = checks.find((c) => c.name === "testing");
	if (!archCheck || det(archCheck).skipped) return "";

	const graph = archCheck.details.graph as Record<string, { imports: string[]; importedBy: string[]; dir: string }> | undefined;
	const input = buildCoverageMapInput(graph, testingCheck ? { issues: testingCheck.issues } : undefined);
	if (!input) return "";

	return `<h3 style="margin-top:1.5rem">Test Coverage Map</h3><div class="arch-svg">${generateCoverageMap(input)}</div>`;
}

// ── Architecture section renderer ────────────────────────

function renderArchSection(details: Record<string, unknown>): string {
	const assessment = details.assessment as
		| {
				pattern: string;
				patternDescription: string;
				layering: string;
				stability: { package: string; instability: number; role: string }[];
				crossCoupling: number;
				cohesion: number;
				rating: string;
				insights: string[];
		  }
		| undefined;

	let html = "";

	// Assessment panel (before diagrams)
	if (assessment) {
		const ratingColors: Record<string, string> = { excellent: "var(--pass)", good: "#84cc16", fair: "var(--warn)", poor: "var(--fail)" };
		const ratingColor = ratingColors[assessment.rating] || "var(--muted)";

		html += `<div class="info-panel" style="margin-top:1rem">`;
		html += `<div class="ip-row"><span class="ip-label">Pattern</span><span><b>${e(assessment.pattern)}</b> — ${e(assessment.patternDescription)}</span></div>`;
		html += `<div class="ip-row"><span class="ip-label">Rating</span><span style="color:${ratingColor};font-weight:700;text-transform:uppercase">${e(assessment.rating)}</span></div>`;
		html += `<div class="ip-row"><span class="ip-label">Layers</span><span>${e(assessment.layering)} layering</span></div>`;
		html += `<div class="ip-row"><span class="ip-label">Coupling</span><span>${assessment.crossCoupling}% cross-directory imports</span></div>`;
		html += `<div class="ip-row"><span class="ip-label">Cohesion</span><span>${assessment.cohesion}% average internal cohesion</span></div>`;
		html += `</div>`;

		// Insights
		if (assessment.insights.length > 0) {
			html += `<div style="margin:0.8rem 0;font-size:0.75rem">`;
			for (const insight of assessment.insights) {
				html += `<div style="padding:0.2rem 0;color:var(--muted)">\u2022 ${e(insight)}</div>`;
			}
			html += `</div>`;
		}

		// Stability table
		if (assessment.stability.length > 1) {
			html += `<h3 style="margin-top:1rem">Package Stability (Martin)</h3>`;
			html += `<div style="font-size:0.72rem;margin-bottom:1rem">`;
			for (const s of assessment.stability) {
				const barW = Math.round(s.instability * 100);
				const color = s.instability > 0.7 ? "var(--warn)" : s.instability < 0.3 ? "var(--pass)" : "var(--accent)";
				html += `<div class="brow"><span class="bl">${e(s.package.replace("src/", ""))}</span><div class="bb"><div class="bf" style="width:${barW}%;background:${color}"></div></div><span class="bv" style="color:${color}">${s.instability.toFixed(2)}</span></div>`;
			}
			html += `<div style="color:var(--muted);font-size:0.62rem;margin-top:0.3rem">I=0 = maximally stable (many dependents, hard to change). I=1 = maximally unstable (no dependents, easy to change).</div>`;
			html += `</div>`;
		}
	}

	// Diagrams
	const containerSvg = details.containerSvg as string | undefined;
	if (containerSvg) {
		html += `<h3 style="margin-top:1.5rem">Container Diagram</h3><div class="arch-svg">${containerSvg}</div>`;
	}
	html += `<h3 style="margin-top:1.5rem">Layer Diagram</h3><div class="arch-svg">${generateLayerDiagram(details)}</div>`;
	html += `<h3 style="margin-top:1.5rem">Dependency Graph</h3><div class="arch-svg">${generateArchSVG(details)}</div>`;
	html += `<h3 style="margin-top:1.5rem">Sequence Diagram</h3><div class="arch-svg">${generateSequenceDiagram(details)}</div>`;
	html += `<h3 style="margin-top:1.5rem">Package Diagram</h3><div class="arch-svg">${generatePackageDiagram(details)}</div>`;
	html += `<h3 style="margin-top:1.5rem">Dependency Matrix (DSM)</h3><div class="arch-svg">${generateDSM(details)}</div>`;

	return html;
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
			const data = history.map((h) => ({ score: h.checkScores.get(name) ?? 0, timestamp: h.timestamp })).filter((d) => d.score > 0);
			if (data.length < 2) return "";

			const current = data[data.length - 1].score;
			const prev = data[data.length - 2].score;
			const delta = current - prev;
			const deltaStr =
				delta > 0
					? `<span style="color:var(--pass)">+${delta}</span>`
					: delta < 0
						? `<span style="color:var(--fail)">${delta}</span>`
						: `<span class="muted">=</span>`;
			const color = current >= 90 ? "var(--pass)" : current >= 75 ? "#84cc16" : current >= 60 ? "var(--warn)" : "var(--fail)";

			const chart = buildTimeline(data, { width: 300, height: 60 });

			return `<div class="trend-card">
<div class="trend-header"><span class="trend-name">${e(name)}</span><span class="trend-score" style="color:${color}">${current}</span>${deltaStr}</div>
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
		.sort((a, b) => (b as { delta: number }).delta - (a as { delta: number }).delta) as {
		name: string;
		first: number;
		last: number;
		delta: number;
	}[];

	const deltaTable = deltaRows
		.map((r) => {
			const clr = r.delta > 0 ? "var(--pass)" : r.delta < 0 ? "var(--fail)" : "var(--muted)";
			return `<div class="trend-row"><span class="trend-row-name">${e(r.name)}</span><span class="trend-row-val">${r.first}</span><span class="trend-row-arrow">\u2192</span><span class="trend-row-val">${r.last}</span><span class="trend-row-delta" style="color:${clr}">${r.delta > 0 ? "+" : ""}${r.delta}</span></div>`;
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

// ── Feature Map (Pro) ────────────────────────────────────

export function featureMapPage(deadPatternsCheck: CheckResult | undefined, fl: FL): string {
	const d = deadPatternsCheck?.details as Record<string, unknown> | undefined;
	const featureMap = d?.featureMap as FeatureCluster[] | undefined;
	const isPro = !!featureMap && featureMap.length > 0;

	if (!isPro) {
		return `
<div class="fm-header">
  <h2>Feature Map <span class="pro-badge">PRO</span></h2>
  <p class="muted">AI-powered map of your codebase — every feature, its files, and refactor debt.</p>
</div>
<div class="fm-teaser">
  <div class="fm-teaser-grid">
    <div class="fm-card fm-card-blur"><div class="fm-card-label">Authentication</div><div class="fm-card-desc">User login, sessions, JWT</div><div class="fm-card-files">src/auth.ts, src/session.ts, src/middleware.ts</div><div class="fm-card-badge fm-warn">2 dead patterns</div></div>
    <div class="fm-card fm-card-blur"><div class="fm-card-label">API Routes</div><div class="fm-card-desc">REST endpoint handlers</div><div class="fm-card-files">src/routes/users.ts, src/routes/posts.ts</div><div class="fm-card-badge fm-ok">Clean</div></div>
    <div class="fm-card fm-card-blur"><div class="fm-card-label">Database</div><div class="fm-card-desc">Query builders, migrations</div><div class="fm-card-files">src/db/client.ts, src/db/schema.ts</div><div class="fm-card-badge fm-warn">1 dead pattern</div></div>
    <div class="fm-card fm-card-blur"><div class="fm-card-label">UI Components</div><div class="fm-card-desc">Reusable React components</div><div class="fm-card-files">src/components/Button.tsx, ...</div><div class="fm-card-badge fm-ok">Clean</div></div>
  </div>
  <div class="fm-cta">
    <p>Set <code>VCQA_PRO_KEY</code> to unlock the Feature Map</p>
    <p class="muted" style="font-size:0.72rem">LLM-powered analysis identifies every feature in your codebase, maps it to source files, and detects refactor leftovers — fallbacks, parallel implementations, dead guards.</p>
  </div>
</div>`;
	}

	const totalFeatures = featureMap.length;
	const totalFiles = featureMap.reduce((s, c) => s + c.fileCount, 0);
	const withIssues = featureMap.filter((c) => c.findings.length > 0).length;
	const totalFindings = featureMap.reduce((s, c) => s + c.findings.length, 0);

	const cards = featureMap
		.map((cluster, idx) => {
			const hasFindings = cluster.findings.length > 0;
			const warningCount = cluster.findings.filter((f) => f.severity === "warning").length;
			const badgeClass = hasFindings ? (warningCount > 0 ? "fm-warn" : "fm-info") : "fm-ok";
			const badgeText = hasFindings ? `${cluster.findings.length} dead pattern${cluster.findings.length !== 1 ? "s" : ""}` : "Clean";

			const fileList = cluster.files
				.slice(0, 8)
				.map((f) => `<div class="fm-file">${fl(f)}</div>`)
				.join("");
			const moreFiles = cluster.fileCount > 8 ? `<div class="fm-file fm-more">+${cluster.fileCount - 8} more</div>` : "";

			let findingsHtml = "";
			if (hasFindings) {
				const rows = cluster.findings
					.map((f) => {
						const sevClass = f.severity === "warning" ? "fm-f-warn" : "fm-f-info";
						const loc = f.file ? fl(f.file, f.line) : "";
						return `<div class="fm-finding ${sevClass}"><span class="fm-f-sev">${f.severity === "warning" ? "W" : "I"}</span>${loc ? `<span class="fm-f-loc">${loc}</span>` : ""}<span class="fm-f-msg">${e(f.message)}</span>${f.rule ? `<span class="fm-f-rule">${e(f.rule)}</span>` : ""}</div>`;
					})
					.join("");
				findingsHtml = `<div class="fm-findings" id="fm-findings-${idx}">${rows}</div>`;
			}

			return `<div class="fm-card${hasFindings ? " fm-card-issue" : ""}">
  <div class="fm-card-top">
    <div class="fm-card-label">${e(cluster.label)}</div>
    <div class="fm-card-badge ${badgeClass}">${badgeText}</div>
  </div>
  ${cluster.description ? `<div class="fm-card-desc">${e(cluster.description)}</div>` : ""}
  <div class="fm-card-dir">${e(cluster.dir)}</div>
  <div class="fm-card-files">${fileList}${moreFiles}</div>
  ${findingsHtml}
</div>`;
		})
		.join("");

	return `
<div class="fm-header">
  <h2>Feature Map <span class="pro-badge">PRO</span></h2>
  <p class="muted">${totalFeatures} features detected across ${totalFiles} files${withIssues > 0 ? ` \u2014 <span style="color:var(--warn)">${totalFindings} dead patterns in ${withIssues} features</span>` : " \u2014 no dead patterns found"}</p>
</div>

<div class="fm-stats">
  <div class="fm-stat"><span class="fm-stat-n">${totalFeatures}</span><span class="fm-stat-l">Features</span></div>
  <div class="fm-stat"><span class="fm-stat-n">${totalFiles}</span><span class="fm-stat-l">Files</span></div>
  <div class="fm-stat"><span class="fm-stat-n" style="color:${totalFindings > 0 ? "var(--warn)" : "var(--pass)"}">${totalFindings}</span><span class="fm-stat-l">Dead Patterns</span></div>
  <div class="fm-stat"><span class="fm-stat-n" style="color:var(--pass)">${totalFeatures - withIssues}</span><span class="fm-stat-l">Clean Features</span></div>
</div>

<div class="fm-grid">${cards}</div>`;
}

// ── Actions page ─────────────────────────────────────────

interface ActionGroup {
	check: string;
	meta: CheckMeta;
	fix: string;
	items: { file?: string; line?: number; message: string; rule?: string }[];
}

export function actionsPage(allChecks: CheckResult[], fl: FL, linter: string, delta?: ScanDelta): string {
	// Classify issues into auto-fixable, AI-fixable, manual
	const autoFixes: { check: string; file?: string; line?: number; message: string; rule?: string }[] = [];
	const aiFixes: ActionGroup[] = [];
	const manualGroups: { meta: CheckMeta; score: number; issues: { file?: string; line?: number; message: string }[] }[] = [];

	// Auto-fixable: lint issues (biome/eslint can auto-fix), structure issues
	const AUTO_RULES = new Set(["missing-file", "missing-lockfile", "ts-strict", "env-not-ignored", "no-ci"]);

	// Group AI-fixable by their fix suggestion
	const fixGroups = new Map<string, ActionGroup>();

	for (const c of allChecks) {
		if (det(c).skipped || det(c).comingSoon) continue;
		const meta = getCheckMeta(c.name);
		const manualIssues: { file?: string; line?: number; message: string }[] = [];

		for (const iss of c.issues) {
			const file = typeof iss.file === "string" ? iss.file : undefined;

			// Auto-fixable: lint issues or known auto-fix rules
			if (c.name === "lint" || AUTO_RULES.has(iss.rule || "")) {
				autoFixes.push({ check: c.name, file, line: iss.line, message: iss.message, rule: iss.rule });
				continue;
			}

			// AI-fixable: has a suggestFix mapping
			const fix = suggestFix(c.name, iss.rule || "", iss.message);
			if (fix) {
				const key = `${c.name}::${fix}`;
				const group = fixGroups.get(key) || { check: c.name, meta, fix, items: [] };
				group.items.push({ file, line: iss.line, message: iss.message, rule: iss.rule });
				fixGroups.set(key, group);
				continue;
			}

			// Manual
			manualIssues.push({ file, line: iss.line, message: iss.message });
		}

		if (manualIssues.length > 0 && c.score < 90) {
			manualGroups.push({ meta, score: c.score, issues: manualIssues });
		}
	}

	for (const g of fixGroups.values()) aiFixes.push(g);
	aiFixes.sort((a, b) => b.items.length - a.items.length);
	manualGroups.sort((a, b) => a.score - b.score);

	const totalAuto = autoFixes.length;
	const totalAI = aiFixes.reduce((s, g) => s + g.items.length, 0);
	const totalManual = manualGroups.reduce((s, g) => s + g.issues.length, 0);

	// Build auto-fix section
	let autoSection = "";
	if (totalAuto > 0) {
		const linterName = linter === "biome" ? "Biome" : linter === "eslint" ? "ESLint" : "linter";
		autoSection = `
<div class="act-section">
  <h3><span class="act-icon" style="background:#22c55e20;color:var(--pass)">&#9889;</span> Quick Fixes <span class="act-count">${totalAuto}</span></h3>
  <p class="act-desc">Auto-fixable with one command. Run <code>npx @vibecodeqa/cli fix</code></p>
  <div class="act-cmd"><code>npx @vibecodeqa/cli fix</code></div>
  <details class="act-details"><summary>${totalAuto} issues (${linterName} formatting, missing files, config)</summary>
  <table class="act-table"><tbody>${autoFixes
		.slice(0, 50)
		.map(
			(i) =>
				`<tr><td class="act-check">${e(i.check)}</td><td>${i.file ? fl(i.file.split(":")[0]!, i.line) : ""}</td><td>${e(i.message)}</td></tr>`,
		)
		.join("")}</tbody></table>
  ${totalAuto > 50 ? `<p class="muted">+${totalAuto - 50} more</p>` : ""}
  </details>
</div>`;
	}

	// Build AI-fix section
	let aiSection = "";
	if (totalAI > 0) {
		const groupRows = aiFixes
			.slice(0, 20)
			.map((g) => {
				const topItems = g.items
					.slice(0, 3)
					.map(
						(i) =>
							`<div class="act-item">${i.file ? fl(i.file.split(":")[0]!, i.line) : ""} <span class="muted">${e(i.message)}</span></div>`,
					)
					.join("");
				const more = g.items.length > 3 ? `<div class="act-item muted">+${g.items.length - 3} more</div>` : "";
				return `<div class="act-card"><div class="act-card-head"><span class="act-check">${e(g.meta.label)}</span><span class="act-count">${g.items.length}</span></div><div class="act-fix">${e(g.fix)}</div>${topItems}${more}</div>`;
			})
			.join("");

		aiSection = `
<div class="act-section">
  <h3><span class="act-icon" style="background:#6366f120;color:var(--info)">&#10024;</span> AI Fixes <span class="act-count">${totalAI}</span></h3>
  <p class="act-desc">Fixable with AI assistance. Run <code>npx @vibecodeqa/cli fix --ai</code></p>
  <div class="act-cmd"><code>npx @vibecodeqa/cli fix --ai</code></div>
  <div class="act-grid">${groupRows}</div>
</div>`;
	}

	// Build manual section
	let manualSection = "";
	if (manualGroups.length > 0) {
		const groupRows = manualGroups
			.slice(0, 15)
			.map((g) => {
				const clr = gc(g.score >= 90 ? "A" : g.score >= 75 ? "B" : g.score >= 60 ? "C" : g.score >= 40 ? "D" : "F");
				const topIssues = g.issues
					.slice(0, 3)
					.map(
						(i) =>
							`<div class="act-item">${i.file ? fl(i.file.split(":")[0]!, i.line) : ""} <span class="muted">${e(i.message)}</span></div>`,
					)
					.join("");
				const more = g.issues.length > 3 ? `<div class="act-item muted">+${g.issues.length - 3} more</div>` : "";
				return `<div class="act-card"><div class="act-card-head"><span class="act-check">${e(g.meta.label)}</span><span style="color:${clr}">${g.score}/100</span></div><div class="act-rec">${e(g.meta.recommendation)}</div>${topIssues}${more}</div>`;
			})
			.join("");

		manualSection = `
<div class="act-section">
  <h3><span class="act-icon" style="background:#eab30820;color:var(--warn)">&#128736;</span> Manual Actions <span class="act-count">${totalManual}</span></h3>
  <p class="act-desc">Require code changes — grouped by check with specific recommendations.</p>
  <div class="act-grid">${groupRows}</div>
</div>`;
	}

	const noActions = totalAuto === 0 && totalAI === 0 && totalManual === 0;

	// Delta section — shows what changed since last scan
	let deltaSection = "";
	if (delta) {
		const dColor = delta.scoreDelta > 0 ? "var(--pass)" : delta.scoreDelta < 0 ? "var(--fail)" : "var(--muted)";
		const dArrow = delta.scoreDelta > 0 ? "&#9650;" : delta.scoreDelta < 0 ? "&#9660;" : "&#9644;";

		// Per-check changes
		const changed = delta.checks.filter((c) => c.delta !== 0).sort((a, b) => b.delta - a.delta);
		const checkDeltas = changed
			.slice(0, 10)
			.map((c) => {
				const cc = c.delta > 0 ? "var(--pass)" : "var(--fail)";
				return `<span class="delta-chip" style="color:${cc}">${c.name} ${c.delta > 0 ? "+" : ""}${c.delta}</span>`;
			})
			.join("");

		// Fixed issues list
		let fixedList = "";
		if (delta.fixed.length > 0) {
			const byCheck = new Map<string, number>();
			for (const f of delta.fixed) byCheck.set(f.check, (byCheck.get(f.check) || 0) + 1);
			fixedList = `<div class="delta-fixed"><strong style="color:var(--pass)">Fixed (${delta.fixed.length}):</strong> ${[
				...byCheck.entries(),
			]
				.sort((a, b) => b[1] - a[1])
				.map(([c, n]) => `${c} (${n})`)
				.join(", ")}</div>`;
		}
		let newList = "";
		if (delta.introduced.length > 0) {
			const byCheck = new Map<string, number>();
			for (const f of delta.introduced) byCheck.set(f.check, (byCheck.get(f.check) || 0) + 1);
			newList = `<div class="delta-new"><strong style="color:var(--fail)">New (${delta.introduced.length}):</strong> ${[
				...byCheck.entries(),
			]
				.sort((a, b) => b[1] - a[1])
				.map(([c, n]) => `${c} (${n})`)
				.join(", ")}</div>`;
		}

		deltaSection = `
<div class="delta-banner">
  <div class="delta-head">
    <span class="delta-title">What Changed</span>
    <span class="delta-score">${delta.before.grade} ${delta.before.score} &rarr; ${delta.after.grade} ${delta.after.score}</span>
    <span class="delta-arrow" style="color:${dColor}">${dArrow} ${delta.scoreDelta > 0 ? "+" : ""}${delta.scoreDelta}</span>
  </div>
  <div class="delta-stats">
    <span style="color:var(--pass)">${delta.fixed.length} fixed</span>
    <span style="color:var(--fail)">${delta.introduced.length} new</span>
    <span style="color:var(--muted)">${delta.after.issueCount} remaining</span>
  </div>
  ${checkDeltas ? `<div class="delta-checks">${checkDeltas}</div>` : ""}
  ${fixedList}${newList}
</div>`;
	}

	return `
<h2>Recommended Actions</h2>
<p class="muted" style="margin-bottom:1.5rem">${noActions ? "No actions needed — all checks passed." : `${totalAuto + totalAI + totalManual} issues across ${totalAuto > 0 ? "3" : totalAI > 0 ? "2" : "1"} fix categories.`}</p>

${deltaSection}

<div class="act-summary">
  <div class="act-stat"><span class="act-stat-n" style="color:var(--pass)">${totalAuto}</span><span class="act-stat-l">Auto-fixable</span></div>
  <div class="act-stat"><span class="act-stat-n" style="color:var(--info)">${totalAI}</span><span class="act-stat-l">AI-fixable</span></div>
  <div class="act-stat"><span class="act-stat-n" style="color:var(--warn)">${totalManual}</span><span class="act-stat-l">Manual</span></div>
</div>

${autoSection}${aiSection}${manualSection}`;
}
