/** Post scan results as a GitHub PR comment. Upserts to avoid duplicates. */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { TrendDelta } from "./trend.js";
import type { VibeReport } from "./types.js";

const MARKER = "<!-- vcqa-report -->";

interface PRInfo {
	owner: string;
	repo: string;
	prNumber: number;
}

export async function postPRComment(report: VibeReport, trend: TrendDelta | null, cwd: string): Promise<boolean> {
	const pr = detectPR(cwd);
	if (!pr) return false;

	const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
	if (!token) return false;

	const body = buildCommentBody(report, trend);

	// Try to find existing vcqa comment to update
	const existingId = await findExistingComment(pr, token);
	if (existingId) {
		await updateComment(pr, existingId, body, token);
	} else {
		await createComment(pr, body, token);
	}
	return true;
}

function detectPR(cwd: string): PRInfo | null {
	// 1. GitHub Actions: GITHUB_EVENT_PATH contains PR info
	const eventPath = process.env.GITHUB_EVENT_PATH;
	if (eventPath && existsSync(eventPath)) {
		try {
			const event = JSON.parse(readFileSync(eventPath, "utf-8"));
			const pr = event.pull_request || event.issue;
			if (pr?.number && process.env.GITHUB_REPOSITORY) {
				const [owner, repo] = process.env.GITHUB_REPOSITORY.split("/");
				return { owner, repo, prNumber: pr.number };
			}
		} catch {
			/* not a PR event */
		}
	}

	// 2. Try gh CLI to detect current PR
	try {
		const out = execSync("gh pr view --json number,headRepository -q '.number'", {
			cwd,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
			timeout: 10_000,
		}).trim();
		const prNumber = parseInt(out, 10);
		if (prNumber > 0) {
			const remote = execSync("git remote get-url origin", { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
			const match = remote.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
			if (match) {
				return { owner: match[1], repo: match[2], prNumber };
			}
		}
	} catch {
		/* gh not available or no PR */
	}

	return null;
}

function buildCommentBody(report: VibeReport, trend: TrendDelta | null): string {
	const grade = report.grade;
	const score = report.score;
	const gradeEmoji = grade === "A" ? "🟢" : grade === "B" ? "🟡" : grade === "C" ? "🟠" : "🔴";

	let body = `${MARKER}\n## ${gradeEmoji} VibeCode QA: **${grade}** ${score}/100\n\n`;

	if (trend) {
		const arrow = trend.scoreDelta > 0 ? "📈" : trend.scoreDelta < 0 ? "📉" : "➡️";
		body += `${arrow} **${trend.scoreDelta > 0 ? "+" : ""}${trend.scoreDelta}** vs previous`;
		if (trend.fixedIssues > 0) body += ` · ${trend.fixedIssues} fixed`;
		if (trend.newIssues > 0) body += ` · ${trend.newIssues} new`;
		body += "\n\n";
	}

	// Category scores table
	body += "| Category | Score | Checks |\n|----------|-------|--------|\n";
	const categories = new Map<string, { scores: number[]; names: string[] }>();
	for (const c of report.checks) {
		const det = c.details as Record<string, unknown>;
		if (det.skipped || det.comingSoon) continue;
		const cat = getCategoryForCheck(c.name);
		if (!categories.has(cat)) categories.set(cat, { scores: [], names: [] });
		const entry = categories.get(cat)!;
		entry.scores.push(c.score);
		entry.names.push(`${c.name} ${c.score}`);
	}
	for (const [cat, { scores, names }] of categories) {
		const avg = Math.round(scores.reduce((s, v) => s + v, 0) / scores.length);
		const bar = avg >= 90 ? "🟢" : avg >= 75 ? "🟡" : avg >= 60 ? "🟠" : "🔴";
		body += `| ${bar} ${cat} | ${avg}/100 | ${names.join(", ")} |\n`;
	}

	// Top issues
	const allIssues = report.checks.flatMap((c) => c.issues.filter((i) => i.severity === "error" || i.severity === "warning"));
	if (allIssues.length > 0) {
		body += `\n<details><summary>${allIssues.length} issues found</summary>\n\n`;
		for (const i of allIssues.slice(0, 10)) {
			const loc = i.file ? ` \`${i.file}${i.line ? `:${i.line}` : ""}\`` : "";
			body += `- ${i.severity === "error" ? "❌" : "⚠️"} ${i.message}${loc}\n`;
		}
		if (allIssues.length > 10) body += `\n...and ${allIssues.length - 10} more\n`;
		body += "\n</details>\n";
	}

	body += `\n<sub>vcqa v${report.version} · ${report.meta.duration}ms · [vibecodeqa.online](https://vibecodeqa.online)</sub>`;
	return body;
}

function getCategoryForCheck(name: string): string {
	const map: Record<string, string> = {
		structure: "Foundations",
		lint: "Foundations",
		types: "Foundations",
		"type-safety": "Foundations",
		standards: "Foundations",
		complexity: "Quality",
		duplication: "Quality",
		"error-handling": "Quality",
		react: "Quality",
		accessibility: "Quality",
		docs: "Quality",
		"best-practices": "Quality",
		testing: "Testing",
		secrets: "Security",
		security: "Security",
		dependencies: "Security",
		architecture: "Architecture",
		performance: "Architecture",
		confusion: "AI Readiness",
		context: "AI Readiness",
	};
	return map[name] || "Other";
}

async function findExistingComment(pr: PRInfo, token: string): Promise<number | null> {
	try {
		const res = await fetch(`https://api.github.com/repos/${pr.owner}/${pr.repo}/issues/${pr.prNumber}/comments?per_page=100`, {
			headers: { Authorization: `token ${token}`, Accept: "application/vnd.github.v3+json" },
		});
		if (!res.ok) return null;
		const comments = (await res.json()) as { id: number; body: string }[];
		const existing = comments.find((c) => c.body.includes(MARKER));
		return existing?.id ?? null;
	} catch {
		return null;
	}
}

async function createComment(pr: PRInfo, body: string, token: string): Promise<void> {
	await fetch(`https://api.github.com/repos/${pr.owner}/${pr.repo}/issues/${pr.prNumber}/comments`, {
		method: "POST",
		headers: { Authorization: `token ${token}`, Accept: "application/vnd.github.v3+json", "Content-Type": "application/json" },
		body: JSON.stringify({ body }),
	});
}

async function updateComment(pr: PRInfo, commentId: number, body: string, token: string): Promise<void> {
	await fetch(`https://api.github.com/repos/${pr.owner}/${pr.repo}/issues/comments/${commentId}`, {
		method: "PATCH",
		headers: { Authorization: `token ${token}`, Accept: "application/vnd.github.v3+json", "Content-Type": "application/json" },
		body: JSON.stringify({ body }),
	});
}
