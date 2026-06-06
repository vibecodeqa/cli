/** Styling consistency — detects AI-generated CSS antipatterns.
 *
 * Checks:
 *   1. Mixed styling approaches (Tailwind + CSS modules + styled-components + inline)
 *   2. Hardcoded colors instead of design tokens / CSS variables / Tailwind palette
 *   3. Magic numbers in spacing (not on a consistent scale)
 *   4. Inline style objects vs className (ratio)
 *   5. !important abuse
 *   6. Duplicate Tailwind class strings across components
 *   7. Inconsistent spacing values
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getProductionFiles, readDeps } from "../fs-utils.js";
import type { CheckResult, Issue } from "../types.js";
import { gradeFromScore } from "../types.js";

// Common CSS color hex patterns (not CSS variables or Tailwind)
const HARDCODED_COLOR = /(?:color|background|border|fill|stroke|shadow)\s*:\s*['"]?#[0-9a-fA-F]{3,8}\b/;
const HARDCODED_COLOR_JSX = /(?:color|backgroundColor|borderColor|fill|stroke)\s*:\s*['"]#[0-9a-fA-F]{3,8}/;

// Magic number spacing (not multiples of 4, not 0/1/2)
const SPACING_PROP = /(?:margin|padding|gap|top|bottom|left|right|width|height|inset)\s*:\s*/;
const MAGIC_PX = /(\d+)px/g;

// Styling approach detection
const TAILWIND_CLASS = /className\s*=\s*["'`][^"'`]*(?:flex|grid|p-|m-|text-|bg-|rounded|border|shadow|w-|h-)/;
const CSS_MODULE = /styles\.\w+|\.module\.css|\.module\.scss/;
const STYLED_COMPONENT = /styled\.\w+|styled\(|css`/;
const INLINE_STYLE = /style\s*=\s*\{\s*\{|style\s*=\s*\{[^}]/;
const EMOTION_CSS = /@emotion|css\s*\(/;

export function runStyling(cwd: string): CheckResult {
	const start = Date.now();
	const issues: Issue[] = [];
	const files = getProductionFiles(cwd);
	const deps = readDeps(cwd);

	// Detect which styling approaches are used
	const approaches = new Map<string, number>();
	const hasTailwind = existsSync(join(cwd, "tailwind.config.js")) ||
		existsSync(join(cwd, "tailwind.config.ts")) ||
		existsSync(join(cwd, "tailwind.config.mjs")) ||
		!!deps.tailwindcss;

	let totalComponentFiles = 0;
	let inlineStyleCount = 0;
	let classNameCount = 0;
	let hardcodedColorCount = 0;
	let importantCount = 0;
	const spacingValues = new Map<number, number>(); // px value → count
	const tailwindStrings = new Map<string, string[]>(); // class string → [files]

	// Scan CSS/SCSS files for !important (getProductionFiles only returns JS/TS)
	scanCssFiles(cwd, "src", (content) => {
		importantCount += (content.match(/!important/g) || []).length;
	});

	// Scan source files
	for (const f of files) {
		if (f.isTest) continue;
		const isComponent = /\.(tsx|jsx|vue|svelte)$/.test(f.path);
		if (!isComponent) continue;

		if (isComponent) totalComponentFiles++;
		const lines = f.content.split("\n");

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const trimmed = line.trim();
			if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;

			// Detect styling approaches
			if (TAILWIND_CLASS.test(line)) approaches.set("tailwind", (approaches.get("tailwind") || 0) + 1);
			if (CSS_MODULE.test(line)) approaches.set("css-modules", (approaches.get("css-modules") || 0) + 1);
			if (STYLED_COMPONENT.test(line)) approaches.set("styled-components", (approaches.get("styled-components") || 0) + 1);
			if (EMOTION_CSS.test(line)) approaches.set("emotion", (approaches.get("emotion") || 0) + 1);
			if (INLINE_STYLE.test(line)) {
				approaches.set("inline", (approaches.get("inline") || 0) + 1);
				inlineStyleCount++;
			}
			if (/className/.test(line)) classNameCount++;

			// Hardcoded colors
			if (HARDCODED_COLOR.test(line) || HARDCODED_COLOR_JSX.test(line)) {
				// Skip CSS variable definitions (--color-primary: #xxx)
				if (/--[\w-]+\s*:/.test(line)) continue;
				// Skip Tailwind config
				if (f.path.includes("tailwind.config")) continue;
				// Skip theme/token definition files
				if (f.path.includes("theme") || f.path.includes("tokens") || f.path.includes("colors")) continue;

				hardcodedColorCount++;
				if (hardcodedColorCount <= 5) {
					const match = line.match(/#[0-9a-fA-F]{3,8}/);
					issues.push({
						severity: "warning",
						message: `Hardcoded color ${match?.[0] || ""} — use a CSS variable or design token`,
						file: f.path,
						line: i + 1,
						rule: "hardcoded-color",
					});
				}
			}

			// !important
			if (/!important/.test(line) && !trimmed.startsWith("//")) {
				importantCount++;
			}

			// Spacing values
			if (SPACING_PROP.test(line)) {
				let match: RegExpExecArray | null;
				MAGIC_PX.lastIndex = 0;
				while ((match = MAGIC_PX.exec(line)) !== null) {
					const px = parseInt(match[1], 10);
					if (px > 2) {
						spacingValues.set(px, (spacingValues.get(px) || 0) + 1);
					}
				}
			}

			// Duplicate Tailwind class strings
			if (hasTailwind) {
				const classMatch = line.match(/className\s*=\s*["'`]([^"'`]{20,})["'`]/);
				if (classMatch) {
					const classes = classMatch[1].trim();
					const existing = tailwindStrings.get(classes) || [];
					existing.push(f.path);
					tailwindStrings.set(classes, existing);
				}
			}
		}

	}

	if (totalComponentFiles === 0) {
		return {
			name: "styling",
			score: 0,
			grade: "F",
			details: { skipped: true, reason: "no component files found" },
			issues: [],
			duration: Date.now() - start,
		};
	}

	// ── Analyze results ──

	// 1. Mixed approaches
	const activeApproaches = [...approaches.entries()].filter(([, count]) => count >= 3);
	if (activeApproaches.length > 1) {
		const names = activeApproaches.map(([name, count]) => `${name} (${count})`).join(", ");
		issues.push({
			severity: "warning",
			message: `Mixed styling approaches: ${names} — pick one and migrate`,
			rule: "mixed-styling",
		});
	}

	// 2. Inline style ratio
	if (totalComponentFiles > 3 && inlineStyleCount > 0) {
		const ratio = inlineStyleCount / (inlineStyleCount + classNameCount);
		if (ratio > 0.3) {
			issues.push({
				severity: "warning",
				message: `${Math.round(ratio * 100)}% inline styles — extract to CSS classes or Tailwind`,
				rule: "inline-style-ratio",
			});
		}
	}

	// 3. Hardcoded colors summary
	if (hardcodedColorCount > 5) {
		issues.push({
			severity: "warning",
			message: `${hardcodedColorCount} hardcoded colors total — define a color palette`,
			rule: "hardcoded-color",
		});
	}

	// 4. !important abuse
	if (importantCount > 3) {
		issues.push({
			severity: "warning",
			message: `${importantCount} uses of !important — indicates specificity wars`,
			rule: "important-abuse",
		});
	}

	// 5. Inconsistent spacing scale
	if (spacingValues.size > 0) {
		const values = [...spacingValues.keys()].sort((a, b) => a - b);
		const notOnScale = values.filter((v) => v % 4 !== 0 && v !== 1 && v !== 2);
		if (notOnScale.length > 3) {
			issues.push({
				severity: "warning",
				message: `Inconsistent spacing: ${notOnScale.slice(0, 6).join(", ")}px — use a 4px/8px scale`,
				rule: "inconsistent-spacing",
			});
		}
	}

	// 6. Duplicate Tailwind strings
	if (hasTailwind) {
		let dupeCount = 0;
		for (const [classes, usedIn] of tailwindStrings) {
			if (usedIn.length >= 3) {
				dupeCount++;
				if (dupeCount <= 3) {
					issues.push({
						severity: "info",
						message: `Tailwind classes duplicated in ${usedIn.length} files — extract component: "${classes.slice(0, 60)}${classes.length > 60 ? "..." : ""}"`,
						rule: "duplicate-tailwind",
					});
				}
			}
		}
		if (dupeCount > 3) {
			issues.push({
				severity: "warning",
				message: `${dupeCount} duplicated Tailwind class strings — extract shared components`,
				rule: "duplicate-tailwind",
			});
		}
	}

	// 7. Tailwind best practices
	if (hasTailwind) {
		// Check for tailwind.config with theme extension
		let hasThemeExtend = false;
		for (const configFile of ["tailwind.config.js", "tailwind.config.ts", "tailwind.config.mjs"]) {
			const configPath = join(cwd, configFile);
			if (existsSync(configPath)) {
				try {
					const content = readFileSync(configPath, "utf-8");
					if (content.includes("extend")) hasThemeExtend = true;
				} catch { /* ignore */ }
				break;
			}
		}
		if (!hasThemeExtend && totalComponentFiles > 5) {
			issues.push({
				severity: "info",
				message: "No theme extension in tailwind.config — consider defining custom colors/spacing",
				rule: "tailwind-no-theme",
			});
		}
	}

	// Score
	const errorCount = issues.filter((i) => i.severity === "error").length;
	const warnCount = issues.filter((i) => i.severity === "warning").length;
	const score = Math.max(0, 100 - errorCount * 20 - warnCount * 12);

	return {
		name: "styling",
		score,
		grade: gradeFromScore(score),
		details: {
			totalComponentFiles,
			approaches: Object.fromEntries(approaches),
			hasTailwind,
			inlineStyleCount,
			hardcodedColorCount,
			importantCount,
			spacingValues: spacingValues.size,
		},
		issues,
		duration: Date.now() - start,
	};
}

/** Recursively scan a directory for CSS/SCSS files and call fn with content. */
function scanCssFiles(cwd: string, subdir: string, fn: (content: string) => void): void {
	const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
	const dir = join(cwd, subdir);
	if (!existsSync(dir)) return;
	try {
		for (const entry of readdirSync(dir)) {
			if (entry === "node_modules" || entry === ".git" || entry === ".vibe-check") continue;
			const full = join(dir, entry);
			try {
				const stat = statSync(full);
				if (stat.isDirectory()) {
					scanCssFiles(cwd, join(subdir, entry), fn);
				} else if (/\.(css|scss)$/.test(entry)) {
					fn(readFileSync(full, "utf-8"));
				}
			} catch { /* skip */ }
		}
	} catch { /* skip */ }
}
