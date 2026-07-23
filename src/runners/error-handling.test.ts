import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runErrorHandling } from "./error-handling.js";

function makeProject(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "vcqa-erh-"));
	writeFileSync(join(dir, "package.json"), "{}");
	mkdirSync(join(dir, "src"), { recursive: true });
	for (const [name, content] of Object.entries(files)) {
		writeFileSync(join(dir, "src", name), content);
	}
	return dir;
}

describe("runErrorHandling", () => {
	it("returns skipped when no source files", () => {
		const dir = mkdtempSync(join(tmpdir(), "vcqa-erh-"));
		writeFileSync(join(dir, "package.json"), "{}");
		const result = runErrorHandling(dir);
		expect((result.details as any).skipped).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("detects empty catch blocks", () => {
		const dir = makeProject({ "app.ts": `try { foo() } catch (e) { }` });
		const result = runErrorHandling(dir);
		expect(result.issues.some((i) => i.rule === "empty-catch")).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("detects throw string literals", () => {
		const dir = makeProject({ "app.ts": `throw "something went wrong"` });
		const result = runErrorHandling(dir);
		expect(result.issues.some((i) => i.rule === "throw-string")).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("scores 100 for clean code", () => {
		const dir = makeProject({ "app.ts": `export function greet() { return "hello"; }` });
		const result = runErrorHandling(dir);
		expect(result.score).toBe(100);
		rmSync(dir, { recursive: true });
	});

	it("detects error info leakage to client", () => {
		const dir = makeProject({
			"app.ts": "export function handler(req: any, res: any) {\n  try { doStuff(); } catch(err) { res.json({ error: err.stack }); }\n}\n",
		});
		const result = runErrorHandling(dir);
		expect(result.issues.some((i) => i.rule === "error-info-leak")).toBe(true);
		rmSync(dir, { recursive: true });
	});
});
