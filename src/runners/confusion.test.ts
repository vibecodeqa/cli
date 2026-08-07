import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectWorkspace } from "../detect.js";
import { buildFileInventory } from "../file-inventory.js";
import { setGlobalSrcRoots } from "../fs-utils.js";
import { buildEffectiveScanPolicy } from "../scan-policy.js";
import { runConfusion } from "./confusion.js";

function makeProject(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "vcqa-conf-"));
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

describe("runConfusion", () => {
	it("detects similar filenames", () => {
		const dir = makeProject({
			"src/user.ts": "export const user = 1;\n",
			"src/users.ts": "export const users = [1];\n",
		});
		const result = runConfusion(dir);
		expect(result.issues.some((i) => i.rule === "similar-filename")).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("does not flag dissimilar filenames", () => {
		const dir = makeProject({
			"src/auth.ts": "export const auth = 1;\n",
			"src/database.ts": "export const db = 1;\n",
		});
		const result = runConfusion(dir);
		expect(result.issues.filter((i) => i.rule === "similar-filename")).toHaveLength(0);
		rmSync(dir, { recursive: true });
	});

	it("returns perfect score for unique names", () => {
		const dir = makeProject({
			"src/authentication.ts": "export const x = 1;\n",
			"src/database.ts": "export const y = 2;\n",
			"src/router.ts": "export const z = 3;\n",
		});
		const result = runConfusion(dir);
		expect(result.score).toBeGreaterThanOrEqual(80);
		rmSync(dir, { recursive: true });
	});

	it("handles empty project", () => {
		const dir = makeProject({});
		const result = runConfusion(dir);
		expect(result.score).toBe(100);
		rmSync(dir, { recursive: true });
	});

	it("uses FileInventory and excludes ignored/generated source", () => {
		const dir = makeProject({
			"src/authentication.ts": "export const authentication = 1;\n",
			"dist/process.ts": "export function run() { return 1; }\n",
			".claude/worktrees/agent-a/src/handler.ts": "export function handle() { return 1; }\n",
		});
		const result = runConfusion(dir, inventory(dir));
		expect(result.details).toMatchObject({ filesScanned: 1, source: "file-inventory" });
		expect(result.issues.some((i) => i.file?.includes(".claude/worktrees") || i.file?.startsWith("dist/"))).toBe(false);
		expect(result.issues.some((i) => i.rule === "generic-name")).toBe(false);
		rmSync(dir, { recursive: true });
	});

	it("reports export collisions as warnings, not errors", () => {
		const dir = makeProject({
			"src/api.ts": "export function createClient() { return 'api'; }\n",
			"src/sdk.ts": "export function createClient() { return 'sdk'; }\n",
		});
		const result = runConfusion(dir);
		const issue = result.issues.find((i) => i.rule === "export-collision");
		expect(issue).toBeDefined();
		expect(issue!.severity).toBe("warning");
		expect(result.issues.filter((i) => i.rule === "export-collision" && i.severity === "error")).toHaveLength(0);
		rmSync(dir, { recursive: true });
	});

	it("works with monorepo srcRoots", () => {
		const dir = makeProject({
			"packages/sdk/src/utils.ts": "export const x = 1;\n",
			"packages/cli/src/helper.ts": "export const y = 2;\n",
			"packages/cli/src/helpers.ts": "export const z = 3;\n",
		});
		setGlobalSrcRoots(["packages/sdk/src", "packages/cli/src"]);
		const result = runConfusion(dir);
		// helper vs helpers = edit distance 1 — should detect across packages
		expect(result.issues.some((i) => i.rule === "similar-filename")).toBe(true);
		setGlobalSrcRoots(undefined);
		rmSync(dir, { recursive: true });
	});
});
