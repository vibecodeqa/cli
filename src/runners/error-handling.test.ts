import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectWorkspace } from "../detect.js";
import { buildFileInventory } from "../file-inventory.js";
import { buildEffectiveScanPolicy } from "../scan-policy.js";
import { runErrorHandling } from "./error-handling.js";

function makeProject(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "vcqa-erh-"));
	writeFileSync(join(dir, "package.json"), "{}");
	mkdirSync(join(dir, "src"), { recursive: true });
	for (const [name, content] of Object.entries(files)) {
		const full = join(dir, "src", name);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, content);
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
		const issue = result.issues.find((i) => i.rule === "empty-catch");
		expect(issue).toBeDefined();
		expect(issue!.severity).toBe("warning");
		rmSync(dir, { recursive: true });
	});

	it("ignores acknowledged best-effort empty catch blocks", () => {
		const dir = makeProject({
			"app.ts": `try { optionalCleanup() } catch { } // best-effort cleanup`,
			"cleanup.ts": `try { optionalCleanup() } catch { /* intentional: best-effort cleanup */ }`,
		});
		const result = runErrorHandling(dir);
		expect(result.issues.some((i) => i.rule === "empty-catch")).toBe(false);
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

	it("uses non-overlapping project roots in mixed workspaces", () => {
		const dir = mkdtempSync(join(tmpdir(), "vcqa-erh-mixed-"));
		writeFileSync(join(dir, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
		mkdirSync(join(dir, "packages/api/src"), { recursive: true });
		mkdirSync(join(dir, "packages/web/src"), { recursive: true });
		writeFileSync(join(dir, "packages/api/package.json"), JSON.stringify({ dependencies: {} }));
		writeFileSync(join(dir, "packages/web/package.json"), JSON.stringify({ dependencies: { react: "^19.0.0" } }));
		writeFileSync(join(dir, "packages/api/src/handler.ts"), "export function handler() { try { work(); } catch (e) { } }\n");
		writeFileSync(join(dir, "packages/web/src/App.tsx"), "export function App() { return <div>ok</div>; }\n");

		const result = runErrorHandling(dir, detectWorkspace(dir));

		expect(result.issues).toEqual([expect.objectContaining({ file: "packages/api/src/handler.ts", rule: "empty-catch" })]);
		expect(result.details.projects).toEqual([
			expect.objectContaining({ path: "packages/api", files: 1, issues: 1 }),
			expect.objectContaining({ path: "packages/web", files: 1, issues: 0 }),
		]);
		rmSync(dir, { recursive: true });
	});

	it("uses FileInventory and skips ignored/generated source", () => {
		const dir = makeProject({
			"app.ts": "export function ok() { return true; }\n",
			"../dist/bad.ts": "export function generated() { try { work(); } catch (e) { } }\n",
			"../.claude/worktrees/agent-a/src/bad.ts": 'export function agent() { throw "bad"; }\n',
		});
		const inventory = buildFileInventory(dir, detectWorkspace(dir), buildEffectiveScanPolicy(dir, {}));
		const result = runErrorHandling(dir, undefined, inventory);
		expect(result.details).toMatchObject({ source: "file-inventory" });
		expect(result.issues.some((issue) => issue.file?.startsWith("dist/") || issue.file?.includes(".claude/worktrees"))).toBe(false);
		rmSync(dir, { recursive: true });
	});
});
