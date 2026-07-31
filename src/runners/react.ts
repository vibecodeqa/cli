/** React-specific checks — hooks rules, conditional hooks, missing keys, prop spreading.
 *  Note: if eslint-plugin-react-hooks is installed, those rules run in the lint check.
 *  This runner catches patterns beyond what the plugin covers. */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getProductionFiles, readDeps } from "../fs-utils.js";
import type { CheckResult, Issue } from "../types.js";
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
	const hooksConfigured = !!deps["eslint-plugin-react-hooks"] && (mentions("react-hooks") || mentions("reactCompiler") || mentions("react-compiler"));
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

function relFromCwd(filePath: string, cwd: string): string {
	if (filePath.startsWith(`${cwd}/`)) return filePath.slice(cwd.length + 1);
	if (filePath.startsWith(`/private${cwd}/`)) return filePath.slice(`/private${cwd}`.length + 1);
	return filePath;
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

export function parseReactEslintIssues(stdout: string, cwd: string): Issue[] | null {
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
			issues.push({
				severity: msg.severity === 2 ? "error" : msg.severity === 1 ? "warning" : "info",
				message: msg.message || "React lint issue",
				file: typeof file.filePath === "string" ? relFromCwd(file.filePath, cwd) : undefined,
				line: typeof msg.line === "number" ? msg.line : undefined,
				rule: msg.ruleId,
			});
		}
	}
	return issues;
}

function runReactEslint(cwd: string, enabled: boolean): { issues: Issue[]; ran: boolean; parsed: boolean } {
	if (!enabled) return { issues: [], ran: false, parsed: false };
	const target = existsSync(join(cwd, "src")) ? "src" : ".";
	const { stdout } = run(`npx eslint ${target} --format json 2>/dev/null || true`, cwd, 60_000);
	const parsed = parseReactEslintIssues(stdout, cwd);
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

export function runReact(cwd: string): CheckResult {
	const start = Date.now();

	// Stack gating is central (core.ts, via CheckMeta.appliesTo) — no framework check here.
	const allFiles = getProductionFiles(cwd);
	const files = allFiles.filter((f) => f.ext === ".tsx" || f.ext === ".jsx");
	if (files.length === 0) {
		return {
			name: "react",
			score: 100,
			grade: "A",
			details: { skipped: true, reason: "no JSX/TSX files" },
			issues: [],
			duration: Date.now() - start,
		};
	}

	const issues: Issue[] = [];
	const deps = readDeps(cwd);
	const hasHooksPlugin = !!deps["eslint-plugin-react-hooks"];
	const hasReactPlugin = !!deps["eslint-plugin-react"];
	const hasReactRefreshPlugin = !!deps["eslint-plugin-react-refresh"];
	const hasJsxA11yPlugin = !!deps["eslint-plugin-jsx-a11y"];
	const hasEslintReactPlugin = !!(deps["@eslint-react/eslint-plugin"] || deps["eslint-plugin-react-x"] || deps["eslint-plugin-react-dom"]);
	const reactLintConfig = detectReactLintConfig(cwd, deps);
	const reactLint = runReactEslint(cwd, reactLintConfig.anyConfigured);
	issues.push(...reactLint.issues);
	const hooksCoveredByLint = reactLint.parsed && reactLintConfig.hooksConfigured;
	const jsxKeyCoveredByLint = reactLint.parsed && reactLintConfig.reactConfigured;
	const effectsCoveredByLint = reactLint.parsed && reactLintConfig.hooksConfigured;
	let conditionalHooks = 0;
	let missingKeys = 0;
	let propSpreading = 0;
	let inlineHandlers = 0;
	let indexKeys = 0;

	for (const f of files) {
		const lines = f.content.split("\n");

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

			// Enter conditional: set depth to 1 on the opening brace
			if (/\b(if|else|switch)\s*[\s(]/.test(trimmed) && opens > 0) {
				condBraceDepth = 1;
			} else if (condBraceDepth > 0) {
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
		}
	}

	// 6. useEffect with missing/empty dependency array
	let effectNoDeps = 0;
	for (const f of files) {
		const lines = f.content.split("\n");
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
		const lines = f.content.split("\n");
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
			conditionalHooks,
			missingKeys,
			indexKeys,
			propSpreading,
			inlineHandlers,
			effectNoDeps,
			domManipulation,
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
			suggestion: !hasHooksPlugin
				? "Install eslint-plugin-react-hooks for deeper React analysis: pnpm add -D eslint-plugin-react-hooks"
				: undefined,
		},
		issues,
		duration: Date.now() - start,
	};
}
