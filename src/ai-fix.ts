/** AI-powered code fixing — uses Claude to fix issues found by vcqa scan.
 *
 * Auth: ANTHROPIC_API_KEY (direct) or VCQA_PRO_KEY (via api.vibecodeqa.online).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getCheckMeta } from "./check-meta.js";
import type { CheckResult } from "./types.js";

export interface FixableIssue {
	check: string;
	file: string;
	line: number;
	rule: string;
	message: string;
	suggestion: string | null;
}

export interface AiFixResult {
	file: string;
	line: number;
	check: string;
	message: string;
	explanation: string;
	applied: boolean;
}

interface LLMFixResponse {
	search: string;
	replace: string;
	explanation: string;
}

/** Collect fixable issues from scan results, optionally filtered by check name. */
export function collectFixableIssues(
	checks: CheckResult[],
	suggestFix: (check: string, rule: string, message: string) => string | null,
	checkFilter?: string,
): FixableIssue[] {
	const issues: FixableIssue[] = [];
	for (const c of checks) {
		if (checkFilter && c.name !== checkFilter) continue;
		for (const iss of c.issues) {
			if (!iss.file || typeof iss.file !== "string" || !iss.line) continue;
			if (iss.severity === "info") continue;
			issues.push({
				check: c.name,
				file: iss.file,
				line: iss.line,
				rule: iss.rule || "",
				message: iss.message,
				suggestion: suggestFix(c.name, iss.rule || "", iss.message),
			});
		}
	}
	return issues;
}

/** Fix issues using AI. Returns results for each attempted fix. */
export async function aiFixIssues(
	cwd: string,
	issues: FixableIssue[],
	opts: { dryRun: boolean },
): Promise<AiFixResult[]> {
	const apiKey = process.env.ANTHROPIC_API_KEY || "";
	const proKey = process.env.VCQA_PRO_KEY || "";

	if (!apiKey && !proKey) {
		console.log("  \x1b[31mNo API key found.\x1b[0m Set ANTHROPIC_API_KEY or VCQA_PRO_KEY.");
		console.log("  \x1b[2mANTHROPIC_API_KEY — direct Claude API (recommended)\x1b[0m");
		console.log("  \x1b[2mVCQA_PRO_KEY     — via api.vibecodeqa.online\x1b[0m");
		return [];
	}

	const results: AiFixResult[] = [];
	// Process files in order, one issue at a time to avoid drift
	const sorted = [...issues].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

	// Limit to 10 fixes per run to avoid burning tokens
	const batch = sorted.slice(0, 10);
	if (sorted.length > 10) {
		console.log(`  \x1b[2mFixing 10 of ${sorted.length} issues (run again for more)\x1b[0m`);
	}

	for (const issue of batch) {
		const absPath = join(cwd, issue.file);
		let content: string;
		try {
			content = readFileSync(absPath, "utf-8");
		} catch {
			results.push({ ...issue, explanation: "file not readable", applied: false });
			continue;
		}

		const lines = content.split("\n");
		const meta = getCheckMeta(issue.check);

		// Extract context: ±20 lines around the issue
		const start = Math.max(0, issue.line - 21);
		const end = Math.min(lines.length, issue.line + 20);
		const contextLines = lines.slice(start, end);
		const numbered = contextLines.map((l, i) => `${start + i + 1}| ${l}`).join("\n");

		const prompt = buildFixPrompt(issue, meta, numbered, issue.file);
		process.stdout.write(`  ${issue.file}:${issue.line} \x1b[2m${issue.message.slice(0, 50)}\x1b[0m `);

		const fix = apiKey
			? await callAnthropicDirect(prompt, apiKey)
			: await callVcqaProxy(prompt, proKey);

		if (!fix) {
			console.log("\x1b[33mskip\x1b[0m");
			results.push({ ...issue, explanation: "AI could not generate fix", applied: false });
			continue;
		}

		if (opts.dryRun) {
			console.log("\x1b[36mdry-run\x1b[0m");
			console.log(`    \x1b[2m${fix.explanation}\x1b[0m`);
			results.push({ ...issue, explanation: fix.explanation, applied: false });
			continue;
		}

		// Apply search/replace
		const searchNormalized = fix.search.trim();
		if (!content.includes(searchNormalized)) {
			console.log("\x1b[33mskip (no match)\x1b[0m");
			results.push({ ...issue, explanation: "search text not found in file", applied: false });
			continue;
		}

		const idx = content.indexOf(searchNormalized);
		const updated = content.slice(0, idx) + fix.replace.trim() + content.slice(idx + searchNormalized.length);
		writeFileSync(absPath, updated);
		console.log("\x1b[32mfixed\x1b[0m");
		console.log(`    \x1b[2m${fix.explanation}\x1b[0m`);
		results.push({ ...issue, explanation: fix.explanation, applied: true });
	}

	return results;
}

function buildFixPrompt(
	issue: FixableIssue,
	meta: { description: string; risk: string; recommendation: string },
	codeContext: string,
	filePath: string,
): string {
	const ext = filePath.split(".").pop() || "ts";
	const lang = ext === "vue" ? "vue" : ext === "svelte" ? "svelte" : ext === "dart" ? "dart" : "typescript";

	let prompt = `Fix this code quality issue. Return a JSON object with search/replace strings.

## Issue
- Check: ${issue.check}
- Rule: ${issue.rule || "n/a"}
- Message: ${issue.message}
- File: ${filePath}:${issue.line}

## Why this matters
${meta.risk}

## Recommended approach
${meta.recommendation}`;

	if (issue.suggestion) {
		prompt += `\n\nSpecific suggestion: ${issue.suggestion}`;
	}

	prompt += `

## Code context (${filePath})
\`\`\`${lang}
${codeContext}
\`\`\`

## Instructions
Return ONLY a valid JSON object (no markdown, no explanation outside JSON):
{
  "search": "exact lines from the code above that need to change (copy verbatim, preserve whitespace)",
  "replace": "the fixed replacement code (same indentation)",
  "explanation": "one sentence: what changed and why"
}

Rules:
- The "search" string MUST appear verbatim in the file — copy it exactly
- Keep the fix minimal — change only what's needed to resolve the issue
- Preserve surrounding code, comments, and formatting
- Do not add imports unless absolutely required
- Match the existing code style`;

	return prompt;
}

let _apiErrorShown = false;

async function callAnthropicDirect(prompt: string, apiKey: string): Promise<LLMFixResponse | null> {
	try {
		const res = await fetch("https://api.anthropic.com/v1/messages", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-api-key": apiKey,
				"anthropic-version": "2023-06-01",
			},
			body: JSON.stringify({
				model: "claude-haiku-4-5-20251001",
				max_tokens: 1024,
				messages: [{ role: "user", content: prompt }],
			}),
		});

		if (!res.ok) {
			if (!_apiErrorShown) {
				const err = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
				console.log(`\n  \x1b[31mAPI error:\x1b[0m ${err?.error?.message || `HTTP ${res.status}`}\n`);
				_apiErrorShown = true;
			}
			return null;
		}

		const data = (await res.json()) as { content?: { type: string; text: string }[] };
		const text = data.content?.find((c) => c.type === "text")?.text;
		if (!text) return null;

		return parseFixResponse(text);
	} catch {
		return null;
	}
}

async function callVcqaProxy(prompt: string, proKey: string): Promise<LLMFixResponse | null> {
	try {
		const res = await fetch("https://api.vibecodeqa.online/api/pro/fix", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${proKey}`,
			},
			body: JSON.stringify({ prompt }),
		});

		if (!res.ok) return null;

		const data = (await res.json()) as { search?: string; replace?: string; explanation?: string };
		if (!data.search || !data.replace) return null;
		return { search: data.search, replace: data.replace, explanation: data.explanation || "" };
	} catch {
		return null;
	}
}

function parseFixResponse(text: string): LLMFixResponse | null {
	try {
		// Try to extract JSON from the response (handle markdown fences)
		let json = text.trim();
		const fenceMatch = json.match(/```(?:json)?\s*([\s\S]*?)```/);
		if (fenceMatch) json = fenceMatch[1].trim();

		const parsed = JSON.parse(json) as { search?: string; replace?: string; explanation?: string };
		if (!parsed.search || typeof parsed.search !== "string") return null;
		if (!parsed.replace || typeof parsed.replace !== "string") return null;

		return {
			search: parsed.search,
			replace: parsed.replace,
			explanation: parsed.explanation || "",
		};
	} catch {
		return null;
	}
}
