/** Complexity analysis — counts lines, functions, and cognitive complexity via AST-free heuristics. */

import { getProductionFiles } from "../fs-utils.js";
import type { CheckResult, Issue } from "../types.js";
import { gradeFromScore } from "../types.js";

interface FunctionMetric {
	file: string;
	name: string;
	startLine: number;
	lines: number;
	complexity: number;
}

const MAX_FUNCTION_LINES = 60;
const MAX_COMPLEXITY = 15;

export function runComplexity(cwd: string): CheckResult {
	const start = Date.now();
	const issues: Issue[] = [];
	const functions: FunctionMetric[] = [];

	const sourceFiles = getProductionFiles(cwd);

	let totalLines = 0;
	const totalFiles = sourceFiles.length;
	let longFunctions = 0;
	let complexFunctions = 0;

	for (const sf of sourceFiles) {
		totalLines += sf.lines;

		// Simple heuristic: find function boundaries and measure complexity
		const funcs = extractFunctions(sf.content, sf.path);
		for (const f of funcs) {
			functions.push(f);
			if (f.lines > MAX_FUNCTION_LINES) {
				longFunctions++;
				issues.push({
					severity: "warning",
					message: `${f.name}: ${f.lines} lines (max ${MAX_FUNCTION_LINES})`,
					file: f.file,
					line: f.startLine,
					rule: "long-function",
				});
			}
			if (f.complexity > MAX_COMPLEXITY) {
				complexFunctions++;
				issues.push({
					severity: "warning",
					message: `${f.name}: complexity ${f.complexity} (max ${MAX_COMPLEXITY})`,
					file: f.file,
					line: f.startLine,
					rule: "high-complexity",
				});
			}
		}
	}

	// Score: based on percentage of functions that are problematic
	const totalFns = functions.length || 1;
	const longPct = (longFunctions / totalFns) * 100;
	const complexPct = (complexFunctions / totalFns) * 100;
	const score = Math.max(0, Math.min(100, Math.round(100 - longPct * 1.5 - complexPct * 2.5)));

	return {
		name: "complexity",
		score,
		grade: gradeFromScore(score),
		details: {
			totalFiles,
			totalLines,
			longFunctions,
			complexFunctions,
			functionCount: functions.length,
		},
		issues,
		duration: Date.now() - start,
	};
}

/** Simple heuristic function extraction — not a full AST parser but good enough for metrics. */
function extractFunctions(content: string, filePath: string): FunctionMetric[] {
	const funcs: FunctionMetric[] = [];
	const lines = content.split("\n");
	// Track brace nesting
	let funcStart = -1;
	let funcName = "";
	let braceCount = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trim();

		// Detect function start
		if (funcStart === -1) {
			const match =
				trimmed.match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/) ||
				trimmed.match(/^(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\(/) ||
				trimmed.match(/^(?:private|public|protected)?\s*(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*\w[^{]*)?\{/) ||
				trimmed.match(/^(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{/);
			if (match) {
				funcStart = i;
				funcName = match[1] || "anonymous";
				braceCount = 0;
			}
		}

		// Track brace depth
		if (funcStart !== -1) {
			for (const ch of line) {
				if (ch === "{") braceCount++;
				if (ch === "}") braceCount--;
			}
			if (braceCount <= 0 && i > funcStart) {
				const funcLines = i - funcStart + 1;
				const funcContent = lines.slice(funcStart, i + 1).join("\n");
				funcs.push({
					file: filePath,
					name: funcName,
					startLine: funcStart + 1, // 1-indexed
					lines: funcLines,
					complexity: measureComplexity(funcContent),
				});
				funcStart = -1;
			}
		}
	}

	return funcs;
}

/** Heuristic cognitive complexity — counts nesting and branching. */
function measureComplexity(code: string): number {
	let complexity = 0;
	const lines = code.split("\n");

	for (const line of lines) {
		const trimmed = line.trim();
		// +1 for each branch/loop keyword
		if (/\b(if|else if|else|switch|for|while|do|catch)\b/.test(trimmed) || /&&|\|\|/.test(trimmed)) {
			complexity++;
		}
		// +1 for ternary
		if (/\?.*:/.test(trimmed) && !trimmed.startsWith("//")) {
			complexity++;
		}
	}

	return complexity;
}
