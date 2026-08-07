/** SQLite / D1 check — audits data access and migration discipline.
 *  Gated centrally via appliesTo { component: ["sqlite-d1"] }. Advisory
 *  (weight 0) while the rules bed in. */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FileInventory } from "../file-inventory.js";
import { inventorySourceFiles } from "../file-inventory.js";
import { getProductionFiles } from "../fs-utils.js";
import type { CheckResult, Issue, WorkspaceInfo } from "../types.js";
import { gradeFromScore } from "../types.js";

/** A `.prepare(...)` / `.exec(...)` / `.run(...)` call whose SQL argument starts here. */
const QUERY_CALL = /\.(prepare|exec|run|batch)\s*\(/g;
/** SQL keywords that mark a string as actual SQL rather than prose. */
const SQL_SHAPE = /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE)\b/i;
/** Interpolation of a non-literal expression inside a template literal. */
const TEMPLATE_INTERP = /\$\{[^}]+\}/;
/** Loop headers — for N+1 detection. */
const LOOP_HEAD = /\b(for\s*\(|for\s+(?:const|let|var)\b|while\s*\(|\.(?:map|forEach|flatMap)\s*\()/;

/** Extract the argument text of a call starting just after its opening paren.
 *  Balanced-paren scan, quote/comment-aware, capped so a pathological file can't hang. */
function callArgument(src: string, openIdx: number): { text: string; closeIdx: number } {
	let depth = 1;
	let quote: string | null = null;
	const limit = Math.min(src.length, openIdx + 4000);
	for (let i = openIdx + 1; i < limit; i++) {
		const c = src[i];
		const prev = src[i - 1];
		if (quote) {
			if (c === quote && prev !== "\\") quote = null;
			continue;
		}
		if (c === "/" && src[i + 1] === "/") {
			i = skipLineComment(src, i);
			continue;
		}
		if (c === "/" && src[i + 1] === "*") {
			i = skipBlockComment(src, i);
			continue;
		}
		if (c === '"' || c === "'" || c === "`") {
			quote = c;
			continue;
		}
		if (c === "(") depth++;
		else if (c === ")") {
			depth--;
			if (depth === 0) return { text: src.slice(openIdx + 1, i), closeIdx: i };
		}
	}
	return { text: src.slice(openIdx + 1, limit), closeIdx: limit };
}

function skipLineComment(src: string, start: number): number {
	const end = src.indexOf("\n", start + 2);
	return end === -1 ? src.length - 1 : end;
}

function skipBlockComment(src: string, start: number): number {
	const end = src.indexOf("*/", start + 2);
	return end === -1 ? src.length - 1 : end + 1;
}

function skipTrivia(src: string, start: number): number {
	let i = start;
	while (i < src.length) {
		if (/\s/.test(src[i])) {
			i++;
			continue;
		}
		if (src[i] === "/" && src[i + 1] === "/") {
			i = skipLineComment(src, i) + 1;
			continue;
		}
		if (src[i] === "/" && src[i + 1] === "*") {
			i = skipBlockComment(src, i) + 1;
			continue;
		}
		return i;
	}
	return i;
}

function hasBindInMemberChain(src: string, start: number): boolean {
	let i = start;
	const limit = Math.min(src.length, start + 1200);
	while (i < limit) {
		i = skipTrivia(src, i);
		if (src[i] !== ".") return false;
		i++;
		const nameStart = i;
		while (/[A-Za-z0-9_$]/.test(src[i] ?? "")) i++;
		const name = src.slice(nameStart, i);
		i = skipTrivia(src, i);
		if (name === "bind" && src[i] === "(") return true;
		if (src[i] === "(") {
			i = callArgument(src, i).closeIdx + 1;
		}
	}
	return false;
}

/** True when the interpolations in a SQL template are all safe (identifiers the
 *  developer controls: constants, table-name maps). We only trust SCREAMING_CASE
 *  constants and string literals — anything else is caller-influenced. */
function interpolationsLookSafe(sql: string): boolean {
	const interps = sql.match(/\$\{([^}]*)\}/g) ?? [];
	return interps.every((i) => {
		const inner = i.slice(2, -1).trim();
		return /^[A-Z][A-Z0-9_]*$/.test(inner) || /^["'][^"']*["']$/.test(inner);
	});
}

/** Classify what an interpolation stands in for. The default is deliberately
 *  NOT "injection": most interpolation in real D1 code is a computed SQL
 *  fragment (an ownership/visibility clause, a column list). Only a genuine
 *  *value* position is unambiguous enough to call an error.
 *  - "value"      — `= ${x}`, `'${x}'`, `LIKE '%${x}%'`, `VALUES (${x})` → injection (error)
 *  - "identifier" — `FROM ${x}`, `UPDATE ${x}`, `SET ${x} =`             → allow-list risk (warning)
 *  - "fragment"   — a clause spliced in: `${scope.sql}`, `${whereClause}` → review (warning)
 *  - "safe"       — `IN (${placeholders})`, SCREAMING_CASE consts        → quiet
 *  Most severe wins across a template. */
function interpolationKind(sql: string): "value" | "identifier" | "fragment" | "safe" {
	let worst: "identifier" | "fragment" | "safe" = "safe";
	for (const m of sql.matchAll(/\$\{([^}]*)\}/g)) {
		const name = m[1].trim();
		const before = sql.slice(Math.max(0, m.index - 40), m.index);
		if (/^[A-Z][A-Z0-9_]*$/.test(name) || /^["'][^"']*["']$/.test(name)) continue;
		// The canonical dynamic-IN / dynamic-INSERT idiom: a generated `?, ?, ?` list.
		if (/placeholder|marks|\bqs\b|question/i.test(name)) continue;
		// Value positions — a bound parameter belongs here, nothing else.
		// "Inside a string literal" means an ODD number of unescaped quotes precede
		// it in the SQL. A trailing quote from a *closed* literal (ESCAPE '\\') is not
		// a value position — that was a false positive on well-bound production code.
		// SQL escapes a quote by doubling it (''), not with a backslash — so drop
		// doubled pairs, then count. This makes `ESCAPE '\'` read as open+close.
		const quotesBefore = (sql.slice(0, m.index).replace(/''/g, "").match(/'/g) ?? []).length;
		const insideLiteral = quotesBefore % 2 === 1;
		// SQLite JSON path segments such as `'$.${key}'` are not SQL values. They
		// still need validation/allow-listing, but they are closer to dynamic
		// identifiers than injectable WHERE values.
		if (insideLiteral && /\$\.[A-Za-z0-9_]*$/.test(before)) {
			if (worst === "safe") worst = "identifier";
			continue;
		}
		if (insideLiteral || /(?:=|<|>|<=|>=|<>|!=|\bLIKE\b|\bGLOB\b|\bLIMIT\b|\bOFFSET\b)\s*%?$/i.test(before)) {
			return "value";
		}
		if (/(?:FROM|JOIN|INTO|UPDATE|TABLE|SET|BY|COLUMN)\s+$/i.test(before)) {
			if (worst === "safe") worst = "identifier";
			continue;
		}
		// Anything else spliced into SQL text — a clause fragment.
		worst = "fragment";
	}
	return worst;
}

function isLiteralOnlyConcatenation(arg: string): boolean {
	const withoutComments = arg.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
	if (!/["']\s*\+|\+\s*["']/.test(withoutComments)) return false;
	const stripped = withoutComments
		.replace(/(["'])(?:\\.|(?!\1)[\s\S])*\1/g, "")
		.replace(/\+/g, "")
		.replace(/[(),;\s]/g, "");
	return stripped.length === 0;
}

function lineOf(src: string, idx: number): number {
	let line = 1;
	for (let i = 0; i < idx && i < src.length; i++) if (src[i] === "\n") line++;
	return line;
}

/** Migration files, sorted, from any migrations dir in the project. */
function migrationDirs(cwd: string, workspace?: WorkspaceInfo): { dir: string; files: string[] }[] {
	const roots = [cwd, ...(workspace?.packages.map((p) => join(cwd, p.path)) ?? [])];
	const out: { dir: string; files: string[] }[] = [];
	for (const root of roots) {
		for (const name of ["migrations", join("db", "migrations"), join("drizzle", "migrations")]) {
			const dir = join(root, name);
			if (!existsSync(dir)) continue;
			try {
				const files = readdirSync(dir)
					.filter((f) => f.endsWith(".sql"))
					.sort();
				if (files.length > 0) out.push({ dir, files });
			} catch {
				/* unreadable */
			}
		}
	}
	return out;
}

export function runSqliteD1(cwd: string, workspace?: WorkspaceInfo, inventory?: FileInventory): CheckResult {
	const start = Date.now();
	const issues: Issue[] = [];
	const files = (inventory ? inventorySourceFiles(inventory) : getProductionFiles(cwd)).filter((f) => /\.(ts|tsx|js|jsx|mjs)$/.test(f.ext));

	let queries = 0;
	let interpolated = 0;
	let missingBind = 0;
	let inLoop = 0;
	let selectStar = 0;

	for (const f of files) {
		const src = f.content;
		if (!SQL_SHAPE.test(src)) continue;
		const lines = src.split("\n");

		QUERY_CALL.lastIndex = 0;
		for (const m of src.matchAll(QUERY_CALL)) {
			const method = m[1];
			const openIdx = m.index + m[0].length - 1;
			const call = callArgument(src, openIdx);
			const arg = call.text;
			if (!SQL_SHAPE.test(arg)) continue;
			queries++;
			const line = lineOf(src, m.index);

			// ── Injection: template interpolation or string concatenation in SQL ──
			const isTemplate = /`/.test(arg);
			if (isTemplate && TEMPLATE_INTERP.test(arg) && !interpolationsLookSafe(arg)) {
				const kind = interpolationKind(arg);
				if (kind === "value") {
					interpolated++;
					issues.push({
						severity: "error",
						message: `SQL value built by interpolation in .${method}() — use ? placeholders with .bind() (SQL injection)`,
						file: f.path,
						line,
						rule: "sql-interpolation",
						snippet: arg.trim().slice(0, 120),
					});
				} else if (kind === "identifier") {
					issues.push({
						severity: "warning",
						message: `Table/column/JSON path interpolated into SQL in .${method}() — safe only if it comes from a hard-coded allow-list or validation, never directly from a request`,
						file: f.path,
						line,
						rule: "sql-dynamic-identifier",
						snippet: arg.trim().slice(0, 120),
					});
				} else if (kind === "fragment") {
					issues.push({
						severity: "warning",
						message: `SQL fragment spliced into .${method}() — fine if built from constants (a scope/visibility clause), a vulnerability if any part comes from a request`,
						file: f.path,
						line,
						rule: "sql-fragment",
						snippet: arg.trim().slice(0, 120),
					});
				}
			} else if (/["']\s*\+|\+\s*["']/.test(arg) && !isTemplate && !isLiteralOnlyConcatenation(arg)) {
				interpolated++;
				issues.push({
					severity: "error",
					message: `SQL built by string concatenation in .${method}() — use ? placeholders with .bind() (SQL injection)`,
					file: f.path,
					line,
					rule: "sql-concatenation",
					snippet: arg.trim().slice(0, 120),
				});
			}

			// ── Placeholders declared but never bound ──
			if (method === "prepare" && /\?/.test(arg)) {
				// Scan forward from the END of the prepare(...) call — a line window
				// misses `.bind()` after a long multi-line SQL template.
				const callEnd = call.closeIdx + 1;
				const after = src
					.slice(callEnd, callEnd + 1200)
					.replace(/\/\*[\s\S]*?\*\//g, "")
					.replace(/^\s*\/\/.*$/gm, "");
				let bound = hasBindInMemberChain(src, callEnd) || /^\s*\.\s*bind\s*\(/.test(after) || /\.bind\s*\(/.test(after.split(";")[0] ?? "");
				// Statement-reuse idiom: `const insert = db.prepare(...)` bound later
				// (often inside a batch). Look for `<var>.bind(` anywhere in the file.
				if (!bound) {
					const decl = src
						.slice(Math.max(0, m.index - 120), m.index)
						.match(/(?:const|let|var)\s+(\w+)\s*=\s*$|(?:const|let|var)\s+(\w+)\s*=\s*[\w.]*$/);
					const varName = decl?.[1] ?? decl?.[2];
					if (varName && new RegExp(`\\b${varName}\\s*\\.\\s*bind\\s*\\(`).test(src)) bound = true;
				}
				if (!bound) {
					missingBind++;
					issues.push({
						severity: "error",
						message: "prepare() declares ? placeholders but no .bind() follows — throws at runtime",
						file: f.path,
						line,
						rule: "missing-bind",
					});
				}
			}

			// ── N+1: a query issued inside a loop body ──
			// `.map(x => db.prepare(...))` feeding `db.batch([...])` is the CORRECT
			// batching idiom, not N+1 — recognise it and stay quiet.
			const before = lines.slice(Math.max(0, line - 6), line - 1).join("\n");
			const buildingBatch = /\.batch\s*\(/.test(lines.slice(Math.max(0, line - 8), line + 2).join("\n"));
			if (LOOP_HEAD.test(before) && !buildingBatch && method !== "batch") {
				inLoop++;
				issues.push({
					severity: "warning",
					message: `.${method}() inside a loop — N+1 queries; use one IN (...) query or db.batch()`,
					file: f.path,
					line,
					rule: "query-in-loop",
				});
			}

			// ── SELECT * (over-fetch; breaks silently when columns change) ──
			if (/\bSELECT\s+\*/i.test(arg)) {
				selectStar++;
				issues.push({
					severity: "info",
					message: "SELECT * — name the columns so schema changes cannot silently change results",
					file: f.path,
					line,
					rule: "select-star",
				});
			}
		}
	}

	// ── Migration discipline ──
	const dirs = migrationDirs(cwd, workspace);
	let migrationCount = 0;
	for (const { dir, files: migFiles } of dirs) {
		migrationCount += migFiles.length;
		const rel = dir.slice(cwd.length + 1) || dir;
		const numbers: number[] = [];
		for (const f of migFiles) {
			const n = f.match(/^(\d+)/);
			if (n) numbers.push(Number.parseInt(n[1], 10));
		}
		if (numbers.length !== migFiles.length && numbers.length > 0) {
			issues.push({
				severity: "warning",
				message: `Some migrations in ${rel} are not numbered — ordering depends on filename sort, which is fragile`,
				file: rel,
				rule: "migration-unnumbered",
			});
		}
		const dupes = numbers.filter((n, i) => numbers.indexOf(n) !== i);
		if (dupes.length > 0) {
			issues.push({
				severity: "error",
				message: `Duplicate migration number(s) ${[...new Set(dupes)].join(", ")} in ${rel} — apply order is ambiguous`,
				file: rel,
				rule: "migration-duplicate",
			});
		}
		// Destructive statements outside the newest migration are a smell, not an error.
		for (const f of migFiles) {
			try {
				const sql = readFileSync(join(dir, f), "utf-8");
				if (/\bDROP\s+TABLE\b/i.test(sql) && !/IF\s+EXISTS/i.test(sql)) {
					issues.push({
						severity: "warning",
						message: `DROP TABLE without IF EXISTS in ${f} — a partially-applied migration set cannot be re-run`,
						file: join(rel, f),
						rule: "migration-unsafe-drop",
					});
				}
			} catch {
				/* unreadable */
			}
		}
	}

	const errors = issues.filter((i) => i.severity === "error").length;
	const warnings = issues.filter((i) => i.severity === "warning").length;
	// Proportional to query volume — a 400-query codebase with a handful of
	// review items is not the same as a 5-query one with the same count.
	const denom = Math.max(queries, migrationCount, 1);
	const errorPenalty = Math.min(60, (errors / denom) * 500);
	const warnPenalty = Math.min(25, (warnings / denom) * 100);
	const score = Math.max(0, Math.min(100, Math.round(100 - errorPenalty - warnPenalty)));

	return {
		name: "sqlite-d1",
		score,
		grade: gradeFromScore(score),
		details: {
			queries,
			interpolated,
			missingBind,
			queriesInLoops: inLoop,
			selectStar,
			migrations: migrationCount,
			tool: "built-in",
			source: inventory ? "file-inventory" : "legacy-walk",
		},
		issues,
		duration: Date.now() - start,
	};
}
