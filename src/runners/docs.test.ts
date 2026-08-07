import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectWorkspace } from "../detect.js";
import { buildFileInventory } from "../file-inventory.js";
import { setGlobalSrcRoots } from "../fs-utils.js";
import { buildEffectiveScanPolicy } from "../scan-policy.js";
import { runDocs } from "./docs.js";

function makeProject(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "vcqa-docs-"));
	writeFileSync(join(dir, "package.json"), "{}");
	for (const [name, content] of Object.entries(files)) {
		const full = join(dir, name);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, content);
	}
	return dir;
}

afterEach(() => setGlobalSrcRoots(undefined));

function inventory(dir: string) {
	return buildFileInventory(dir, detectWorkspace(dir), buildEffectiveScanPolicy(dir, {}));
}

describe("runDocs", () => {
	it("flags missing README", () => {
		const dir = makeProject({ "src/app.ts": "export const x = 1;\n" });
		const result = runDocs(dir);
		expect(result.issues.some((i) => i.rule === "no-readme")).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("credits existing README", () => {
		const dir = makeProject({
			"README.md": "# My App\n\nA description.\n\n## Install\n\nnpm install\n\n## Usage\n\nRun it.\n",
			"src/app.ts": "export const x = 1;\n",
		});
		const result = runDocs(dir);
		expect(result.issues.some((i) => i.rule === "no-readme")).toBe(false);
		rmSync(dir, { recursive: true });
	});

	it("detects undocumented exports", () => {
		const dir = makeProject({
			"README.md": "# App\n\nSome docs\n",
			"src/app.ts": "export function foo() {}\nexport function bar() {}\n",
		});
		const result = runDocs(dir);
		expect(result.issues.some((i) => i.rule === "undocumented-exports")).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("credits JSDoc before export", () => {
		const dir = makeProject({
			"README.md": "# App\n\nSome docs\n",
			"src/app.ts": "/** Does something. */\nexport function foo() {}\n",
		});
		const result = runDocs(dir);
		expect((result.details as any).documentedPct).toBe("100%");
		rmSync(dir, { recursive: true });
	});

	it("credits JSDoc with blank line before export", () => {
		const dir = makeProject({
			"README.md": "# App\n\nSome docs\n",
			"src/app.ts": "/** Does something. */\n\nexport function foo() {}\n",
		});
		const result = runDocs(dir);
		expect((result.details as any).documentedPct).toBe("100%");
		rmSync(dir, { recursive: true });
	});

	it("credits // comment before export", () => {
		const dir = makeProject({
			"README.md": "# App\n\nSome docs\n",
			"src/app.ts": "// Does something.\nexport function foo() {}\n",
		});
		const result = runDocs(dir);
		expect((result.details as any).documentedPct).toBe("100%");
		rmSync(dir, { recursive: true });
	});

	it("uses FileInventory and excludes ignored/generated source", () => {
		const dir = makeProject({
			"README.md": "# App\n\nDocumented enough for this regression.\n\n## Install\n\nnpm install\n\n## Usage\n\nnpm test\n",
			"CHANGELOG.md": "# Changelog\n",
			"src/app.ts": "/** Does something. */\nexport function foo() {}\n",
			"dist/generated.ts": "export function generatedOutput() {}\n",
			".claude/worktrees/agent-a/src/generated.ts": "export function agentOutput() {}\n",
		});
		const result = runDocs(dir, inventory(dir));
		expect(result.details).toMatchObject({
			totalExports: 1,
			documentedExports: 1,
			documentedPct: "100%",
			source: "file-inventory",
		});
		expect(result.issues.some((i) => i.file?.includes(".claude/worktrees") || i.file?.startsWith("dist/"))).toBe(false);
		expect(result.issues.some((i) => i.rule === "undocumented-exports")).toBe(false);
		rmSync(dir, { recursive: true });
	});

	it("flags missing CHANGELOG", () => {
		const dir = makeProject({
			"README.md": "# App\n\nDocs\n",
			"src/app.ts": "export const x = 1;\n",
		});
		const result = runDocs(dir);
		expect(result.issues.some((i) => i.rule === "no-changelog")).toBe(true);
		rmSync(dir, { recursive: true });
	});
});
