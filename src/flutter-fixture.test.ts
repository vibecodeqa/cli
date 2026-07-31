import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scan } from "./core.js";

/**
 * The non-TS tripwire (issue #22): run the FULL scan over a real Flutter
 * fixture and fail loudly if any check crashes on Dart or silently
 * misclassifies the project. Works both with the Dart toolchain installed
 * (local dev) and without it (CI runners) — shell-out checks must degrade to
 * an explicit skip, never a crash-stub.
 */
const fixtureDir = fileURLToPath(new URL("../fixtures/flutter-app/", import.meta.url));

describe("flutter fixture e2e", () => {
	it("scans a Flutter project without any runner crashing", { timeout: 120_000 }, async () => {
		const report = await scan(fixtureDir, { skipTests: true });

		// Stack + workspace detection ground truth
		expect(report.meta.stack.language).toBe("dart");
		expect(report.meta.stack.framework).toBe("flutter");

		// The tripwire: no check may degrade to the crash-stub. A thrown runner
		// is recorded as { skipped: true, reason: "runner error: ..." } — that is
		// a silent 0/F masquerading as a skip, and exactly the bug class this
		// fixture exists to catch.
		const crashed = report.checks.filter(
			(c) => typeof c.details.reason === "string" && (c.details.reason as string).startsWith("runner error:"),
		);
		expect(crashed.map((c) => `${c.name}: ${c.details.reason}`)).toEqual([]);

		// Central stack gating: react must be skipped via appliesTo, not run.
		const react = report.checks.find((c) => c.name === "react");
		expect(react?.details.skipped).toBe(true);
		expect(react?.details.reason).toContain("not applicable");
		const flutter = report.checks.find((c) => c.name === "flutter");
		expect(flutter?.details.skipped).not.toBe(true);
		expect(flutter?.details.packages).toEqual(
			expect.arrayContaining([expect.objectContaining({ path: ".", kind: "app", widgetTests: 0 })]),
		);

		// All registered checks reported something
		expect(report.checks.length).toBeGreaterThanOrEqual(34);

		// The composite is a sane report, not a pile of stubs
		expect(report.score).toBeGreaterThan(0);
		expect(["A", "B", "C", "D", "F"]).toContain(report.grade);

		// Stable projection: which checks actually ran vs skipped. Scores churn;
		// this shape should not. If a check's applicability to Dart changes,
		// this assertion is the loud diff in review.
		const skipped = report.checks
			.filter((c) => c.details.skipped === true)
			.map((c) => c.name)
			.sort();
		// react is gated out; everything else that skips must be an explicit
		// environment/tool skip, never a crash. Assert the gate, allow the rest.
		expect(skipped).toContain("react");
	});
});
