/** Type safety check — count unsafe patterns: `as any`, explicit `any`, non-null assertions. */

import { getProductionFiles } from "../fs-utils.js";
import type { CheckResult, Issue } from "../types.js";
import { gradeFromScore } from "../types.js";

interface UnsafePattern {
	name: string;
	pattern: RegExp;
	severity: "error" | "warning" | "info";
	weight: number; // score penalty per occurrence
}

// TypeScript unsafe patterns
const TS_PATTERNS: UnsafePattern[] = [
	{ name: "as any", pattern: /\bas any\b/g, severity: "warning", weight: 2 },
	{ name: ": any", pattern: /:\s*any\b/g, severity: "warning", weight: 1 },
	{ name: "non-null assertion (!.)", pattern: /\w+!\./g, severity: "info", weight: 0.5 },
	{ name: "@ts-ignore", pattern: /@ts-ignore/g, severity: "error", weight: 5 },
	{ name: "@ts-expect-error", pattern: /@ts-expect-error/g, severity: "warning", weight: 2 },
	{ name: "@ts-nocheck", pattern: /@ts-nocheck/g, severity: "error", weight: 10 },
];

// Dart unsafe patterns
const DART_PATTERNS: UnsafePattern[] = [
	{ name: "dynamic type", pattern: /\bdynamic\b/g, severity: "warning", weight: 1 },
	{ name: "as dynamic", pattern: /\bas dynamic\b/g, severity: "warning", weight: 2 },
	{ name: "// ignore:", pattern: /\/\/\s*ignore:/g, severity: "error", weight: 5 },
	{ name: "// ignore_for_file:", pattern: /\/\/\s*ignore_for_file:/g, severity: "error", weight: 10 },
	{ name: "late keyword", pattern: /\blate\s+(?!final)/g, severity: "info", weight: 0.5 },
];

export function runTypeSafety(cwd: string, isDart = false): CheckResult {
	const start = Date.now();
	const issues: Issue[] = [];
	const counts: Record<string, number> = {};
	let totalPenalty = 0;
	const PATTERNS = isDart ? DART_PATTERNS : TS_PATTERNS;

	const sourceFiles = getProductionFiles(cwd);

	if (sourceFiles.length === 0) {
		return {
			name: "type-safety",
			score: 100,
			grade: "A",
			details: { skipped: true, reason: "no source files" },
			issues: [],
			duration: Date.now() - start,
		};
	}

	for (const sf of sourceFiles) {
		const lines = sf.content.split("\n");

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const trimmed = line.trim();
			// Check for @ts-* directives in comments BEFORE skipping comment lines
			if (trimmed.startsWith("//")) {
				for (const p of PATTERNS) {
					if (!p.name.startsWith("@ts-")) continue;
					const matches = line.match(p.pattern);
					if (matches) {
						counts[p.name] = (counts[p.name] || 0) + matches.length;
						totalPenalty += p.weight * matches.length;
						for (const _m of matches) {
							issues.push({ severity: p.severity, message: p.name, file: sf.path, line: i + 1, rule: "unsafe-type" });
						}
					}
				}
				continue;
			}
			if (trimmed.startsWith("*")) continue;
			// Skip pattern definition lines and string-heavy lines (prevents false positives)
			if (/\bpattern\s*:|name:\s*["']|message:\s*["']|description:\s*["']|risk:\s*["']|recommendation:\s*["']/.test(trimmed)) continue;
			if (/^\s*["'`].*["'`][,;]?\s*$/.test(line)) continue;

			for (const p of PATTERNS) {
				const matches = line.match(p.pattern);
				if (matches) {
					counts[p.name] = (counts[p.name] || 0) + matches.length;
					totalPenalty += p.weight * matches.length;
					for (const _m of matches) {
						issues.push({ severity: p.severity, message: p.name, file: sf.path, line: i + 1, rule: "unsafe-type" });
					}
				}
			}
		}
	}

	// Scale penalty relative to codebase size (min 100 lines to avoid small-file distortion)
	const totalLines = Math.max(100, sourceFiles.reduce((s, f) => s + f.lines, 0));
	const penaltyPerKLOC = (totalPenalty / totalLines) * 1000;
	const score = Math.max(0, Math.min(100, Math.round(100 - penaltyPerKLOC * 3)));

	return {
		name: "type-safety",
		score,
		grade: gradeFromScore(score),
		details: { ...counts, filesScanned: sourceFiles.length, totalUnsafe: issues.length },
		issues,
		duration: Date.now() - start,
	};
}
