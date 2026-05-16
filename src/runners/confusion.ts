/** Confusion Index — measures naming ambiguity that causes LLMs to misunderstand or edit the wrong code.
 *
 * Research backing:
 * - "When Names Disappear" (arXiv:2510.03178): GPT-4o drops 28.6 pts on summarization with obfuscated names
 * - "How Does Naming Affect LLMs?" (Wang et al. 2024): LLMs heavily rely on well-defined names
 * - Linguistic Antipatterns (Arnaoudova et al.): 17-pattern catalog, 69% devs perceive as harmful
 * - "Variable Naming Impact" (2024): descriptive names = 0.874 semantic similarity vs 0.802 obfuscated
 *
 * Four sub-checks:
 *   1. File name confusability (near-identical or synonym filenames)
 *   2. Generic function/variable names (process, handle, data, result, etc.)
 *   3. Export name collisions (same name exported from multiple files)
 *   4. Ambiguous abbreviations (auth, config, ctx, etc. outside conventional scope)
 */

import { getProductionFiles } from "../fs-utils.js";
import type { CheckResult, Issue } from "../types.js";
import { gradeFromScore } from "../types.js";

// ── Pattern dictionaries ──

const SYNONYM_PAIRS: [string, string][] = [
	["utils", "helpers"],
	["util", "helper"],
	["types", "interfaces"],
	["types", "models"],
	["interfaces", "models"],
	["constants", "config"],
	["constants", "settings"],
	["config", "settings"],
	["service", "controller"],
	["service", "handler"],
	["controller", "handler"],
	["store", "state"],
	["context", "provider"],
];

const GENERIC_NAMES = new Set([
	"process",
	"handle",
	"run",
	"execute",
	"do",
	"perform",
	"make",
	"get",
	"set",
	"update",
	"create",
	"delete",
	"remove",
	"add",
	"data",
	"result",
	"item",
	"value",
	"info",
	"temp",
	"obj",
	"stuff",
	"thing",
	"ret",
	"val",
	"res",
	"output",
	"input",
	"response",
	"request",
	"payload",
	"body",
	"args",
	"params",
	"list",
	"arr",
	"map",
	"dict",
	"collection",
	"callback",
	"cb",
	"fn",
	"func",
	"handler",
]);

const AMBIGUOUS_ABBREVS: Record<string, string> = {
	auth: "authentication OR authorization",
	config: "which configuration?",
	env: "environment (runtime? deployment? variables?)",
	db: "database (connection? schema? query builder?)",
	msg: "message (type? content? handler?)",
	ctx: "context (React? request? app?)",
	err: "error (type? instance? handler?)",
	mgr: "manager (of what?)",
	svc: "service (which service?)",
	srv: "server (HTTP? WebSocket? instance?)",
	req: "request (HTTP? specific type?)",
	res: "response or result?",
	cmd: "command (CLI? pattern? string?)",
	evt: "event (DOM? custom? type?)",
	ref: "reference (React ref? DB ref? pointer?)",
};

export function runConfusion(cwd: string): CheckResult {
	const start = Date.now();
	const issues: Issue[] = [];

	const sourceFiles = getProductionFiles(cwd);
	const files = sourceFiles.map((sf) => ({ path: sf.path, base: sf.base, content: sf.content, exports: extractExports(sf.content) }));

	if (files.length === 0) {
		return {
			name: "confusion",
			score: 100,
			grade: "A",
			details: { skipped: true, reason: "no source files" },
			issues: [],
			duration: Date.now() - start,
		};
	}

	let fileConfusability = 0;
	let genericNames = 0;
	let exportCollisions = 0;
	let ambiguousAbbrevs = 0;

	// ── 1. File name confusability ──
	for (let i = 0; i < files.length; i++) {
		for (let j = i + 1; j < files.length; j++) {
			const a = files[i].base;
			const b = files[j].base;

			// Near-identical (Levenshtein ≤ 2)
			if (a !== b && levenshtein(a, b) <= 2) {
				fileConfusability++;
				issues.push({
					severity: "warning",
					message: `Similar filenames: ${a} ↔ ${b} (edit distance ${levenshtein(a, b)})`,
					file: files[i].path,
					rule: "similar-filename",
				});
			}

			// Synonym pairs
			for (const [s1, s2] of SYNONYM_PAIRS) {
				if ((a.includes(s1) && b.includes(s2)) || (a.includes(s2) && b.includes(s1))) {
					fileConfusability++;
					issues.push({
						severity: "warning",
						message: `Synonym filenames: ${a} ↔ ${b} (${s1}/${s2} are interchangeable — pick one convention)`,
						file: files[i].path,
						rule: "synonym-filename",
					});
					break;
				}
			}
		}
	}

	// ── 2. Generic function/variable names ──
	for (const f of files) {
		const lines = f.content.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i].trim();
			if (line.startsWith("//") || line.startsWith("*")) continue;

			// Match exported function names
			const funcMatch = line.match(/^export\s+(?:async\s+)?function\s+(\w+)/);
			if (funcMatch && GENERIC_NAMES.has(funcMatch[1].toLowerCase())) {
				genericNames++;
				issues.push({
					severity: "warning",
					message: `Generic export name: ${funcMatch[1]}() — not descriptive enough for LLM comprehension`,
					file: f.path,
					line: i + 1,
					rule: "generic-name",
				});
			}

			// Match standalone variable assignments with generic names
			const varMatch = line.match(/^(?:export\s+)?(?:const|let)\s+(\w+)\s*=/);
			if (varMatch && GENERIC_NAMES.has(varMatch[1].toLowerCase()) && varMatch[1].length <= 6) {
				genericNames++;
				issues.push({
					severity: "warning",
					message: `Generic variable: ${varMatch[1]} — use a descriptive name`,
					file: f.path,
					line: i + 1,
					rule: "generic-name",
				});
			}
		}
	}

	// ── 3. Export name collisions ──
	const exportMap = new Map<string, string[]>();
	for (const f of files) {
		for (const exp of f.exports) {
			const arr = exportMap.get(exp) || [];
			arr.push(f.path);
			exportMap.set(exp, arr);
		}
	}
	for (const [name, paths] of exportMap) {
		if (paths.length > 1) {
			exportCollisions++;
			issues.push({
				severity: "error",
				message: `Export collision: "${name}" exported from ${paths.length} files — LLMs may reference the wrong one`,
				file: paths.join(", "),
				rule: "export-collision",
			});
		}
	}

	// ── 4. Ambiguous abbreviations in filenames and exports ──
	for (const f of files) {
		const nameParts = f.base.split(/[-_./]/).map((s) => s.toLowerCase());
		for (const part of nameParts) {
			if (AMBIGUOUS_ABBREVS[part]) {
				ambiguousAbbrevs++;
				issues.push({
					severity: "warning",
					message: `Ambiguous abbreviation "${part}" in filename — could mean: ${AMBIGUOUS_ABBREVS[part]}`,
					file: f.path,
					rule: "ambiguous-abbreviation",
				});
			}
		}
	}

	// ── Score ──
	const penalty = fileConfusability * 5 + genericNames * 1 + exportCollisions * 10 + ambiguousAbbrevs * 2;
	const score = Math.max(0, Math.min(100, 100 - penalty));

	return {
		name: "confusion",
		score,
		grade: gradeFromScore(score),
		details: { fileConfusability, genericNames, exportCollisions, ambiguousAbbrevs, filesScanned: files.length },
		issues,
		duration: Date.now() - start,
	};
}

// ── Helpers ──

function levenshtein(a: string, b: string): number {
	const m = a.length,
		n = b.length;
	const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
	for (let i = 0; i <= m; i++) dp[i][0] = i;
	for (let j = 0; j <= n; j++) dp[0][j] = j;
	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
		}
	}
	return dp[m][n];
}

function extractExports(content: string): string[] {
	const exports: string[] = [];
	const patterns = [
		/export\s+(?:async\s+)?function\s+(\w+)/g,
		/export\s+(?:const|let|var)\s+(\w+)/g,
		/export\s+class\s+(\w+)/g,
		/export\s+interface\s+(\w+)/g,
		/export\s+type\s+(\w+)/g,
	];
	for (const pat of patterns) {
		let match;
		while ((match = pat.exec(content)) !== null) {
			exports.push(match[1]);
		}
	}
	return exports;
}

