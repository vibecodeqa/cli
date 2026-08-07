/** Compute weighted composite score from individual check results.
 *  Weights are sourced from check-meta.ts — single source of truth. */

import { CHECK_META, getCheckMeta } from "./check-meta.js";
import type { CheckResult } from "./types.js";

export function normalizeScore(score: unknown): number {
	const n = Number(score);
	if (!Number.isFinite(n)) return 0;
	return Math.max(0, Math.min(100, Math.round(n)));
}

export function computeScore(checks: CheckResult[]): number {
	let totalWeight = 0;
	let weightedSum = 0;

	for (const check of checks) {
		const det = check.details as Record<string, unknown>;
		if (det.skipped || det.comingSoon || det.synthetic || det.scoreImpact === false) continue;
		const meta = getCheckMeta(check.name);
		totalWeight += meta.weight;
		weightedSum += normalizeScore(check.score) * meta.weight;
	}

	return totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;
}

/** Total weight across all checks (should be 100). */
export function totalWeight(): number {
	return Object.values(CHECK_META).reduce((s, m) => s + m.weight, 0);
}
