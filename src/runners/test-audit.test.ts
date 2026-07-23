import { describe, expect, it, vi } from "vitest";

function mockTestFiles(mod: typeof import("../fs-utils.js"), files: { path: string; content: string }[]) {
	vi.spyOn(mod, "getTestFiles").mockReturnValue(
		files.map((f) => ({
			path: f.path,
			fullPath: `/tmp/${f.path}`,
			base: f.path
				.split("/")
				.pop()!
				.replace(/\.\w+$/, ""),
			ext: ".ts",
			content: f.content,
			lines: f.content.split("\n").length,
			isTest: true,
		})),
	);
}

describe("test-audit local heuristics", () => {
	it("detects empty test bodies", async () => {
		const { runTestAudit } = await import("./test-audit.js");
		process.env.VCQA_PRO_KEY = "test-key";
		const mod = await import("../fs-utils.js");
		mockTestFiles(mod, [
			{
				path: "src/auth.test.ts",
				content: `describe("auth", () => {\n  it("should work", () => {\n  });\n});`,
			},
		]);

		const result = await runTestAudit("/tmp");
		expect(result.issues.filter((i) => i.rule === "empty-test")).toHaveLength(1);
		delete process.env.VCQA_PRO_KEY;
		vi.restoreAllMocks();
	});

	it("detects trivial assertions", async () => {
		const { runTestAudit } = await import("./test-audit.js");
		process.env.VCQA_PRO_KEY = "test-key";
		const mod = await import("../fs-utils.js");
		mockTestFiles(mod, [
			{
				path: "src/utils.test.ts",
				content: `describe("utils", () => {\n  it("works", () => {\n    expect(true).toBe(true);\n  });\n});`,
			},
		]);

		const result = await runTestAudit("/tmp");
		expect(result.issues.filter((i) => i.rule === "trivial-assertions")).toHaveLength(1);
		delete process.env.VCQA_PRO_KEY;
		vi.restoreAllMocks();
	});

	it("detects no-assertion tests", async () => {
		const { runTestAudit } = await import("./test-audit.js");
		process.env.VCQA_PRO_KEY = "test-key";
		const mod = await import("../fs-utils.js");
		mockTestFiles(mod, [
			{
				path: "src/api.test.ts",
				content: `describe("api", () => {\n  it("does something", () => {\n    const x = 1 + 1;\n    console.log(x);\n  });\n});`,
			},
		]);

		const result = await runTestAudit("/tmp");
		expect(result.issues.filter((i) => i.rule === "no-assertions")).toHaveLength(1);
		delete process.env.VCQA_PRO_KEY;
		vi.restoreAllMocks();
	});

	it("detects weak-only assertions", async () => {
		const { runTestAudit } = await import("./test-audit.js");
		process.env.VCQA_PRO_KEY = "test-key";
		const mod = await import("../fs-utils.js");
		mockTestFiles(mod, [
			{
				path: "src/api.test.ts",
				content: `describe("api", () => {\n  it("returns", () => {\n    const res = fn();\n    expect(res).toBeDefined();\n    expect(res).toBeTruthy();\n  });\n});`,
			},
		]);

		const result = await runTestAudit("/tmp");
		expect(result.issues.filter((i) => i.rule === "weak-assertions")).toHaveLength(1);
		delete process.env.VCQA_PRO_KEY;
		vi.restoreAllMocks();
	});

	it("detects skipped tests", async () => {
		const { runTestAudit } = await import("./test-audit.js");
		process.env.VCQA_PRO_KEY = "test-key";
		const mod = await import("../fs-utils.js");
		mockTestFiles(mod, [
			{
				path: "src/x.test.ts",
				content: `describe("x", () => {\n  it.skip("broken", () => { expect(1).toBe(2); });\n});`,
			},
		]);

		const result = await runTestAudit("/tmp");
		expect(result.issues.filter((i) => i.rule === "skipped-test")).toHaveLength(1);
		expect(result.details.skippedTests).toBe(1);
		delete process.env.VCQA_PRO_KEY;
		vi.restoreAllMocks();
	});

	it("detects todo tests", async () => {
		const { runTestAudit } = await import("./test-audit.js");
		process.env.VCQA_PRO_KEY = "test-key";
		const mod = await import("../fs-utils.js");
		mockTestFiles(mod, [
			{
				path: "src/y.test.ts",
				content: `describe("y", () => {\n  it.todo("implement later");\n});`,
			},
		]);

		const result = await runTestAudit("/tmp");
		expect(result.issues.filter((i) => i.rule === "todo-test")).toHaveLength(1);
		delete process.env.VCQA_PRO_KEY;
		vi.restoreAllMocks();
	});

	it("detects mock-heavy tests", async () => {
		const { runTestAudit } = await import("./test-audit.js");
		process.env.VCQA_PRO_KEY = "test-key";
		const mod = await import("../fs-utils.js");
		mockTestFiles(mod, [
			{
				path: "src/db.test.ts",
				content: `describe("db", () => {
  it("queries", () => {
    const mock1 = vi.fn();
    const mock2 = vi.fn();
    const mock3 = vi.fn();
    const mock4 = vi.fn();
    const mock5 = vi.fn();
    expect(mock1).toBeDefined();
  });
});`,
			},
		]);

		const result = await runTestAudit("/tmp");
		expect(result.issues.filter((i) => i.rule === "mock-heavy")).toHaveLength(1);
		delete process.env.VCQA_PRO_KEY;
		vi.restoreAllMocks();
	});

	it("passes good tests without issues", async () => {
		const { runTestAudit } = await import("./test-audit.js");
		process.env.VCQA_PRO_KEY = "test-key";
		const mod = await import("../fs-utils.js");
		mockTestFiles(mod, [
			{
				path: "src/calc.test.ts",
				content: `describe("calc", () => {
  it("adds numbers", () => {
    expect(add(1, 2)).toBe(3);
    expect(add(0, 0)).toBe(0);
    expect(add(-1, 1)).toBe(0);
  });
});`,
			},
		]);

		const result = await runTestAudit("/tmp");
		// Should have no warnings — only possibly weak/info at most
		const warnings = result.issues.filter((i) => i.severity === "warning");
		expect(warnings).toHaveLength(0);
		delete process.env.VCQA_PRO_KEY;
		vi.restoreAllMocks();
	});

	it("returns placeholder without Pro key", async () => {
		delete process.env.VCQA_PRO_KEY;
		const { runTestAudit } = await import("./test-audit.js");
		const result = await runTestAudit("/tmp");
		expect(result.details.comingSoon).toBe(true);
		expect(result.score).toBe(0);
	});

	it("returns score 100 with no test files", async () => {
		const { runTestAudit } = await import("./test-audit.js");
		process.env.VCQA_PRO_KEY = "test-key";
		const mod = await import("../fs-utils.js");
		mockTestFiles(mod, []);

		const result = await runTestAudit("/tmp");
		expect(result.score).toBe(100);
		expect(result.grade).toBe("A");
		delete process.env.VCQA_PRO_KEY;
		vi.restoreAllMocks();
	});

	it("detects disabled describe blocks", async () => {
		const { runTestAudit } = await import("./test-audit.js");
		process.env.VCQA_PRO_KEY = "test-key";
		const mod = await import("../fs-utils.js");
		mockTestFiles(mod, [
			{
				path: "src/z.test.ts",
				content: `xdescribe("disabled suite", () => {\n  it("test", () => { expect(1).toBe(1); });\n});`,
			},
		]);

		const result = await runTestAudit("/tmp");
		expect(result.issues.filter((i) => i.rule === "disabled-suite")).toHaveLength(1);
		delete process.env.VCQA_PRO_KEY;
		vi.restoreAllMocks();
	});
});
