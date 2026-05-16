/** Accessibility check — detects common a11y violations in JSX/TSX code. */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getProductionFiles } from "../fs-utils.js";
import type { CheckResult, Issue } from "../types.js";
import { gradeFromScore } from "../types.js";

export function runAccessibility(cwd: string): CheckResult {
	const start = Date.now();
	const files = getProductionFiles(cwd).filter((f) => f.ext === ".tsx" || f.ext === ".jsx");

	if (files.length === 0) {
		return {
			name: "accessibility",
			score: 100,
			grade: "A",
			details: { skipped: true, reason: "no JSX/TSX files" },
			issues: [],
			duration: Date.now() - start,
		};
	}

	const issues: Issue[] = [];
	let missingAlt = 0;
	let clickDiv = 0;
	let missingLabel = 0;
	let missingLang = 0;
	let autofocus = 0;
	let positiveTabindex = 0;

	for (const f of files) {
		const lines = f.content.split("\n");

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
			if (/onClick=/.test(trimmed) && /<(?:div|span|p|li|section|article|header|footer)\b/.test(trimmed)) {
				const block = lines.slice(i, Math.min(i + 3, lines.length)).join(" ");
				if (!(/role=/.test(block) && /(?:onKeyDown|onKeyUp|onKeyPress|tabIndex)/.test(block))) {
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
		}
	}

	// 6. Check for html lang attribute in index.html
	const htmlPaths = ["index.html", "web/index.html", "public/index.html"];
	for (const h of htmlPaths) {
		const full = join(cwd, h);
		if (!existsSync(full)) continue;
		const content = readFileSync(full, "utf-8");
		if (/<html\b/.test(content) && !/<html[^>]*lang=/.test(content)) {
			missingLang++;
			issues.push({ severity: "warning", message: "<html> missing lang attribute", file: h, rule: "html-lang" });
		}
	}

	const errors = issues.filter((i) => i.severity === "error").length;
	const warnings = issues.filter((i) => i.severity === "warning").length;
	const score = Math.max(0, Math.min(100, 100 - errors * 10 - warnings * 4));

	return {
		name: "accessibility",
		score,
		grade: gradeFromScore(score),
		details: { jsxFiles: files.length, missingAlt, clickDiv, missingLabel, missingLang, autofocus, positiveTabindex },
		issues,
		duration: Date.now() - start,
	};
}
