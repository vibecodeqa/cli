/** Code standards check — naming conventions, anti-patterns, config hygiene. */

import { readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { getProductionFiles, readDeps } from "../fs-utils.js";
import type { CheckResult, Issue, StackInfo } from "../types.js";
import { gradeFromScore } from "../types.js";

interface PatternCheck {
	name: string;
	pattern: RegExp;
	severity: "error" | "warning";
	message: string;
	exclude?: RegExp; // skip lines matching this
}

const CODE_SMELLS: PatternCheck[] = [
	{
		name: "console.log",
		pattern: /\bconsole\.(log|debug|info)\s*\(/,
		severity: "warning",
		message: "console.log in production code",
		exclude: /\/\/ ?ok|eslint-disable|biome-ignore/,
	},
	{ name: "var keyword", pattern: /\bvar\s+\w/, severity: "error", message: "Use const/let instead of var" },
	{ name: "loose equality", pattern: /[^!=]==[^=]/, severity: "warning", message: "Use === instead of ==", exclude: /['"]use strict['"]/ },
	{ name: "eval()", pattern: /\beval\s*\(/, severity: "error", message: "eval() is a security risk — never use it" },
	{ name: "new Function()", pattern: /new\s+Function\s*\(/, severity: "error", message: "new Function() is equivalent to eval()" },
	{
		name: "innerHTML assignment",
		pattern: /\.innerHTML\s*=/,
		severity: "warning",
		message: "innerHTML is an XSS vector — use textContent or DOM APIs",
	},
	{
		name: "dangerouslySetInnerHTML",
		pattern: /dangerouslySetInnerHTML/,
		severity: "error",
		message: "dangerouslySetInnerHTML bypasses React's XSS protection",
	},
	{ name: "document.write", pattern: /document\.write\s*\(/, severity: "error", message: "document.write blocks rendering" },
	{
		name: "http:// URL",
		pattern: /['"]http:\/\/(?!localhost|127\.0\.0\.1|www\.w3\.org|schemas?\.)/,
		severity: "warning",
		message: "Non-HTTPS URL — use https://",
	},
	{ name: "TODO/FIXME", pattern: /\b(TODO|FIXME|HACK|XXX)\b/, severity: "warning", message: "Unresolved TODO/FIXME comment" },
	{
		name: "magic number",
		pattern: /(?:timeout|delay|interval|limit|max|min)\s*[:=]\s*\d{4,}(?!\d)/,
		severity: "warning",
		message: "Large magic number — consider a named constant",
	},
];

export function runStandards(cwd: string, stack: StackInfo): CheckResult {
	const start = Date.now();
	const issues: Issue[] = [];

	// Collect source files
	const files = getProductionFiles(cwd);

	// ── File naming conventions ──
	let namingViolations = 0;
	for (const f of files) {
		const name = basename(f.path);
		const ext = extname(name);
		const base = name.replace(ext, "");

		// React components should be PascalCase
		if ((ext === ".tsx" || ext === ".jsx") && /^[A-Z]/.test(base)) {
			// PascalCase component file — correct
		} else if ((ext === ".tsx" || ext === ".jsx") && /^[a-z]/.test(base) && base !== "main" && base !== "index") {
			// lowercase tsx file that's not main/index — check if it exports a component
			if (/export (default )?(function|const) [A-Z]/.test(f.content)) {
				namingViolations++;
				issues.push({ severity: "warning", message: `Component file should be PascalCase: ${name}`, file: f.path, rule: "file-naming" });
			}
		}

		// Non-component TS files should be kebab-case or camelCase
		if (ext === ".ts" && /[A-Z]/.test(base) && base !== "App" && !base.includes(".")) {
			// PascalCase .ts file (not a component) — unusual
			// Only flag if it's not a class file
			if (!/export (default )?class /.test(f.content)) {
				issues.push({
					severity: "warning",
					message: `TS file uses PascalCase but doesn't export a class: ${name}`,
					file: f.path,
					rule: "file-naming",
				});
			}
		}
	}

	// ── Large files ──
	let largeFiles = 0;
	for (const f of files) {
		const lines = f.content.split("\n").length;
		if (lines > 300) {
			largeFiles++;
			issues.push({ severity: "warning", message: `${lines} lines — consider splitting (max 300)`, file: f.path, rule: "large-file" });
		} else if (lines > 200) {
			issues.push({ severity: "warning", message: `${lines} lines — getting large`, file: f.path, rule: "large-file" });
		}
	}

	// ── Code smell patterns ──
	let smellCount = 0;
	for (const f of files) {
		const lines = f.content.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const trimmed = line.trim();
			if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
			if (/\bpattern\s*:|name:\s*["']|message:\s*["']|description:\s*["']|risk:\s*["']|recommendation:\s*["']/.test(trimmed)) continue;
			// Skip string-only lines (check-meta descriptions, inline scripts)
			if (/^\s*["'`].*["'`][,;]?\s*$/.test(line)) continue;

			for (const check of CODE_SMELLS) {
				// Skip console.log in CLI entry points (intentional output)
				if (check.name === "console.log" && (f.path.includes("cli.") || f.path.includes("bin/"))) continue;
				if (check.pattern.test(line)) {
					if (check.exclude?.test(line)) continue;
					smellCount++;
					issues.push({ severity: check.severity, message: check.message, file: f.path, line: i + 1, rule: check.name });
				}
			}
		}
	}

	// ── Config hygiene ──
	// tsconfig strict mode
	if (stack.language === "typescript") {
		const tsconfigPaths = ["tsconfig.json", "tsconfig.app.json", "tsconfig.base.json"];
		let strictFound = false;
		for (const p of tsconfigPaths) {
			try {
				const tsconfig = JSON.parse(readFileSync(join(cwd, p), "utf-8"));
				if (tsconfig.compilerOptions?.strict === true) strictFound = true;
			} catch {
				/* no tsconfig */
			}
		}
		if (!strictFound) {
			issues.push({
				severity: "warning",
				message: 'TypeScript strict mode not enabled — add "strict": true to tsconfig',
				rule: "ts-strict",
			});
		}
	}

	// Tailwind: check for inline styles when TW is available
	if (stack.framework === "react" && readDeps(cwd).tailwindcss) {
		let inlineStyles = 0;
		for (const f of files) {
			if (!f.path.endsWith(".tsx")) continue;
			const matches = f.content.match(/style=\{\{/g);
			if (matches) inlineStyles += matches.length;
		}
		if (inlineStyles > 10) {
			issues.push({
				severity: "warning",
				message: `${inlineStyles} inline style objects in TSX — prefer Tailwind classes`,
				rule: "prefer-tailwind",
			});
		}
	}

	const errors = issues.filter((i) => i.severity === "error").length;
	const warnings = issues.filter((i) => i.severity === "warning").length;
	// Scale penalties relative to codebase size — cap individual penalties
	const totalFiles = files.length || 1;
	const errorPenalty = Math.min(40, (errors / totalFiles) * 150);
	const warningPenalty = Math.min(30, (warnings / totalFiles) * 80);
	const largePenalty = Math.min(20, (largeFiles / totalFiles) * 100);
	const score = Math.max(0, Math.min(100, Math.round(100 - errorPenalty - warningPenalty - largePenalty)));

	return {
		name: "standards",
		score,
		grade: gradeFromScore(score),
		details: { filesScanned: files.length, codeSmells: smellCount, largeFiles, namingViolations },
		issues,
		duration: Date.now() - start,
	};
}
