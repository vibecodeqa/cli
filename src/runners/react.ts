/** React-specific checks — hooks rules, conditional hooks, missing keys, prop spreading.
 *  Note: if eslint-plugin-react-hooks is installed, those rules run in the lint check.
 *  This runner catches patterns beyond what the plugin covers. */

import { getProductionFiles, readDeps } from "../fs-utils.js";
import type { CheckResult, Issue } from "../types.js";
import { gradeFromScore } from "../types.js";

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
	// If eslint-plugin-react-hooks is installed, lint runner already covers hooks rules
	const hasHooksPlugin = !!(deps["eslint-plugin-react-hooks"] || deps["eslint-plugin-react"]);
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
			if (!hasHooksPlugin && condBraceDepth > 0 && /\buse[A-Z]\w*\s*\(/.test(trimmed) && !/\/\//.test(trimmed.split("use")[0]!)) {
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
			if (mapIdx !== -1 && mapCallbackReturnsJsx(trimmed.slice(mapIdx).trimEnd(), lines, i)) {
				// Inspect just the JSX head for a key — enough to cover the opening element.
				const head = lines.slice(i, Math.min(i + 8, lines.length)).join("\n");
				if (!head.includes("key=") && !head.includes("key:")) {
					missingKeys++;
					issues.push({ severity: "error", message: "JSX in .map() without key prop", file: f.path, line: i + 1, rule: "missing-key" });
				}
			}

			// 3. index as key
			if (/key=\{(?:i|idx|index)\}/.test(trimmed) || /key=\{.*(?:, *(?:i|idx|index)\))/.test(trimmed)) {
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
			if (/\buseEffect\s*\(\s*(?:\(\)|function|\([^)]*\)\s*=>)/.test(trimmed)) {
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
	const hasErrorBoundary = allFiles.some(
		(f) => f.content.includes("componentDidCatch") || f.content.includes("ErrorBoundary"),
	);

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
			suggestion: !hasHooksPlugin ? "Install eslint-plugin-react-hooks for deeper React analysis: pnpm add -D eslint-plugin-react-hooks" : undefined,
		},
		issues,
		duration: Date.now() - start,
	};
}
