/** HTML quality — checks static HTML sites for meta tags, images, links, a11y, performance, SEO, security.
 *
 * Activates when the project has .html files. Works alongside framework checks —
 * catches issues in static sites, landing pages, and docs that framework-specific
 * checks miss entirely.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { CheckResult, Issue } from "../types.js";
import { gradeFromScore } from "../types.js";

const SKIP_DIRS = new Set(["node_modules", ".git", ".vibe-check", "dist", "build", "coverage", ".next", ".nuxt"]);

export function runHtmlQuality(cwd: string): CheckResult {
	const start = Date.now();
	const issues: Issue[] = [];

	const htmlFiles = collectHtmlFiles(cwd);
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

	const allLinks = new Set<string>();
	const titles = new Map<string, string[]>();

	for (const file of htmlFiles) {
		const relPath = relative(cwd, file);
		let content: string;
		try {
			content = readFileSync(file, "utf-8");
		} catch {
			continue;
		}

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

			if (!/<meta\s[^>]*name=["']viewport["']/i.test(content)) {
				issues.push({
					severity: "error",
					message: "Missing viewport meta — page won't be mobile-responsive",
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
		if (/<html[\s>]/.test(content) && !/<html\s[^>]*lang=/i.test(content)) {
			issues.push({
				severity: "warning",
				message: "Missing lang attribute on <html> — screen readers need this",
				file: relPath,
				rule: "missing-lang",
			});
		}

		// ── Images ──
		const imgRegex = /<img\s[^>]*>/gi;
		for (const imgMatch of content.matchAll(imgRegex)) {
			const tag = imgMatch[0];
			const line = content.slice(0, imgMatch.index).split("\n").length;

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
		for (const linkMatch of content.matchAll(linkRegex)) {
			const href = linkMatch[1];
			const tag = linkMatch[0];
			const line = content.slice(0, linkMatch.index).split("\n").length;

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
			if (!href.startsWith("http") && !href.startsWith("mailto:") && !href.startsWith("#") && !href.startsWith("javascript:")) {
				allLinks.add(join(cwd, href.split("#")[0].split("?")[0]));
			}
		}

		// ── Heading hierarchy ──
		const headings: number[] = [];
		const headingRegex = /<h(\d)/gi;
		for (const hMatch of content.matchAll(headingRegex)) {
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
		if (/<(?:img|script|link|iframe)\s[^>]*(?:src|href)=["']http:\/\/(?!localhost)/i.test(content)) {
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
		if (!existsSync(link)) {
			const relLink = relative(cwd, link);
			issues.push({ severity: "warning", message: `Broken internal link: ${relLink}`, rule: "broken-link" });
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
	if (!existsSync(join(cwd, "robots.txt"))) {
		issues.push({ severity: "info", message: "Missing robots.txt", rule: "missing-robots" });
	}
	if (!existsSync(join(cwd, "sitemap.xml"))) {
		issues.push({ severity: "info", message: "Missing sitemap.xml", rule: "missing-sitemap" });
	}

	// Score
	const errorCount = issues.filter((i) => i.severity === "error").length;
	const warnCount = issues.filter((i) => i.severity === "warning").length;
	const score = Math.max(0, 100 - errorCount * 15 - warnCount * 5);

	return {
		name: "html-quality",
		score,
		grade: gradeFromScore(score),
		details: { htmlFiles: htmlFiles.length },
		issues,
		duration: Date.now() - start,
	};
}

function collectHtmlFiles(cwd: string, subdir = ""): string[] {
	const files: string[] = [];
	const dir = subdir ? join(cwd, subdir) : cwd;
	try {
		for (const entry of readdirSync(dir)) {
			if (SKIP_DIRS.has(entry)) continue;
			const full = join(dir, entry);
			try {
				const stat = statSync(full);
				if (stat.isDirectory()) {
					files.push(...collectHtmlFiles(cwd, subdir ? join(subdir, entry) : entry));
				} else if (entry.endsWith(".html") || entry.endsWith(".htm")) {
					files.push(full);
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
