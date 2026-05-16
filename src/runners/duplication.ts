/** Code duplication detection — finds copy-pasted blocks. */

import { getProductionFiles } from "../fs-utils.js";
import type { CheckResult, Issue } from "../types.js";
import { gradeFromScore } from "../types.js";

const MIN_LINES = 6; // minimum duplicate block size
const MIN_TOKENS = 50; // minimum token count for a duplicate

interface DuplicateBlock {
	fileA: string;
	lineA: number;
	fileB: string;
	lineB: number;
	lines: number;
	content: string;
}

export function runDuplication(cwd: string): CheckResult {
	const start = Date.now();
	const issues: Issue[] = [];

	const sourceFiles = getProductionFiles(cwd);

	if (sourceFiles.length < 2) {
		return {
			name: "duplication",
			score: 100,
			grade: "A",
			details: { filesScanned: sourceFiles.length, duplicates: 0 },
			issues: [],
			duration: Date.now() - start,
		};
	}

	// Simple line-based duplicate detection
	// Build a map of normalized line hashes → locations
	const lineMap = new Map<string, { file: string; line: number }[]>();
	let totalSourceLines = 0;

	for (const sf of sourceFiles) {
		const lines = sf.content.split("\n");
		totalSourceLines += lines.length;

		for (let i = 0; i <= lines.length - MIN_LINES; i++) {
			const block = lines
				.slice(i, i + MIN_LINES)
				.map((l) => l.trim())
				.filter(
					(l) =>
						l.length > 0 &&
						!l.startsWith("//") &&
						!l.startsWith("*") &&
						!l.startsWith("import ") &&
						!l.startsWith("export {") &&
						l !== "{" &&
						l !== "}" &&
						l !== "",
				);

			if (block.length < MIN_LINES - 2) continue; // too many empty/trivial lines
			const key = block.join("\n");
			if (key.length < MIN_TOKENS) continue;

			const locs = lineMap.get(key) || [];
			locs.push({ file: sf.path, line: i + 1 });
			lineMap.set(key, locs);
		}
	}

	// Find blocks that appear in 2+ locations
	const duplicates: DuplicateBlock[] = [];
	const seen = new Set<string>();

	for (const [key, locs] of lineMap) {
		if (locs.length < 2) continue;
		// Deduplicate: same file, adjacent lines are the same block
		const unique = locs.filter((l, i) => i === 0 || l.file !== locs[i - 1].file || l.line > locs[i - 1].line + MIN_LINES);
		if (unique.length < 2) continue;

		// Only report each pair once
		for (let i = 0; i < unique.length - 1; i++) {
			const a = unique[i];
			const b = unique[i + 1];
			const pairKey = `${a.file}:${a.line}-${b.file}:${b.line}`;
			if (seen.has(pairKey)) continue;
			seen.add(pairKey);
			duplicates.push({ fileA: a.file, lineA: a.line, fileB: b.file, lineB: b.line, lines: MIN_LINES, content: key });
		}
	}

	for (const d of duplicates.slice(0, 20)) {
		// Show first 3 lines of the duplicated content, truncate at word boundary
		const lines = d.content.split("\n").slice(0, 3);
		const preview = lines.join(" \u2502 "); // use │ separator
		const maxLen = 120;
		const truncated = preview.length > maxLen ? `${preview.slice(0, preview.lastIndexOf(" ", maxLen) || maxLen)}...` : preview;
		// First line of content is the best search string
		const searchSnippet = d.content.split("\n")[0];
		issues.push({
			severity: "warning",
			message: `Duplicate (${d.lines} lines): ${truncated}`,
			file: `${d.fileA}:${d.lineA} ↔ ${d.fileB}:${d.lineB}`,
			rule: "duplicate-code",
			snippet: searchSnippet,
		});
	}

	const dupPct = totalSourceLines > 0 ? Math.round((duplicates.length * MIN_LINES * 100) / totalSourceLines) : 0;
	const score = Math.max(0, Math.min(100, 100 - dupPct * 3 - duplicates.length));

	return {
		name: "duplication",
		score,
		grade: gradeFromScore(score),
		details: { filesScanned: sourceFiles.length, totalSourceLines, duplicateBlocks: duplicates.length, duplicationPct: `${dupPct}%` },
		issues,
		duration: Date.now() - start,
	};
}
