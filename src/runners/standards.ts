/**
 * Code standards check — naming conventions, anti-patterns, config hygiene.
 *
 * Dangerous browser/runtime APIs are deliberately NOT here. `security.ts` owns
 * `eval`, `new Function`, `innerHTML`, `document.write` and
 * `dangerouslySetInnerHTML` (CWE-79/CWE-94), and grades them with context this
 * runner does not have — notably HTML provenance for `dangerouslySetInnerHTML`
 * (#86), which a flat pattern rule here silently overrode with `error`.
 * Do not re-add them: a second flat rule reintroduces that regression.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { FileInventory } from "../file-inventory.js";
import { inventorySourceFiles } from "../file-inventory.js";
import { getProductionFiles } from "../fs-utils.js";
import type { CheckResult, Issue, StackInfo, WorkspaceInfo } from "../types.js";
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
	{ name: "var keyword", pattern: /\bvar\s+\w/, severity: "warning", message: "Use const/let instead of var" },
	{ name: "loose equality", pattern: /[^!=]==[^=]/, severity: "warning", message: "Use === instead of ==", exclude: /['"]use strict['"]/ },
	// eval / new Function / innerHTML / dangerouslySetInnerHTML / document.write live in security.ts — see the file header.
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

export function runStandards(cwd: string, stack: StackInfo, workspace?: WorkspaceInfo, inventory?: FileInventory): CheckResult {
	const start = Date.now();
	const issues: Issue[] = [];

	// Detect CLI projects — console.log is intentional in CLI tools
	let isCLI = false;
	try {
		const pkgPath = join(cwd, "package.json");
		if (existsSync(pkgPath)) {
			const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
			isCLI = !!pkg.bin;
		}
	} catch {
		/* ignore */
	}

	// Collect source files
	const files = inventory ? inventorySourceFiles(inventory) : getProductionFiles(cwd);

	// ── File naming conventions ──
	let namingViolations = 0;

	// Detect dominant convention for tsx/jsx files before flagging
	const tsxFiles = files.filter((f) => {
		const ext = extname(basename(f.path));
		return ext === ".tsx" || ext === ".jsx";
	});
	const pascalCount = tsxFiles.filter((f) => /^[A-Z]/.test(basename(f.path).replace(extname(basename(f.path)), ""))).length;
	const usesKebabConvention = tsxFiles.length >= 3 && pascalCount < tsxFiles.length / 2;

	for (const f of files) {
		const name = basename(f.path);
		const ext = extname(name);
		const base = name.replace(ext, "");

		// React components should be PascalCase — but only flag if PascalCase is the project convention
		if ((ext === ".tsx" || ext === ".jsx") && /^[A-Z]/.test(base)) {
			// PascalCase component file — correct
		} else if (!usesKebabConvention && (ext === ".tsx" || ext === ".jsx") && /^[a-z]/.test(base) && base !== "main" && base !== "index") {
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

	// ── Large files (exponential penalty) ──
	// Penalty grows with the square of excess lines. A 300-line file is a nudge.
	// A 600-line file is a wall. A 1000-line file tanks the check.
	let largeFiles = 0;
	let fileSizePenalty = 0;
	const SOFT_LIMIT = 300;
	for (const f of files) {
		const lines = f.content.split("\n").length;
		if (lines > SOFT_LIMIT * 2) {
			largeFiles++;
			const excess = lines - SOFT_LIMIT;
			fileSizePenalty += (excess / 100) ** 2;
			issues.push({
				severity: "warning",
				message: `${lines} lines — split this file (exponential penalty above ${SOFT_LIMIT})`,
				file: f.path,
				rule: "large-file",
			});
		} else if (lines > SOFT_LIMIT) {
			largeFiles++;
			const excess = lines - SOFT_LIMIT;
			fileSizePenalty += (excess / 100) ** 2;
			issues.push({
				severity: "warning",
				message: `${lines} lines — consider splitting (penalty grows exponentially above ${SOFT_LIMIT})`,
				file: f.path,
				rule: "large-file",
			});
		}
	}

	// ── Code smell patterns ──
	let smellCount = 0;
	for (const f of files) {
		const maskedContent = maskJsTextSpans(f.content);
		const lines = maskedContent.split("\n");
		const originalLines = f.content.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const originalLine = originalLines[i] ?? "";
			const line = lines[i] ?? "";
			const trimmed = line.trim();
			if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
			if (/\bpattern\s*:|name:\s*["']|message:\s*["']|description:\s*["']|risk:\s*["']|recommendation:\s*["']/.test(originalLine.trim()))
				continue;
			// Skip string-only lines (check-meta descriptions, inline scripts)
			if (/^\s*["'`].*["'`][,;]?\s*$/.test(originalLine)) continue;

			for (const check of CODE_SMELLS) {
				// Skip console.log in CLI projects (intentional terminal output)
				if (check.name === "console.log" && isCLI) continue;
				if (check.pattern.test(line)) {
					if (check.exclude?.test(line)) continue;
					smellCount++;
					issues.push({ severity: check.severity, message: check.message, file: f.path, line: i + 1, rule: check.name });
				}
			}
		}
	}

	// ── Config hygiene ──
	// tsconfig maturity
	if (stack.language === "typescript") {
		const tsconfigPaths = ["tsconfig.json", "tsconfig.app.json", "tsconfig.base.json"];
		// In monorepos, also check each workspace package's tsconfig
		if (workspace?.isMonorepo) {
			for (const pkg of workspace.packages) {
				tsconfigPaths.push(join(pkg.path, "tsconfig.json"));
			}
		}
		let strictFound = false;
		let compilerOpts: Record<string, unknown> = {};
		for (const p of tsconfigPaths) {
			try {
				const raw = readFileSync(join(cwd, p), "utf-8");
				const tsconfig = JSON.parse(raw.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, ""));
				if (tsconfig.compilerOptions?.strict === true) strictFound = true;
				if (tsconfig.compilerOptions) compilerOpts = { ...compilerOpts, ...tsconfig.compilerOptions };
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
		// Additional maturity flags (info — recommended, not required)
		if (strictFound) {
			if (!compilerOpts.noUncheckedIndexedAccess) {
				issues.push({
					severity: "info",
					message: "Enable noUncheckedIndexedAccess — array/object index access returns T | undefined, catches real bugs",
					rule: "ts-maturity",
				});
			}
			if (!compilerOpts.verbatimModuleSyntax && !compilerOpts.isolatedModules) {
				issues.push({
					severity: "info",
					message: "Enable verbatimModuleSyntax — enforces explicit type-only imports, better for bundlers",
					rule: "ts-maturity",
				});
			}
			if (!compilerOpts.skipLibCheck) {
				issues.push({
					severity: "info",
					message: "Enable skipLibCheck — faster builds, skip type-checking .d.ts files from node_modules",
					rule: "ts-maturity",
				});
			}
		}
	}

	const errors = issues.filter((i) => i.severity === "error").length;
	const warnings = issues.filter((i) => i.severity === "warning").length;
	// Scale penalties relative to codebase size — cap individual penalties
	const totalFiles = files.length || 1;
	const errorPenalty = Math.min(40, (errors / totalFiles) * 150);
	const warningPenalty = Math.min(30, (warnings / totalFiles) * 80);
	// fileSizePenalty is already exponential — normalize by file count, cap at 80
	const largePenalty = Math.min(80, (fileSizePenalty / totalFiles) * 3);
	const score = Math.max(0, Math.min(100, Math.round(100 - errorPenalty - warningPenalty - largePenalty)));

	return {
		name: "standards",
		score,
		grade: gradeFromScore(score),
		details: {
			filesScanned: files.length,
			codeSmells: smellCount,
			largeFiles,
			namingViolations,
			source: inventory ? "file-inventory" : "legacy-walk",
		},
		issues,
		duration: Date.now() - start,
	};
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: quote/comment masking is a tiny state machine; splitting it obscures the transitions.
function maskJsTextSpans(source: string): string {
	let out = "";
	let mode: "code" | "single" | "double" | "template" | "line-comment" | "block-comment" = "code";
	const templateExpressionDepths: number[] = [];

	for (let i = 0; i < source.length; i++) {
		const c = source[i]!;
		const next = source[i + 1];

		if (mode === "line-comment") {
			if (c === "\n") {
				out += "\n";
				mode = "code";
			} else {
				out += " ";
			}
			continue;
		}

		if (mode === "block-comment") {
			out += c === "\n" ? "\n" : " ";
			if (c === "*" && next === "/") {
				out += " ";
				i++;
				mode = "code";
			}
			continue;
		}

		if (mode === "single" || mode === "double") {
			out += " ";
			if (c === "\\" && next) {
				out += next === "\n" ? "\n" : " ";
				i++;
				continue;
			}
			if ((mode === "single" && c === "'") || (mode === "double" && c === '"')) mode = "code";
			continue;
		}

		if (mode === "template") {
			if (c === "\n") {
				out += "\n";
				continue;
			}
			out += " ";
			if (c === "\\" && next) {
				out += next === "\n" ? "\n" : " ";
				i++;
				continue;
			}
			if (c === "`") {
				mode = "code";
				continue;
			}
			if (c === "$" && next === "{") {
				out += " ";
				i++;
				templateExpressionDepths.push(1);
				mode = "code";
			}
			continue;
		}

		if (templateExpressionDepths.length > 0) {
			const depthIndex = templateExpressionDepths.length - 1;
			if (c === "{") templateExpressionDepths[depthIndex]++;
			if (c === "}") {
				templateExpressionDepths[depthIndex]--;
				if (templateExpressionDepths[depthIndex] === 0) {
					templateExpressionDepths.pop();
					out += " ";
					mode = "template";
					continue;
				}
			}
		}

		if (c === "/" && next === "/") {
			out += "  ";
			i++;
			mode = "line-comment";
			continue;
		}
		if (c === "/" && next === "*") {
			out += "  ";
			i++;
			mode = "block-comment";
			continue;
		}
		if (c === "'") {
			out += " ";
			mode = "single";
			continue;
		}
		if (c === '"') {
			out += " ";
			mode = "double";
			continue;
		}
		if (c === "`") {
			out += " ";
			mode = "template";
			continue;
		}
		out += c;
	}

	return out;
}
