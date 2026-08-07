/** Styling consistency — delegates to Stylelint when available, adds cross-file analysis.
 *
 * Tool delegation (same pattern as lint → biome/eslint, secrets → gitleaks):
 *   - Stylelint installed → run it for CSS/SCSS linting (170+ rules)
 *   - Always: cross-file analysis that no CSS linter covers:
 *     1. Mixed styling approaches (Tailwind + CSS modules + styled-components + inline)
 *     2. Hardcoded colors in JSX (not CSS — Stylelint handles CSS)
 *     3. Magic numbers in spacing (cross-file consistency)
 *     4. Inline style ratio
 *     5. !important abuse
 *     6. Duplicate Tailwind class strings across components
 *     7. Inconsistent spacing values across components
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { FileInventory } from "../file-inventory.js";
import { inventorySourceFiles } from "../file-inventory.js";
import { getProductionFiles, readDeps } from "../fs-utils.js";
import type { CheckResult, Issue, ProjectContext, WorkspaceInfo } from "../types.js";
import { gradeFromScore } from "../types.js";
import { runJSON } from "./exec.js";
import {
	cleanProjectPath,
	depsForProjects,
	filesForProjects,
	frontendProjects,
	projectContainsPath,
	projectDetails,
	projectSourceRoots,
} from "./project-scope.js";

// ── Stylelint delegation ──

interface StylelintResult {
	source: string;
	warnings: { line: number; column: number; rule: string; severity: string; text: string }[];
}

function tryStylelint(cwd: string, context: { projectId?: string; projectPath?: string } = {}): Issue[] | null {
	const deps = readDeps(cwd);
	if (!deps.stylelint) return null;

	// Check for config
	const hasConfig =
		existsSync(join(cwd, ".stylelintrc.json")) ||
		existsSync(join(cwd, ".stylelintrc.js")) ||
		existsSync(join(cwd, ".stylelintrc.yml")) ||
		existsSync(join(cwd, "stylelint.config.js")) ||
		existsSync(join(cwd, "stylelint.config.mjs")) ||
		existsSync(join(cwd, "stylelint.config.cjs"));

	if (!hasConfig) {
		// No config — try with standard config if available
		const hasStandard = deps["stylelint-config-standard"] || deps["stylelint-config-recommended"];
		if (!hasStandard) return null;
	}

	const results = runJSON<StylelintResult[]>(
		'npx stylelint --formatter json "**/*.{css,scss}" --ignore-pattern node_modules 2>/dev/null || true',
		cwd,
		30_000,
		context,
	);

	if (!results || !Array.isArray(results)) return null;

	const issues: Issue[] = [];
	for (const file of results) {
		const relPath = file.source.replace(`${cwd}/`, "").replace(`${cwd}\\`, "");
		for (const w of file.warnings) {
			issues.push({
				severity: w.severity === "error" ? "error" : "warning",
				message: `${w.text} (${w.rule})`,
				file: relPath,
				line: w.line,
				rule: w.rule,
			});
		}
	}
	return issues;
}

function prefixIssues(issues: Issue[], projectPath: string): Issue[] {
	const clean = cleanProjectPath(projectPath);
	if (clean === ".") return issues;
	return issues.map((issue) => {
		if (!issue.file || issue.file.startsWith(`${clean}/`)) return issue;
		return { ...issue, file: `${clean}/${issue.file}` };
	});
}

function tryStylelintForProjects(
	cwd: string,
	projects: ProjectContext[] | null,
): { issues: Issue[] | null; tool: "stylelint" | "built-in" } {
	if (!projects) {
		const issues = tryStylelint(cwd);
		return { issues, tool: issues ? "stylelint" : "built-in" };
	}
	let ran = false;
	const allIssues: Issue[] = [];
	for (const project of projects) {
		const projectDir = project.path === "." ? cwd : join(cwd, project.path);
		const issues = tryStylelint(projectDir, { projectId: project.id, projectPath: project.path });
		if (!issues) continue;
		ran = true;
		allIssues.push(...prefixIssues(issues, project.path));
	}
	return { issues: ran ? allIssues : null, tool: ran ? "stylelint" : "built-in" };
}

function hasTailwindProjectConfig(cwd: string, projects: ProjectContext[] | null): boolean {
	const roots = projects?.map((project) => project.path) ?? ["."];
	return roots.some((root) => {
		const dir = root === "." ? cwd : join(cwd, root);
		return (
			existsSync(join(dir, "tailwind.config.js")) ||
			existsSync(join(dir, "tailwind.config.ts")) ||
			existsSync(join(dir, "tailwind.config.mjs"))
		);
	});
}

function tailwindThemeExtended(cwd: string, projects: ProjectContext[] | null): boolean {
	const roots = projects?.map((project) => project.path) ?? ["."];
	for (const root of roots) {
		const dir = root === "." ? cwd : join(cwd, root);
		for (const cfg of ["tailwind.config.js", "tailwind.config.ts", "tailwind.config.mjs"]) {
			const path = join(dir, cfg);
			if (!existsSync(path)) continue;
			try {
				if (readFileSync(path, "utf-8").includes("extend")) return true;
			} catch {
				/* ignore */
			}
		}
	}
	return false;
}

// ── Cross-file analysis (our unique value — no linter covers this) ──

const TAILWIND_CLASS = /className\s*=\s*["'`][^"'`]*(?:flex|grid|p-|m-|text-|bg-|rounded|border|shadow|w-|h-)/;
const CSS_MODULE = /styles\.\w+|\.module\.css|\.module\.scss/;
const STYLED_COMPONENT = /styled\.\w+|styled\(|css`/;
const INLINE_STYLE = /style\s*=\s*\{\s*\{|style\s*=\s*\{[^}]/;
const EMOTION_CSS = /@emotion|css\s*\(/;
const HARDCODED_COLOR_JSX = /(?:color|backgroundColor|borderColor|fill|stroke)\s*:\s*['"]#[0-9a-fA-F]{3,8}/;
const SPACING_PROP = /(?:margin|padding|gap|top|bottom|left|right|width|height|inset)\s*:\s*/;
const MAGIC_PX = /(\d+)px/g;
const STYLING_ERROR_PENALTY = 25;
const STYLING_WARNING_PENALTY = 4;
const STYLING_INFO_PENALTY = 1;

export function stylingScore(issues: Issue[], componentFiles: number) {
	const errorCount = issues.filter((i) => i.severity === "error").length;
	const warnCount = issues.filter((i) => i.severity === "warning").length;
	const infoCount = issues.filter((i) => i.severity === "info").length;
	const hardFailure = errorCount > 0;
	const warningDensity = componentFiles > 0 ? warnCount / componentFiles : warnCount;
	const warningPenalty = Math.min(warnCount * STYLING_WARNING_PENALTY, Math.round(warningDensity * 16), 45);
	const infoPenalty = Math.min(infoCount * STYLING_INFO_PENALTY, 8);
	const errorPenalty = Math.min(errorCount * STYLING_ERROR_PENALTY, 75);
	const score = Math.max(0, 100 - errorPenalty - warningPenalty - infoPenalty);
	return {
		score,
		errorCount,
		warnCount,
		infoCount,
		hardFailure,
		warningDensity: Math.round(warningDensity * 100) / 100,
		penalties: { errors: errorPenalty, warnings: warningPenalty, info: infoPenalty },
	};
}

export function runStyling(cwd: string, workspace?: WorkspaceInfo, inventory?: FileInventory): CheckResult {
	const start = Date.now();
	const issues: Issue[] = [];
	const projects = frontendProjects(workspace);
	const sourceRoots = projects ? projectSourceRoots(projects) : undefined;
	const files = filesForProjects(inventory ? inventorySourceFiles(inventory) : getProductionFiles(cwd, sourceRoots), projects);
	const deps = depsForProjects(cwd, projects);

	const componentFiles = files.filter((f) => !f.isTest && /\.(tsx|jsx|vue|svelte)$/.test(f.path));
	if (componentFiles.length === 0) {
		return {
			name: "styling",
			score: 0,
			grade: "F",
			details: { skipped: true, reason: "no component files found", projects: projectDetails(projects, componentFiles) },
			issues: [],
			duration: Date.now() - start,
		};
	}

	// ── Phase 1: Delegate to Stylelint ──
	const stylelint = tryStylelintForProjects(cwd, projects);
	const tool = stylelint.tool;
	const stylelintIssues = stylelint.issues;
	if (stylelintIssues) {
		issues.push(...stylelintIssues);
	}

	// ── Phase 2: Cross-file analysis (always runs — Stylelint can't do this) ──
	const approaches = new Map<string, number>();
	const hasTailwind = hasTailwindProjectConfig(cwd, projects) || !!deps.tailwindcss;

	let inlineStyleCount = 0;
	let classNameCount = 0;
	let hardcodedColorCount = 0;
	let importantCount = 0;
	const spacingValues = new Map<number, number>();
	const tailwindStrings = new Map<string, string[]>();

	// Scan CSS files for !important (only if Stylelint didn't already flag them)
	if (!stylelintIssues) {
		for (const root of sourceRoots ?? ["src"]) {
			scanCssFiles(cwd, root, (content) => {
				importantCount += (content.match(/!important/g) || []).length;
			});
		}
	}

	for (const f of componentFiles) {
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

			// Hardcoded colors in JSX (Stylelint only catches CSS files)
			if (HARDCODED_COLOR_JSX.test(line)) {
				if (f.path.includes("tailwind.config") || f.path.includes("theme") || f.path.includes("tokens")) continue;
				hardcodedColorCount++;
				if (hardcodedColorCount <= 5) {
					const match = line.match(/#[0-9a-fA-F]{3,8}/);
					issues.push({
						severity: "warning",
						message: `Hardcoded color ${match?.[0] || ""} in JSX — use a CSS variable or design token`,
						file: f.path,
						line: i + 1,
						rule: "hardcoded-color",
					});
				}
			}

			// Spacing values (cross-file consistency)
			if (SPACING_PROP.test(line)) {
				for (const match of line.matchAll(MAGIC_PX)) {
					const px = parseInt(match[1], 10);
					if (px > 2) spacingValues.set(px, (spacingValues.get(px) || 0) + 1);
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

	// ── Aggregate findings ──

	// Mixed approaches
	const activeApproaches = [...approaches.entries()].filter(([, count]) => count >= 3);
	if (activeApproaches.length > 1) {
		issues.push({
			severity: "warning",
			message: `Mixed styling approaches: ${activeApproaches.map(([n, c]) => `${n} (${c})`).join(", ")} — pick one`,
			rule: "mixed-styling",
		});
	}

	// Inline style ratio
	if (componentFiles.length > 3 && inlineStyleCount > 0) {
		const ratio = inlineStyleCount / (inlineStyleCount + classNameCount);
		if (ratio > 0.3) {
			issues.push({
				severity: "warning",
				message: `${Math.round(ratio * 100)}% inline styles — extract to CSS classes or Tailwind`,
				rule: "inline-style-ratio",
			});
		}
	}

	// Hardcoded colors summary
	if (hardcodedColorCount > 5) {
		issues.push({
			severity: "warning",
			message: `${hardcodedColorCount} hardcoded colors in JSX — define a color palette`,
			rule: "hardcoded-color",
		});
	}

	// !important (only if we counted, not Stylelint)
	if (!stylelintIssues && importantCount > 3) {
		issues.push({
			severity: "warning",
			message: `${importantCount} uses of !important — indicates specificity wars`,
			rule: "important-abuse",
		});
	}

	// Inconsistent spacing
	const values = [...spacingValues.keys()].sort((a, b) => a - b);
	const notOnScale = values.filter((v) => v % 4 !== 0 && v !== 1 && v !== 2);
	if (notOnScale.length > 3) {
		issues.push({
			severity: "warning",
			message: `Inconsistent spacing: ${notOnScale.slice(0, 6).join(", ")}px — use a 4px/8px scale`,
			rule: "inconsistent-spacing",
		});
	}

	// Duplicate Tailwind strings
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

	// Tailwind theme check
	if (hasTailwind && componentFiles.length > 5) {
		if (!tailwindThemeExtended(cwd, projects)) {
			issues.push({
				severity: "info",
				message: "No theme extension in tailwind.config — consider defining custom colors/spacing",
				rule: "tailwind-no-theme",
			});
		}
	}

	const scoreModel = stylingScore(issues, componentFiles.length);

	return {
		name: "styling",
		score: scoreModel.score,
		grade: gradeFromScore(scoreModel.score),
		details: {
			tool,
			source: inventory ? "file-inventory" : "legacy-walk",
			totalComponentFiles: componentFiles.length,
			hardFailure: scoreModel.hardFailure,
			scoring: {
				errorFindings: scoreModel.errorCount,
				warningFindings: scoreModel.warnCount,
				infoFindings: scoreModel.infoCount,
				warningDensity: scoreModel.warningDensity,
				penalties: scoreModel.penalties,
				note: scoreModel.hardFailure
					? "Styling has hard lint/error findings."
					: "Warning/info-only styling findings are treated as design-system consistency debt, not a hard failure.",
			},
			approaches: Object.fromEntries(approaches),
			hasTailwind,
			inlineStyleCount,
			hardcodedColorCount,
			importantCount,
			spacingValues: spacingValues.size,
			stylelintIssues: stylelintIssues?.length ?? 0,
			projects: projectDetails(projects, componentFiles)?.map((project) => ({
				...project,
				issues: issues.filter((issue) => issue.file && projectContainsPath(String(project.path), issue.file)).length,
			})),
			suggestion: !stylelintIssues
				? "Install Stylelint for deeper CSS analysis (170+ rules): pnpm add -D stylelint stylelint-config-standard"
				: undefined,
		},
		issues,
		duration: Date.now() - start,
	};
}

/** Recursively scan for CSS/SCSS files. */
function scanCssFiles(cwd: string, subdir: string, fn: (content: string) => void): void {
	const dir = join(cwd, subdir);
	if (!existsSync(dir)) return;
	try {
		for (const entry of readdirSync(dir)) {
			if (entry === "node_modules" || entry === ".git" || entry === ".vibe-check") continue;
			const full = join(dir, entry);
			try {
				const stat = statSync(full);
				if (stat.isDirectory()) scanCssFiles(cwd, join(subdir, entry), fn);
				else if (/\.(css|scss)$/.test(entry)) fn(readFileSync(full, "utf-8"));
			} catch {
				/* skip */
			}
		}
	} catch {
		/* skip */
	}
}
