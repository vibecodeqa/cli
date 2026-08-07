import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectWorkspace } from "../detect.js";
import { buildFileInventory } from "../file-inventory.js";
import { buildEffectiveScanPolicy } from "../scan-policy.js";
import { generateArchSVG, runArchitecture } from "./architecture.js";

function makeProject(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "vcqa-arch-"));
	writeFileSync(join(dir, "package.json"), "{}");
	mkdirSync(join(dir, "src"), { recursive: true });
	for (const [name, content] of Object.entries(files)) {
		const full = join(dir, "src", name);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, content);
	}
	return dir;
}

function makeRepo(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "vcqa-arch-"));
	writeFileSync(join(dir, "package.json"), "{}");
	for (const [name, content] of Object.entries(files)) {
		const full = join(dir, name);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, content);
	}
	return dir;
}

function inventory(dir: string) {
	return buildFileInventory(dir, detectWorkspace(dir), buildEffectiveScanPolicy(dir, {}));
}

describe("runArchitecture", () => {
	it("skips when fewer than 2 source files", async () => {
		const dir = makeProject({ "index.ts": `export const x = 1;` });
		const result = await runArchitecture(dir);
		expect((result.details as any).skipped).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("detects circular dependencies", async () => {
		const dir = makeProject({
			"a.ts": `import { b } from "./b.js";\nexport const a = b;`,
			"b.ts": `import { a } from "./a.js";\nexport const b = a;`,
		});
		const result = await runArchitecture(dir);
		expect(result.issues.some((i) => i.rule === "circular-dep")).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("does not treat type-only import cycles as runtime circular dependencies", async () => {
		const dir = makeProject({
			"a.ts": `import type { B } from "./b.js";\nexport type A = { b?: B };\nexport const a = 1;`,
			"b.ts": `import type { A } from "./a.js";\nexport type B = { a?: A };`,
		});
		const result = await runArchitecture(dir);
		expect(result.issues.some((i) => i.rule === "circular-dep")).toBe(false);
		expect(result.issues.some((i) => i.rule === "type-only-cycle")).toBe(true);
		expect((result.details as Record<string, unknown>).typeOnlyEdgesIgnored).toBeGreaterThan(0);
		expect((result.details as Record<string, unknown>).typeOnlyCycles).toBe(1);
		rmSync(dir, { recursive: true });
	});

	it("does not treat deferred dynamic imports as static runtime cycles", async () => {
		const dir = makeProject({
			"a.ts": `export async function loadB() { return import("./b.js"); }\nexport const a = 1;`,
			"b.ts": `import { a } from "./a.js";\nexport const b = a;`,
		});
		const result = await runArchitecture(dir);
		expect(result.issues.some((i) => i.rule === "circular-dep")).toBe(false);
		expect(result.issues.some((i) => i.rule === "dynamic-import-cycle")).toBe(true);
		expect((result.details as Record<string, unknown>).dynamicCycles).toBe(1);
		rmSync(dir, { recursive: true });
	});

	it("detects orphan modules", async () => {
		const dir = makeProject({
			"main.ts": `import { x } from "./util.js";\nconsole.log(x);`,
			"util.ts": `export const x = 1;`,
			"orphan.ts": `export const lonely = true;`,
		});
		const result = await runArchitecture(dir);
		expect(result.issues.some((i) => i.rule === "orphan-module")).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("scores 100 for clean architecture", async () => {
		const dir = makeProject({
			"index.ts": `import { greet } from "./greet.js";\nconsole.log(greet());`,
			"greet.ts": `export function greet() { return "hi"; }`,
		});
		const result = await runArchitecture(dir);
		expect(result.score).toBe(100);
		rmSync(dir, { recursive: true });
	});

	it("uses FileInventory and excludes ignored/generated source", async () => {
		const dir = makeRepo({
			"src/app.ts": `import { helper } from "./helper.js";\nexport const app = helper;`,
			"src/helper.ts": `export const helper = 1;`,
			"dist/a.ts": `import { b } from "./b.js";\nexport const a = b;`,
			"dist/b.ts": `import { a } from "./a.js";\nexport const b = a;`,
			".claude/worktrees/agent-a/src/a.ts": `import { b } from "./b.js";\nexport const a = b;`,
			".claude/worktrees/agent-a/src/b.ts": `import { a } from "./a.js";\nexport const b = a;`,
		});
		const result = await runArchitecture(dir, undefined, inventory(dir));
		expect(result.details).toMatchObject({ totalModules: 2, source: "file-inventory" });
		expect(Object.keys((result.details as any).graph)).toEqual(expect.arrayContaining(["src/app.ts", "src/helper.ts"]));
		expect(result.issues.some((i) => i.file?.includes(".claude/worktrees") || i.file?.startsWith("dist/"))).toBe(false);
		expect(result.issues.some((i) => i.rule === "circular-dep")).toBe(false);
		rmSync(dir, { recursive: true });
	});
});

describe("generateArchSVG", () => {
	it("returns empty for no graph data", () => {
		expect(generateArchSVG({})).toBe("");
		expect(generateArchSVG({ graph: {} })).toBe("");
	});

	it("renders SVG with dark background rect", () => {
		const details = {
			circularDeps: 0,
			graph: {
				"src/a.ts": { imports: ["src/b.ts"], importedBy: [], dir: "src" },
				"src/b.ts": { imports: [], importedBy: ["src/a.ts"], dir: "src" },
			},
		};
		const svg = generateArchSVG(details);
		expect(svg).toContain("<svg");
		expect(svg).toContain('fill="none"'); // transparent bg, inherits page dark background
		expect(svg).not.toContain("background:"); // no CSS background
		expect(svg).toContain("<path"); // bezier edges
		expect(svg).toContain("marker-end"); // arrowheads
	});

	it("renders legend", () => {
		const details = {
			circularDeps: 0,
			graph: {
				"src/a.ts": { imports: ["src/b.ts"], importedBy: [], dir: "src" },
				"src/b.ts": { imports: [], importedBy: ["src/a.ts"], dir: "src" },
			},
		};
		const svg = generateArchSVG(details);
		expect(svg).toContain("god module");
		expect(svg).toContain("orphan");
		expect(svg).toContain("circular");
	});

	it("handles >120 nodes gracefully", () => {
		const graph: Record<string, { imports: string[]; importedBy: string[]; dir: string }> = {};
		for (let i = 0; i < 125; i++) {
			graph[`src/mod${i}.ts`] = { imports: [], importedBy: [], dir: "src" };
		}
		const result = generateArchSVG({ graph, circularDeps: 0 });
		expect(result).toContain("125 modules"); // fallback message
		expect(result).not.toContain("<svg");
	});
});
