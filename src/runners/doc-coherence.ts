/** Doc Coherence — detects contradictions between documentation and code.
 *
 * Pro feature. Requires VCQA_PRO_KEY env var. Without it, returns placeholder.
 *
 * Local checks (always run with Pro key):
 *   - JSDoc @param names not matching function signature
 *   - README mentions features not found in exports
 *
 * LLM-powered analysis is handled by the upload flow (--upload + VCQA_PRO_KEY).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getProductionFiles } from "../fs-utils.js";
import type { CheckResult, Issue } from "../types.js";
import { gradeFromScore } from "../types.js";

export function runDocCoherence(cwd: string): CheckResult {
	const start = Date.now();
	const proKey = process.env.VCQA_PRO_KEY || "";

	// Gather doc context
	const docFiles: string[] = [];
	const candidates = ["README.md", "CLAUDE.md", "ARCHITECTURE.md", "CONTRIBUTING.md", "CHANGELOG.md", "API.md", "docs/README.md"];
	for (const f of candidates) {
		if (existsSync(join(cwd, f))) docFiles.push(f);
	}

	let hasJSDoc = false;
	const files = getProductionFiles(cwd);
	hasJSDoc = files.some((f) => /\/\*\*/.test(f.content));

	// Without Pro key, return placeholder
	if (!proKey) {
		return {
			name: "doc-coherence",
			score: 0,
			grade: "F",
			details: {
				premium: true,
				comingSoon: !proKey,
				reason: "Set VCQA_PRO_KEY to enable LLM-powered analysis",
				docFiles,
				hasJSDoc,
				description: "Detects contradictions between documentation and code. Finds stale README claims, incorrect JSDoc, and misleading comments.",
			},
			issues: [],
			duration: Date.now() - start,
		};
	}

	// Pro: build context and call API
	const issues: Issue[] = [];

	// Gather README + top exports for analysis
	const readme = docFiles.includes("README.md") ? readFileSync(join(cwd, "README.md"), "utf-8").slice(0, 4000) : "";
	const exports = files
		.flatMap((f) => {
			const matches = f.content.match(/export\s+(?:async\s+)?function\s+(\w+)|export\s+(?:const|class|interface)\s+(\w+)/g) || [];
			return matches.map((m) => ({ file: f.path, export: m.replace(/export\s+(?:async\s+)?/, "").trim() }));
		})
		.slice(0, 50);

	// Collect JSDoc mismatches (local check — no LLM needed)
	for (const f of files) {
		const lines = f.content.split("\n");
		for (let i = 0; i < lines.length; i++) {
			// JSDoc @param for param that doesn't exist in function signature
			if (lines[i].includes("@param") && i < lines.length - 5) {
				const paramMatch = lines[i].match(/@param\s+\{[^}]*\}\s+(\w+)/);
				if (paramMatch) {
					// Look for function signature within next 5 lines
					const sigBlock = lines.slice(i, Math.min(i + 6, lines.length)).join("\n");
					const funcMatch = sigBlock.match(/function\s+\w+\s*\(([^)]*)\)/);
					if (funcMatch && !funcMatch[1].includes(paramMatch[1])) {
						issues.push({
							severity: "warning",
							message: `JSDoc @param ${paramMatch[1]} not found in function signature`,
							file: f.path,
							line: i + 1,
							rule: "jsdoc-param-mismatch",
						});
					}
				}
			}
		}
	}

	// Check README references to code that doesn't exist
	if (readme) {
		const exportNames = new Set(exports.map((e) => e.export.split(/\s+/).pop() || ""));
		// Find backtick-quoted function/class names in README that don't match any export
		const codeRefs = readme.match(/`(\w{3,})`/g) || [];
		for (const ref of codeRefs) {
			const name = ref.replace(/`/g, "");
			// Skip common non-code words
			if (["true", "false", "null", "undefined", "string", "number", "boolean", "json", "html", "css"].includes(name.toLowerCase())) continue;
			if (/^[A-Z_]+$/.test(name)) continue; // constants like NODE_ENV
			// Check if it looks like a function/class name and isn't in exports
			if (/^[a-z]/.test(name) && name.length > 4 && !exportNames.has(name)) {
				// Could be a function name — check if it exists anywhere in source
				const existsInCode = files.some((f) => f.content.includes(name));
				if (!existsInCode) {
					issues.push({
						severity: "info",
						message: `README references \`${name}\` but it wasn't found in source code`,
						file: "README.md",
						rule: "readme-stale-ref",
					});
				}
			}
		}
	}

	const score = issues.length === 0 ? 100 : Math.max(20, 100 - issues.length * 10);

	return {
		name: "doc-coherence",
		score,
		grade: gradeFromScore(score),
		details: { premium: true, docFiles, hasJSDoc, issuesFound: issues.length, tool: "pro-local" },
		issues,
		duration: Date.now() - start,
	};
}
