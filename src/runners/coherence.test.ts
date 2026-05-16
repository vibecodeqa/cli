import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
});
