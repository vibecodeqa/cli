/** Accessibility check — generic UI accessibility heuristics for React, Vue, Svelte, and static HTML.
 *  Runtime axe/Playwright audits should complement this static pass when a built app is available. */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { getProductionFiles, readDeps } from "../fs-utils.js";
import type { CheckResult, Issue } from "../types.js";
import { gradeFromScore } from "../types.js";

const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git", ".vibe-check", "coverage", ".next", ".nuxt"]);
const STYLE_EXTS = new Set([".css", ".scss", ".sass", ".less"]);

interface StandardTools {
	linter: { verify: (code: string, config: unknown, options: { filename: string }) => StandardLintMessage[] };
	jsxA11y: { configs: { recommended: { rules: Record<string, unknown> }; strict: { rules: Record<string, unknown> } } };
	tsParser: unknown;
	htmlValidate: { validateStringSync: (content: string, filename: string) => StandardHtmlReport };
}

interface StandardLintMessage {
	ruleId?: string | null;
	severity: number;
	message: string;
	line?: number;
}

interface StandardHtmlReport {
	results: { messages: StandardHtmlMessage[] }[];
}

interface StandardHtmlMessage {
	ruleId: string;
	severity: number;
	message: string;
	line?: number;
	selector?: string;
}

let standardToolsPromise: Promise<StandardTools> | null = null;

interface TextFile {
	path: string;
	fullPath: string;
	ext: string;
	content: string;
}

interface Counts {
	missingAlt: number;
	clickDiv: number;
	missingLabel: number;
	missingAccessibleName: number;
	headingOrder: number;
	missingLandmark: number;
	contrast: number;
	focusVisibility: number;
	keyboardNavigation: number;
	missingLang: number;
	autofocus: number;
	positiveTabindex: number;
}

export async function runAccessibility(cwd: string): Promise<CheckResult> {
	const start = Date.now();
	const componentFiles = getProductionFiles(cwd).filter(
		(f) => f.ext === ".tsx" || f.ext === ".jsx" || f.ext === ".vue" || f.ext === ".svelte",
	);
	const htmlFiles = collectTextFiles(cwd, new Set([".html"]));
	const styleFiles = collectTextFiles(cwd, STYLE_EXTS);
	const files = [
		...componentFiles.map((f) => ({ path: f.path, fullPath: f.fullPath, ext: f.ext, content: f.rawContent || f.content })),
		...htmlFiles,
	];

	if (files.length === 0 && styleFiles.length === 0) {
		return {
			name: "accessibility",
			score: 100,
			grade: "A",
			details: { skipped: true, reason: "no JSX/TSX/Vue/Svelte/HTML/CSS files" },
			issues: [],
			duration: Date.now() - start,
		};
	}

	const issues: Issue[] = [];
	const counts: Counts = {
		missingAlt: 0,
		clickDiv: 0,
		missingLabel: 0,
		missingAccessibleName: 0,
		headingOrder: 0,
		missingLandmark: 0,
		contrast: 0,
		focusVisibility: 0,
		keyboardNavigation: 0,
		missingLang: 0,
		autofocus: 0,
		positiveTabindex: 0,
	};

	const standardToolIssues = await runStandardStaticScans(componentFiles, htmlFiles, issues);

	for (const f of files) {
		scanMarkupFile(f, issues, counts);
	}
	for (const f of styleFiles) {
		scanStyleFile(f, issues, counts);
	}
	scanProjectLandmarks(files, issues, counts);

	const errors = issues.filter((i) => i.severity === "error").length;
	const warnings = issues.filter((i) => i.severity === "warning").length;
	const totalFiles = Math.max(1, files.length + styleFiles.length);
	const errorPenalty = Math.min(60, (errors / totalFiles) * 160);
	const warnPenalty = Math.min(30, (warnings / totalFiles) * 70);
	const score = Math.max(0, Math.min(100, Math.round(100 - errorPenalty - warnPenalty)));
	const deps = readDeps(cwd);

	return {
		name: "accessibility",
		score,
		grade: gradeFromScore(score),
		details: {
			componentFiles: componentFiles.length,
			htmlFiles: htmlFiles.length,
			styleFiles: styleFiles.length,
			standardToolIssues,
			tools: {
				jsxA11y: "eslint-plugin-jsx-a11y",
				htmlValidate: "html-validate:standard + html-validate:a11y",
				fallbackHeuristics: true,
			},
			...counts,
			eslintPluginJsxA11y: Boolean(deps["eslint-plugin-jsx-a11y"]),
			runtimeAudit:
				deps["@playwright/test"] || deps.playwright
					? "Playwright detected; add axe-core/@axe-core/playwright for a built-app audit."
					: "Static heuristics only. Add Playwright + axe-core for runtime contrast, focus, and ARIA validation.",
		},
		issues,
		duration: Date.now() - start,
	};
}

async function runStandardStaticScans(componentFiles: TextFile[], htmlFiles: TextFile[], issues: Issue[]): Promise<number> {
	const before = issues.length;
	const tools = await loadStandardTools();
	for (const file of componentFiles.filter((f) => f.ext === ".tsx" || f.ext === ".jsx")) {
		runJsxA11y(file, issues, tools);
	}
	for (const file of htmlFiles) {
		runHtmlValidate(file, issues, tools);
	}
	return issues.length - before;
}

async function loadStandardTools(): Promise<StandardTools> {
	standardToolsPromise ??= Promise.all([
		import("eslint"),
		import("eslint-plugin-jsx-a11y"),
		import("@typescript-eslint/parser"),
		import("html-validate"),
	]).then(([eslintModule, jsxA11yModule, tsParserModule, htmlValidateModule]) => {
		const jsxA11y = ("default" in jsxA11yModule ? jsxA11yModule.default : jsxA11yModule) as StandardTools["jsxA11y"];
		const tsParser = "default" in tsParserModule ? tsParserModule.default : tsParserModule;
		const htmlValidate = new htmlValidateModule.HtmlValidate({
			extends: ["html-validate:standard", "html-validate:a11y"],
		}) as StandardTools["htmlValidate"];
		return {
			linter: new eslintModule.Linter() as StandardTools["linter"],
			jsxA11y,
			tsParser,
			htmlValidate,
		};
	});
	return standardToolsPromise;
}

function runJsxA11y(file: TextFile, issues: Issue[], tools: StandardTools): void {
	try {
		const rules = {
			...tools.jsxA11y.configs.recommended.rules,
			...tools.jsxA11y.configs.strict.rules,
		};
		const messages = tools.linter.verify(
			file.content,
			[
				{
					files: ["**/*.{jsx,tsx}"],
					languageOptions: {
						parser: tools.tsParser,
						parserOptions: { ecmaVersion: "latest", sourceType: "module", ecmaFeatures: { jsx: true } },
					},
					plugins: { "jsx-a11y": tools.jsxA11y },
					rules,
				},
			],
			{ filename: file.path },
		);
		for (const msg of messages) {
			if (!msg.ruleId?.startsWith("jsx-a11y/")) continue;
			addUniqueIssue(
				issues,
				a11yIssue(
					msg.severity === 2 ? "error" : "warning",
					msg.message,
					file.path,
					msg.line,
					msg.ruleId,
					selectorFromJsxRule(msg.ruleId),
					wcagFromJsxRule(msg.ruleId),
					suggestionFromRule(msg.ruleId),
				),
			);
		}
	} catch {
		/* Managed JSX a11y lint is best-effort; VCQA heuristics still run. */
	}
}

function runHtmlValidate(file: TextFile, issues: Issue[], tools: StandardTools): void {
	try {
		const report = tools.htmlValidate.validateStringSync(file.content, file.path);
		for (const result of report.results) {
			for (const msg of result.messages) {
				addUniqueIssue(
					issues,
					a11yIssue(
						msg.severity === 2 ? "error" : "warning",
						msg.message,
						file.path,
						msg.line,
						msg.ruleId,
						msg.selector || selectorFromHtmlRule(msg.ruleId),
						wcagFromHtmlRule(msg.ruleId),
						suggestionFromRule(msg.ruleId),
					),
				);
			}
		}
	} catch {
		/* Invalid or template-like HTML falls back to VCQA heuristics. */
	}
}

function scanMarkupFile(file: TextFile, issues: Issue[], counts: Counts): void {
	const lines = file.content.split("\n");
	const headings: { level: number; line: number }[] = [];
	let hasLandmark = false;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trim();
		if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;

		if (isLandmarkLine(trimmed)) hasLandmark = true;
		collectHeadings(trimmed, i + 1, headings);
		scanImage(lines, i, file, issues, counts);
		scanButton(lines, i, file, issues, counts);
		scanFormControl(lines, i, file, issues, counts);
		scanClickTarget(lines, i, file, issues, counts);
		scanFocusOrder(trimmed, i + 1, file, issues, counts);
		scanDialog(lines, i, file, issues, counts);
		scanInlineContrast(trimmed, i + 1, file, issues, counts);
	}

	scanHeadingOrder(headings, file, issues, counts);
	scanHtmlPageBasics(file, hasLandmark, issues, counts);
}

function isLandmarkLine(line: string): boolean {
	return (
		/<(?:main|nav|header|footer|aside)\b/i.test(line) ||
		/role=["'](?:main|navigation|banner|contentinfo|complementary|search)["']/i.test(line)
	);
}

function collectHeadings(line: string, lineNumber: number, headings: { level: number; line: number }[]): void {
	for (const match of line.matchAll(/<h([1-6])\b/gi)) {
		headings.push({ level: Number(match[1]), line: lineNumber });
	}
}

function scanImage(lines: string[], index: number, file: TextFile, issues: Issue[], counts: Counts): void {
	const tag = tagBlock(lines, index, "img", 5);
	if (!tag || /\balt\s*=/.test(tag.text)) return;
	if (hasIssueAt(issues, file.path, index + 1, ["jsx-a11y/alt-text", "wcag/h37"])) return;
	counts.missingAlt++;
	issues.push(
		a11yIssue(
			"error",
			"Image missing alt text",
			file.path,
			index + 1,
			"img-alt",
			"img",
			"1.1.1 Non-text Content",
			'Add meaningful alt text, or alt="" for decorative images.',
		),
	);
}

function scanButton(lines: string[], index: number, file: TextFile, issues: Issue[], counts: Counts): void {
	const tag = tagBlock(lines, index, "button", 8);
	if (!tag || hasAccessibleName(tag.text)) return;
	if (hasIssueAt(issues, file.path, index + 1, ["jsx-a11y/control-has-associated-label"])) return;
	counts.missingAccessibleName++;
	issues.push(
		a11yIssue(
			"error",
			"Button has no accessible name",
			file.path,
			index + 1,
			"button-name",
			"button",
			"4.1.2 Name, Role, Value",
			"Add visible button text, aria-label, or aria-labelledby.",
		),
	);
}

function scanFormControl(lines: string[], index: number, file: TextFile, issues: Issue[], counts: Counts): void {
	const tag = tagBlock(lines, index, "(?:input|select|textarea)", 5);
	if (!tag || isExcludedControl(tag.text) || hasControlLabel(tag.text, lines, index)) return;
	if (hasIssueAt(issues, file.path, index + 1, ["jsx-a11y/label-has-associated-control", "wcag/h44"])) return;
	counts.missingLabel++;
	issues.push(
		a11yIssue(
			"warning",
			"Form control without an associated label",
			file.path,
			index + 1,
			"form-label",
			controlSelector(tag.text),
			"3.3.2 Labels or Instructions",
			"Use a <label for>, wrapping <label>, aria-label, or aria-labelledby.",
		),
	);
}

function scanClickTarget(lines: string[], index: number, file: TextFile, issues: Issue[], counts: Counts): void {
	const line = lines[index].trim();
	if (!clickOnNonInteractive(line)) return;
	if (hasIssueAt(issues, file.path, index + 1, ["jsx-a11y/click-events-have-key-events"])) return;
	const block = lines.slice(index, Math.min(index + 4, lines.length)).join(" ");
	if (/role\s*=/.test(block) && /(onKeyDown|onKeyUp|onKeyPress|tabIndex|@keydown|v-on:keydown|on:keydown)/.test(block)) return;
	counts.clickDiv++;
	issues.push(
		a11yIssue(
			"warning",
			"Click handler on non-interactive element without role and keyboard handler",
			file.path,
			index + 1,
			"click-events",
			"div[onClick], span[onClick]",
			"2.1.1 Keyboard",
			"Use a native <button>/<a>, or add role, tabIndex, and keyboard activation.",
		),
	);
}

function scanFocusOrder(line: string, lineNumber: number, file: TextFile, issues: Issue[], counts: Counts): void {
	if (/\bautoFocus\b/.test(line) || /\bautofocus\b/i.test(line)) {
		counts.autofocus++;
		issues.push(
			a11yIssue(
				"warning",
				"autoFocus can disorient keyboard and screen reader users",
				file.path,
				lineNumber,
				"no-autofocus",
				"[autofocus]",
				"2.4.3 Focus Order",
				"Move focus only after an explicit user action or clear route change.",
			),
		);
	}
	if (/tabIndex=\{[1-9]/.test(line) || /tabindex=["'][1-9]/i.test(line)) {
		counts.positiveTabindex++;
		counts.keyboardNavigation++;
		issues.push(
			a11yIssue(
				"warning",
				"Positive tabIndex disrupts natural tab order",
				file.path,
				lineNumber,
				"tabindex",
				"[tabindex]",
				"2.4.3 Focus Order",
				"Use natural DOM order, tabIndex={0}, or tabIndex={-1}.",
			),
		);
	}
}

function scanDialog(lines: string[], index: number, file: TextFile, issues: Issue[], counts: Counts): void {
	if (!/role=["']dialog["']|<dialog\b/i.test(lines[index])) return;
	const block = lines.slice(index, Math.min(index + 8, lines.length)).join(" ");
	if (/aria-modal=["']true["']/i.test(block)) return;
	counts.keyboardNavigation++;
	issues.push(
		a11yIssue(
			"warning",
			"Dialog missing aria-modal/focus-trap basics",
			file.path,
			index + 1,
			"dialog-focus",
			"[role=dialog], dialog",
			"2.1.2 No Keyboard Trap",
			'Add aria-modal="true", move focus into the dialog, trap focus while open, and restore focus on close.',
		),
	);
}

function scanInlineContrast(line: string, lineNumber: number, file: TextFile, issues: Issue[], counts: Counts): void {
	const contrast = findInlineContrastIssue(line);
	if (!contrast) return;
	counts.contrast++;
	issues.push(
		a11yIssue(
			"warning",
			`Low static color contrast (${contrast.ratio.toFixed(2)}:1)`,
			file.path,
			lineNumber,
			"color-contrast",
			"[style]",
			"1.4.3 Contrast (Minimum)",
			"Use colors with at least 4.5:1 contrast for normal text.",
		),
	);
}

function scanHeadingOrder(headings: { level: number; line: number }[], file: TextFile, issues: Issue[], counts: Counts): void {
	for (let i = 1; i < headings.length; i++) {
		if (headings[i].level <= headings[i - 1].level + 1) continue;
		counts.headingOrder++;
		issues.push(
			a11yIssue(
				"warning",
				`Heading order skips from h${headings[i - 1].level} to h${headings[i].level}`,
				file.path,
				headings[i].line,
				"heading-order",
				`h${headings[i].level}`,
				"1.3.1 Info and Relationships",
				"Do not skip heading levels; use CSS for visual size changes.",
			),
		);
		break;
	}
}

function scanHtmlPageBasics(file: TextFile, hasLandmark: boolean, issues: Issue[], counts: Counts): void {
	if (file.ext !== ".html") return;
	if (/<html\b/i.test(file.content) && !/<html[^>]*\blang\s*=/i.test(file.content)) {
		if (hasIssueAt(issues, file.path, undefined, ["element-required-attributes"])) return;
		counts.missingLang++;
		issues.push(
			a11yIssue(
				"warning",
				"<html> missing lang attribute",
				file.path,
				undefined,
				"html-lang",
				"html",
				"3.1.1 Language of Page",
				'Set <html lang="en"> or the correct page language.',
			),
		);
	}
	if (!hasLandmark && /<body\b/i.test(file.content)) {
		counts.missingLandmark++;
		issues.push(
			a11yIssue(
				"warning",
				"Page has no recognizable landmark elements",
				file.path,
				undefined,
				"landmarks",
				"body",
				"1.3.1 Info and Relationships",
				"Add main, nav, header, footer, aside, or matching ARIA landmark roles.",
			),
		);
	}
}

function scanProjectLandmarks(files: TextFile[], issues: Issue[], counts: Counts): void {
	const componentFiles = files.filter((f) => f.ext !== ".html");
	if (componentFiles.length === 0) return;
	const appLike = componentFiles.filter((f) => /(?:^|\/)(App|Layout|Root|Page|Home|Main)\.(?:tsx|jsx|vue|svelte)$/i.test(f.path));
	const candidates = appLike.length > 0 ? appLike : componentFiles;
	const hasMain = candidates.some((f) => /<main\b|role=["']main["']/i.test(f.content));
	if (!hasMain) {
		counts.missingLandmark++;
		const target = candidates[0];
		issues.push(
			a11yIssue(
				"warning",
				"No main landmark found in app-level UI",
				target?.path,
				undefined,
				"main-landmark",
				"main, [role=main]",
				"1.3.1 Info and Relationships",
				'Wrap the primary page content in <main> or role="main".',
			),
		);
	}
}

function scanStyleFile(file: TextFile, issues: Issue[], counts: Counts): void {
	const lines = file.content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (/outline\s*:\s*(?:0|none)\b/i.test(line)) {
			const nearby = lines.slice(Math.max(0, i - 4), Math.min(lines.length, i + 6)).join("\n");
			if (!/(focus-visible|box-shadow|outline\s*:\s*(?!0|none)|border-color)/i.test(nearby.replace(line, ""))) {
				counts.focusVisibility++;
				issues.push(
					a11yIssue(
						"warning",
						"Focus outline removed without a visible replacement",
						file.path,
						i + 1,
						"focus-visible",
						":focus",
						"2.4.7 Focus Visible",
						"Use :focus-visible with an outline, ring, border, or shadow.",
					),
				);
			}
		}
		const contrast = findCssContrastIssue(lines, i);
		if (contrast) {
			counts.contrast++;
			issues.push(
				a11yIssue(
					"warning",
					`Low static color contrast (${contrast.ratio.toFixed(2)}:1)`,
					file.path,
					i + 1,
					"color-contrast",
					contrast.selector,
					"1.4.3 Contrast (Minimum)",
					"Use colors with at least 4.5:1 contrast for normal text.",
				),
			);
		}
	}
}

function tagBlock(lines: string[], start: number, tag: string, maxLines: number): { text: string } | null {
	if (!new RegExp(`<${tag}\\b`, "i").test(lines[start])) return null;
	let text = "";
	for (let i = start; i < Math.min(lines.length, start + maxLines); i++) {
		text += `${lines[i].trim()} `;
		if (/>/.test(lines[i])) break;
	}
	return { text };
}

function hasAccessibleName(tag: string): boolean {
	if (/\b(?:aria-label|aria-labelledby|title)\s*=/.test(tag)) return true;
	if (/<button[^>]*>\s*[^<{\s][^<]*<\/button>/i.test(tag)) return true;
	if (/<button[^>]*>\s*\{[^}]+\}\s*<\/button>/i.test(tag)) return true;
	return false;
}

function hasControlLabel(tag: string, lines: string[], lineIndex: number): boolean {
	if (/\b(?:aria-label|aria-labelledby|title)\s*=/.test(tag)) return true;
	const nearby = lines.slice(Math.max(0, lineIndex - 5), Math.min(lines.length, lineIndex + 6)).join(" ");
	if (/<label\b/i.test(nearby)) return true;
	const id = tag.match(/\bid\s*=\s*["']([^"']+)["']/i)?.[1];
	if (id && new RegExp(`<label[^>]+for=["']${escapeRegExp(id)}["']`, "i").test(nearby)) return true;
	return false;
}

function isExcludedControl(tag: string): boolean {
	return /type\s*=\s*["'](?:hidden|submit|button|reset|image)["']/i.test(tag);
}

function controlSelector(tag: string): string {
	const name = tag.match(/<([a-z]+)/i)?.[1] || "input";
	const type = tag.match(/\btype\s*=\s*["']([^"']+)["']/i)?.[1];
	return type ? `${name}[type=${type}]` : name;
}

function clickOnNonInteractive(line: string): boolean {
	return /(?:onClick=|@click|v-on:click|on:click)/.test(line) && /<(?:div|span|p|li|section|article|header|footer)\b/i.test(line);
}

function addUniqueIssue(issues: Issue[], issue: Issue): void {
	if (hasIssueAt(issues, issue.file, issue.line, [issue.rule || ""])) return;
	issues.push(issue);
}

function hasIssueAt(issues: Issue[], file: string | undefined, line: number | undefined, rules: string[]): boolean {
	return issues.some((issue) => {
		if (issue.file !== file) return false;
		if (line !== undefined && issue.line !== undefined && issue.line !== line) return false;
		return rules.includes(issue.rule || "");
	});
}

function a11yIssue(
	severity: Issue["severity"],
	message: string,
	file: string | undefined,
	line: number | undefined,
	rule: string,
	selector: string,
	wcag: string,
	suggestion: string,
): Issue {
	return { severity, message, file, line, rule, selector, wcag, suggestion };
}

function selectorFromJsxRule(rule: string): string {
	if (rule.includes("alt-text")) return "img, area, input[type=image]";
	if (rule.includes("label")) return "label, input, select, textarea";
	if (rule.includes("click-events")) return "[onClick]";
	if (rule.includes("interactive")) return "[role], button, a";
	if (rule.includes("heading")) return "h1, h2, h3, h4, h5, h6";
	if (rule.includes("tabindex")) return "[tabIndex]";
	return "[jsx]";
}

function selectorFromHtmlRule(rule: string): string {
	if (rule === "wcag/h37") return "img";
	if (rule.includes("heading")) return "h1, h2, h3, h4, h5, h6";
	if (rule.includes("element-required-attributes")) return "[required-attribute]";
	return "[html]";
}

function wcagFromJsxRule(rule: string): string {
	if (rule.includes("alt-text")) return "1.1.1 Non-text Content";
	if (rule.includes("label")) return "3.3.2 Labels or Instructions";
	if (rule.includes("click-events") || rule.includes("interactive")) return "2.1.1 Keyboard";
	if (rule.includes("heading")) return "1.3.1 Info and Relationships";
	if (rule.includes("tabindex")) return "2.4.3 Focus Order";
	return "WCAG / ARIA best practice";
}

function wcagFromHtmlRule(rule: string): string {
	if (rule === "wcag/h37") return "1.1.1 Non-text Content";
	if (rule === "element-required-attributes") return "WCAG required semantics";
	if (rule.includes("heading")) return "1.3.1 Info and Relationships";
	if (rule.includes("input") || rule.includes("label")) return "3.3.2 Labels or Instructions";
	return rule.startsWith("wcag/") ? rule.toUpperCase() : "WCAG / HTML best practice";
}

function suggestionFromRule(rule: string): string {
	if (rule.includes("alt-text") || rule === "wcag/h37") return 'Add meaningful alt text, or alt="" for decorative images.';
	if (rule.includes("label")) return "Associate each control with a visible label, aria-label, or aria-labelledby.";
	if (rule.includes("click-events")) return "Use a native button/link or add keyboard handlers and a semantic role.";
	if (rule.includes("tabindex")) return "Use natural DOM order instead of positive tabIndex values.";
	if (rule.includes("element-required-attributes")) return "Add the required semantic attribute, such as lang on <html> or alt on images.";
	return "Follow the linked accessibility rule and prefer semantic HTML.";
}

function collectTextFiles(cwd: string, exts: Set<string>, subdir = ""): TextFile[] {
	const files: TextFile[] = [];
	const dir = subdir ? join(cwd, subdir) : cwd;
	try {
		for (const entry of readdirSync(dir)) {
			if (SKIP_DIRS.has(entry)) continue;
			const full = join(dir, entry);
			const stat = statSync(full);
			if (stat.isDirectory()) {
				files.push(...collectTextFiles(cwd, exts, subdir ? join(subdir, entry) : entry));
				continue;
			}
			const ext = extname(entry);
			if (!exts.has(ext) || stat.size > 1_000_000) continue;
			files.push({ path: relative(cwd, full), fullPath: full, ext, content: readFileSync(full, "utf-8") });
		}
	} catch {
		/* ignore unreadable directories */
	}
	return files;
}

function findInlineContrastIssue(line: string): { ratio: number } | null {
	const color = line.match(/\bcolor\s*:\s*(#[0-9a-f]{3,6})/i)?.[1];
	const bg = line.match(/\bbackground(?:-color)?\s*:\s*(#[0-9a-f]{3,6})/i)?.[1];
	return contrastIssue(color, bg);
}

function findCssContrastIssue(lines: string[], index: number): { ratio: number; selector: string } | null {
	const block = lines.slice(index, Math.min(lines.length, index + 12)).join("\n");
	if (!/{/.test(block)) return null;
	const selector = lines[index].split("{")[0].trim() || "[css rule]";
	const color = block.match(/\bcolor\s*:\s*(#[0-9a-f]{3,6})/i)?.[1];
	const bg = block.match(/\bbackground(?:-color)?\s*:\s*(#[0-9a-f]{3,6})/i)?.[1];
	const issue = contrastIssue(color, bg);
	return issue ? { ...issue, selector } : null;
}

function contrastIssue(foreground?: string, background?: string): { ratio: number } | null {
	if (!foreground || !background) return null;
	const ratio = contrastRatio(hexToRgb(foreground), hexToRgb(background));
	if (ratio > 0 && ratio < 4.5) return { ratio };
	return null;
}

function hexToRgb(hex: string): [number, number, number] {
	const clean = hex.replace("#", "");
	const full =
		clean.length === 3
			? clean
					.split("")
					.map((c) => c + c)
					.join("")
			: clean;
	return [Number.parseInt(full.slice(0, 2), 16), Number.parseInt(full.slice(2, 4), 16), Number.parseInt(full.slice(4, 6), 16)];
}

function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
	const l1 = luminance(a);
	const l2 = luminance(b);
	const lighter = Math.max(l1, l2);
	const darker = Math.min(l1, l2);
	return (lighter + 0.05) / (darker + 0.05);
}

function luminance(rgb: [number, number, number]): number {
	const [r, g, b] = rgb.map((value) => {
		const s = value / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
