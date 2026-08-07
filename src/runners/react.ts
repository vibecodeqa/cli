/** React-specific checks — hooks rules, conditional hooks, missing keys, prop spreading.
 *  Note: if eslint-plugin-react-hooks is installed, those rules run in the lint check.
 *  This runner catches patterns beyond what the plugin covers. */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { FileInventory } from "../file-inventory.js";
import { inventorySourceFiles } from "../file-inventory.js";
import type { SourceFile } from "../fs-utils.js";
import { collectAllFiles, getProductionFiles, normalizeToolPath, readDeps } from "../fs-utils.js";
import type { CheckResult, Issue, ProjectContext, WorkspaceInfo } from "../types.js";
import { gradeFromScore } from "../types.js";
import { run } from "./exec.js";

type ReactCategoryId =
	| "hooks"
	| "effects"
	| "rendering"
	| "component-structure"
	| "error-boundary"
	| "compiler-readiness"
	| "fast-refresh"
	| "accessibility";

interface ReactCategoryDef {
	id: ReactCategoryId;
	label: string;
}

const REACT_CATEGORIES: ReactCategoryDef[] = [
	{ id: "hooks", label: "Hooks" },
	{ id: "effects", label: "Effects" },
	{ id: "rendering", label: "Rendering" },
	{ id: "component-structure", label: "Component structure" },
	{ id: "error-boundary", label: "Error boundaries" },
	{ id: "compiler-readiness", label: "Compiler readiness" },
	{ id: "fast-refresh", label: "Fast Refresh" },
	{ id: "accessibility", label: "Accessibility" },
];

const RULE_CATEGORY: Record<string, ReactCategoryId> = {
	"conditional-hook": "hooks",
	"effect-no-deps": "effects",
	"missing-key": "rendering",
	"index-key": "rendering",
	"prop-spreading": "component-structure",
	"react-dangerous-html": "rendering",
	"react-dangerous-html-sanitized": "rendering",
	"inline-handlers": "component-structure",
	"direct-dom": "component-structure",
	"prefer-tailwind": "component-structure",
	"no-error-boundary": "error-boundary",
};

function categoryForRule(rule: string | undefined): ReactCategoryId {
	if (!rule) return "component-structure";
	if (rule === "react-hooks/exhaustive-deps") return "effects";
	if (rule.startsWith("react-hooks/")) return "hooks";
	if (rule.startsWith("react-refresh/")) return "fast-refresh";
	if (rule.startsWith("jsx-a11y/")) return "accessibility";
	if (rule === "react/jsx-key" || /(^|\/)(jsx-key|no-array-index-key|key)/.test(rule)) return "rendering";
	if (/compiler/i.test(rule)) return "compiler-readiness";
	if (rule.startsWith("react/") || rule.startsWith("@eslint-react/") || rule.startsWith("react-dom/") || rule.startsWith("react-x/")) {
		return "component-structure";
	}
	return RULE_CATEGORY[rule] ?? "component-structure";
}

function categoryForIssue(issue: Issue): ReactCategoryId {
	return categoryForRule(issue.rule);
}

function categoryScore(issues: Issue[]): number {
	const errors = issues.filter((i) => i.severity === "error").length;
	const warnings = issues.filter((i) => i.severity === "warning").length;
	const info = issues.filter((i) => i.severity === "info").length;
	return Math.max(0, Math.round(100 - errors * 25 - warnings * 10 - info * 3));
}

function buildReactCategories(issues: Issue[]) {
	return REACT_CATEGORIES.map((def) => {
		const grouped = issues.filter((issue) => categoryForIssue(issue) === def.id);
		const rules = new Map<string, number>();
		const files = new Map<string, number>();
		const severityCounts = { error: 0, warning: 0, info: 0 };
		for (const issue of grouped) {
			severityCounts[issue.severity]++;
			const rule = issue.rule ?? "react";
			rules.set(rule, (rules.get(rule) ?? 0) + 1);
			if (issue.file) files.set(issue.file, (files.get(issue.file) ?? 0) + 1);
		}
		return {
			id: def.id,
			label: def.label,
			score: categoryScore(grouped),
			issues: grouped.length,
			severityCounts,
			topRules: [...rules.entries()]
				.map(([rule, count]) => ({ rule, count }))
				.sort((a, b) => b.count - a.count || a.rule.localeCompare(b.rule))
				.slice(0, 4),
			files: [...files.entries()]
				.map(([file, count]) => ({ file, count }))
				.sort((a, b) => b.count - a.count || a.file.localeCompare(b.file))
				.slice(0, 6),
		};
	});
}

const ESLINT_CONFIG_FILES = [
	"eslint.config.js",
	"eslint.config.mjs",
	"eslint.config.cjs",
	"eslint.config.ts",
	".eslintrc",
	".eslintrc.json",
	".eslintrc.js",
	".eslintrc.cjs",
	".eslintrc.yml",
	".eslintrc.yaml",
];

function readExistingEslintConfigs(cwd: string): string {
	return ESLINT_CONFIG_FILES.map((file) => join(cwd, file))
		.filter((file) => existsSync(file))
		.map((file) => {
			try {
				return readFileSync(file, "utf-8");
			} catch {
				return "";
			}
		})
		.join("\n");
}

function detectReactLintConfig(cwd: string, deps: Record<string, string>) {
	const config = readExistingEslintConfigs(cwd);
	const mentions = (text: string) => config.includes(text);
	const hooksConfigured =
		!!deps["eslint-plugin-react-hooks"] && (mentions("react-hooks") || mentions("reactCompiler") || mentions("react-compiler"));
	const reactConfigured = !!deps["eslint-plugin-react"] && mentions("react");
	const refreshConfigured = !!deps["eslint-plugin-react-refresh"] && mentions("react-refresh");
	const jsxA11yConfigured = !!deps["eslint-plugin-jsx-a11y"] && mentions("jsx-a11y");
	const eslintReactConfigured =
		(!!deps["@eslint-react/eslint-plugin"] || !!deps["eslint-plugin-react-x"] || !!deps["eslint-plugin-react-dom"]) &&
		(mentions("@eslint-react") || mentions("react-x") || mentions("react-dom"));
	return {
		hooksConfigured,
		reactConfigured,
		refreshConfigured,
		jsxA11yConfigured,
		eslintReactConfigured,
		anyConfigured: hooksConfigured || reactConfigured || refreshConfigured || jsxA11yConfigured || eslintReactConfigured,
	};
}

function isReactLintRule(rule: unknown): rule is string {
	if (typeof rule !== "string") return false;
	return (
		rule.startsWith("react-hooks/") ||
		rule.startsWith("react-refresh/") ||
		rule.startsWith("react/") ||
		rule.startsWith("jsx-a11y/") ||
		rule.startsWith("@eslint-react/") ||
		rule.startsWith("react-dom/") ||
		rule.startsWith("react-x/")
	);
}

function pathMetadata(repoCwd: string, toolCwd: string, rawPath: string): { file?: string; details: Record<string, string> } {
	const repoRelativePath = normalizeToolPath(repoCwd, toolCwd, rawPath);
	const outsideRepo = repoRelativePath.startsWith("../") || repoRelativePath === ".." || isAbsolute(repoRelativePath);
	return {
		file: outsideRepo ? undefined : repoRelativePath,
		details: {
			...(outsideRepo ? {} : { repoRelativePath }),
			toolRelativePath: rawPath,
			toolCwd,
			pathStatus: outsideRepo ? "outside-repo" : "normalized",
		},
	};
}

function withPathDetails(issue: Issue, details: Record<string, string>): Issue {
	return { ...issue, details } as Issue;
}

export function parseReactEslintIssues(stdout: string, toolCwd: string, repoCwd = toolCwd): Issue[] | null {
	let files: unknown;
	try {
		files = JSON.parse(stdout);
	} catch {
		return null;
	}
	if (!Array.isArray(files)) return null;
	const issues: Issue[] = [];
	for (const file of files as Array<Record<string, any>>) {
		for (const msg of file.messages || []) {
			if (!isReactLintRule(msg.ruleId)) continue;
			const path = typeof file.filePath === "string" ? pathMetadata(repoCwd, toolCwd, file.filePath) : undefined;
			issues.push(
				withPathDetails(
					{
						severity: msg.severity === 2 ? "error" : msg.severity === 1 ? "warning" : "info",
						message: msg.message || "React lint issue",
						file: path?.file,
						line: typeof msg.line === "number" ? msg.line : undefined,
						rule: msg.ruleId,
					},
					path?.details ?? { toolCwd, pathStatus: "missing-path" },
				),
			);
		}
	}
	return issues;
}

function runReactEslint(
	cwd: string,
	enabled: boolean,
	context: { projectId?: string; projectPath?: string } = {},
	repoCwd = cwd,
): { issues: Issue[]; ran: boolean; parsed: boolean } {
	if (!enabled) return { issues: [], ran: false, parsed: false };
	const target = existsSync(join(cwd, "src")) ? "src" : ".";
	const { stdout } = run(`npx eslint ${target} --format json 2>/dev/null || true`, cwd, 60_000, context);
	const parsed = parseReactEslintIssues(stdout, cwd, repoCwd);
	return { issues: parsed ?? [], ran: true, parsed: parsed !== null };
}

/** True when the `.map()` callback starting at line `i` actually returns JSX.
 *  `after` is the line text from `.map(` onward, right-trimmed. Distinguishes JSX
 *  returns from data maps (`=> ({...})`, `=> fn(...)`), TS generics, and comparisons. */
function mapCallbackReturnsJsx(after: string, lines: string[], i: number): boolean {
	if (/=>\s*<[A-Za-z]/.test(after)) return true; // inline: => <Tag
	if (/=>\s*\($/.test(after)) {
		// multiline arrow body: => (   followed by JSX on the next non-empty line
		return /^<[A-Za-z]/.test((lines[i + 1] || "").trim());
	}
	if (/=>\s*\{$/.test(after)) {
		// block body: JSX iff it returns `<Tag` or `(` then `<Tag`
		for (let j = i; j < Math.min(i + 12, lines.length); j++) {
			const lt = (lines[j] || "").trim();
			if (/return\s*<[A-Za-z]/.test(lt)) return true;
			if (/return\s*\($/.test(lt)) return /^<[A-Za-z]/.test((lines[j + 1] || "").trim());
			if (j > i && /^return\b/.test(lt)) return false; // returns a non-JSX value
		}
	}
	return false;
}

function replaceExceptNewlines(value: string, replacement = " "): string {
	return value.replace(/[^\n]/g, replacement);
}

function maskCommentsAndNonMarkupTemplates(content: string): string {
	return content
		.replace(/\{\/\*[\s\S]*?\*\/\}/g, (match) => replaceExceptNewlines(match))
		.replace(/\/\*[\s\S]*?\*\//g, (match) => replaceExceptNewlines(match))
		.replace(/(^|[^:])\/\/.*$/gm, (match, prefix: string) => `${prefix}${replaceExceptNewlines(match.slice(prefix.length))}`)
		.replace(/`(?:\\[\s\S]|\$\{[\s\S]*?\}|[^`\\])*`/g, (match) => {
			const hasMarkup = /<\/?[A-Za-z][\w:-]*(?:\s|>|\/)/.test(match);
			return hasMarkup ? match : replaceExceptNewlines(match);
		});
}

type SafeHtmlSourceKind = "html-sanitizer" | "markdown-renderer" | "terminal-renderer" | "trusted-types" | "inline-suppression";

interface SafeHtmlBoundary {
	name: string;
	sourceKind: SafeHtmlSourceKind;
	evidence: "direct-call" | "assigned-value" | "trusted-type" | "security-suppression";
}

interface DangerousHtmlContext {
	file: string;
	line: number;
	expression: string;
	classification: "raw" | "sanitized-tested" | "sanitized-untested";
	sanitizer?: string;
	sourceKind?: SafeHtmlSourceKind;
	evidence?: SafeHtmlBoundary["evidence"];
	tested?: boolean;
}

const SAFE_HTML_BOUNDARIES: Array<{ name: string; sourceKind: SafeHtmlSourceKind; aliases?: string[] }> = [
	{ name: "DOMPurify.sanitize", sourceKind: "html-sanitizer", aliases: ["DOMPurify"] },
	{ name: "sanitizeHtml", sourceKind: "html-sanitizer", aliases: ["sanitize-html"] },
	{ name: "sanitizeHTML", sourceKind: "html-sanitizer" },
	{ name: "sanitize", sourceKind: "html-sanitizer" },
	{ name: "escapeHtml", sourceKind: "html-sanitizer" },
	{ name: "escapeHTML", sourceKind: "html-sanitizer" },
	{ name: "renderMd", sourceKind: "markdown-renderer", aliases: ["renderMarkdown"] },
	{ name: "renderMarkdown", sourceKind: "markdown-renderer", aliases: ["renderMd"] },
	{ name: "renderTerminal", sourceKind: "terminal-renderer" },
	{ name: "toTrustedHTML", sourceKind: "trusted-types", aliases: ["TrustedHTML"] },
	{ name: "createTrustedHTML", sourceKind: "trusted-types", aliases: ["TrustedHTML"] },
];

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function boundaryCallPattern(boundary: { name: string }): RegExp {
	return new RegExp(`(?:^|[^\\w$])${escapeRegExp(boundary.name)}\\s*\\(`);
}

function safeHtmlBoundaryFromText(text: string): SafeHtmlBoundary | undefined {
	for (const boundary of SAFE_HTML_BOUNDARIES) {
		if (boundaryCallPattern(boundary).test(text)) {
			return { name: boundary.name, sourceKind: boundary.sourceKind, evidence: "direct-call" };
		}
	}
	return undefined;
}

function classifySafeHtmlExpression(expr: string, content: string, lineIndex: number, lines: string[]): SafeHtmlBoundary | undefined {
	const direct = safeHtmlBoundaryFromText(expr);
	if (direct) return direct;
	if (/\bas\s+TrustedHTML\b|\bTrustedHTML\b/.test(expr)) {
		return { name: "TrustedHTML", sourceKind: "trusted-types", evidence: "trusted-type" };
	}

	const identifier = expr.trim().match(/^[A-Za-z_$][\w$]*$/)?.[0];
	if (identifier) {
		const assignment = content.match(new RegExp(`\\b(?:const|let|var)\\s+${escapeRegExp(identifier)}\\s*=\\s*([^;\\n]+)`));
		const boundary = assignment?.[1] ? safeHtmlBoundaryFromText(assignment[1]) : undefined;
		if (boundary) return { ...boundary, evidence: "assigned-value" };
	}

	const preceding = lines.slice(Math.max(0, lineIndex - 3), lineIndex).join("\n");
	if (/biome-ignore\s+lint\/security\/noDangerouslySetInnerHtml/i.test(preceding)) {
		const namedBoundary = SAFE_HTML_BOUNDARIES.find((boundary) => {
			const names = [boundary.name, ...(boundary.aliases ?? [])];
			return names.some((name) => new RegExp(`\\b${escapeRegExp(name)}\\b`, "i").test(preceding));
		});
		if (namedBoundary) {
			return { name: namedBoundary.name, sourceKind: namedBoundary.sourceKind, evidence: "security-suppression" };
		}
		if (/\b(?:sanitize|escape|trusted)\b/i.test(preceding)) {
			return { name: "security suppression", sourceKind: "inline-suppression", evidence: "security-suppression" };
		}
	}

	return undefined;
}

function sanitizerHasTestCoverage(boundary: SafeHtmlBoundary, testFiles: SourceFile[]): boolean {
	if (boundary.sourceKind === "trusted-types") return true;
	const configured = SAFE_HTML_BOUNDARIES.find((item) => item.name === boundary.name);
	const names = [boundary.name, ...(configured?.aliases ?? [])]
		.map((name) => name.split(".").at(-1) ?? name)
		.filter((name) => name && name !== "security suppression");
	if (names.length === 0) return false;
	return testFiles.some((file) => names.some((name) => file.content.includes(name)));
}

function dangerousHtmlExpression(line: string): string | undefined {
	return line.match(/dangerouslySetInnerHTML\s*=\s*\{\s*\{\s*__html\s*:\s*([^}]+?)\s*\}\s*\}/)?.[1]?.trim();
}

function reactProjects(workspace?: WorkspaceInfo): ProjectContext[] | null {
	if (!workspace?.projects) return null;
	return workspace.projects.filter((project) => project.stack.framework === "react");
}

function cleanProjectPath(projectPath: string): string {
	const clean = projectPath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
	return clean || ".";
}

function projectContainsPath(projectPath: string, filePath: string): boolean {
	const clean = cleanProjectPath(projectPath);
	return clean === "." || filePath === clean || filePath.startsWith(`${clean}/`);
}

function projectSourceRoots(projects: ProjectContext[]): string[] {
	const roots = new Set<string>();
	for (const project of projects) {
		if (project.srcRoots.length === 0) {
			roots.add(project.path);
			continue;
		}
		for (const root of project.srcRoots) roots.add(root);
	}
	return [...roots];
}

function mergedReactDeps(cwd: string, projects: ProjectContext[] | null): Record<string, string> {
	const deps = { ...readDeps(cwd) };
	for (const project of projects ?? []) {
		if (project.path === ".") continue;
		Object.assign(deps, readDeps(join(cwd, project.path)));
	}
	return deps;
}

function runProjectReactEslint(
	cwd: string,
	projects: ProjectContext[] | null,
): { issues: Issue[]; ran: boolean; parsed: boolean; byProject: Array<Record<string, unknown>> } {
	if (!projects) {
		const deps = readDeps(cwd);
		const config = detectReactLintConfig(cwd, deps);
		const lint = runReactEslint(cwd, config.anyConfigured);
		return { ...lint, byProject: [] };
	}

	const issues: Issue[] = [];
	const byProject: Array<Record<string, unknown>> = [];
	let ran = false;
	let parsed = false;
	for (const project of projects) {
		const projectDir = project.path === "." ? cwd : join(cwd, project.path);
		const deps = { ...readDeps(cwd), ...readDeps(projectDir) };
		const config = detectReactLintConfig(projectDir, deps);
		const lint = runReactEslint(projectDir, config.anyConfigured, { projectId: project.id, projectPath: project.path }, cwd);
		ran = ran || lint.ran;
		parsed = parsed || lint.parsed;
		issues.push(...lint.issues);
		byProject.push({
			id: project.id,
			name: project.name,
			path: project.path,
			lintConfigured: config.anyConfigured,
			lintRan: lint.ran,
			lintParsed: lint.parsed,
			lintIssues: lint.issues.length,
		});
	}
	return { issues, ran, parsed, byProject };
}

function aggregateReactLintConfig(cwd: string, deps: Record<string, string>, projects: ProjectContext[] | null) {
	const configs = projects
		? projects.map((project) => {
				const projectDir = project.path === "." ? cwd : join(cwd, project.path);
				const projectDeps = { ...readDeps(cwd), ...readDeps(projectDir) };
				return detectReactLintConfig(projectDir, projectDeps);
			})
		: [detectReactLintConfig(cwd, deps)];
	return {
		hooksConfigured: configs.some((config) => config.hooksConfigured),
		reactConfigured: configs.some((config) => config.reactConfigured),
		refreshConfigured: configs.some((config) => config.refreshConfigured),
		jsxA11yConfigured: configs.some((config) => config.jsxA11yConfigured),
		eslintReactConfigured: configs.some((config) => config.eslintReactConfigured),
		anyConfigured: configs.some((config) => config.anyConfigured),
	};
}

export function runReact(cwd: string, workspace?: WorkspaceInfo, inventory?: FileInventory): CheckResult {
	const start = Date.now();

	// Stack gating is central (core.ts, via CheckMeta.appliesTo) — no framework check here.
	const scopedProjects = reactProjects(workspace);
	if (scopedProjects?.length === 0) {
		return {
			name: "react",
			score: 100,
			grade: "A",
			details: { skipped: true, reason: "no React projects detected", projects: [] },
			issues: [],
			duration: Date.now() - start,
		};
	}
	const allFiles = (
		inventory ? inventorySourceFiles(inventory) : getProductionFiles(cwd, scopedProjects ? projectSourceRoots(scopedProjects) : undefined)
	).filter((file) => !scopedProjects || scopedProjects.some((project) => projectContainsPath(project.path, file.path)));
	const files = allFiles.filter((f) => f.ext === ".tsx" || f.ext === ".jsx");
	if (files.length === 0) {
		return {
			name: "react",
			score: 100,
			grade: "A",
			details: {
				skipped: true,
				reason: "no JSX/TSX files",
				projects: scopedProjects?.map((project) => ({ id: project.id, name: project.name, path: project.path })),
			},
			issues: [],
			duration: Date.now() - start,
		};
	}

	const issues: Issue[] = [];
	const deps = mergedReactDeps(cwd, scopedProjects);
	const hasHooksPlugin = !!deps["eslint-plugin-react-hooks"];
	const hasReactPlugin = !!deps["eslint-plugin-react"];
	const hasReactRefreshPlugin = !!deps["eslint-plugin-react-refresh"];
	const hasJsxA11yPlugin = !!deps["eslint-plugin-jsx-a11y"];
	const hasEslintReactPlugin = !!(deps["@eslint-react/eslint-plugin"] || deps["eslint-plugin-react-x"] || deps["eslint-plugin-react-dom"]);
	const reactLintConfig = aggregateReactLintConfig(cwd, deps, scopedProjects);
	const reactLint = runProjectReactEslint(cwd, scopedProjects);
	issues.push(...reactLint.issues);
	const hooksCoveredByLint = reactLint.parsed && reactLintConfig.hooksConfigured;
	const jsxKeyCoveredByLint = reactLint.parsed && reactLintConfig.reactConfigured;
	const effectsCoveredByLint = reactLint.parsed && reactLintConfig.hooksConfigured;
	let conditionalHooks = 0;
	let missingKeys = 0;
	let propSpreading = 0;
	let inlineHandlers = 0;
	let indexKeys = 0;
	let rawDangerousHtml = 0;
	let sanitizedDangerousHtml = 0;
	let sanitizedDangerousHtmlWithoutTests = 0;
	const dangerousHtmlContexts: DangerousHtmlContext[] = [];
	const testFiles = collectAllFiles(cwd).filter((file) => file.isTest);

	for (const f of files) {
		const scanContent = maskCommentsAndNonMarkupTemplates(f.content);
		const lines = scanContent.split("\n");

		// Track brace depth inside conditional blocks
		let condBraceDepth = 0; // > 0 means we're inside a conditional's body

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const trimmed = line.trim();

			// Skip comments
			if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;

			// Count braces on this line
			const opens = (trimmed.match(/\{/g) || []).length;
			const closes = (trimmed.match(/\}/g) || []).length;

			// Track conditional-block nesting by net brace delta. Entering a new
			// conditional only when its block stays open past this line (opens >
			// closes) — otherwise a self-contained `if (x) { foo(); }` (opens ==
			// closes) would pin the depth at 1 and falsely flag every following hook.
			const entersConditional = /\b(if|else|switch)\s*[\s(]/.test(trimmed) && opens > closes;
			if (entersConditional || condBraceDepth > 0) {
				condBraceDepth += opens - closes;
				if (condBraceDepth < 0) condBraceDepth = 0;
			}

			// 1. Hooks called inside conditionals (skip if eslint-plugin-react-hooks handles this)
			if (!hooksCoveredByLint && condBraceDepth > 0 && /\buse[A-Z]\w*\s*\(/.test(trimmed) && !/\/\//.test(trimmed.split("use")[0]!)) {
				conditionalHooks++;
				issues.push({
					severity: "error",
					message: "Hook called inside conditional — violates Rules of Hooks",
					file: f.path,
					line: i + 1,
					rule: "conditional-hook",
				});
			}

			// 2. Missing key in .map() returning JSX. Only flag genuine JSX returns —
			// not data maps, TS generics, or comparisons (see mapCallbackReturnsJsx).
			const mapIdx = trimmed.indexOf(".map(");
			if (!jsxKeyCoveredByLint && mapIdx !== -1 && mapCallbackReturnsJsx(trimmed.slice(mapIdx).trimEnd(), lines, i)) {
				// Inspect just the JSX head for a key — enough to cover the opening element.
				const head = lines.slice(i, Math.min(i + 8, lines.length)).join("\n");
				if (!head.includes("key=") && !head.includes("key:")) {
					missingKeys++;
					issues.push({ severity: "error", message: "JSX in .map() without key prop", file: f.path, line: i + 1, rule: "missing-key" });
				}
			}

			// 3. index as key
			if (!jsxKeyCoveredByLint && (/key=\{(?:i|idx|index)\}/.test(trimmed) || /key=\{.*(?:, *(?:i|idx|index)\))/.test(trimmed))) {
				indexKeys++;
				issues.push({
					severity: "warning",
					message: "Using index as key — can cause rendering bugs with reorderable lists",
					file: f.path,
					line: i + 1,
					rule: "index-key",
				});
			}

			// 4. Prop spreading ({...props} on DOM elements)
			if (/\{\.\.\.(?!children)\w+\}/.test(trimmed) && /<[a-z]/.test(trimmed)) {
				propSpreading++;
				issues.push({
					severity: "warning",
					message: "Spreading props onto DOM element — can pass unexpected attributes",
					file: f.path,
					line: i + 1,
					rule: "prop-spreading",
				});
			}

			// 5. Inline arrow functions in JSX event handlers (performance)
			if (/on[A-Z]\w*=\{(?:\(\) =>|function)/.test(trimmed)) {
				inlineHandlers++;
			}

			const htmlExpr = dangerousHtmlExpression(trimmed);
			if (htmlExpr) {
				const boundary = classifySafeHtmlExpression(htmlExpr, scanContent, i, lines);
				if (boundary) {
					sanitizedDangerousHtml++;
					const tested = sanitizerHasTestCoverage(boundary, testFiles);
					if (!tested) sanitizedDangerousHtmlWithoutTests++;
					dangerousHtmlContexts.push({
						file: f.path,
						line: i + 1,
						expression: htmlExpr,
						classification: tested ? "sanitized-tested" : "sanitized-untested",
						sanitizer: boundary.name,
						sourceKind: boundary.sourceKind,
						evidence: boundary.evidence,
						tested,
					});
					issues.push({
						severity: tested ? "info" : "warning",
						message: tested
							? `React raw HTML sink is fed by tested ${boundary.name} ${boundary.sourceKind} boundary`
							: `React raw HTML sink is fed by ${boundary.name} ${boundary.sourceKind} boundary, but no matching sanitizer tests were found`,
						file: f.path,
						line: i + 1,
						rule: "react-dangerous-html-sanitized",
						snippet: htmlExpr,
					});
				} else {
					rawDangerousHtml++;
					dangerousHtmlContexts.push({
						file: f.path,
						line: i + 1,
						expression: htmlExpr,
						classification: "raw",
					});
					issues.push({
						severity: "warning",
						message: "React raw HTML sink without a recognized sanitizer boundary",
						file: f.path,
						line: i + 1,
						rule: "react-dangerous-html",
						snippet: htmlExpr,
					});
				}
			}
		}
	}

	// 6. useEffect with missing/empty dependency array
	let effectNoDeps = 0;
	for (const f of files) {
		const lines = maskCommentsAndNonMarkupTemplates(f.content).split("\n");
		for (let i = 0; i < lines.length; i++) {
			const trimmed = lines[i].trim();
			// useEffect(() => { ... }) without second argument
			if (!effectsCoveredByLint && /\buseEffect\s*\(\s*(?:\(\)|function|\([^)]*\)\s*=>)/.test(trimmed)) {
				// Look at the next few lines for closing ), ] pattern
				const block = lines.slice(i, Math.min(i + 20, lines.length)).join("\n");
				// Check if there's NO dependency array (no `], [` or `, []` pattern)
				const closingMatch = block.match(/\}\s*\)\s*;/);
				if (closingMatch && !block.includes("], [") && !block.includes("], []") && !/,\s*\[/.test(block)) {
					effectNoDeps++;
					issues.push({
						severity: "warning",
						message: "useEffect without dependency array — runs on every render",
						file: f.path,
						line: i + 1,
						rule: "effect-no-deps",
					});
				}
			}
		}
	}

	// 7. Direct DOM manipulation in React components
	let domManipulation = 0;
	for (const f of files) {
		const lines = maskCommentsAndNonMarkupTemplates(f.content).split("\n");
		for (let i = 0; i < lines.length; i++) {
			const trimmed = lines[i].trim();
			if (/document\.(?:getElementById|querySelector|getElementsBy)\s*\(/.test(trimmed)) {
				domManipulation++;
				issues.push({
					severity: "warning",
					message: "Direct DOM query in React component — use refs instead",
					file: f.path,
					line: i + 1,
					rule: "direct-dom",
				});
			}
		}
	}

	// Only warn about inline handlers if there are many
	if (inlineHandlers > 15) {
		issues.push({
			severity: "warning",
			message: `${inlineHandlers} inline arrow functions in JSX handlers — extract to named functions for readability`,
			rule: "inline-handlers",
		});
	}

	// Error Boundary presence (moved here from error-handling — React-owned concern).
	// Flat 5-point penalty, matching its historical weight; kept out of warnPenalty.
	const hasErrorBoundary = allFiles.some((f) => f.content.includes("componentDidCatch") || f.content.includes("ErrorBoundary"));

	// Tailwind: inline style objects when TW is available (moved from standards).
	let inlineStyles = 0;
	if (deps.tailwindcss) {
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
	const totalFiles = files.length || 1;
	const errorPenalty = Math.min(50, (errors / totalFiles) * 200);
	const warnPenalty = Math.min(30, (warnings / totalFiles) * 80);
	const boundaryPenalty = hasErrorBoundary ? 0 : 5;
	if (!hasErrorBoundary && files.some((f) => f.ext === ".tsx")) {
		issues.push({ severity: "warning", message: "React project with no Error Boundary", rule: "no-error-boundary" });
	}
	const score = Math.max(0, Math.min(100, Math.round(100 - errorPenalty - warnPenalty - boundaryPenalty)));
	const categories = buildReactCategories(issues);

	return {
		name: "react",
		score,
		grade: gradeFromScore(score),
		details: {
			jsxFiles: files.length,
			source: inventory ? "file-inventory" : "legacy-walk",
			conditionalHooks,
			missingKeys,
			indexKeys,
			propSpreading,
			inlineHandlers,
			effectNoDeps,
			domManipulation,
			rawDangerousHtml,
			sanitizedDangerousHtml,
			sanitizedDangerousHtmlWithoutTests,
			dangerousHtmlContexts,
			safeHtmlBoundaries: SAFE_HTML_BOUNDARIES.map((boundary) => ({ name: boundary.name, sourceKind: boundary.sourceKind })),
			hasErrorBoundary,
			inlineStyles,
			categories,
			metrics: [
				{ id: "jsxFiles", label: "JSX/TSX files", value: files.length },
				{ id: "officialReactLintIssues", label: "React ESLint issues", value: reactLint.issues.length },
				{ id: "conditionalHooks", label: "Conditional hooks", value: conditionalHooks },
				{ id: "missingKeys", label: "Missing keys", value: missingKeys },
				{ id: "indexKeys", label: "Index keys", value: indexKeys },
				{ id: "effectNoDeps", label: "Effects without deps", value: effectNoDeps },
				{ id: "domManipulation", label: "Direct DOM queries", value: domManipulation },
				{ id: "rawDangerousHtml", label: "Raw HTML sinks", value: rawDangerousHtml },
				{ id: "sanitizedDangerousHtml", label: "Sanitized HTML sinks", value: sanitizedDangerousHtml },
				{
					id: "sanitizedDangerousHtmlWithoutTests",
					label: "Sanitized HTML sinks without tests",
					value: sanitizedDangerousHtmlWithoutTests,
				},
			],
			tooling: {
				eslintPluginReactHooks: hasHooksPlugin,
				eslintPluginReact: hasReactPlugin,
				eslintPluginReactRefresh: hasReactRefreshPlugin,
				eslintPluginJsxA11y: hasJsxA11yPlugin,
				eslintReactPlugin: hasEslintReactPlugin,
				reactLintConfigured: reactLintConfig.anyConfigured,
				reactLintRan: reactLint.ran,
				reactLintParsed: reactLint.parsed,
				officialReactLintIssues: reactLint.issues.length,
				hooksCoveredByLint,
				jsxKeyCoveredByLint,
				effectsCoveredByLint,
			},
			projects: scopedProjects?.map((project) => ({
				id: project.id,
				name: project.name,
				path: project.path,
				jsxFiles: files.filter((file) => projectContainsPath(project.path, file.path)).length,
				issues: issues.filter((issue) => issue.file && projectContainsPath(project.path, issue.file)).length,
				tooling: reactLint.byProject.find((entry) => entry.id === project.id),
			})),
			suggestion: !hasHooksPlugin
				? "Install eslint-plugin-react-hooks for deeper React analysis: pnpm add -D eslint-plugin-react-hooks"
				: undefined,
		},
		issues,
		duration: Date.now() - start,
	};
}
