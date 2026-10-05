/** Delta report — structured diff between two scans.
 *
 * Used by `vcqa fix` to show before/after, and by the Actions page
 * to display "what changed since last scan."
 */

import { readIssueFingerprint } from "./issue-fingerprint.js";
import type { CheckResult, Issue, VibeReport } from "./types.js";

/**
 * Whether a check produced a real score. A check that did not run carries a
 * placeholder `score: 100` (core.ts), which must never be subtracted from a
 * real score: "lint: 100 → 72" would read as a regression, and the reverse
 * (a tool uninstalled) as an improvement (#107).
 *
 * `runner-error`: the check ran and its runner crashed. It counts as having
 * run, with status `failed`, but its `score: 0` / grade F is a placeholder
 * too, so it is compared as a state, never as a number.
 */
export type CheckRunState = "ran" | "runner-error" | "skipped" | "unavailable" | "absent";

/** One side of a check comparison. `score` is set only when the check ran. */
export interface CheckSide {
	state: CheckRunState;
	score?: number;
}

/** A check whose run state changed between two scans, e.g. lint: unavailable → 72. */
export interface StatusTransition {
	before: CheckSide;
	after: CheckSide;
}

/**
 * Run state of a check. Reads `status` (the CLI writes it; it survives schema
 * 0.5.0 via `.passthrough()`), else `details.status` (what history snapshots
 * keep). Reports without either fall back to the details flags, in the order
 * core.ts uses (`unavailable`/`comingSoon` before `skipped`).
 *
 * A "runner error:" reason is a crashed runner (core.ts reports it as
 * `failed`); an explicit `skipped`/`unavailable` status still wins over it.
 * `status` is an open vocabulary (schema 0.6.0): any other value counts as ran.
 */
export function checkRunState(check: CheckResult | undefined): CheckRunState {
	if (!check) return "absent";
	const details = (check.details ?? {}) as Record<string, unknown>;
	const topStatus: unknown = (check as { status?: unknown }).status;
	const status: unknown = typeof topStatus === "string" && topStatus ? topStatus : details.status;
	if (status === "skipped") return "skipped";
	if (status === "unavailable") return "unavailable";
	const reason = typeof details.reason === "string" ? details.reason : "";
	if (reason.startsWith("runner error:")) return "runner-error";
	if (typeof status === "string" && status) return "ran";
	if (details.unavailable || details.comingSoon) return "unavailable";
	if (details.skipped) return "skipped";
	return "ran";
}

export function checkSide(check: CheckResult | undefined): CheckSide {
	const state = checkRunState(check);
	return state === "ran" && check ? { state, score: check.score } : { state };
}

/**
 * Compare two sides of one check: a numeric delta when both ran, otherwise a
 * status transition (or nothing, when the not-run state is unchanged).
 */
export function compareCheckSides(before: CheckSide, after: CheckSide): { delta: number; transition?: StatusTransition } {
	if (before.state === "ran" && after.state === "ran") return { delta: (after.score ?? 0) - (before.score ?? 0) };
	if (before.state === after.state) return { delta: 0 };
	return { delta: 0, transition: { before, after } };
}

/** "72", "failed (runner error)", "unavailable", "skipped" or "not present". */
export function formatCheckSide(side: CheckSide): string {
	if (side.state === "ran") return String(side.score);
	if (side.state === "runner-error") return "failed (runner error)";
	return side.state === "absent" ? "not present" : side.state;
}

export interface DeltaIssue {
	check: string;
	severity: Issue["severity"];
	message: string;
	file?: string;
	line?: number;
	rule?: string;
}

export interface CheckDelta {
	name: string;
	label: string;
	/** Score before; null when the check did not run, its runner crashed, or it was absent (see `transition`). */
	before: number | null;
	/** Score after; null when the check did not run, its runner crashed, or it was absent (see `transition`). */
	after: number | null;
	/** Score change; 0 whenever either side did not run or crashed (see `transition`). */
	delta: number;
	/** Set instead of a numeric delta when the check's run state changed. */
	transition?: StatusTransition;
	fixed: DeltaIssue[];
	introduced: DeltaIssue[];
}

export interface ScanDelta {
	before: { score: number; grade: string; timestamp: string; issueCount: number };
	after: { score: number; grade: string; timestamp: string; issueCount: number };
	scoreDelta: number;
	checks: CheckDelta[];
	fixed: DeltaIssue[];
	introduced: DeltaIssue[];
}

/** Fingerprint an issue for stable matching (ignores line numbers which shift after edits). */
function issueKey(check: string, iss: Issue): string {
	return readIssueFingerprint(check, iss);
}

type IssueMultiset = Map<string, { count: number; issue: Issue }>;

function issueMultiset(name: string, check: CheckResult | undefined): IssueMultiset {
	const out: IssueMultiset = new Map();
	for (const iss of check?.issues ?? []) {
		const key = issueKey(name, iss);
		const entry = out.get(key);
		if (entry) entry.count++;
		else out.set(key, { count: 1, issue: iss });
	}
	return out;
}

/** Issues in `from` beyond their count in `minus`, as DeltaIssues. */
function multisetDifference(name: string, from: IssueMultiset, minus: IssueMultiset): DeltaIssue[] {
	const out: DeltaIssue[] = [];
	for (const [key, entry] of from) {
		const diff = entry.count - (minus.get(key)?.count ?? 0);
		for (let i = 0; i < diff; i++) {
			out.push({
				check: name,
				severity: entry.issue.severity,
				message: entry.issue.message,
				file: typeof entry.issue.file === "string" ? entry.issue.file : undefined,
				line: entry.issue.line,
				rule: entry.issue.rule,
			});
		}
	}
	return out;
}

/** Compute a structured delta between two scan reports. */
export function computeDelta(before: VibeReport, after: VibeReport): ScanDelta {
	const beforeIssueCount = before.checks.reduce((s, c) => s + c.issues.length, 0);
	const afterIssueCount = after.checks.reduce((s, c) => s + c.issues.length, 0);

	const checks: CheckDelta[] = [];
	const allFixed: DeltaIssue[] = [];
	const allIntroduced: DeltaIssue[] = [];

	// Union of check names: a check present only in `before` (tool removed,
	// check dropped or renamed) still gets a "72 → not present" transition and
	// its issues count as fixed.
	const names = [...after.checks.map((c) => c.name)];
	for (const c of before.checks) if (!names.includes(c.name)) names.push(c.name);

	for (const name of names) {
		const beforeCheck = before.checks.find((c) => c.name === name);
		const afterCheck = after.checks.find((c) => c.name === name);
		const beforeSide = checkSide(beforeCheck);
		const afterSide = checkSide(afterCheck);
		const { delta: scoreChange, transition } = compareCheckSides(beforeSide, afterSide);

		// Build multiset of issue keys for before and after
		const beforeKeys = issueMultiset(name, beforeCheck);
		const afterKeys = issueMultiset(name, afterCheck);

		// Fixed: in before but not in after (or count decreased)
		const fixed = multisetDifference(name, beforeKeys, afterKeys);
		// Introduced: in after but not in before (or count increased)
		const introduced = multisetDifference(name, afterKeys, beforeKeys);
		allFixed.push(...fixed);
		allIntroduced.push(...introduced);

		checks.push({
			name,
			label: name,
			before: beforeSide.score ?? null,
			after: afterSide.score ?? null,
			delta: scoreChange,
			...(transition ? { transition } : {}),
			fixed,
			introduced,
		});
	}

	return {
		before: { score: before.score, grade: before.grade, timestamp: before.timestamp, issueCount: beforeIssueCount },
		after: { score: after.score, grade: after.grade, timestamp: after.timestamp, issueCount: afterIssueCount },
		scoreDelta: after.score - before.score,
		checks: checks.filter((c) => c.delta !== 0 || c.transition || c.fixed.length > 0 || c.introduced.length > 0),
		fixed: allFixed,
		introduced: allIntroduced,
	};
}

/** Checks whose score changed, both sides having run; biggest gain first. */
export function scoreChanges(delta: ScanDelta): CheckDelta[] {
	return delta.checks.filter((c) => c.delta !== 0).sort((a, b) => b.delta - a.delta);
}

/** Checks whose run state changed (ran ↔ runner-error/skipped/unavailable/absent). */
export function statusTransitions(delta: ScanDelta): (CheckDelta & { transition: StatusTransition })[] {
	return delta.checks.filter((c): c is CheckDelta & { transition: StatusTransition } => c.transition !== undefined);
}

export function formatTransition(t: StatusTransition): string {
	return `${formatCheckSide(t.before)} → ${formatCheckSide(t.after)}`;
}

/**
 * Markdown bullet list of per-check changes, as the PR comment and the CLI
 * summary print it: score changes, then status transitions separately.
 */
export function formatCheckChangeBullets(delta: ScanDelta, limit: number): string {
	let md = "";
	const changed = scoreChanges(delta);
	if (changed.length > 0) {
		for (const c of changed.slice(0, limit)) {
			const a = c.delta > 0 ? "+" : "";
			md += `- ${c.delta > 0 ? "✅" : "⚠️"} ${c.name}: ${c.before} → ${c.after} (${a}${c.delta})\n`;
		}
		md += "\n";
	}
	const transitions = statusTransitions(delta);
	if (transitions.length > 0) {
		md += "**Status changes** (not scored):\n";
		for (const c of transitions.slice(0, limit)) md += `- ${c.name}: ${formatTransition(c.transition)}\n`;
		md += "\n";
	}
	return md;
}

/** Format a delta as a markdown report. */
export function formatDeltaMarkdown(delta: ScanDelta): string {
	const arrow = delta.scoreDelta > 0 ? "+" : "";
	const emoji = delta.scoreDelta > 0 ? "improvement" : delta.scoreDelta < 0 ? "regression" : "no change";

	let md = `# VibeCode QA — Delta Report\n\n`;
	md += `| | Before | After | Delta |\n|---|---|---|---|\n`;
	md += `| **Score** | ${delta.before.grade} ${delta.before.score} | ${delta.after.grade} ${delta.after.score} | ${arrow}${delta.scoreDelta} (${emoji}) |\n`;
	md += `| **Issues** | ${delta.before.issueCount} | ${delta.after.issueCount} | ${delta.fixed.length} fixed, ${delta.introduced.length} new |\n\n`;

	// Per-check changes
	const changed = scoreChanges(delta);
	if (changed.length > 0) {
		md += `## Check Changes\n\n`;
		md += `| Check | Before | After | Delta |\n|---|---|---|---|\n`;
		for (const c of changed) {
			const a = c.delta > 0 ? "+" : "";
			md += `| ${c.name} | ${c.before} | ${c.after} | ${a}${c.delta} |\n`;
		}
		md += "\n";
	}

	// Checks that started or stopped running: a placeholder score is not a score.
	const transitions = statusTransitions(delta);
	if (transitions.length > 0) {
		md += `## Status Changes\n\n`;
		md += `| Check | Before | After |\n|---|---|---|\n`;
		for (const c of transitions) {
			md += `| ${c.name} | ${formatCheckSide(c.transition.before)} | ${formatCheckSide(c.transition.after)} |\n`;
		}
		md += "\n";
	}

	// Fixed issues
	if (delta.fixed.length > 0) {
		md += `## Fixed (${delta.fixed.length})\n\n`;
		// Group by check
		const byCheck = new Map<string, DeltaIssue[]>();
		for (const f of delta.fixed) {
			const arr = byCheck.get(f.check) || [];
			arr.push(f);
			byCheck.set(f.check, arr);
		}
		for (const [check, issues] of byCheck) {
			md += `### ${check} (${issues.length} fixed)\n`;
			for (const iss of issues.slice(0, 10)) {
				md += `- ${iss.file ? `\`${iss.file}\`` : ""} ${iss.message}\n`;
			}
			if (issues.length > 10) md += `- ...and ${issues.length - 10} more\n`;
			md += "\n";
		}
	}

	// New issues
	if (delta.introduced.length > 0) {
		md += `## New Issues (${delta.introduced.length})\n\n`;
		const byCheck = new Map<string, DeltaIssue[]>();
		for (const f of delta.introduced) {
			const arr = byCheck.get(f.check) || [];
			arr.push(f);
			byCheck.set(f.check, arr);
		}
		for (const [check, issues] of byCheck) {
			md += `### ${check} (${issues.length} new)\n`;
			for (const iss of issues.slice(0, 10)) {
				md += `- ${iss.file ? `\`${iss.file}\`` : ""} ${iss.message}\n`;
			}
			if (issues.length > 10) md += `- ...and ${issues.length - 10} more\n`;
			md += "\n";
		}
	}

	return md;
}
