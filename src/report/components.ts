/** Reusable HTML components and helpers for the report. */

import type { Priority } from "../check-meta.js";
import type { CheckResult } from "../types.js";

/** Type-safe accessor for check detail flags. */
export function det(c: CheckResult): { skipped?: boolean; comingSoon?: boolean; reason?: string; [k: string]: unknown } {
	return c.details as { skipped?: boolean; comingSoon?: boolean; reason?: string; [k: string]: unknown };
}

/** HTML-escape a string. */
export function e(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** The tree file links should point at: the scanned commit when the report
 *  knows it (a permalink that stays correct after the branch moves), else the
 *  branch, else "" — meaning no link at all. A scan that decided otherwise
 *  (`meta.linkRef`: a local HEAD not pushed yet, whose sha would 404) wins. */
export function linkRef(meta: { branch?: string | null; git?: { sha?: string | null } | null; linkRef?: unknown }): string {
	if (typeof meta.linkRef === "string") return meta.linkRef;
	return meta.git?.sha || meta.branch || "";
}

/** Make a file path a clickable link into the repo at `ref` (a commit sha or a
 *  branch). Plain text when there is no http(s) repoUrl or no ref — a link with
 *  an empty ref would be `/blob//…`, which resolves nowhere. */
export function fileLink(path: string, line: number | undefined, repoUrl: string | null, ref: string): string {
	const clean = path.split(":")[0]!;
	if (!repoUrl || !/^https?:\/\//.test(repoUrl) || !ref) return e(path);
	// Encode path segments for URL safety (spaces, #, ?, etc.)
	const encodedPath = clean.split("/").map(encodeURIComponent).join("/");
	const safeRepoUrl = repoUrl.replace(/ /g, "%20");
	const href = `${safeRepoUrl}/blob/${encodeURIComponent(ref)}/${encodedPath}${line ? `#L${line}` : ""}`;
	return `<a href="${e(href)}" target="_blank" rel="noopener" class="flink">${e(path)}</a>`;
}

/** Grade color. */
export function gc(grade: string): string {
	return { A: "#22c55e", B: "#84cc16", C: "#eab308", D: "#f97316", F: "#ef4444" }[grade] || "#6b7280";
}

/** Priority color. */
export function pc(p: Priority): string {
	return { critical: "#ef4444", high: "#f97316", medium: "#eab308", low: "#6b7280" }[p];
}
