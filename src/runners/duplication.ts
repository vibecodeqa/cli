/** Code duplication — delegates to jscpd when available, falls back to built-in line-hash. */

import { readFileSync, rmdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getProductionFiles, readDeps } from "../fs-utils.js";
import type { CheckResult, Issue } from "../types.js";
import { gradeFromScore } from "../types.js";
import { run } from "./exec.js";

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

	// Try jscpd if it's an explicit project dependency (opt-in, not auto-npx)
	const deps = readDeps(cwd);
	const jscpdResult = deps.jscpd ? tryJscpd(cwd) : null;
	if (jscpdResult) {
		jscpdResult.duration = Date.now() - start;
		return jscpdResult;
	}

	// Fallback: built-in line-hash detection
	const issues: Issue[] = [];
	const sourceFiles = getProductionFiles(cwd);

	if (sourceFiles.length < 2) {
		return {
			name: "duplication",
			score: 100,
			grade: "A",
			details: { filesScanned: sourceFiles.length, duplicates: 0, tool: "built-in" },
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
	// Score based on duplication percentage (not absolute count)
	const score = Math.max(0, Math.min(100, 100 - dupPct * 5));

	return {
		name: "duplication",
		score,
		grade: gradeFromScore(score),
		details: { filesScanned: sourceFiles.length, totalSourceLines, duplicateBlocks: duplicates.length, duplicationPct: `${dupPct}%`, tool: "built-in" },
		issues,
		duration: Date.now() - start,
	};
}

function tryJscpd(cwd: string): CheckResult | null {
	// jscpd writes JSON to a file, not stdout. Use a temp output dir.
	const tmpDir = join(cwd, ".vibe-check", "jscpd-tmp");
	const ignores = "node_modules/**,dist/**,build/**,.vibe-check/**,coverage/**,.next/**,.nuxt/**,**/*.json,**/*.lock,**/*.yaml,**/*.md";
	run(`npx jscpd . --min-lines 6 --min-tokens 50 --reporters json --output "${tmpDir}" --ignore "${ignores}" --silent 2>/dev/null || true`, cwd, 30_000);
	const reportPath = join(tmpDir, "jscpd-report.json");
	let rawData: string;
	try { rawData = readFileSync(reportPath, "utf-8"); } catch { return null; }
	// Clean up temp
	try { unlinkSync(reportPath); rmdirSync(tmpDir); } catch { /* ignore */ }

	try {
		const data = JSON.parse(rawData);
		if (!data.statistics) return null;

		const issues: Issue[] = [];
		const clones = data.duplicates || [];
		for (const d of clones.slice(0, 20)) {
			const fileA = d.firstFile?.name || "?";
			const fileB = d.secondFile?.name || "?";
			const lines = d.lines || 0;
			issues.push({
				severity: "warning",
				message: `Duplicate (${lines} lines)`,
				file: `${fileA}:${d.firstFile?.start} \u2194 ${fileB}:${d.secondFile?.start}`,
				rule: "duplicate-code",
			});
		}

		const dupPct = Math.round((data.statistics.total?.percentage || 0) * 100) / 100;
		// jscpd token-level detection is more aggressive than line-hash
		// Industry benchmarks: <10% good, 10-20% acceptable, 20-40% needs work, >40% poor
		const score = dupPct <= 5 ? 100
			: dupPct <= 10 ? 90
			: dupPct <= 20 ? 75
			: dupPct <= 30 ? 60
			: dupPct <= 40 ? 45
			: dupPct <= 50 ? 30
			: Math.max(10, Math.round(30 - (dupPct - 50)));

		return {
			name: "duplication",
			score,
			grade: gradeFromScore(score),
			details: {
				filesScanned: data.statistics.total?.sources || 0,
				totalSourceLines: data.statistics.total?.lines || 0,
				duplicateBlocks: clones.length,
				duplicationPct: `${dupPct}%`,
				tool: "jscpd",
			},
			issues,
			duration: 0, // filled by caller
		};
	} catch {
		return null;
	}
}
