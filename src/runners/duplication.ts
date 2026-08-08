/** Code duplication.
 *
 *  - If the project depends on jscpd, shell out to it (opt-in, richest output).
 *  - Otherwise run jscpd's detection engine (@jscpd/core — battle-tested Rabin-Karp
 *    matching + maximal-clone extension) over our own lightweight tokenizer. We
 *    supply the tokens (zero heavy language-grammar dependency) and let the mature
 *    engine do the matching/merging/statistics.
 *
 *  Catches Type-1/2 clones (exact, modulo formatting), like jscpd's default. */

import { createHash } from "node:crypto";
import { readFileSync, rmdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
	Detector,
	type DetectorEvents,
	getDefaultOptions,
	type IMapFrame,
	type IOptions,
	type IToken,
	type ITokenizer,
	type ITokensMap,
	MemoryStore,
	Statistic,
} from "@jscpd/core";
import { type FileInventory, inventorySourceFiles } from "../file-inventory.js";
import { getProductionFiles, readDeps, type SourceFile } from "../fs-utils.js";
import type { CheckResult, Issue } from "../types.js";
import { gradeFromScore } from "../types.js";
import { run } from "./exec.js";

// jscpd-parity thresholds: ≥ MIN_TOKENS consecutive matching tokens AND ≥ MIN_LINES lines.
const MIN_TOKENS = 50;
const MIN_LINES = 6;
const MAX_ISSUES = 20;
// One synthetic "format" for every file so clones are detected across all sources
// (jscpd only compares within a format; we want cross-file/cross-extension matches).
const FORMAT = "src";

interface Clone {
	fileA: string;
	lineA: number;
	fileB: string;
	lineB: number;
	lines: number;
	snippet: string;
}

export async function runDuplication(cwd: string, inventory?: FileInventory): Promise<CheckResult> {
	const start = Date.now();

	// Try jscpd if it's an explicit project dependency (opt-in, not auto-npx)
	const deps = readDeps(cwd);
	const jscpdResult = deps.jscpd ? tryJscpd(cwd) : null;
	if (jscpdResult) {
		jscpdResult.duration = Date.now() - start;
		return jscpdResult;
	}

	// One file universe: the scan-wide inventory when the scan built one, the
	// legacy walk only for direct callers that never ran a scan.
	const files = inventory ? inventorySourceFiles(inventory) : getProductionFiles(cwd);
	if (files.length < 2) {
		return {
			name: "duplication",
			score: 100,
			grade: "A",
			details: { filesScanned: files.length, duplicates: 0, tool: "built-in" },
			issues: [],
			duration: Date.now() - start,
		};
	}

	const { clones, percentage, totalLines } = await detectWithCore(files);
	const score = scoreFromPct(percentage);

	// Rank biggest clones first; stable tie-break for deterministic output.
	clones.sort((a, b) => b.lines - a.lines || a.fileA.localeCompare(b.fileA) || a.lineA - b.lineA);
	const issues: Issue[] = clones.slice(0, MAX_ISSUES).map((c) => ({
		severity: "warning",
		message: `Duplicate (${c.lines} lines): ${c.snippet.slice(0, 100)}`,
		file: `${c.fileA}:${c.lineA} ↔ ${c.fileB}:${c.lineB}`,
		rule: "duplicate-code",
		snippet: c.snippet,
	}));

	return {
		name: "duplication",
		score,
		grade: gradeFromScore(score),
		details: {
			filesScanned: files.length,
			totalSourceLines: totalLines,
			duplicateBlocks: clones.length,
			duplicationPct: `${percentage}%`,
			tool: "built-in",
		},
		issues,
		duration: Date.now() - start,
	};
}

/** Run @jscpd/core over our tokens. Files are fed sequentially into one Detector
 *  sharing a store, so later files match earlier ones (cross-file clones). */
async function detectWithCore(files: SourceFile[]): Promise<{ clones: Clone[]; percentage: number; totalLines: number }> {
	const options: IOptions = { ...getDefaultOptions(), minTokens: MIN_TOKENS, minLines: MIN_LINES, maxLines: 100_000 };
	const detector = new Detector(new VcqaTokenizer(), new MemoryStore(), undefined, options);

	const statistic = new Statistic();
	const handlers = statistic.subscribe();
	for (const event of Object.keys(handlers) as DetectorEvents[]) {
		const handler = handlers[event];
		if (handler) detector.on(event, handler);
	}

	const clones: Clone[] = [];
	for (const f of files) {
		const found = await detector.detect(f.path, f.content, FORMAT);
		for (const c of found) {
			const a = c.duplicationA; // the current file
			const b = c.duplicationB; // the earlier match
			const lines = Math.max(1, a.end.line - a.start.line + 1);
			const snippet = (f.content.split("\n")[a.start.line - 1] ?? "").trim();
			clones.push({ fileA: a.sourceId, lineA: a.start.line, fileB: b.sourceId, lineB: b.start.line, lines, snippet });
		}
	}

	const stat = statistic.getStatistic();
	const percentage = Math.round((stat.total.percentage ?? 0) * 10) / 10;
	return { clones, percentage, totalLines: stat.total.lines ?? 0 };
}

// ── Tokenizer feeding @jscpd/core ──

interface Token {
	text: string;
	line: number; // 1-based start line
	endLine: number; // end line (differs only for multi-line template literals)
	start: number; // char offset
	end: number; // char offset (exclusive)
}

interface Cursor {
	i: number;
	line: number;
}

const isWord = (ch: string) => (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9") || ch === "_" || ch === "$";

/** Consume a string/template literal, returning its full text. One token, so the
 *  detector never matches *inside* a string; text retained so distinct strings differ. */
function scanString(content: string, cur: Cursor): string {
	const quote = content[cur.i]!;
	const start = cur.i;
	const n = content.length;
	cur.i++;
	while (cur.i < n && content[cur.i] !== quote) {
		if (content[cur.i] === "\\") {
			if (content[cur.i + 1] === "\n") cur.line++;
			cur.i += 2;
			continue;
		}
		if (content[cur.i] === "\n") cur.line++;
		cur.i++;
	}
	const text = content.slice(start, Math.min(cur.i + 1, n));
	cur.i++; // skip closing quote
	return text;
}

/** Consume a block comment, advancing past the closing star-slash. */
function scanBlockComment(content: string, cur: Cursor): void {
	const n = content.length;
	cur.i += 2;
	while (cur.i < n && !(content[cur.i] === "*" && content[cur.i + 1] === "/")) {
		if (content[cur.i] === "\n") cur.line++;
		cur.i++;
	}
	cur.i += 2;
}

/** Lex source into tokens, skipping whitespace and comments. */
export function tokenize(content: string): Token[] {
	const tokens: Token[] = [];
	const n = content.length;
	const cur: Cursor = { i: 0, line: 1 };

	while (cur.i < n) {
		const c = content[cur.i]!;
		if (c === "\n") {
			cur.line++;
			cur.i++;
			continue;
		}
		if (c === " " || c === "\t" || c === "\r") {
			cur.i++;
			continue;
		}
		if (c === "/" && content[cur.i + 1] === "/") {
			while (cur.i < n && content[cur.i] !== "\n") cur.i++;
			continue;
		}
		if (c === "/" && content[cur.i + 1] === "*") {
			scanBlockComment(content, cur);
			continue;
		}

		const startLine = cur.line;
		const startPos = cur.i;
		if (c === '"' || c === "'" || c === "`") {
			const text = scanString(content, cur);
			tokens.push({ text, line: startLine, endLine: cur.line, start: startPos, end: cur.i });
			continue;
		}
		if (isWord(c)) {
			let j = cur.i + 1;
			while (j < n && isWord(content[j]!)) j++;
			tokens.push({ text: content.slice(cur.i, j), line: startLine, endLine: startLine, start: cur.i, end: j });
			cur.i = j;
			continue;
		}
		tokens.push({ text: c, line: startLine, endLine: startLine, start: startPos, end: cur.i + 1 }); // punctuation
		cur.i++;
	}
	return tokens;
}

/** Blank out import / re-export statements (preserving line numbers) before
 *  tokenizing. Identical import headers aren't refactorable duplication. */
export function stripImports(content: string): string {
	const lines = content.split("\n");
	let cont = false; // inside a multi-line import
	for (let i = 0; i < lines.length; i++) {
		const t = lines[i]!.trim();
		if (cont) {
			lines[i] = "";
			if (/from\s*['"][^'"]*['"]\s*;?\s*$/.test(t) || /;\s*$/.test(t)) cont = false;
			continue;
		}
		if (/^import\b/.test(t)) {
			const done = /from\s*['"][^'"]*['"]\s*;?\s*$/.test(t) || /^import\s*['"][^'"]*['"]\s*;?\s*$/.test(t);
			lines[i] = "";
			if (!done) cont = true;
			continue;
		}
		if (/^export\s*(\*|\{[^}]*\})\s*from\s*['"]/.test(t)) lines[i] = "";
	}
	return lines.join("\n");
}

function toIToken(t: Token, format: string): IToken {
	return {
		type: "code",
		value: t.text,
		length: t.text.length,
		format,
		range: [t.start, t.end],
		loc: { start: { line: t.line, column: 0, position: t.start }, end: { line: t.endLine, column: 0, position: t.end } },
	};
}

/** Bridges our tokens into the @jscpd/core engine: hashes rolling MIN_TOKENS-token
 *  windows into map frames the Rabin-Karp detector matches against. */
class VcqaTokenizer implements ITokenizer {
	generateMaps(id: string, data: string, format: string, options: Partial<IOptions>): ITokensMap[] {
		const w = options.minTokens ?? MIN_TOKENS;
		const toks = tokenize(stripImports(data)).map((t) => toIToken(t, format));
		const frames: IMapFrame[] = [];
		for (let i = 0; i + w <= toks.length; i++) {
			const id2 = createHash("md5")
				.update(
					toks
						.slice(i, i + w)
						.map((t) => t.value)
						.join(" "),
				)
				.digest("hex");
			frames.push({ id: id2, sourceId: id, start: toks[i]!, end: toks[i + w - 1]! });
		}
		return [new VcqaTokensMap(id, format, data, toks.length, frames)];
	}
}

class VcqaTokensMap implements ITokensMap {
	private p = 0;
	constructor(
		private readonly id: string,
		private readonly format: string,
		private readonly data: string,
		private readonly tokensCount: number,
		private readonly frames: IMapFrame[],
	) {}
	getFormat() {
		return this.format;
	}
	getId() {
		return this.id;
	}
	getLinesCount() {
		return this.data.split("\n").length;
	}
	getTokensCount() {
		return this.tokensCount;
	}
	next(): IteratorResult<IMapFrame | boolean> {
		if (this.p < this.frames.length) return { value: this.frames[this.p++]!, done: false };
		return { value: false, done: true };
	}
}

/** Shared scoring band (used by both built-in and jscpd paths).
 *  Industry benchmarks: <5% great, 5-10% good, 10-20% acceptable, >20% needs work. */
function scoreFromPct(dupPct: number): number {
	if (dupPct <= 5) return 100;
	if (dupPct <= 10) return 90;
	if (dupPct <= 20) return 75;
	if (dupPct <= 30) return 60;
	if (dupPct <= 40) return 45;
	if (dupPct <= 50) return 30;
	return Math.max(10, Math.round(30 - (dupPct - 50)));
}

function tryJscpd(cwd: string): CheckResult | null {
	// jscpd writes JSON to a file, not stdout. Use a temp output dir.
	const tmpDir = join(cwd, ".vibe-check", "jscpd-tmp");
	const ignores = "node_modules/**,dist/**,build/**,.vibe-check/**,coverage/**,.next/**,.nuxt/**,**/*.json,**/*.lock,**/*.yaml,**/*.md";
	run(
		`npx jscpd . --min-lines ${MIN_LINES} --min-tokens ${MIN_TOKENS} --reporters json --output "${tmpDir}" --ignore "${ignores}" --silent 2>/dev/null || true`,
		cwd,
		30_000,
	);
	const reportPath = join(tmpDir, "jscpd-report.json");
	let rawData: string;
	try {
		rawData = readFileSync(reportPath, "utf-8");
	} catch {
		return null;
	}
	// Clean up temp
	try {
		unlinkSync(reportPath);
		rmdirSync(tmpDir);
	} catch {
		/* ignore */
	}

	try {
		const data = JSON.parse(rawData);
		if (!data.statistics) return null;

		const issues: Issue[] = [];
		const clones = data.duplicates || [];
		for (const d of clones.slice(0, MAX_ISSUES)) {
			const fileA = d.firstFile?.name || "?";
			const fileB = d.secondFile?.name || "?";
			const lines = d.lines || 0;
			issues.push({
				severity: "warning",
				message: `Duplicate (${lines} lines)`,
				file: `${fileA}:${d.firstFile?.start} ↔ ${fileB}:${d.secondFile?.start}`,
				rule: "duplicate-code",
			});
		}

		const dupPct = Math.round((data.statistics.total?.percentage || 0) * 100) / 100;
		const score = scoreFromPct(dupPct);

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
