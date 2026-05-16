import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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

describe("runArchitecture", () => {
	it("skips when fewer than 2 source files", () => {
		const dir = makeProject({ "index.ts": `export const x = 1;` });
		const result = runArchitecture(dir);
		expect((result.details as any).skipped).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("detects circular dependencies", () => {
		const dir = makeProject({
			"a.ts": `import { b } from "./b.js";\nexport const a = b;`,
			"b.ts": `import { a } from "./a.js";\nexport const b = a;`,
		});
		const result = runArchitecture(dir);
		expect(result.issues.some((i) => i.rule === "circular-dep")).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("detects orphan modules", () => {
		const dir = makeProject({
			"main.ts": `import { x } from "./util.js";\nconsole.log(x);`,
			"util.ts": `export const x = 1;`,
			"orphan.ts": `export const lonely = true;`,
		});
		const result = runArchitecture(dir);
		expect(result.issues.some((i) => i.rule === "orphan-module")).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("scores 100 for clean architecture", () => {
		const dir = makeProject({
			"index.ts": `import { greet } from "./greet.js";\nconsole.log(greet());`,
			"greet.ts": `export function greet() { return "hi"; }`,
		});
		const result = runArchitecture(dir);
		expect(result.score).toBe(100);
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

	it("handles >50 nodes gracefully", () => {
		const graph: Record<string, { imports: string[]; importedBy: string[]; dir: string }> = {};
		for (let i = 0; i < 55; i++) {
			graph[`src/mod${i}.ts`] = { imports: [], importedBy: [], dir: "src" };
		}
		const result = generateArchSVG({ graph, circularDeps: 0 });
		expect(result).toContain("55 modules"); // fallback message
		expect(result).not.toContain("<svg");
	});
});
