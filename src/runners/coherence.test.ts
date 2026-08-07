import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectWorkspace } from "../detect.js";
import { buildFileInventory } from "../file-inventory.js";
import { buildEffectiveScanPolicy } from "../scan-policy.js";
import { runCodeCoherence } from "./code-coherence.js";
import { runDocCoherence } from "./doc-coherence.js";

function _makeProject(files?: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "vcqa-coh-"));
	writeFileSync(join(dir, "package.json"), "{}");
	mkdirSync(join(dir, "src"), { recursive: true });
	if (files) {
		for (const [name, content] of Object.entries(files)) {
			writeFileSync(
				join(dir, name.startsWith("src/") ? name.replace("src/", `${join(dir, "src")}/`).replace(join(dir, ""), "") : name),
				content,
			);
		}
	}
	return dir;
}

function makeProject(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "vcqa-coh-"));
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

describe("runDocCoherence", () => {
	it("returns coming-soon placeholder", () => {
		const dir = mkdtempSync(join(tmpdir(), "vcqa-dc-"));
		writeFileSync(join(dir, "package.json"), "{}");
		const result = runDocCoherence(dir);
		expect((result.details as any).comingSoon).toBe(true);
		expect((result.details as any).premium).toBe(true);
		expect(result.score).toBe(0);
		expect(result.issues).toHaveLength(0);
		rmSync(dir, { recursive: true });
	});

	it("detects doc files that exist", () => {
		const dir = mkdtempSync(join(tmpdir(), "vcqa-dc-"));
		writeFileSync(join(dir, "package.json"), "{}");
		writeFileSync(join(dir, "README.md"), "# Hello");
		writeFileSync(join(dir, "CHANGELOG.md"), "## v1.0");
		const result = runDocCoherence(dir);
		const docFiles = (result.details as any).docFiles as string[];
		expect(docFiles).toContain("README.md");
		expect(docFiles).toContain("CHANGELOG.md");
		rmSync(dir, { recursive: true });
	});

	it("uses FileInventory and excludes ignored/generated source", () => {
		const dir = makeProject({
			"src/app.ts": "export const app = 1;\n",
			"dist/generated.ts": "/** Generated JSDoc should not count. */\nexport const generated = 1;\n",
			".claude/worktrees/agent-a/src/work.ts": "/** Agent JSDoc should not count. */\nexport const work = 1;\n",
		});
		const result = runDocCoherence(dir, inventory(dir));
		expect(result.details).toMatchObject({ hasJSDoc: false, source: "file-inventory" });
		rmSync(dir, { recursive: true });
	});
});

describe("runCodeCoherence", () => {
	it("returns coming-soon placeholder", () => {
		const dir = mkdtempSync(join(tmpdir(), "vcqa-cc-"));
		writeFileSync(join(dir, "package.json"), "{}");
		const result = runCodeCoherence(dir);
		expect((result.details as any).comingSoon).toBe(true);
		expect((result.details as any).premium).toBe(true);
		expect(result.score).toBe(0);
		expect(result.issues).toHaveLength(0);
		rmSync(dir, { recursive: true });
	});

	it("counts exports and functions", () => {
		const dir = mkdtempSync(join(tmpdir(), "vcqa-cc-"));
		writeFileSync(join(dir, "package.json"), "{}");
		mkdirSync(join(dir, "src"), { recursive: true });
		writeFileSync(join(dir, "src", "util.ts"), `export function foo() {}\nexport function bar() {}`);
		const result = runCodeCoherence(dir);
		expect((result.details as any).totalExports).toBeGreaterThanOrEqual(2);
		expect((result.details as any).totalFunctions).toBeGreaterThanOrEqual(2);
		rmSync(dir, { recursive: true });
	});

	it("uses FileInventory and excludes ignored/generated source", () => {
		const dir = makeProject({
			"src/app.ts": "const app = 1;\n",
			"dist/generated.ts": "export function generated() {}\n",
			".claude/worktrees/agent-a/src/work.ts": "export function work() {}\n",
		});
		const result = runCodeCoherence(dir, inventory(dir));
		expect(result.details).toMatchObject({
			filesAnalyzed: 1,
			source: "file-inventory",
			totalExports: 0,
			totalFunctions: 0,
		});
		rmSync(dir, { recursive: true });
	});
});
