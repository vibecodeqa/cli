import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectWorkspace } from "../detect.js";
import { buildFileInventory } from "../file-inventory.js";
import { buildEffectiveScanPolicy } from "../scan-policy.js";
import { runMemorySafety } from "./memory-safety.js";

describe("memory-safety", () => {
	it("keeps the legacy check id but exposes Resource Lifecycle semantics", () => {
		const dir = mkdtempSync(join(tmpdir(), "vcqa-memory-label-"));
		mkdirSync(join(dir, "src"), { recursive: true });
		writeFileSync(join(dir, "package.json"), "{}");
		writeFileSync(join(dir, "src", "App.tsx"), "export function App() { setInterval(() => {}, 1000); return null; }\n");

		const result = runMemorySafety(dir);

		expect(result.name).toBe("memory-safety");
		expect(result.details).toMatchObject({
			label: "Resource Lifecycle",
			legacyId: "memory-safety",
			semantics: "js-ts-resource-lifecycle",
		});
		rmSync(dir, { recursive: true });
	});

	it("uses non-overlapping project roots in mixed workspaces", () => {
		const dir = mkdtempSync(join(tmpdir(), "vcqa-memory-mixed-"));
		writeFileSync(join(dir, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
		mkdirSync(join(dir, "packages/web/src"), { recursive: true });
		mkdirSync(join(dir, "packages/core/src"), { recursive: true });
		writeFileSync(join(dir, "packages/web/package.json"), JSON.stringify({ dependencies: { react: "^19.0.0" } }));
		writeFileSync(join(dir, "packages/core/package.json"), JSON.stringify({ dependencies: {} }));
		writeFileSync(join(dir, "packages/web/src/App.tsx"), "export function App() { setInterval(() => {}, 1000); return null; }\n");
		writeFileSync(join(dir, "packages/core/src/index.ts"), "export const value = 1;\n");

		const result = runMemorySafety(dir, detectWorkspace(dir));

		expect(result.issues).toEqual([expect.objectContaining({ file: "packages/web/src/App.tsx", rule: "interval-leak" })]);
		expect(result.details.projects).toEqual([
			expect.objectContaining({ path: "packages/core", files: 1, issues: 0 }),
			expect.objectContaining({ path: "packages/web", files: 1, issues: 1 }),
		]);
		rmSync(dir, { recursive: true });
	});

	it("uses FileInventory and skips ignored/generated source", () => {
		const dir = mkdtempSync(join(tmpdir(), "vcqa-memory-inventory-"));
		writeFileSync(join(dir, "package.json"), "{}");
		mkdirSync(join(dir, "src"), { recursive: true });
		mkdirSync(join(dir, "dist"), { recursive: true });
		mkdirSync(join(dir, ".claude/worktrees/agent-a/src"), { recursive: true });
		writeFileSync(join(dir, "src", "App.tsx"), "export function App() { return null; }\n");
		writeFileSync(join(dir, "dist", "generated.ts"), "export function Generated() { setInterval(() => {}, 1000); }\n");
		writeFileSync(
			join(dir, ".claude/worktrees/agent-a/src", "Generated.tsx"),
			"export function Generated() { window.addEventListener('resize', () => {}); return null; }\n",
		);

		const inventory = buildFileInventory(dir, detectWorkspace(dir), buildEffectiveScanPolicy(dir, {}));
		const result = runMemorySafety(dir, undefined, inventory);

		expect(result.details).toMatchObject({ source: "file-inventory", totalFiles: 1 });
		expect(result.issues.some((issue) => issue.file?.startsWith("dist/") || issue.file?.includes(".claude/worktrees"))).toBe(false);
		rmSync(dir, { recursive: true });
	});
});
