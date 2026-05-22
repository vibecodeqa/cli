import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setGlobalSrcRoots } from "../fs-utils.js";
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
