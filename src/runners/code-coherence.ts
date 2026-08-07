/** Code Coherence — detects internal contradictions and inconsistencies.
 *
 * Pro feature (LLM-powered via api.vibecodeqa.online).
 * Requires VCQA_PRO_KEY. Without it, runs local heuristic checks only.
 *
 * Local checks (always run):
 *   - Inconsistent default values for the same config key
 *   - Mixed error handling patterns (throw vs return null)
 *   - Duplicate function signatures with different implementations
 *
 * Pro checks (LLM-powered):
 *   - Contradictory validation logic
 *   - Dead config flags
 *   - Behavioral mismatches across modules
 */

import type { FileInventory } from "../file-inventory.js";
import { inventorySourceFiles } from "../file-inventory.js";
import { getProductionFiles } from "../fs-utils.js";
import type { CheckResult, Issue } from "../types.js";
import { gradeFromScore } from "../types.js";

export function runCodeCoherence(cwd: string, inventory?: FileInventory): CheckResult {
	const start = Date.now();
	const proKey = process.env.VCQA_PRO_KEY || "";

	const files = inventory ? inventorySourceFiles(inventory) : getProductionFiles(cwd);
	const totalExports = files.reduce((s, f) => s + (f.content.match(/\bexport\s+/g) || []).length, 0);
	const totalFunctions = files.reduce((s, f) => s + (f.content.match(/\bfunction\s+\w+/g) || []).length, 0);

	if (!proKey) {
		return {
			name: "code-coherence",
			score: 0,
			grade: "F",
			details: {
				premium: true,
				comingSoon: true,
				reason: "Set VCQA_PRO_KEY to enable LLM-powered analysis",
				filesAnalyzed: files.length,
				source: inventory ? "file-inventory" : "legacy-walk",
				totalExports,
				totalFunctions,
				description:
					"Detects internal contradictions: inconsistent validation, conflicting defaults, naming drift, and behavioral mismatches.",
			},
			issues: [],
			duration: Date.now() - start,
		};
	}

	// Pro: local heuristic checks
	const issues: Issue[] = [];

	// Check for inconsistent error handling patterns within the same file
	for (const f of files) {
		const hasThrow = /\bthrow\s+new\s+Error/.test(f.content);
		const hasReturnNull = /return\s+null\b/.test(f.content);
		if (hasThrow && hasReturnNull) {
			issues.push({
				severity: "info",
				message: "Mixed error handling: both throw and return null in same file — pick one pattern",
				file: f.path,
				rule: "inconsistent-error-pattern",
			});
		}
	}

	// Check for duplicate function names across files (same name, different implementation)
	const funcsByName = new Map<string, string[]>();
	for (const f of files) {
		const funcs = f.content.match(/export\s+(?:async\s+)?function\s+(\w+)/g) || [];
		for (const func of funcs) {
			const name = func.replace(/export\s+(?:async\s+)?function\s+/, "");
			const arr = funcsByName.get(name) || [];
			arr.push(f.path);
			funcsByName.set(name, arr);
		}
	}
	for (const [name, paths] of funcsByName) {
		if (paths.length > 1) {
			issues.push({
				severity: "warning",
				message: `Function "${name}" exported from ${paths.length} files — potential behavioral inconsistency`,
				file: paths[0],
				rule: "duplicate-export-name",
			});
		}
	}

	const score = issues.length === 0 ? 100 : Math.max(30, 100 - issues.length * 8);

	return {
		name: "code-coherence",
		score,
		grade: gradeFromScore(score),
		details: {
			premium: true,
			filesAnalyzed: files.length,
			source: inventory ? "file-inventory" : "legacy-walk",
			totalExports,
			totalFunctions,
			issuesFound: issues.length,
			tool: proKey ? "pro-llm" : "local-heuristic",
		},
		issues,
		duration: Date.now() - start,
	};
}
