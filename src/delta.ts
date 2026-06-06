/** Delta report — structured diff between two scans.
 *
 * Used by `vcqa fix` to show before/after, and by the Actions page
 * to display "what changed since last scan."
 */

import type { Issue, VibeReport } from "./types.js";

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
	before: number;
	after: number;
	delta: number;
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
	const file = typeof iss.file === "string" ? iss.file.split(":")[0] : "";
	return `${check}|${iss.rule || ""}|${file}|${iss.message}`;
}

/** Compute a structured delta between two scan reports. */
export function computeDelta(before: VibeReport, after: VibeReport): ScanDelta {
	const beforeIssueCount = before.checks.reduce((s, c) => s + c.issues.length, 0);
	const afterIssueCount = after.checks.reduce((s, c) => s + c.issues.length, 0);

	const checks: CheckDelta[] = [];
	const allFixed: DeltaIssue[] = [];
	const allIntroduced: DeltaIssue[] = [];

	for (const afterCheck of after.checks) {
		const beforeCheck = before.checks.find((c) => c.name === afterCheck.name);
		const beforeScore = beforeCheck?.score ?? 0;

		// Build multiset of issue keys for before and after
		const beforeKeys = new Map<string, { count: number; issue: Issue }>();
		const afterKeys = new Map<string, { count: number; issue: Issue }>();

		if (beforeCheck) {
			for (const iss of beforeCheck.issues) {
				const key = issueKey(afterCheck.name, iss);
				const entry = beforeKeys.get(key);
				if (entry) entry.count++;
				else beforeKeys.set(key, { count: 1, issue: iss });
			}
		}
		for (const iss of afterCheck.issues) {
			const key = issueKey(afterCheck.name, iss);
			const entry = afterKeys.get(key);
			if (entry) entry.count++;
			else afterKeys.set(key, { count: 1, issue: iss });
		}

		const fixed: DeltaIssue[] = [];
		const introduced: DeltaIssue[] = [];

		// Fixed: in before but not in after (or count decreased)
		for (const [key, bEntry] of beforeKeys) {
			const aEntry = afterKeys.get(key);
			const aCount = aEntry?.count ?? 0;
			const diff = bEntry.count - aCount;
			for (let i = 0; i < diff; i++) {
				const di: DeltaIssue = {
					check: afterCheck.name,
					severity: bEntry.issue.severity,
					message: bEntry.issue.message,
					file: typeof bEntry.issue.file === "string" ? bEntry.issue.file : undefined,
					line: bEntry.issue.line,
					rule: bEntry.issue.rule,
				};
				fixed.push(di);
				allFixed.push(di);
			}
		}

		// Introduced: in after but not in before (or count increased)
		for (const [key, aEntry] of afterKeys) {
			const bEntry = beforeKeys.get(key);
			const bCount = bEntry?.count ?? 0;
			const diff = aEntry.count - bCount;
			for (let i = 0; i < diff; i++) {
				const di: DeltaIssue = {
					check: afterCheck.name,
					severity: aEntry.issue.severity,
					message: aEntry.issue.message,
					file: typeof aEntry.issue.file === "string" ? aEntry.issue.file : undefined,
					line: aEntry.issue.line,
					rule: aEntry.issue.rule,
				};
				introduced.push(di);
				allIntroduced.push(di);
			}
		}

		checks.push({
			name: afterCheck.name,
			label: afterCheck.name,
			before: beforeScore,
			after: afterCheck.score,
			delta: afterCheck.score - beforeScore,
			fixed,
			introduced,
		});
	}

	return {
		before: { score: before.score, grade: before.grade, timestamp: before.timestamp, issueCount: beforeIssueCount },
		after: { score: after.score, grade: after.grade, timestamp: after.timestamp, issueCount: afterIssueCount },
		scoreDelta: after.score - before.score,
		checks: checks.filter((c) => c.delta !== 0 || c.fixed.length > 0 || c.introduced.length > 0),
		fixed: allFixed,
		introduced: allIntroduced,
	};
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
	const changed = delta.checks.filter((c) => c.delta !== 0);
	if (changed.length > 0) {
		md += `## Check Changes\n\n`;
		md += `| Check | Before | After | Delta |\n|---|---|---|---|\n`;
		for (const c of changed.sort((a, b) => b.delta - a.delta)) {
			const a = c.delta > 0 ? "+" : "";
			md += `| ${c.name} | ${c.before} | ${c.after} | ${a}${c.delta} |\n`;
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
