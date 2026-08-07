/** Type safety check — count unsafe patterns and type-check escape hatches. */

import type { FileInventory } from "../file-inventory.js";
import { inventorySourceFiles } from "../file-inventory.js";
import { getProductionFiles } from "../fs-utils.js";
import type { CheckResult, Issue, ProjectContext, WorkspaceInfo } from "../types.js";
import { gradeFromScore } from "../types.js";
import { filesForProjects, nonOverlappingProjects, projectContainsPath, projectSourceRoots } from "./project-scope.js";

interface UnsafePattern {
	name: string;
	pattern: RegExp;
	severity: "error" | "warning" | "info";
	weight: number; // score penalty per occurrence
}

interface DetectedUnsafe {
	name: string;
	severity: "error" | "warning" | "info";
	weight: number;
	message: string;
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

function projectForFile(projects: ProjectContext[], filePath: string): ProjectContext | undefined {
	return projects.find((project) => projectContainsPath(project.path, filePath));
}

function patternsForFile(filePath: string, isDart: boolean, project?: ProjectContext): UnsafePattern[] {
	if (project) {
		return project.stack.language === "dart" || filePath.endsWith(".dart") ? DART_PATTERNS : TS_PATTERNS;
	}
	return isDart ? DART_PATTERNS : TS_PATTERNS;
}

function projectSummaries(projects: ProjectContext[] | undefined, sourceFiles: Array<{ path: string }>, issues: Issue[]) {
	return projects?.map((project) => ({
		id: project.id,
		name: project.name,
		path: project.path,
		language: project.stack.language,
		files: sourceFiles.filter((file) => projectContainsPath(project.path, file.path)).length,
		issues: issues.filter((issue) => issue.file && projectContainsPath(project.path, issue.file)).length,
	}));
}

function isExhaustivenessNever(line: string): boolean {
	return /\b(assertNever|exhaustive|unreachable)\b/i.test(line) || /:\s*never\s*=/.test(line);
}

function detectTypeScriptEscapeHatches(line: string): DetectedUnsafe[] {
	const findings: DetectedUnsafe[] = [];
	if (/\bas\s+never\b/.test(line)) {
		if (isExhaustivenessNever(line)) {
			findings.push({
				name: "as never",
				severity: "info",
				weight: 0.25,
				message: "as never in an exhaustiveness path — prefer an assertNever(value: never) helper when possible",
			});
		} else {
			findings.push({
				name: "as never",
				severity: "warning",
				weight: 2,
				message: "as never bypasses the type checker — model the impossible state or use a typed exhaustiveness helper",
			});
		}
	}
	if (/\bas\s+(?:unknown|any)\s+as\s+/.test(line)) {
		findings.push({
			name: "double cast",
			severity: "warning",
			weight: 3,
			message: "Double cast through any/unknown bypasses assignability — use a type guard, satisfies, or a typed factory",
		});
	}
	if (/\bcreateContext(?:<[^>]+>)?\([^)]*\bas\s+[^)]*\)/.test(line) || /<[\w.]+\.Provider\b[^>]*\bvalue=\{[^}]*\bas\s+[^}]+}/.test(line)) {
		findings.push({
			name: "context cast",
			severity: "warning",
			weight: 3,
			message: "Context value/default is forced through a cast — provide a real default implementation or use satisfies",
		});
	}
	return findings;
}

export function runTypeSafety(cwd: string, isDart = false, workspace?: WorkspaceInfo, inventory?: FileInventory): CheckResult {
	const start = Date.now();
	const issues: Issue[] = [];
	const counts: Record<string, number> = {};
	let totalPenalty = 0;
	const projects = nonOverlappingProjects(workspace) ?? undefined;

	const sourceFiles = filesForProjects(
		inventory ? inventorySourceFiles(inventory) : getProductionFiles(cwd, projects ? projectSourceRoots(projects) : undefined),
		projects ?? null,
	);

	if (sourceFiles.length === 0) {
		return {
			name: "type-safety",
			score: 100,
			grade: "A",
			details: { skipped: true, reason: "no source files", projects: projectSummaries(projects, sourceFiles, issues) },
			issues: [],
			duration: Date.now() - start,
		};
	}

	for (const sf of sourceFiles) {
		const lines = sf.content.split("\n");
		const project = projects ? projectForFile(projects, sf.path) : undefined;
		const patterns = patternsForFile(sf.path, isDart, project);

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const trimmed = line.trim();
			// Check for @ts-* directives in comments BEFORE skipping comment lines
			if (trimmed.startsWith("//")) {
				for (const p of patterns) {
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

			for (const p of patterns) {
				const matches = line.match(p.pattern);
				if (matches) {
					counts[p.name] = (counts[p.name] || 0) + matches.length;
					totalPenalty += p.weight * matches.length;
					for (const _m of matches) {
						issues.push({ severity: p.severity, message: p.name, file: sf.path, line: i + 1, rule: "unsafe-type" });
					}
				}
			}

			if (patterns === TS_PATTERNS) {
				for (const finding of detectTypeScriptEscapeHatches(line)) {
					counts[finding.name] = (counts[finding.name] || 0) + 1;
					totalPenalty += finding.weight;
					issues.push({
						severity: finding.severity,
						message: finding.message,
						file: sf.path,
						line: i + 1,
						rule: "unsafe-type",
					});
				}
			}
		}
	}

	// Scale penalty relative to codebase size (min 100 lines to avoid small-file distortion)
	const totalLines = Math.max(
		100,
		sourceFiles.reduce((s, f) => s + f.lines, 0),
	);
	const penaltyPerKLOC = (totalPenalty / totalLines) * 1000;
	const score = Math.max(0, Math.min(100, Math.round(100 - penaltyPerKLOC * 3)));

	return {
		name: "type-safety",
		score,
		grade: gradeFromScore(score),
		details: {
			...counts,
			source: inventory ? "file-inventory" : "legacy-walk",
			filesScanned: sourceFiles.length,
			totalUnsafe: issues.length,
			projects: projectSummaries(projects, sourceFiles, issues),
		},
		issues,
		duration: Date.now() - start,
	};
}
