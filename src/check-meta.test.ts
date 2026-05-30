import { describe, expect, it } from "vitest";
import { CHECK_META, getCheckMeta } from "./check-meta.js";

describe("CHECK_META", () => {
	const allChecks = [
		"structure",
		"lint",
		"types",
		"type-safety",
		"standards",
		"complexity",
		"duplication",
		"error-handling",
		"react",
		"accessibility",
		"docs",
		"best-practices",
		"testing",
		"secrets",
		"security",
		"dependencies",
		"architecture",
		"performance",
		"confusion",
		"context",
		"doc-coherence",
		"code-coherence",
		"comment-staleness",
		"dead-patterns",
		"test-audit",
	];

	it("has metadata for all 25 checks", () => {
		for (const name of allChecks) {
			expect(CHECK_META[name]).toBeDefined();
			expect(CHECK_META[name].label).toBeTruthy();
			expect(CHECK_META[name].description.length).toBeGreaterThan(50);
			expect(CHECK_META[name].risk.length).toBeGreaterThan(20);
			expect(CHECK_META[name].recommendation.length).toBeGreaterThan(20);
		}
	});

	it("has valid priorities", () => {
		for (const meta of Object.values(CHECK_META)) {
			expect(["critical", "high", "medium", "low"]).toContain(meta.priority);
		}
	});

	it("has valid categories", () => {
		const validCats = ["Foundations", "Quality", "Testing", "Architecture", "Security", "LLM Readiness", "AI Analysis"];
		for (const meta of Object.values(CHECK_META)) {
			expect(validCats).toContain(meta.category);
		}
	});

	it("weights sum to 100", () => {
		const total = Object.values(CHECK_META).reduce((s, m) => s + m.weight, 0);
		expect(total).toBe(100);
	});

	it("testing has the highest weight", () => {
		const maxWeight = Math.max(...Object.values(CHECK_META).map((m) => m.weight));
		expect(CHECK_META.testing.weight).toBe(maxWeight);
	});
});

describe("getCheckMeta", () => {
	it("returns metadata for known checks", () => {
		const meta = getCheckMeta("lint");
		expect(meta.label).toBe("Lint");
		expect(meta.priority).toBe("high");
	});

	it("returns fallback for unknown checks", () => {
		const meta = getCheckMeta("unknown-check");
		expect(meta.name).toBe("unknown-check");
		expect(meta.priority).toBe("medium");
		expect(meta.weight).toBe(5);
	});
});
