/** Accessibility check — detects common a11y violations in JSX/TSX code.
 *  If eslint-plugin-jsx-a11y is installed, lint runner handles most of these.
 *  This runner catches additional patterns and provides a dedicated a11y score. */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getProductionFiles, readDeps } from "../fs-utils.js";
import type { CheckResult, Issue } from "../types.js";
import { gradeFromScore } from "../types.js";

export function runAccessibility(cwd: string): CheckResult {
	const start = Date.now();
	const files = getProductionFiles(cwd).filter((f) => f.ext === ".tsx" || f.ext === ".jsx" || f.ext === ".vue" || f.ext === ".svelte");

	if (files.length === 0) {
		return {
			name: "accessibility",
			score: 100,
			grade: "A",
			details: { skipped: true, reason: "no JSX/TSX/Vue/Svelte files" },
			issues: [],
			duration: Date.now() - start,
		};
	}

	const issues: Issue[] = [];
	const deps = readDeps(cwd);
	// If jsx-a11y plugin is installed, most a11y rules are handled by lint runner
	const hasA11yPlugin = !!deps["eslint-plugin-jsx-a11y"];
	if (hasA11yPlugin) {
		return {
			name: "accessibility",
			score: 100,
			grade: "A",
			details: { skipped: true, reason: "covered by eslint-plugin-jsx-a11y (see lint check)" },
			issues: [],
			duration: Date.now() - start,
		};
	}
	let missingAlt = 0;
	let clickDiv = 0;
	let missingLabel = 0;
	let missingLang = 0;
	let autofocus = 0;
	let positiveTabindex = 0;

	for (const f of files) {
		// For SFCs, use raw content (includes template) for a11y checks
		const source = f.rawContent || f.content;
		const lines = source.split("\n");

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const trimmed = line.trim();
			if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;

			// 1. <img> without alt
			if (/<img\b/.test(trimmed) && !/alt=/.test(trimmed)) {
				const block = lines.slice(i, Math.min(i + 5, lines.length)).join(" ");
				if (/<img\b/.test(block) && !/alt=/.test(block)) {
					missingAlt++;
					issues.push({ severity: "error", message: "<img> missing alt attribute", file: f.path, line: i + 1, rule: "img-alt" });
				}
			}

			// 2. Click handler on non-interactive element without role/keyboard
			// React: onClick=, Vue: @click/v-on:click, Svelte: on:click
			if (/(?:onClick=|@click|v-on:click|on:click)/.test(trimmed) && /<(?:div|span|p|li|section|article|header|footer)\b/.test(trimmed)) {
				const block = lines.slice(i, Math.min(i + 3, lines.length)).join(" ");
				if (!(/role=/.test(block) && /(?:onKeyDown|onKeyUp|onKeyPress|tabIndex|@keydown|on:keydown)/.test(block))) {
					clickDiv++;
					issues.push({
						severity: "warning",
						message: "Click handler on non-interactive element without role + keyboard handler",
						file: f.path,
						line: i + 1,
						rule: "click-events",
					});
				}
			}

			// 3. <input>/<select>/<textarea> without associated label
			if (/<(?:input|select|textarea)\b/.test(trimmed) && !/type=["'](?:hidden|submit|button|reset)["']/.test(trimmed)) {
				const block = lines.slice(Math.max(0, i - 3), Math.min(i + 3, lines.length)).join(" ");
				if (!/aria-label=/.test(block) && !/aria-labelledby=/.test(block) && !/<label/.test(block) && !/id=/.test(trimmed)) {
					missingLabel++;
					issues.push({
						severity: "warning",
						message: "Form control without label, aria-label, or aria-labelledby",
						file: f.path,
						line: i + 1,
						rule: "form-label",
					});
				}
			}

			// 4. autoFocus
			if (/\bautoFocus\b/.test(trimmed) || /\bautofocus\b/.test(trimmed)) {
				autofocus++;
				issues.push({
					severity: "warning",
					message: "autoFocus can disorient screen reader users",
					file: f.path,
					line: i + 1,
					rule: "no-autofocus",
				});
			}

			// 5. Positive tabIndex
			if (/tabIndex=\{[1-9]/.test(trimmed) || /tabindex=["'][1-9]/.test(trimmed)) {
				positiveTabindex++;
				issues.push({
					severity: "warning",
					message: "Positive tabIndex disrupts natural tab order — use 0 or -1",
					file: f.path,
					line: i + 1,
					rule: "tabindex",
				});
			}
			// 6. Vue: v-for without :key (check same element, not next lines)
			if (/v-for=/.test(trimmed)) {
				// Collect the full opening tag (may span multiple lines until >)
				let tag = trimmed;
				for (let k = i + 1; k < Math.min(i + 5, lines.length) && !tag.includes(">"); k++) {
					tag += ` ${lines[k].trim()}`;
				}
				if (!/:key=/.test(tag) && !/v-bind:key=/.test(tag)) {
					issues.push({
						severity: "error",
						message: "v-for without :key — causes rendering bugs when list changes",
						file: f.path,
						line: i + 1,
						rule: "vue-v-for-key",
					});
				}
			}
		}
	}

	// 7. Check for html lang attribute + viewport + mobile meta in index.html
	const htmlPaths = ["index.html", "web/index.html", "public/index.html", "src/index.html"];
	for (const h of htmlPaths) {
		const full = join(cwd, h);
		if (!existsSync(full)) continue;
		const content = readFileSync(full, "utf-8");
		if (/<html\b/.test(content) && !/<html[^>]*lang=/.test(content)) {
			missingLang++;
			issues.push({ severity: "warning", message: "<html> missing lang attribute", file: h, rule: "html-lang" });
		}
		// Mobile viewport
		if (!/<meta[^>]*name=["']viewport["']/.test(content)) {
			issues.push({
				severity: "error",
				message: 'Missing <meta name="viewport"> — page won\'t scale on mobile',
				file: h,
				rule: "missing-viewport",
			});
		}
		// charset
		if (!/<meta[^>]*charset=/i.test(content)) {
			issues.push({ severity: "warning", message: "Missing <meta charset> — may cause encoding issues", file: h, rule: "missing-charset" });
		}
		// Touch icon for mobile bookmarks
		if (!/<link[^>]*apple-touch-icon/.test(content) && !/<link[^>]*icon/.test(content)) {
			issues.push({
				severity: "info",
				message: "No favicon or apple-touch-icon — poor mobile bookmark experience",
				file: h,
				rule: "missing-icon",
			});
		}
	}

	// 8. Mobile-unfriendly patterns in components
	for (const f of files) {
		const source = f.rawContent || f.content;
		const lines = source.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			// Fixed pixel widths that break on mobile
			if (/style=.*width:\s*\d{4,}px/.test(line)) {
				issues.push({
					severity: "info",
					message: "Fixed width ≥1000px — likely breaks on mobile",
					file: f.path,
					line: i + 1,
					rule: "fixed-width",
				});
			}
			// Horizontal scroll containers without overflow handling
			if (/overflow-x:\s*(?:scroll|auto)/.test(line) && !/\btouch\b/.test(line) && !/-webkit-overflow-scrolling/.test(line)) {
				issues.push({
					severity: "info",
					message: "Horizontal scroll without touch-action — poor mobile scroll UX",
					file: f.path,
					line: i + 1,
					rule: "touch-scroll",
				});
			}
			// Hover-only interactions (no touch fallback)
			if (/onMouseEnter=|@mouseenter|on:mouseenter/.test(line) && !/onClick=|@click|on:click|onTouchStart|@touchstart/.test(line)) {
				issues.push({
					severity: "info",
					message: "Hover-only interaction — unreachable on touch devices",
					file: f.path,
					line: i + 1,
					rule: "hover-only",
				});
			}
			// Tiny touch targets
			if (/(?:width|height):\s*(?:1[0-9]|[1-9])px/.test(line) && /(?:onClick|@click|on:click|button|<a )/.test(line)) {
				issues.push({
					severity: "info",
					message: "Touch target likely <44px — hard to tap on mobile (WCAG 2.5.8)",
					file: f.path,
					line: i + 1,
					rule: "small-touch-target",
				});
			}
		}
	}

	const errors = issues.filter((i) => i.severity === "error").length;
	const warnings = issues.filter((i) => i.severity === "warning").length;
	const totalFiles = files.length || 1;
	const errorPenalty = Math.min(60, (errors / totalFiles) * 200);
	const warnPenalty = Math.min(30, (warnings / totalFiles) * 100);
	const score = Math.max(0, Math.min(100, Math.round(100 - errorPenalty - warnPenalty)));

	return {
		name: "accessibility",
		score,
		grade: gradeFromScore(score),
		details: {
			jsxFiles: files.length,
			missingAlt,
			clickDiv,
			missingLabel,
			missingLang,
			autofocus,
			positiveTabindex,
			suggestion: !hasA11yPlugin
				? "Install eslint-plugin-jsx-a11y for deeper accessibility analysis: pnpm add -D eslint-plugin-jsx-a11y"
				: undefined,
		},
		issues,
		duration: Date.now() - start,
	};
}
