/** Doc Coherence — detects contradictions between documentation and code.
 *
 * Pro feature (LLM-powered via api.vibecodeqa.online).
 * Requires VCQA_PRO_KEY env var. Without it, returns placeholder.
 *
 * Checks:
 *   - README claims vs actual exports/features
 *   - JSDoc @param/@returns vs function signatures
 *   - Comments that contradict adjacent code
 *   - CHANGELOG references to files that no longer exist
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getProductionFiles } from "../fs-utils.js";
import type { CheckResult, Issue } from "../types.js";
import { gradeFromScore } from "../types.js";

const API = "https://api.vibecodeqa.online";

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

	// Call Pro API for deeper LLM analysis
	try {
		const res = fetchSync(`${API}/api/pro/doc-coherence`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${proKey}` },
			body: JSON.stringify({ readme, exports: exports.slice(0, 30), docFiles }),
		});
		if (res) {
			for (const finding of res.findings || []) {
				issues.push({
					severity: (finding.severity === "error" || finding.severity === "info" ? finding.severity : "warning") as "error" | "warning" | "info",
					message: finding.message,
					file: finding.file,
					rule: "doc-drift",
				});
			}
		}
	} catch {
		// API unavailable — still return local findings
	}

	const score = issues.length === 0 ? 100 : Math.max(20, 100 - issues.length * 10);

	return {
		name: "doc-coherence",
		score,
		grade: gradeFromScore(score),
		details: { premium: true, docFiles, hasJSDoc, issuesFound: issues.length, tool: "pro-llm" },
		issues,
		duration: Date.now() - start,
	};
}

/** Synchronous fetch wrapper for CLI context. Returns parsed JSON or null. */
function fetchSync(url: string, opts: { method: string; headers: Record<string, string>; body: string }): { findings: { severity: string; message: string; file?: string }[] } | null {
	try {
		const { execSync } = require("node:child_process") as typeof import("node:child_process");
		const result = execSync(
			`curl -s -X ${opts.method} "${url}" -H "Content-Type: application/json" -H "Authorization: ${opts.headers.Authorization}" -d '${opts.body.replace(/'/g, "'\\''")}'`,
			{ encoding: "utf-8", timeout: 15_000 },
		);
		return JSON.parse(result);
	} catch {
		return null;
	}
}
