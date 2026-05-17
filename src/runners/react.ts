/** React-specific checks — hooks rules, conditional hooks, missing keys, prop spreading.
 *  Note: if eslint-plugin-react-hooks is installed, those rules run in the lint check.
 *  This runner catches patterns beyond what the plugin covers. */

import { getProductionFiles, readDeps } from "../fs-utils.js";
import type { CheckResult, Issue, StackInfo } from "../types.js";
import { gradeFromScore } from "../types.js";

export function runReact(cwd: string, stack: StackInfo): CheckResult {
	const start = Date.now();

	if (stack.framework !== "react") {
		return {
			name: "react",
			score: 100,
			grade: "A",
			details: { skipped: true, reason: "not a React project" },
			issues: [],
			duration: Date.now() - start,
		};
	}

	const files = getProductionFiles(cwd).filter((f) => f.ext === ".tsx" || f.ext === ".jsx");
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

			// 2. Missing key in .map() returning JSX
			if (/\.map\s*\(/.test(trimmed)) {
				// Look ahead for JSX return without key
				const mapBlock = lines.slice(i, Math.min(i + 10, lines.length)).join("\n");
				if (/<\w/.test(mapBlock) && !mapBlock.includes("key=") && !mapBlock.includes("key:")) {
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

	const errors = issues.filter((i) => i.severity === "error").length;
	const warnings = issues.filter((i) => i.severity === "warning").length;
	const totalFiles = files.length || 1;
	const errorPenalty = Math.min(50, (errors / totalFiles) * 200);
	const warnPenalty = Math.min(30, (warnings / totalFiles) * 80);
	const score = Math.max(0, Math.min(100, Math.round(100 - errorPenalty - warnPenalty)));

	return {
		name: "react",
		score,
		grade: gradeFromScore(score),
		details: { jsxFiles: files.length, conditionalHooks, missingKeys, indexKeys, propSpreading, inlineHandlers, effectNoDeps, domManipulation },
		issues,
		duration: Date.now() - start,
	};
}
