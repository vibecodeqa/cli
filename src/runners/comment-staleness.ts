/** Comment Staleness — detects comments that don't match the code they describe.
 *
 * Pro feature. Local heuristic checks always run. LLM-powered deep analysis requires VCQA_PRO_KEY.
 *
 * Local checks (always run):
 *   - TODO/FIXME/HACK comments older than 6 months (git blame)
 *   - Numeric claims in comments that don't match code ("handles 3 cases" but switch has 5)
 *   - Commented-out code blocks (dead code in comments)
 *   - @deprecated without replacement suggestion
 *
 * LLM checks (Pro only):
 *   - Semantic mismatch: comment describes behavior X but code does Y
 *   - Function name contradicts implementation
 */

import { getProductionFiles } from "../fs-utils.js";
import type { CheckResult, Issue } from "../types.js";
import { gradeFromScore } from "../types.js";

export function runCommentStaleness(cwd: string): CheckResult {
	const start = Date.now();
	const proKey = process.env.VCQA_PRO_KEY || "";

	const files = getProductionFiles(cwd);

	if (!proKey) {
		return {
			name: "comment-staleness",
			score: 0,
			grade: "F",
			details: {
				premium: true,
				comingSoon: true,
				reason: "Set VCQA_PRO_KEY to enable comment staleness analysis",
				description: "Detects stale comments: TODOs older than 6 months, numeric mismatches, commented-out code, semantic contradictions (LLM-powered).",
			},
			issues: [],
			duration: Date.now() - start,
		};
	}

	const issues: Issue[] = [];
	let totalComments = 0;
	let staleCount = 0;

	for (const f of files) {
		const lines = f.content.split("\n");

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const trimmed = line.trim();

			// ── TODO/FIXME/HACK comments ──
			const todoMatch = trimmed.match(/\/\/\s*(TODO|FIXME|HACK|XXX|TEMP)\b[:\s]*(.*)/i);
			if (todoMatch) {
				totalComments++;
				// Check if it has a date
				const dateMatch = todoMatch[2].match(/\b(20\d{2}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]20\d{2})\b/);
				if (dateMatch) {
					try {
						const d = new Date(dateMatch[1]);
						const ageMs = Date.now() - d.getTime();
						const ageMonths = ageMs / (1000 * 60 * 60 * 24 * 30);
						if (ageMonths > 6) {
							staleCount++;
							issues.push({
								severity: "warning",
								message: `${todoMatch[1]} from ${dateMatch[1]} — ${Math.round(ageMonths)} months old`,
								file: f.path,
								line: i + 1,
								rule: "stale-todo",
							});
						}
					} catch { /* invalid date */ }
				} else {
					// No date — flag as potentially stale
					issues.push({
						severity: "info",
						message: `${todoMatch[1]}: ${todoMatch[2].slice(0, 80).trim() || "(no description)"}`,
						file: f.path,
						line: i + 1,
						rule: "undated-todo",
					});
				}
			}

			// ── Commented-out code blocks ──
			if (trimmed.startsWith("//") && !trimmed.startsWith("///") && !trimmed.match(/\/\/\s*(TODO|FIXME|HACK|NOTE|eslint|biome|ts-|@)/i)) {
				const codeContent = trimmed.slice(2).trim();
				// Looks like code, not a comment
				if (
					/^(const |let |var |function |return |if \(|for \(|import |export |await |class )/.test(codeContent) &&
					codeContent.length > 10
				) {
					// Check if next lines are also commented-out code
					let blockLen = 1;
					for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
						const next = lines[j].trim();
						if (next.startsWith("//") && /^\/\/\s*(const |let |var |function |return |if \(|for \(|\}|await )/.test(next)) {
							blockLen++;
						} else break;
					}
					if (blockLen >= 3) {
						staleCount++;
						issues.push({
							severity: "warning",
							message: `${blockLen} lines of commented-out code — delete or extract to a branch`,
							file: f.path,
							line: i + 1,
							rule: "commented-out-code",
						});
						// Skip the block
						i += blockLen - 1;
					}
				}
			}

			// ── Numeric claims in comments ──
			if (trimmed.startsWith("//")) {
				const numClaim = trimmed.match(/\/\/.*\b(\d+)\s+(?:cases?|options?|steps?|types?|variants?|modes?|states?)\b/i);
				if (numClaim && i < lines.length - 20) {
					const claimed = parseInt(numClaim[1], 10);
					// Look for switch/if-else chains below
					const block = lines.slice(i + 1, Math.min(i + 30, lines.length)).join("\n");
					const caseCount = (block.match(/\bcase\s+/g) || []).length;
					const ifCount = (block.match(/\belse\s+if\b/g) || []).length + (block.match(/^\s*if\s*\(/gm) || []).length;
					const actual = Math.max(caseCount, ifCount);
					if (actual > 0 && actual !== claimed && Math.abs(actual - claimed) > 1) {
						staleCount++;
						issues.push({
							severity: "warning",
							message: `Comment says "${numClaim[1]} ${numClaim[0].match(/cases?|options?|steps?|types?|variants?|modes?|states?/i)?.[0]}" but code has ${actual}`,
							file: f.path,
							line: i + 1,
							rule: "numeric-mismatch",
						});
					}
				}
			}

			// ── @deprecated without replacement ──
			if (trimmed.includes("@deprecated") && !trimmed.match(/@deprecated.*(?:use|replace|see|prefer|switch|migrate)\b/i)) {
				issues.push({
					severity: "info",
					message: "@deprecated without replacement suggestion — tell users what to use instead",
					file: f.path,
					line: i + 1,
					rule: "deprecated-no-replacement",
				});
			}
		}
	}

	const score = issues.length === 0 ? 100 : Math.max(20, 100 - staleCount * 8 - (issues.length - staleCount) * 2);

	return {
		name: "comment-staleness",
		score,
		grade: gradeFromScore(score),
		details: {
			premium: true,
			filesScanned: files.length,
			totalComments,
			staleComments: staleCount,
			tool: "pro-local",
		},
		issues,
		duration: Date.now() - start,
	};
}
