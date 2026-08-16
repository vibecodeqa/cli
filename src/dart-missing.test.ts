import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scan } from "./core.js";
import { resetToolchainProbes } from "./runners/toolchain.js";
import { computeScore } from "./score.js";
import type { CheckResult } from "./types.js";

/**
 * Issue #92: on a machine without the Dart SDK, `dart analyze` / `dart pub
 * outdated` are shelled out as `… 2>/dev/null || true`. The `|| true` forces
 * exit 0 and `2>/dev/null` throws the "command not found" away, so the parsers
 * see empty output — which they read as zero findings, and zero findings scores
 * as a perfect pass. `lint` and `types` both reported A/100 for Dart code that
 * was never analyzed, and `dependencies` reported a clean bill for packages it
 * never queried.
 *
 * These run the real scan with a PATH that has no `dart` on it.
 */
const fixtureDir = fileURLToPath(new URL("../fixtures/flutter-app/", import.meta.url));

/** A PATH with the standard system binaries (git, sh) but no Dart SDK. */
const NO_DART_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

describe("Dart SDK absent", () => {
	let originalPath: string | undefined;

	beforeEach(() => {
		originalPath = process.env.PATH;
		process.env.PATH = NO_DART_PATH;
		resetToolchainProbes();
	});

	afterEach(() => {
		process.env.PATH = originalPath;
		resetToolchainProbes();
	});

	it("reports lint, types and dependencies as unavailable instead of scoring them", { timeout: 120_000 }, async () => {
		const report = await scan(fixtureDir, { skipTests: true, checks: ["lint", "types", "dependencies"] });

		expect(report.meta.stack.language).toBe("dart");

		for (const name of ["lint", "types", "dependencies"]) {
			const check = report.checks.find((c) => c.name === name);
			expect(check, `${name} should have run`).toBeDefined();
			const details = check?.details as Record<string, unknown>;

			// The whole point: not a score. Before the fix these were A/100 (lint,
			// types) and A/100 with "0 outdated" (dependencies).
			expect(details.unavailable, `${name} should be flagged unavailable`).toBe(true);
			expect(check?.status, `${name} status`).toBe("unavailable");

			// `unavailable`, not `not-applicable` — the stack was detected, the tool
			// was not, and installing Dart would make this check work.
			expect(details.scoreMode, `${name} scoreMode`).toBe("unavailable");
			expect(details.scoreImpact, `${name} scoreImpact`).toBe(false);

			// The reason has to name the thing the user must install.
			expect(String(details.reason)).toContain("Dart SDK");

			// A check that could not run has nothing to report.
			expect(check?.issues).toEqual([]);
		}

		// `dependencies` specifically must not claim "0 outdated" for a Dart
		// package it could not query.
		const dependencies = report.checks.find((c) => c.name === "dependencies");
		expect((dependencies?.details as Record<string, unknown>).outdated).toBeUndefined();
		expect((dependencies?.details as Record<string, unknown>).vulnerabilities).toBeUndefined();
	});

	it("excludes the unavailable checks from the composite score", { timeout: 120_000 }, async () => {
		const report = await scan(fixtureDir, { skipTests: true, checks: ["lint", "types", "dependencies"] });

		// One real scored check alongside the three unavailable ones: if the
		// unavailable checks contributed at all, the composite would move off 42.
		const scored: CheckResult = {
			name: "complexity",
			score: 42,
			grade: "F",
			details: {},
			issues: [],
			duration: 0,
		};
		expect(computeScore([...report.checks, scored])).toBe(42);
	});
});
