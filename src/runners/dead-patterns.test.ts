import { describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	return { ...actual };
});

function mockFiles(mod: typeof import("../fs-utils.js"), files: { path: string; content: string }[]) {
	vi.spyOn(mod, "getProductionFiles").mockReturnValue(
		files.map((f) => ({ path: f.path, fullPath: `/tmp/${f.path}`, base: f.path.split("/").pop()!.replace(/\.\w+$/, ""), ext: ".ts", content: f.content, lines: f.content.split("\n").length, isTest: false })),
	);
}

describe("dead-patterns local heuristics", () => {
	it("detects legacy naming patterns", async () => {
		const { runDeadPatterns } = await import("./dead-patterns.js");
		process.env.VCQA_PRO_KEY = "test-key";
		const mod = await import("../fs-utils.js");
		mockFiles(mod, [{ path: "src/auth.ts", content: `export function authenticateLegacy(user: string) { return true; }` }]);

		const result = await runDeadPatterns("/tmp");
		expect(result.issues.filter((i) => i.rule === "legacy-naming")).toHaveLength(1);
		expect(result.issues[0].message).toContain("authenticateLegacy");
		delete process.env.VCQA_PRO_KEY;
		vi.restoreAllMocks();
	});

	it("detects _old, _backup, _fallback, V1 naming", async () => {
		const { runDeadPatterns } = await import("./dead-patterns.js");
		process.env.VCQA_PRO_KEY = "test-key";
		const mod = await import("../fs-utils.js");
		mockFiles(mod, [{
			path: "src/db.ts",
			content: `const queryOld = () => {};
const query_backup = () => {};
interface ConfigV1 { x: number; }`,
		}]);

		const result = await runDeadPatterns("/tmp");
		const legacy = result.issues.filter((i) => i.rule === "legacy-naming");
		expect(legacy.length).toBe(3);
		delete process.env.VCQA_PRO_KEY;
		vi.restoreAllMocks();
	});

	it("detects hardcoded feature flags used in conditions", async () => {
		const { runDeadPatterns } = await import("./dead-patterns.js");
		process.env.VCQA_PRO_KEY = "test-key";
		const mod = await import("../fs-utils.js");
		mockFiles(mod, [{
			path: "src/config.ts",
			content: `const USE_NEW_AUTH = true;\nif (USE_NEW_AUTH) { doNew(); } else { doOld(); }`,
		}]);

		const result = await runDeadPatterns("/tmp");
		const flags = result.issues.filter((i) => i.rule === "hardcoded-flag");
		expect(flags).toHaveLength(1);
		expect(flags[0].message).toContain("USE_NEW_AUTH");
		delete process.env.VCQA_PRO_KEY;
		vi.restoreAllMocks();
	});

	it("ignores flags NOT used in conditions", async () => {
		const { runDeadPatterns } = await import("./dead-patterns.js");
		process.env.VCQA_PRO_KEY = "test-key";
		const mod = await import("../fs-utils.js");
		mockFiles(mod, [{
			path: "src/config.ts",
			content: `const ENABLE_LOGS = true;\nconsole.log(ENABLE_LOGS);`,
		}]);

		const result = await runDeadPatterns("/tmp");
		expect(result.issues.filter((i) => i.rule === "hardcoded-flag")).toHaveLength(0);
		delete process.env.VCQA_PRO_KEY;
		vi.restoreAllMocks();
	});

	it("detects try-catch fallback patterns", async () => {
		const { runDeadPatterns } = await import("./dead-patterns.js");
		process.env.VCQA_PRO_KEY = "test-key";
		const mod = await import("../fs-utils.js");
		mockFiles(mod, [{
			path: "src/api.ts",
			content: `function getData() {
  try {
    return newApi();
  }
  catch (e) {
    const fallback = oldApi();
    const transformed = transform(fallback);
    const validated = validate(transformed);
    const result = finalize(validated);
    return result;
  }
}`,
		}]);

		const result = await runDeadPatterns("/tmp");
		const fallbacks = result.issues.filter((i) => i.rule === "fallback-catch");
		expect(fallbacks.length).toBeGreaterThanOrEqual(1);
		delete process.env.VCQA_PRO_KEY;
		vi.restoreAllMocks();
	});

	it("ignores catch blocks that only log", async () => {
		const { runDeadPatterns } = await import("./dead-patterns.js");
		process.env.VCQA_PRO_KEY = "test-key";
		const mod = await import("../fs-utils.js");
		mockFiles(mod, [{
			path: "src/api.ts",
			content: `try { doThing(); } catch (e) { console.error(e); }`,
		}]);

		const result = await runDeadPatterns("/tmp");
		expect(result.issues.filter((i) => i.rule === "fallback-catch")).toHaveLength(0);
		delete process.env.VCQA_PRO_KEY;
		vi.restoreAllMocks();
	});

	it("returns placeholder without Pro key", async () => {
		delete process.env.VCQA_PRO_KEY;
		const { runDeadPatterns } = await import("./dead-patterns.js");
		const result = await runDeadPatterns("/tmp");
		expect(result.details.comingSoon).toBe(true);
		expect(result.score).toBe(0);
	});

	it("produces feature map in details", async () => {
		const { runDeadPatterns } = await import("./dead-patterns.js");
		process.env.VCQA_PRO_KEY = "test-key";
		const mod = await import("../fs-utils.js");
		mockFiles(mod, [
			{ path: "src/a.ts", content: "export const a = 1;" },
			{ path: "src/b.ts", content: "export const b = 2;" },
		]);

		const result = await runDeadPatterns("/tmp");
		const map = (result.details as Record<string, unknown>).featureMap;
		expect(Array.isArray(map)).toBe(true);
		delete process.env.VCQA_PRO_KEY;
		vi.restoreAllMocks();
	});
});
