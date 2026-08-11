/** HTML quality — checks static HTML sites for meta tags, images, links, a11y, performance, SEO, security.
 *
 * Activates when the project has .html files. Works alongside framework checks —
 * catches issues in static sites, landing pages, and docs that framework-specific
 * checks miss entirely.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { FileInventory, StaticSiteContext } from "../file-inventory.js";
import { inventoryFiles } from "../file-inventory.js";
import { isIgnoredPath } from "../fs-utils.js";
import type { CheckResult, Issue } from "../types.js";
import { gradeFromScore } from "../types.js";

interface HtmlInput {
	path: string;
	fullPath: string;
}

interface InternalLink {
	sourceFile: string;
	href: string;
	candidates: string[];
}

function replaceExceptNewlines(value: string): string {
	return value.replace(/[^\n]/g, " ");
}

function contentForDomChecks(content: string): string {
	return content
		.replace(/<!--[\s\S]*?-->/g, (match) => replaceExceptNewlines(match))
		.replace(/<script\b([^>]*)>[\s\S]*?<\/script>/gi, (_match, attrs: string) => `<script${attrs}></script>`)
		.replace(/<style\b([^>]*)>[\s\S]*?<\/style>/gi, (_match, attrs: string) => `<style${attrs}></style>`)
		.replace(/<svg\b[\s\S]*?<\/svg>/gi, (match) => replaceExceptNewlines(match));
}

export function runHtmlQuality(cwd: string, inventory?: FileInventory): CheckResult {
	const start = Date.now();
	const issues: Issue[] = [];

	const htmlFiles = inventory
		? inventoryFiles(inventory, { kind: "html" }).map((file) => ({ path: file.path, fullPath: file.fullPath }))
		: collectHtmlFiles(cwd);
	const staticSites = inventory?.staticSites ?? [];
	if (htmlFiles.length === 0) {
		return {
			name: "html-quality",
			score: 0,
			grade: "F",
			details: { skipped: true, reason: "no HTML files found" },
			issues: [],
			duration: Date.now() - start,
		};
	}

	const allLinks: InternalLink[] = [];
	const titles = new Map<string, string[]>();

	for (const file of htmlFiles) {
		const relPath = file.path;
		let content: string;
		try {
			content = readFileSync(file.fullPath, "utf-8");
		} catch {
			continue;
		}
		const domContent = contentForDomChecks(content);

		// ── Meta tags ──
		if (content.includes("<head")) {
			if (!/<title[^>]*>/.test(content)) {
				issues.push({ severity: "error", message: "Missing <title> tag", file: relPath, rule: "missing-title" });
			} else {
				const titleMatch = content.match(/<title[^>]*>([^<]*)<\/title>/i);
				if (titleMatch) {
					const title = titleMatch[1].trim();
					if (title.length < 10) {
						issues.push({
							severity: "warning",
							message: `Title too short: "${title}" — aim for 30-60 characters`,
							file: relPath,
							rule: "short-title",
						});
					}
					const existing = titles.get(title) || [];
					existing.push(relPath);
					titles.set(title, existing);
				}
			}

			if (!/<meta\s[^>]*name=["']description["']/i.test(content)) {
				issues.push({ severity: "warning", message: "Missing meta description", file: relPath, rule: "missing-description" });
			}

			// Canonical owner of the viewport meta (#68). The `accessibility` check used
			// to emit the same `missing-viewport` rule id under its own category, so a
			// project with both an index.html and JSX was billed for it twice.
			if (!/<meta\s[^>]*name=["']viewport["']/i.test(content)) {
				issues.push({
					severity: "error",
					message:
						'Missing viewport meta — page won\'t be mobile-responsive; add <meta name="viewport" content="width=device-width, initial-scale=1.0">',
					file: relPath,
					rule: "missing-viewport",
				});
			}

			if (!/<meta\s[^>]*charset/i.test(content)) {
				issues.push({ severity: "warning", message: "Missing charset declaration", file: relPath, rule: "missing-charset" });
			}

			if (!/<meta\s[^>]*property=["']og:title["']/i.test(content)) {
				issues.push({
					severity: "info",
					message: "Missing Open Graph tags (og:title, og:description) — social sharing will look plain",
					file: relPath,
					rule: "missing-og",
				});
			}

			if (!/<link\s[^>]*rel=["']canonical["']/i.test(content)) {
				issues.push({
					severity: "info",
					message: "Missing canonical link — may cause duplicate content issues",
					file: relPath,
					rule: "missing-canonical",
				});
			}

			if (!/<link\s[^>]*rel=["']icon["']/i.test(content) && !/<link\s[^>]*rel=["']shortcut icon["']/i.test(content)) {
				issues.push({ severity: "info", message: "Missing favicon", file: relPath, rule: "missing-favicon" });
			}
		}

		// ── HTML lang ──
		// Canonical owner of `<html lang>` (#68). The `accessibility` check used to
		// emit its own `html-lang` for the same file; it no longer does.
		if (/<html[\s>]/.test(domContent) && !/<html\s[^>]*lang=/i.test(domContent)) {
			issues.push({
				severity: "warning",
				message: 'Missing lang attribute on <html> — screen readers need this (WCAG 3.1.1); add e.g. <html lang="en">',
				file: relPath,
				rule: "missing-lang",
			});
		}

		// ── Images ──
		const imgRegex = /<img\s[^>]*>/gi;
		for (const imgMatch of domContent.matchAll(imgRegex)) {
			const tag = imgMatch[0];
			const line = domContent.slice(0, imgMatch.index).split("\n").length;

			if (!/alt\s*=/i.test(tag)) {
				issues.push({ severity: "error", message: "Image missing alt attribute", file: relPath, line, rule: "img-no-alt" });
			}

			if (!/(?:width|height)\s*=/i.test(tag)) {
				issues.push({
					severity: "warning",
					message: "Image missing width/height — causes layout shift",
					file: relPath,
					line,
					rule: "img-no-dimensions",
				});
			}

			if (!/loading\s*=/i.test(tag)) {
				issues.push({
					severity: "info",
					message: 'Image missing loading="lazy" — add for below-fold images',
					file: relPath,
					line,
					rule: "img-no-lazy",
				});
			}
		}

		// ── Links ──
		const linkRegex = /<a\s[^>]*href=["']([^"']+)["'][^>]*>/gi;
		for (const linkMatch of domContent.matchAll(linkRegex)) {
			const href = linkMatch[1];
			const tag = linkMatch[0];
			const line = domContent.slice(0, linkMatch.index).split("\n").length;

			// HTTP links on what should be HTTPS
			if (href.startsWith("http://") && !href.includes("localhost")) {
				issues.push({ severity: "warning", message: `HTTP link: ${href} — use HTTPS`, file: relPath, line, rule: "http-link" });
			}

			// External links without rel=noopener
			if (href.startsWith("http") && /target\s*=\s*["']_blank["']/i.test(tag) && !/rel\s*=\s*["'][^"']*noopener/i.test(tag)) {
				issues.push({
					severity: "warning",
					message: 'External link with target="_blank" missing rel="noopener"',
					file: relPath,
					line,
					rule: "missing-noopener",
				});
			}

			// Collect internal links for broken link check
			if (isInternalHref(href)) {
				const link = resolveInternalLink(cwd, file, href, staticSites);
				if (link) {
					allLinks.push(link);
				}
			}
		}

		// ── Heading hierarchy ──
		const headings: number[] = [];
		const headingRegex = /<h(\d)/gi;
		for (const hMatch of domContent.matchAll(headingRegex)) {
			headings.push(parseInt(hMatch[1], 10));
		}
		for (let i = 1; i < headings.length; i++) {
			if (headings[i] > headings[i - 1] + 1) {
				issues.push({
					severity: "warning",
					message: `Heading hierarchy skip: h${headings[i - 1]} → h${headings[i]} (should be h${headings[i - 1] + 1})`,
					file: relPath,
					rule: "heading-skip",
				});
				break;
			}
		}

		// ── Performance ──
		// Render-blocking scripts (script in head without async/defer)
		const headContent = content.match(/<head[^>]*>([\s\S]*?)<\/head>/i)?.[1] || "";
		const scriptInHead = /<script\s[^>]*src=["'][^"']+["'][^>]*>/gi;
		for (const scriptMatch of headContent.matchAll(scriptInHead)) {
			const tag = scriptMatch[0];
			if (!/\b(?:async|defer|type=["']module["'])\b/i.test(tag)) {
				issues.push({
					severity: "warning",
					message: "Render-blocking script in <head> — add async or defer",
					file: relPath,
					rule: "render-blocking",
				});
			}
		}

		// ── Security ──
		// Mixed content (http:// resources on a page)
		if (/<(?:img|script|link|iframe)\s[^>]*(?:src|href)=["']http:\/\/(?!localhost)/i.test(domContent)) {
			issues.push({
				severity: "warning",
				message: "Mixed content: HTTP resource on page — use HTTPS",
				file: relPath,
				rule: "mixed-content",
			});
		}
	}

	// ── Cross-file checks ──

	// Broken internal links
	for (const link of allLinks) {
		if (!link.candidates.some((candidate) => existsSync(candidate))) {
			const relLink = relative(cwd, link.candidates[0] ?? cwd);
			issues.push({
				severity: "warning",
				message: `Broken internal link: ${link.href} -> ${relLink}`,
				file: link.sourceFile,
				rule: "broken-link",
			});
		}
	}

	// Duplicate titles
	for (const [title, files] of titles) {
		if (files.length > 1) {
			issues.push({
				severity: "warning",
				message: `Duplicate title "${title}" in ${files.length} files — each page should have a unique title`,
				rule: "duplicate-title",
			});
		}
	}

	// SEO files
	for (const site of htmlSiteContexts(cwd, htmlFiles, staticSites)) {
		if (!staticRootFileExists(site, "robots.txt")) {
			issues.push({
				severity: "info",
				message: site.rootPath === "." ? "Missing robots.txt" : `Missing robots.txt for static site root ${site.rootPath}`,
				rule: "missing-robots",
			});
		}
		if (!staticRootFileExists(site, "sitemap.xml")) {
			issues.push({
				severity: "info",
				message: site.rootPath === "." ? "Missing sitemap.xml" : `Missing sitemap.xml for static site root ${site.rootPath}`,
				rule: "missing-sitemap",
			});
		}
	}

	// Score
	const errorCount = issues.filter((i) => i.severity === "error").length;
	const warnCount = issues.filter((i) => i.severity === "warning").length;
	const score = Math.max(0, 100 - errorCount * 15 - warnCount * 5);

	return {
		name: "html-quality",
		score,
		grade: gradeFromScore(score),
		details: {
			htmlFiles: htmlFiles.length,
			source: inventory ? "file-inventory" : "legacy-walk",
			staticSites: staticSites.map((site) => ({
				rootPath: site.rootPath,
				publicRoots: site.publicRoots.map((root) => root.path),
				outputRoots: site.outputRoots.map((root) => root.path),
				evidence: site.evidence,
			})),
		},
		issues,
		duration: Date.now() - start,
	};
}

function isInternalHref(href: string): boolean {
	return (
		!href.startsWith("http") &&
		!href.startsWith("//") &&
		!href.startsWith("mailto:") &&
		!href.startsWith("#") &&
		!href.startsWith("javascript:")
	);
}

function resolveInternalLink(cwd: string, file: HtmlInput, href: string, staticSites: StaticSiteContext[] = []): InternalLink | null {
	const cleanHref = href.split("#")[0]?.split("?")[0] ?? "";
	if (!cleanHref) return null;

	const isSiteRootAbsolute = cleanHref.startsWith("/");
	const site = isSiteRootAbsolute ? staticSiteForFile(file, staticSites) : undefined;
	const base = isSiteRootAbsolute ? (site?.fullRootPath ?? detectSiteRoot(cwd, file.fullPath)) : dirname(file.fullPath);
	const targetPath = isSiteRootAbsolute ? cleanHref.replace(/^\/+/, "") : cleanHref;
	const target = join(base, targetPath);
	const publicTargets = isSiteRootAbsolute ? (site?.publicRoots ?? []).map((root) => join(root.fullPath, targetPath)) : [];

	return {
		sourceFile: file.path,
		href: cleanHref,
		candidates: [target, ...publicTargets].flatMap((candidate) => internalLinkCandidates(candidate, cleanHref)),
	};
}

function staticSiteForFile(file: HtmlInput, staticSites: StaticSiteContext[]): StaticSiteContext | undefined {
	const relPath = file.path.replace(/\\/g, "/");
	const matching = staticSites.filter(
		(site) => relPath === site.rootPath || relPath.startsWith(`${site.rootPath}/`) || site.rootPath === ".",
	);
	return matching.sort((a, b) => b.rootPath.length - a.rootPath.length)[0];
}

function htmlSiteContexts(cwd: string, htmlFiles: HtmlInput[], staticSites: StaticSiteContext[]): StaticSiteContext[] {
	const matched = new Map<string, StaticSiteContext>();
	for (const file of htmlFiles) {
		const site = staticSiteForFile(file, staticSites);
		if (site) matched.set(site.rootPath, site);
	}
	if (matched.size > 0) return [...matched.values()];
	return [{ rootPath: ".", fullRootPath: cwd, publicRoots: [], outputRoots: [], evidence: [] }];
}

function staticRootFileExists(site: StaticSiteContext, fileName: string): boolean {
	if (existsSync(join(site.fullRootPath, fileName))) return true;
	return site.publicRoots.some((root) => existsSync(join(root.fullPath, fileName)));
}

function detectSiteRoot(cwd: string, htmlFile: string): string {
	const fileDir = dirname(htmlFile);
	const relDir = relative(cwd, fileDir);
	const segments = relDir && !relDir.startsWith("..") ? relDir.split(/[\\/]/).filter(Boolean) : [];
	let current = cwd;

	// Root-absolute static-site links are site-root relative, not page-dir relative.
	// Prefer the shallowest ancestor with an index page so nested index.html routes
	// such as /app/terms/ do not become their own site root.
	if (hasIndexPage(current)) return current;
	for (const segment of segments) {
		current = join(current, segment);
		if (hasIndexPage(current)) return current;
	}
	return cwd;
}

function hasIndexPage(dir: string): boolean {
	return existsSync(join(dir, "index.html")) || existsSync(join(dir, "index.htm"));
}

function internalLinkCandidates(target: string, href: string): string[] {
	const candidates = [target];
	const lastSegment = href.split("/").filter(Boolean).at(-1) ?? "";
	const hasExtension = /\.[^/.]+$/.test(lastSegment);
	if (href.endsWith("/") || !hasExtension) {
		candidates.push(join(target, "index.html"), join(target, "index.htm"));
	}
	if (!href.endsWith("/") && !hasExtension) {
		candidates.push(`${target}.html`, `${target}.htm`);
	}
	return candidates;
}

function collectHtmlFiles(cwd: string, subdir = ""): HtmlInput[] {
	const files: HtmlInput[] = [];
	const dir = subdir ? join(cwd, subdir) : cwd;
	try {
		for (const entry of readdirSync(dir)) {
			const full = join(dir, entry);
			const relPath = subdir ? join(subdir, entry).replace(/\\/g, "/") : entry;
			if (isIgnoredPath(relPath)) continue;
			try {
				const stat = statSync(full);
				if (stat.isDirectory()) {
					files.push(...collectHtmlFiles(cwd, subdir ? join(subdir, entry) : entry));
				} else if (entry.endsWith(".html") || entry.endsWith(".htm")) {
					files.push({ path: relPath, fullPath: full });
				}
			} catch {
				/* skip */
			}
		}
	} catch {
		/* skip */
	}
	return files;
}
