import { describe, expect, it, vi } from "vitest";

describe("test-audit local heuristics", () => {
	it("detects empty test bodies", async () => {
		const { runTestAudit } = await import("./test-audit.js");
		process.env.VCQA_PRO_KEY = "test-key";

		const mod = await import("../fs-utils.js");
		vi.spyOn(mod, "getTestFiles").mockReturnValue([
			{
				path: "src/auth.test.ts",
				fullPath: "/tmp/src/auth.test.ts",
				base: "auth.test",
				ext: ".ts",
				content: `import { describe, it } from "vitest";
describe("auth", () => {
  it("should work", () => {
  });
  it("should validate", () => {
    expect(true).toBe(true);
  });
  it("has no assertions", () => {
    const x = 1 + 1;
    console.log(x);
  });
});`,
				lines: 12,
				isTest: true,
			},
		]);

		const result = await runTestAudit("/tmp");
		expect(result.name).toBe("test-audit");

		const empty = result.issues.filter((i) => i.rule === "empty-test");
		expect(empty.length).toBe(1);

		const trivial = result.issues.filter((i) => i.rule === "trivial-assertions");
		expect(trivial.length).toBe(1);
		expect(trivial[0].message).toContain("trivial");

		const noAssert = result.issues.filter((i) => i.rule === "no-assertions");
		expect(noAssert.length).toBe(1);

		delete process.env.VCQA_PRO_KEY;
		vi.restoreAllMocks();
	});

	it("detects skipped and todo tests", async () => {
		const { runTestAudit } = await import("./test-audit.js");
		process.env.VCQA_PRO_KEY = "test-key";

		const mod = await import("../fs-utils.js");
		vi.spyOn(mod, "getTestFiles").mockReturnValue([
			{
				path: "src/utils.test.ts",
				fullPath: "/tmp/src/utils.test.ts",
				base: "utils.test",
				ext: ".ts",
				content: `import { describe, it } from "vitest";
describe("utils", () => {
  it.skip("broken test", () => {
    expect(1).toBe(2);
  });
  it.todo("implement later");
});`,
				lines: 7,
				isTest: true,
			},
		]);

		const result = await runTestAudit("/tmp");
		const skipped = result.issues.filter((i) => i.rule === "skipped-test");
		expect(skipped.length).toBe(1);
		const todo = result.issues.filter((i) => i.rule === "todo-test");
		expect(todo.length).toBe(1);
		expect(result.details.skippedTests).toBe(2);

		delete process.env.VCQA_PRO_KEY;
		vi.restoreAllMocks();
	});

	it("detects weak-only assertions", async () => {
		const { runTestAudit } = await import("./test-audit.js");
		process.env.VCQA_PRO_KEY = "test-key";

		const mod = await import("../fs-utils.js");
		vi.spyOn(mod, "getTestFiles").mockReturnValue([
			{
				path: "src/api.test.ts",
				fullPath: "/tmp/src/api.test.ts",
				base: "api.test",
				ext: ".ts",
				content: `import { describe, it, expect } from "vitest";
describe("api", () => {
  it("returns a response", () => {
    const res = fetch("/api");
    expect(res).toBeDefined();
    expect(res).toBeTruthy();
  });
});`,
				lines: 8,
				isTest: true,
			},
		]);

		const result = await runTestAudit("/tmp");
		const weak = result.issues.filter((i) => i.rule === "weak-assertions");
		expect(weak.length).toBe(1);
		expect(weak[0].message).toContain("weak");

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
});
