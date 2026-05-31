import { describe, expect, it, vi } from "vitest";

// Mock the fetch + fs to test local heuristics without network
vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	return { ...actual };
});

describe("dead-patterns local heuristics", () => {
	it("detects legacy naming patterns", async () => {
		const { runDeadPatterns } = await import("./dead-patterns.js");
		// Set Pro key to enable local checks (but no network for LLM)
		process.env.VCQA_PRO_KEY = "test-key";

		const mod = await import("../fs-utils.js");
		vi.spyOn(mod, "getProductionFiles").mockReturnValue([
			{
				path: "src/auth.ts",
				fullPath: "/tmp/src/auth.ts",
				base: "auth",
				ext: ".ts",
				content: `export function authenticateLegacy(user: string) { return true; }
export function authenticate(user: string) { return true; }`,
				lines: 2,
				isTest: false,
			},
		]);

		const result = await runDeadPatterns("/tmp");
		expect(result.name).toBe("dead-patterns");
		expect(result.details.premium).toBe(true);
		const legacyIssues = result.issues.filter((i) => i.rule === "legacy-naming");
		expect(legacyIssues.length).toBeGreaterThan(0);
		expect(legacyIssues[0].message).toContain("authenticateLegacy");

		delete process.env.VCQA_PRO_KEY;
		vi.restoreAllMocks();
	});

	it("detects hardcoded feature flags", async () => {
		const { runDeadPatterns } = await import("./dead-patterns.js");
		process.env.VCQA_PRO_KEY = "test-key";

		const mod = await import("../fs-utils.js");
		vi.spyOn(mod, "getProductionFiles").mockReturnValue([
			{
				path: "src/config.ts",
				fullPath: "/tmp/src/config.ts",
				base: "config",
				ext: ".ts",
				content: `const USE_NEW_AUTH = true;
if (USE_NEW_AUTH) { doNewThing(); } else { doOldThing(); }`,
				lines: 2,
				isTest: false,
			},
		]);

		const result = await runDeadPatterns("/tmp");
		const flagIssues = result.issues.filter((i) => i.rule === "hardcoded-flag");
		expect(flagIssues.length).toBe(1);
		expect(flagIssues[0].message).toContain("USE_NEW_AUTH");

		delete process.env.VCQA_PRO_KEY;
		vi.restoreAllMocks();
	});

	it("returns placeholder without Pro key", async () => {
		delete process.env.VCQA_PRO_KEY;
		const { runDeadPatterns } = await import("./dead-patterns.js");

		const result = await runDeadPatterns("/tmp");
		expect(result.details.comingSoon).toBe(true);
		expect(result.score).toBe(0);
		expect(result.issues).toHaveLength(0);
	});
});
