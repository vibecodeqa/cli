import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectWorkspace } from "../detect.js";
import { buildFileInventory } from "../file-inventory.js";
import { setGlobalSrcRoots } from "../fs-utils.js";
import { buildEffectiveScanPolicy } from "../scan-policy.js";
import { runArchitecture } from "./architecture.js";
import { runContext } from "./context.js";

function makeProject(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "vcqa-ctx-"));
	writeFileSync(join(dir, "package.json"), "{}");
	for (const [name, content] of Object.entries(files)) {
		const full = join(dir, name);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, content);
	}
	return dir;
}

afterEach(() => setGlobalSrcRoots(undefined));

describe("runContext", () => {
	it("flags high token count files", () => {
		const dir = makeProject({
			"src/big.ts": Array.from(
				{ length: 500 },
				(_, i) => `export const val${i} = ${i}; // some padding text here to increase token count`,
			).join("\n"),
		});
		const result = runContext(dir);
		expect(result.issues.some((i) => i.rule === "high-token-count")).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("flags files with too many imports", () => {
		const imports = Array.from({ length: 20 }, (_, i) => `import { x${i} } from './mod${i}';`).join("\n");
		const dir = makeProject({
			"src/heavy.ts": `${imports}\nexport const y = 1;\n`,
		});
		const result = runContext(dir);
		expect(result.issues.some((i) => i.rule === "heavy-imports")).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("ignores generated agent worktree source", () => {
		const imports = Array.from({ length: 20 }, (_, i) => `import { x${i} } from './mod${i}';`).join("\n");
		const dir = makeProject({
			"src/app.ts": "export const app = 1;\n",
			".claude/worktrees/agent-a/src/heavy.ts": `${imports}\nexport const y = 1;\n`,
		});
		const result = runContext(dir);
		expect(result.issues.some((i) => i.file?.includes(".claude/worktrees"))).toBe(false);
		expect(result.details.filesScanned).toBe(1);
		rmSync(dir, { recursive: true });
	});

	it("uses FileInventory and excludes ignored/generated source", () => {
		const imports = Array.from({ length: 20 }, (_, i) => `import { x${i} } from './mod${i}';`).join("\n");
		const dir = makeProject({
			"src/app.ts": "export const app = 1;\n",
			"dist/heavy.ts": `${imports}\nexport const dist = 1;\n`,
			".claude/worktrees/agent-a/src/heavy.ts": `${imports}\nexport const hidden = 1;\n`,
		});
		const inventory = buildFileInventory(dir, detectWorkspace(dir), buildEffectiveScanPolicy(dir, {}));
		const result = runContext(dir, inventory);
		expect(result.details).toMatchObject({ filesScanned: 1, source: "file-inventory" });
		expect(result.issues.some((i) => i.file?.includes(".claude/worktrees") || i.file?.startsWith("dist/"))).toBe(false);
		rmSync(dir, { recursive: true });
	});

	it("records circular dependency metrics without duplicating architecture findings", async () => {
		const dir = makeProject({
			"src/a.ts": "import { b } from './b';\nexport const a = 1;\n",
			"src/b.ts": "import { a } from './a';\nexport const b = 2;\n",
		});
		const result = runContext(dir);
		const architecture = await runArchitecture(dir);
		expect(result.details.circularDeps).toBe(1);
		expect(result.issues.some((i) => i.rule === "circular-dependency")).toBe(false);
		expect(architecture.issues.some((i) => i.rule === "circular-dep")).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("resolves .vue imports for circular metrics", () => {
		const dir = makeProject({
			"src/App.vue": '<script>\nimport { helper } from "./helper";\nexport default {};\n</script>\n',
			"src/helper.ts": "import App from './App.vue';\nexport const helper = 1;\n",
		});
		const result = runContext(dir);
		expect(result.details.circularDeps).toBe(1);
		expect(result.issues.some((i) => i.rule === "circular-dependency")).toBe(false);
		rmSync(dir, { recursive: true });
	});

	it("returns perfect score for clean code", () => {
		const dir = makeProject({
			"src/app.ts": "export const x = 1;\n",
			"src/utils.ts": "export function add(a: number, b: number) { return a + b; }\n",
		});
		const result = runContext(dir);
		expect(result.score).toBe(100);
		rmSync(dir, { recursive: true });
	});

	it("handles empty project", () => {
		const dir = makeProject({});
		const result = runContext(dir);
		expect(result.score).toBe(100);
		expect(result.details.skipped).toBe(true);
		rmSync(dir, { recursive: true });
	});
});
