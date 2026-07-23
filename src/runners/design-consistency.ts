/** Design Consistency — LLM-powered audit of visual consistency across components.
 *
 * Pro feature. Requires VCQA_PRO_KEY env var.
 *
 * Detects:
 *   - Components that define the same visual pattern differently (accidental design system)
 *   - Spacing/color/typography inconsistencies across files
 *   - Missing component extraction opportunities
 *   - Tailwind class patterns that should be @apply'd or componentized
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getProductionFiles } from "../fs-utils.js";
import type { CheckResult, Issue } from "../types.js";
import { gradeFromScore } from "../types.js";

interface DesignCache {
	version: number;
	hash: string;
	findings: Issue[];
}

export async function runDesignConsistency(cwd: string): Promise<CheckResult> {
	const start = Date.now();
	const proKey = process.env.VCQA_PRO_KEY || "";

	if (!proKey) {
		return {
			name: "design-consistency",
			score: 0,
			grade: "F",
			details: {
				premium: true,
				comingSoon: true,
				reason: "Set VCQA_PRO_KEY to enable design consistency analysis",
				description:
					"LLM-powered audit of visual consistency — finds components with duplicate styling, inconsistent spacing scales, and missing component extraction opportunities.",
			},
			issues: [],
			duration: Date.now() - start,
		};
	}

	const files = getProductionFiles(cwd);
	const componentFiles = files.filter((f) => !f.isTest && /\.(tsx|jsx|vue|svelte)$/.test(f.path));

	if (componentFiles.length < 2) {
		return {
			name: "design-consistency",
			score: 100,
			grade: "A",
			details: { componentsAnalyzed: componentFiles.length },
			issues: [],
			duration: Date.now() - start,
		};
	}

	// Build hash of all component content for cache key
	const h = createHash("sha256");
	for (const f of componentFiles.sort((a, b) => a.path.localeCompare(b.path))) {
		h.update(f.path);
		h.update(f.content.slice(0, 2000));
	}
	const contentHash = h.digest("hex").slice(0, 16);

	// Check cache
	const cache = loadCache(cwd);
	if (cache && cache.hash === contentHash) {
		return {
			name: "design-consistency",
			score: cache.findings.length === 0 ? 100 : Math.max(20, 100 - cache.findings.length * 12),
			grade: gradeFromScore(cache.findings.length === 0 ? 100 : Math.max(20, 100 - cache.findings.length * 12)),
			details: { premium: true, componentsAnalyzed: componentFiles.length, cached: true },
			issues: cache.findings,
			duration: Date.now() - start,
		};
	}

	// Extract styling snippets from top components (by size, most likely to have styling)
	const candidates = componentFiles.sort((a, b) => b.content.length - a.content.length).slice(0, 10);

	const snippets = candidates.map((f) => ({
		path: f.path,
		content: f.content.slice(0, 2000),
	}));

	const issues = await analyzeDesign(snippets, proKey);

	// Cache results
	saveCache(cwd, { version: 1, hash: contentHash, findings: issues });

	const score = issues.length === 0 ? 100 : Math.max(20, 100 - issues.length * 12);

	return {
		name: "design-consistency",
		score,
		grade: gradeFromScore(score),
		details: { premium: true, componentsAnalyzed: componentFiles.length },
		issues,
		duration: Date.now() - start,
	};
}

async function analyzeDesign(files: { path: string; content: string }[], proKey: string): Promise<Issue[]> {
	try {
		const res = await fetch("https://api.vibecodeqa.online/api/pro/design-consistency", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${proKey}`,
			},
			body: JSON.stringify({ files: files.map((f) => ({ path: f.path, content: f.content })) }),
		});

		if (!res.ok) return [];

		const data = (await res.json()) as { findings?: Issue[] };
		return data.findings || [];
	} catch {
		return [];
	}
}

function loadCache(cwd: string): DesignCache | null {
	try {
		const cachePath = join(cwd, ".vibe-check", "design-consistency-cache.json");
		if (existsSync(cachePath)) {
			const data = JSON.parse(readFileSync(cachePath, "utf-8"));
			if (data.version === 1) return data;
		}
	} catch {
		/* corrupt cache */
	}
	return null;
}

function saveCache(cwd: string, cache: DesignCache): void {
	try {
		const dir = join(cwd, ".vibe-check");
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "design-consistency-cache.json"), JSON.stringify(cache));
	} catch {
		/* write failed */
	}
}
