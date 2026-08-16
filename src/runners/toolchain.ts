/** Toolchain availability probes for delegated tools.
 *
 * A command that never ran must not be read as "the tool ran and found
 * nothing". Runners shell out as `<tool> … 2>/dev/null || true`, which forces
 * exit 0 and throws stderr away, so a missing SDK reaches the parser as empty
 * output — and empty output parses as zero findings, which scores as a perfect
 * pass. That is how a Flutter repo scanned without the Dart SDK reported
 * `lint A/100` and `types A/100` (#92).
 *
 * Unmasking the real exit codes is the general fix and belongs to #26. Until
 * then a runner that is about to delegate to the Dart SDK asks here first, and
 * returns an *unavailable* result rather than a score if the SDK is absent.
 *
 * `unavailable` is deliberately not `not-applicable`: the stack was detected,
 * the tool was not. Both are excluded from the composite score (#52 — a missing
 * SDK is not a code defect), but only one of them is something the user can fix
 * by installing something.
 */

import type { CheckResult } from "../types.js";
import { run } from "./exec.js";

/** What the user is told when the Dart SDK is not installed. */
export const DART_SDK_MISSING_REASON = "Dart SDK not installed — install Dart/Flutter to analyze this repo";

let dartProbe: { path: string; available: boolean } | null = null;

/** True when a Dart SDK is on PATH.
 *
 * Probed with a bare `dart --version` — no `|| true`, so a missing binary is a
 * real non-zero exit and is recorded as such in the tool log. The result is
 * cached against PATH, so a scan pays for one probe while a PATH change (a
 * test, a long-lived monitor process) still re-probes instead of answering
 * from a stale cache. */
export function hasDartSdk(cwd: string): boolean {
	const path = process.env.PATH ?? "";
	if (dartProbe && dartProbe.path === path) return dartProbe.available;
	const available = run("dart --version", cwd, 10_000).ok;
	dartProbe = { path, available };
	return available;
}

/** Forget every probed result. Tests use this; nothing in a scan should need it. */
export function resetToolchainProbes(): void {
	dartProbe = null;
}

/** A check result meaning "this check applies here, but its tool is missing".
 *
 * `skipped: true` is what `score.ts` reads to drop the check from the weighted
 * composite; `unavailable: true` is what `core.ts` reads to report it as
 * *unavailable* rather than *not applicable*. The 0/F is normalized away by
 * `normalizeCheckResult` — an excluded check renders as a skip, not a fail. */
export function unavailableResult(name: string, reason: string, details: Record<string, unknown>, start: number): CheckResult {
	return {
		name,
		score: 0,
		grade: "F",
		details: { ...details, skipped: true, unavailable: true, reason },
		issues: [],
		duration: Date.now() - start,
	};
}
