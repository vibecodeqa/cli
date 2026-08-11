/** Accessibility check — detects common a11y violations in JSX/TSX code.
 *  If eslint-plugin-jsx-a11y is installed, lint runner handles most of these.
 *  This runner catches additional patterns and provides a dedicated a11y score. */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FileInventory } from "../file-inventory.js";
import { inventorySourceFiles } from "../file-inventory.js";
import { getProductionFiles, normalizeToolPath } from "../fs-utils.js";
import type { CheckResult, Issue, ProjectContext, WorkspaceInfo } from "../types.js";
import { gradeFromScore } from "../types.js";
import { run } from "./exec.js";
import { depsForProjects, filesForProjects, frontendProjects, projectDetails, projectSourceRoots } from "./project-scope.js";

type A11yIssue = Issue & {
	category?: string;
	fix?: string;
	selector?: string;
	source?: "eslint-plugin-jsx-a11y" | "vcqa-heuristic";
	wcag?: string;
};

const VALID_ARIA_ROLES = new Set([
	"alert",
	"alertdialog",
	"application",
	"article",
	"banner",
	"button",
	"cell",
	"checkbox",
	"columnheader",
	"combobox",
	"complementary",
	"contentinfo",
	"definition",
	"dialog",
	"directory",
	"document",
	"feed",
	"figure",
	"form",
	"grid",
	"gridcell",
	"group",
	"heading",
	"img",
	"link",
	"list",
	"listbox",
	"listitem",
	"log",
	"main",
	"marquee",
	"math",
	"menu",
	"menubar",
	"menuitem",
	"menuitemcheckbox",
	"menuitemradio",
	"navigation",
	"none",
	"note",
	"option",
	"presentation",
	"progressbar",
	"radio",
	"radiogroup",
	"region",
	"row",
	"rowgroup",
	"rowheader",
	"scrollbar",
	"search",
	"searchbox",
	"separator",
	"slider",
	"spinbutton",
	"status",
	"switch",
	"tab",
	"table",
	"tablist",
	"tabpanel",
	"term",
	"textbox",
	"timer",
	"toolbar",
	"tooltip",
	"tree",
	"treegrid",
	"treeitem",
]);

const WCAG_BY_ESLINT_RULE: Record<string, string> = {
	"jsx-a11y/alt-text": "WCAG 1.1.1",
	"jsx-a11y/anchor-has-content": "WCAG 2.4.4",
	"jsx-a11y/aria-activedescendant-has-tabindex": "WCAG 4.1.2",
	"jsx-a11y/aria-props": "WCAG 4.1.2",
	"jsx-a11y/aria-proptypes": "WCAG 4.1.2",
	"jsx-a11y/aria-role": "WCAG 4.1.2",
	"jsx-a11y/aria-unsupported-elements": "WCAG 4.1.2",
	"jsx-a11y/click-events-have-key-events": "WCAG 2.1.1",
	"jsx-a11y/control-has-associated-label": "WCAG 4.1.2",
	"jsx-a11y/heading-has-content": "WCAG 2.4.6",
	"jsx-a11y/html-has-lang": "WCAG 3.1.1",
	"jsx-a11y/interactive-supports-focus": "WCAG 2.1.1",
	"jsx-a11y/label-has-associated-control": "WCAG 3.3.2",
	"jsx-a11y/media-has-caption": "WCAG 1.2.2",
	"jsx-a11y/no-autofocus": "WCAG 2.4.3",
	"jsx-a11y/no-noninteractive-tabindex": "WCAG 2.4.3",
	"jsx-a11y/no-redundant-roles": "WCAG 4.1.2",
	"jsx-a11y/role-has-required-aria-props": "WCAG 4.1.2",
	"jsx-a11y/role-supports-aria-props": "WCAG 4.1.2",
	"jsx-a11y/tabindex-no-positive": "WCAG 2.4.3",
};

function htmlPathsForProjects(projects: ProjectContext[] | null): string[] {
	const htmlPaths = ["index.html", "web/index.html", "public/index.html", "src/index.html"];
	if (!projects) return htmlPaths;
	return projects.flatMap((project) => {
		if (project.path === ".") return htmlPaths;
		return htmlPaths.map((path) => `${project.path}/${path}`);
	});
}

function issue(input: A11yIssue): Issue {
	return input;
}

function selectorForTag(tag: string): string | undefined {
	return tag.match(/^<([A-Za-z][\w:-]*)/)?.[1]?.toLowerCase();
}

function openingTag(lines: string[], start: number, maxLines = 8): string {
	let tag = lines[start]?.trim() ?? "";
	for (let i = start + 1; i < Math.min(lines.length, start + maxLines) && !tag.includes(">"); i++) {
		tag += ` ${lines[i].trim()}`;
	}
	return tag;
}

function hasExplicitName(text: string): boolean {
	return /\b(?:aria-label|aria-labelledby|title)=/.test(text);
}

/** End index (inclusive) of the tag opening at `from`, ignoring `>` inside strings and `{}` expressions. */
function tagEnd(source: string, from: number): { end: number; selfClosing: boolean } | null {
	let depth = 0;
	let quote = "";
	for (let i = from; i < source.length; i++) {
		const char = source[i];
		if (quote) {
			if (char === "\\") i++;
			else if (char === quote) quote = "";
			continue;
		}
		if (char === '"' || char === "'" || char === "`") quote = char;
		else if (char === "{" || char === "(" || char === "[") depth++;
		else if (char === "}" || char === ")" || char === "]") depth--;
		else if (char === ">" && depth <= 0) return { end: i, selfClosing: /\/\s*$/.test(source.slice(from, i)) };
	}
	return null;
}

/** End index (exclusive) of the balanced `{...}` expression starting at `from`. */
function expressionEnd(source: string, from: number): number {
	let depth = 0;
	let quote = "";
	for (let i = from; i < source.length; i++) {
		const char = source[i];
		if (quote) {
			if (char === "\\") i++;
			else if (char === quote) quote = "";
			continue;
		}
		if (char === '"' || char === "'" || char === "`") quote = char;
		else if (char === "{") depth++;
		else if (char === "}") {
			depth--;
			if (depth === 0) return i + 1;
		}
	}
	return source.length;
}

interface JsxChildren {
	/** The element's own source, opening tag through closing tag (or as far as it was read). */
	raw: string;
	/** Literal text between tags, with nested tag markup (and its attributes) removed. */
	text: string;
	/** Each `{...}` child expression, in order. */
	expressions: string[];
	/** False when the closing tag was not reached inside the window — the element is unknown, not empty. */
	terminated: boolean;
}

/**
 * Children of the `<tagName>` element opening at `from`. Nested elements are walked, so
 * `<button><span>{label}</span></button>` yields the `{label}` expression; attribute
 * expressions belong to the tag and are skipped.
 */
function jsxChildren(source: string, from: number, tagName: string): JsxChildren {
	const open = tagEnd(source, from);
	if (!open) return { raw: source.slice(from), text: "", expressions: [], terminated: false };
	if (open.selfClosing) return { raw: source.slice(from, open.end + 1), text: "", expressions: [], terminated: true };

	const closing = `</${tagName}`;
	const opening = `<${tagName}`;
	let text = "";
	const expressions: string[] = [];
	let depth = 0;
	for (let i = open.end + 1; i < source.length; i++) {
		const char = source[i];
		if (char === "{") {
			const end = expressionEnd(source, i);
			expressions.push(source.slice(i + 1, Math.max(i + 1, end - 1)));
			i = end - 1;
			continue;
		}
		if (char === "<") {
			const isClose = source.startsWith(closing, i) && !/[\w:-]/.test(source[i + closing.length] ?? "");
			const isOpen = source.startsWith(opening, i) && !/[\w:-]/.test(source[i + opening.length] ?? "");
			const tag = tagEnd(source, i);
			if (!tag) break;
			if (isClose) {
				if (depth === 0) return { raw: source.slice(from, tag.end + 1), text, expressions, terminated: true };
				depth--;
			} else if (isOpen && !tag.selfClosing) depth++;
			i = tag.end;
			continue;
		}
		text += char;
	}
	return { raw: source.slice(from), text, expressions, terminated: false };
}

/** Strips JSX tag markup (and its attributes) but keeps the text between tags. */
function stripJsxTags(source: string): string {
	let out = "";
	for (let i = 0; i < source.length; i++) {
		if (source[i] === "<") {
			const tag = tagEnd(source, i);
			if (!tag) break;
			i = tag.end;
			continue;
		}
		out += source[i];
	}
	return out;
}

function hasReadableText(value: string): boolean {
	return /[\p{L}\p{N}]/u.test(value.replace(/&[a-z]+;|&#\d+;/gi, " "));
}

/**
 * Does a `{...}` child supply an accessible name? A string literal, ternary, identifier or
 * call all name the element at runtime; only an expression that is nothing but rendered
 * elements (`{<Icon />}`) leaves the button unnamed.
 */
function expressionNamesElement(expression: string): boolean {
	const withoutComments = expression.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
	return hasReadableText(stripJsxTags(withoutComments));
}

/** Do the element's children supply a visible/dynamic accessible name? */
function childrenNameElement(children: JsxChildren): boolean {
	if (hasReadableText(children.text)) return true;
	return children.expressions.some(expressionNamesElement);
}

/** Character offset of each line's first character in the joined source. */
function lineStartOffsets(lines: string[]): number[] {
	const offsets: number[] = [];
	let at = 0;
	for (const line of lines) {
		offsets.push(at);
		at += line.length + 1;
	}
	return offsets;
}

function staticIdValues(source: string): string[] {
	return [...source.matchAll(/\bid=["']([^"']+)["']/g)].map((match) => match[1]).filter((value): value is string => !!value);
}

function idRefs(value: string): string[] {
	return value
		.split(/\s+/)
		.map((ref) => ref.trim())
		.filter(Boolean);
}

function hasAssociatedLabel(source: string, tag: string, surroundingBlock: string): boolean {
	if (hasExplicitName(tag) || hasExplicitName(surroundingBlock)) return true;
	if (/<label\b/i.test(surroundingBlock)) return true;
	const id = tag.match(/\bid=["']([^"']+)["']/)?.[1];
	return !!id && new RegExp(`<label\\b[^>]*(?:htmlFor|for)=["']${escapeRegExp(id)}["']`, "i").test(source);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasLandmark(source: string): boolean {
	return (
		/<(?:main|nav|header|footer|aside)\b/i.test(source) ||
		/\brole=["'](?:main|navigation|banner|contentinfo|complementary|search)["']/i.test(source)
	);
}

function isReactViteApp(projects: ProjectContext[] | null, deps: Record<string, string>): boolean {
	if (projects) return projects.some((project) => project.stack.framework === "react" && project.stack.bundler === "vite");
	return !!deps.react && !!deps.vite;
}

function eslintConfigMentionsJsxA11y(cwd: string, projects: ProjectContext[] | null): boolean {
	const configNames = [
		"eslint.config.js",
		"eslint.config.ts",
		"eslint.config.mjs",
		"eslint.config.cjs",
		".eslintrc",
		".eslintrc.json",
		".eslintrc.js",
		".eslintrc.cjs",
		".eslintrc.yml",
		".eslintrc.yaml",
	];
	for (const project of projects ?? [{ path: "." }]) {
		const base = project.path === "." ? cwd : join(cwd, project.path);
		for (const name of configNames) {
			try {
				if (readFileSync(join(base, name), "utf-8").includes("jsx-a11y")) return true;
			} catch {
				/* config absent */
			}
		}
	}
	return false;
}

function eslintBinary(cwd: string, projects: ProjectContext[] | null): { bin: string; cwd: string; project?: ProjectContext } | null {
	for (const project of projects ?? [{ path: "." as const }]) {
		const base = project.path === "." ? cwd : join(cwd, project.path);
		const localBin = join(base, "node_modules", ".bin", "eslint");
		if (existsSync(localBin)) return { bin: localBin, cwd: base, project: "id" in project ? project : undefined };
	}
	const rootBin = join(cwd, "node_modules", ".bin", "eslint");
	return existsSync(rootBin) ? { bin: rootBin, cwd, project: undefined } : null;
}

function parseJsxA11yEslint(stdout: string, repoCwd: string, toolCwd: string): Issue[] {
	const issues: Issue[] = [];
	try {
		const files = JSON.parse(stdout);
		for (const file of files) {
			for (const msg of file.messages || []) {
				if (typeof msg.ruleId !== "string" || !msg.ruleId.startsWith("jsx-a11y/")) continue;
				const filePath = typeof file.filePath === "string" ? normalizeToolPath(repoCwd, toolCwd, file.filePath) : undefined;
				issues.push(
					issue({
						severity: msg.severity === 2 ? "error" : "warning",
						message: msg.message,
						file: filePath,
						line: msg.line,
						rule: msg.ruleId,
						category: "Accessibility",
						fix: "Apply the eslint-plugin-jsx-a11y rule guidance for this component.",
						source: "eslint-plugin-jsx-a11y",
						wcag: WCAG_BY_ESLINT_RULE[msg.ruleId],
					}),
				);
			}
		}
	} catch {
		/* eslint output parse failed */
	}
	return issues;
}

function runJsxA11yEslint(
	cwd: string,
	projects: ProjectContext[] | null,
): { issues: Issue[]; ran: boolean; configured: boolean; reason?: string } {
	const configured = eslintConfigMentionsJsxA11y(cwd, projects);
	const bin = eslintBinary(cwd, projects);
	if (!configured) return { issues: [], ran: false, configured, reason: "eslint-plugin-jsx-a11y not referenced in ESLint config" };
	if (!bin) return { issues: [], ran: false, configured, reason: "eslint binary not installed locally" };
	const { stdout } = run(`"${bin.bin}" . --format json 2>/dev/null || true`, bin.cwd, 60_000, {
		projectId: bin.project?.id,
		projectPath: bin.project?.path,
	});
	return { issues: parseJsxA11yEslint(stdout, cwd, bin.cwd), ran: true, configured };
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: this runner keeps related static accessibility rules in one pass so scoring counters and evidence details stay aligned.
export function runAccessibility(cwd: string, workspace?: WorkspaceInfo, inventory?: FileInventory): CheckResult {
	const start = Date.now();
	const projects = frontendProjects(workspace);
	if (workspace?.projects && projects?.length === 0) {
		return {
			name: "accessibility",
			score: 100,
			grade: "A",
			details: { skipped: true, reason: "no frontend app projects detected", projects: [] },
			issues: [],
			duration: Date.now() - start,
		};
	}
	const files = filesForProjects(
		inventory ? inventorySourceFiles(inventory) : getProductionFiles(cwd, projects ? projectSourceRoots(projects) : undefined),
		projects,
	).filter((f) => f.ext === ".tsx" || f.ext === ".jsx" || f.ext === ".vue" || f.ext === ".svelte");

	if (files.length === 0) {
		return {
			name: "accessibility",
			score: 100,
			grade: "A",
			details: { skipped: true, reason: "no JSX/TSX/Vue/Svelte files", projects: projectDetails(projects, files) },
			issues: [],
			duration: Date.now() - start,
		};
	}

	const issues: Issue[] = [];
	const deps = depsForProjects(cwd, projects);
	const hasA11yPlugin = !!deps["eslint-plugin-jsx-a11y"];
	const jsxA11y = hasA11yPlugin
		? runJsxA11yEslint(cwd, projects)
		: { issues: [], ran: false, configured: false, reason: "dependency absent" };
	issues.push(...jsxA11y.issues);
	let missingAlt = 0;
	let buttonName = 0;
	let clickDiv = 0;
	let missingLabel = 0;
	let autofocus = 0;
	let positiveTabindex = 0;
	let invalidAria = 0;
	let headingOrder = 0;
	let brokenAriaRefs = 0;
	const allSource = files.map((f) => f.rawContent || f.content).join("\n");
	const projectHasLandmark = hasLandmark(allSource);
	const reactViteApp = isReactViteApp(projects, deps);

	for (const f of files) {
		// For SFCs, use raw content (includes template) for a11y checks
		const source = f.rawContent || f.content;
		const lines = source.split("\n");
		const lineOffsets = lineStartOffsets(lines);
		const idValues = staticIdValues(source);
		const ids = new Set(idValues);
		const seenIds = new Map<string, number>();
		let previousHeading = 0;

		for (const id of idValues) seenIds.set(id, (seenIds.get(id) ?? 0) + 1);
		for (const [id, count] of seenIds) {
			if (count > 1) {
				invalidAria++;
				issues.push(
					issue({
						severity: "warning",
						message: `Duplicate id "${id}" can break accessible-name references`,
						file: f.path,
						rule: "duplicate-id",
						category: "Accessibility",
						fix: "Make IDs unique before referencing them from labels or ARIA attributes.",
						source: "vcqa-heuristic",
						wcag: "WCAG 4.1.1",
					}),
				);
			}
		}

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const trimmed = line.trim();
			if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;

			// 1. <img> without alt
			if (/<img\b/.test(trimmed) && !/alt=/.test(trimmed)) {
				const block = openingTag(lines, i, 5);
				if (/<img\b/.test(block) && !/alt=/.test(block)) {
					missingAlt++;
					issues.push(
						issue({
							severity: "error",
							message: "<img> missing alt attribute",
							file: f.path,
							line: i + 1,
							rule: "img-alt",
							category: "Accessibility",
							fix: 'Add meaningful alt text, or alt="" when the image is decorative.',
							selector: selectorForTag(block),
							source: "vcqa-heuristic",
							wcag: "WCAG 1.1.1",
						}),
					);
				}
			}

			// 2. Icon-only button without an accessible name
			const buttonAt = line.indexOf("<button");
			if (buttonAt >= 0 && /<button\b/.test(line)) {
				const button = jsxChildren(source, lineOffsets[i] + buttonAt, "button");
				// An element whose closing tag was never reached is unknown, not unnamed.
				if (button.terminated && !hasExplicitName(button.raw) && !childrenNameElement(button)) {
					buttonName++;
					issues.push(
						issue({
							severity: "error",
							message: "Icon-only <button> has no accessible name",
							file: f.path,
							line: i + 1,
							rule: "button-name",
							category: "Accessibility",
							fix: "Add aria-label, aria-labelledby, title, or visible text that names the button action.",
							selector: "button",
							source: "vcqa-heuristic",
							wcag: "WCAG 4.1.2",
						}),
					);
				}
			}

			// 3. Click handler on non-interactive element without role/keyboard
			// React: onClick=, Vue: @click/v-on:click, Svelte: on:click
			if (/(?:onClick=|@click|v-on:click|on:click)/.test(trimmed) && /<(?:div|span|p|li|section|article|header|footer)\b/.test(trimmed)) {
				const block = lines.slice(i, Math.min(i + 3, lines.length)).join(" ");
				if (!(/role=/.test(block) && /(?:onKeyDown|onKeyUp|onKeyPress|tabIndex|@keydown|on:keydown)/.test(block))) {
					clickDiv++;
					issues.push(
						issue({
							severity: "warning",
							message: "Click handler on non-interactive element without role + keyboard handler",
							file: f.path,
							line: i + 1,
							rule: "click-events",
							category: "Accessibility",
							fix: "Use a native <button>/<a>, or add an appropriate role, tabIndex, and keyboard handler.",
							selector: selectorForTag(block),
							source: "vcqa-heuristic",
							wcag: "WCAG 2.1.1",
						}),
					);
				}
			}

			// 4. <input>/<select>/<textarea> without associated label
			if (/<(?:input|select|textarea)\b/.test(trimmed) && !/type=["'](?:hidden|submit|button|reset)["']/.test(trimmed)) {
				const tag = openingTag(lines, i, 6);
				const block = lines.slice(Math.max(0, i - 3), Math.min(i + 3, lines.length)).join(" ");
				if (!hasAssociatedLabel(source, tag, block)) {
					missingLabel++;
					issues.push(
						issue({
							severity: "warning",
							message: "Form control without label, aria-label, or aria-labelledby",
							file: f.path,
							line: i + 1,
							rule: "form-label",
							category: "Accessibility",
							fix: "Associate the control with a <label>, aria-label, or aria-labelledby.",
							selector: selectorForTag(tag),
							source: "vcqa-heuristic",
							wcag: "WCAG 3.3.2",
						}),
					);
				}
			}

			// 5. Invalid or suspicious ARIA attributes/roles
			if (/\baria-lable=|\barialabel=|\bariaLabel=|\barial-label=/i.test(trimmed)) {
				invalidAria++;
				issues.push(
					issue({
						severity: "error",
						message: "Suspicious ARIA attribute spelling",
						file: f.path,
						line: i + 1,
						rule: "invalid-aria-attr",
						category: "Accessibility",
						fix: "Use valid ARIA attribute names such as aria-label or aria-labelledby.",
						source: "vcqa-heuristic",
						wcag: "WCAG 4.1.2",
					}),
				);
			}
			const role = trimmed.match(/\brole=["']([^"']+)["']/)?.[1];
			if (role && !VALID_ARIA_ROLES.has(role)) {
				invalidAria++;
				issues.push(
					issue({
						severity: "error",
						message: `Unknown ARIA role "${role}"`,
						file: f.path,
						line: i + 1,
						rule: "invalid-aria-role",
						category: "Accessibility",
						fix: "Use a valid ARIA role, or prefer the native semantic element.",
						source: "vcqa-heuristic",
						wcag: "WCAG 4.1.2",
					}),
				);
			}
			if (/aria-hidden=["']true["']/.test(trimmed) && /(?:tabIndex=\{?0|tabindex=["']0|onClick=|@click|on:click|href=)/.test(trimmed)) {
				invalidAria++;
				issues.push(
					issue({
						severity: "error",
						message: "Focusable or interactive element is hidden from assistive technology",
						file: f.path,
						line: i + 1,
						rule: "aria-hidden-focus",
						category: "Accessibility",
						fix: "Remove aria-hidden from focusable content or remove the element from the tab order.",
						source: "vcqa-heuristic",
						wcag: "WCAG 4.1.2",
					}),
				);
			}
			for (const match of trimmed.matchAll(/\baria-labelledby=["']([^"']+)["']/g)) {
				for (const ref of idRefs(match[1] ?? "")) {
					if (!ids.has(ref)) {
						brokenAriaRefs++;
						issues.push(
							issue({
								severity: "warning",
								message: `aria-labelledby references missing id "${ref}"`,
								file: f.path,
								line: i + 1,
								rule: "broken-aria-reference",
								category: "Accessibility",
								fix: "Point aria-labelledby at visible text with a matching id, or use aria-label.",
								source: "vcqa-heuristic",
								wcag: "WCAG 4.1.2",
							}),
						);
					}
				}
			}

			// 6. Heading order regression when statically visible
			const heading = trimmed.match(/<h([1-6])\b/i)?.[1];
			if (heading) {
				const level = Number.parseInt(heading, 10);
				if (previousHeading > 0 && level > previousHeading + 1) {
					headingOrder++;
					issues.push(
						issue({
							severity: "warning",
							message: `Heading jumps from h${previousHeading} to h${level}`,
							file: f.path,
							line: i + 1,
							rule: "heading-order",
							category: "Accessibility",
							fix: "Do not skip heading levels; use CSS for visual size instead of changing semantic order.",
							selector: `h${level}`,
							source: "vcqa-heuristic",
							wcag: "WCAG 2.4.6",
						}),
					);
				}
				previousHeading = level;
			}

			// 7. autoFocus
			if (/\bautoFocus\b/.test(trimmed) || /\bautofocus\b/.test(trimmed)) {
				autofocus++;
				issues.push(
					issue({
						severity: "warning",
						message: "autoFocus can disorient screen reader users",
						file: f.path,
						line: i + 1,
						rule: "no-autofocus",
						category: "Accessibility",
						fix: "Move focus intentionally after user action, or announce the context change.",
						source: "vcqa-heuristic",
						wcag: "WCAG 2.4.3",
					}),
				);
			}

			// 8. Positive tabIndex
			if (/tabIndex=\{[1-9]/.test(trimmed) || /tabindex=["'][1-9]/.test(trimmed)) {
				positiveTabindex++;
				issues.push(
					issue({
						severity: "warning",
						message: "Positive tabIndex disrupts natural tab order — use 0 or -1",
						file: f.path,
						line: i + 1,
						rule: "tabindex",
						category: "Accessibility",
						fix: "Keep DOM order logical and use tabIndex={0} or {-1} only when needed.",
						source: "vcqa-heuristic",
						wcag: "WCAG 2.4.3",
					}),
				);
			}
			// 9. Vue: v-for without :key (check same element, not next lines)
			if (/v-for=/.test(trimmed)) {
				// Collect the full opening tag (may span multiple lines until >)
				let tag = trimmed;
				for (let k = i + 1; k < Math.min(i + 5, lines.length) && !tag.includes(">"); k++) {
					tag += ` ${lines[k].trim()}`;
				}
				if (!/:key=/.test(tag) && !/v-bind:key=/.test(tag)) {
					issues.push(
						issue({
							severity: "error",
							message: "v-for without :key — causes rendering bugs when list changes",
							file: f.path,
							line: i + 1,
							rule: "vue-v-for-key",
							category: "Accessibility",
							fix: "Add a stable :key for each repeated item.",
							source: "vcqa-heuristic",
						}),
					);
				}
			}
		}
	}

	if (reactViteApp && !projectHasLandmark) {
		issues.push(
			issue({
				severity: "warning",
				message: 'React/Vite app has no obvious page landmark such as <main> or role="main"',
				file: files.find((file) => /(?:^|\/)(?:App|main|index)\.(?:tsx|jsx)$/.test(file.path))?.path ?? files[0]?.path,
				rule: "missing-landmark",
				category: "Accessibility",
				fix: "Wrap primary page content in <main>, and use nav/header/footer landmarks where appropriate.",
				selector: "main",
				source: "vcqa-heuristic",
				wcag: "WCAG 1.3.1",
			}),
		);
	}

	// 10. Static-HTML document metadata.
	//
	// `<html lang>` and `<meta name="viewport">` are NOT checked here: `html-quality`
	// owns them (#68). They used to be emitted from this block as well, which
	// double-reported every project that has both an index.html and JSX — the same
	// file produced `html-lang` here and `missing-lang` there, and `missing-viewport`
	// under two different categories with the same rule id.
	//
	// html-quality is the canonical owner because it is the only runner that can be
	// relied on: this check returns early with "no JSX/TSX/Vue/Svelte files", so on a
	// pure static site it never runs at all — while html-quality walks every HTML file
	// in the inventory rather than the four hardcoded paths below.
	for (const h of htmlPathsForProjects(projects)) {
		const full = join(cwd, h);
		if (!existsSync(full)) continue;
		const content = readFileSync(full, "utf-8");
		// charset
		if (!/<meta[^>]*charset=/i.test(content)) {
			issues.push(
				issue({
					severity: "warning",
					message: "Missing <meta charset> — may cause encoding issues",
					file: h,
					rule: "missing-charset",
					category: "Accessibility",
					fix: 'Add <meta charset="UTF-8"> near the start of <head>.',
					selector: "meta[charset]",
					source: "vcqa-heuristic",
				}),
			);
		}
		// Touch icon for mobile bookmarks
		if (!/<link[^>]*apple-touch-icon/.test(content) && !/<link[^>]*icon/.test(content)) {
			issues.push(
				issue({
					severity: "info",
					message: "No favicon or apple-touch-icon — poor mobile bookmark experience",
					file: h,
					rule: "missing-icon",
					category: "Accessibility",
					fix: "Add a favicon or apple-touch-icon link so saved shortcuts are recognizable.",
					selector: 'link[rel~="icon"]',
					source: "vcqa-heuristic",
				}),
			);
		}
	}

	// 11. Mobile-unfriendly patterns in components
	for (const f of files) {
		const source = f.rawContent || f.content;
		const lines = source.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			// Fixed pixel widths that break on mobile
			if (/style=.*width:\s*\d{4,}px/.test(line)) {
				issues.push(
					issue({
						severity: "info",
						message: "Fixed width ≥1000px — likely breaks on mobile",
						file: f.path,
						line: i + 1,
						rule: "fixed-width",
						category: "Accessibility",
						fix: "Use responsive sizing with max-width, percentages, or container queries.",
						source: "vcqa-heuristic",
					}),
				);
			}
			// Horizontal scroll containers without overflow handling
			if (/overflow-x:\s*(?:scroll|auto)/.test(line) && !/\btouch\b/.test(line) && !/-webkit-overflow-scrolling/.test(line)) {
				issues.push(
					issue({
						severity: "info",
						message: "Horizontal scroll without touch-action — poor mobile scroll UX",
						file: f.path,
						line: i + 1,
						rule: "touch-scroll",
						category: "Accessibility",
						fix: "Ensure horizontal scroll regions work with touch and keyboard, with visible overflow affordances.",
						source: "vcqa-heuristic",
					}),
				);
			}
			// Hover-only interactions (no touch fallback)
			if (/onMouseEnter=|@mouseenter|on:mouseenter/.test(line) && !/onClick=|@click|on:click|onTouchStart|@touchstart/.test(line)) {
				issues.push(
					issue({
						severity: "info",
						message: "Hover-only interaction — unreachable on touch devices",
						file: f.path,
						line: i + 1,
						rule: "hover-only",
						category: "Accessibility",
						fix: "Provide click, focus, or touch behavior for the same action.",
						source: "vcqa-heuristic",
					}),
				);
			}
			// Tiny touch targets
			if (/(?:width|height):\s*(?:1[0-9]|[1-9])px/.test(line) && /(?:onClick|@click|on:click|button|<a )/.test(line)) {
				issues.push(
					issue({
						severity: "info",
						message: "Touch target likely <44px — hard to tap on mobile (WCAG 2.5.8)",
						file: f.path,
						line: i + 1,
						rule: "small-touch-target",
						category: "Accessibility",
						fix: "Make interactive targets at least 44px by 44px, or provide equivalent spacing.",
						source: "vcqa-heuristic",
						wcag: "WCAG 2.5.8",
					}),
				);
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
			source: inventory ? "file-inventory" : "legacy-walk",
			reactViteApp,
			standardSignals: {
				"eslint-plugin-jsx-a11y": {
					installed: hasA11yPlugin,
					configured: jsxA11y.configured,
					ran: jsxA11y.ran,
					issues: jsxA11y.issues.length,
					reason: jsxA11y.reason,
				},
			},
			missingAlt,
			buttonName,
			clickDiv,
			missingLabel,
			autofocus,
			positiveTabindex,
			invalidAria,
			headingOrder,
			brokenAriaRefs,
			projects: projectDetails(projects, files),
			suggestion:
				!hasA11yPlugin || !jsxA11y.configured
					? "Install and configure eslint-plugin-jsx-a11y for deeper accessibility analysis: pnpm add -D eslint-plugin-jsx-a11y"
					: undefined,
		},
		issues,
		duration: Date.now() - start,
	};
}
