import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectWorkspace } from "../detect.js";
import { buildFileInventory } from "../file-inventory.js";
import { buildEffectiveScanPolicy } from "../scan-policy.js";
import { runGitHygiene } from "./git-hygiene.js";

let dir: string | null = null;

function makeProject(files: Record<string, string>): string {
	dir = mkdtempSync(join(tmpdir(), "vcqa-git-hygiene-"));
	mkdirSync(join(dir, ".git"), { recursive: true });
	writeFileSync(join(dir, "package.json"), "{}");
	for (const [name, content] of Object.entries(files)) {
		const full = join(dir, name);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, content);
	}
	return dir;
}

afterEach(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
	dir = null;
});

describe("runGitHygiene", () => {
	it("uses FileInventory and skips ignored/generated merge conflict markers", () => {
		const cwd = makeProject({
			"src/app.ts": "export const ok = true;\n",
			"dist/generated.ts": "<<<<<<< HEAD\nexport const bad = 1;\n=======\nexport const bad = 2;\n>>>>>>> branch\n",
			".claude/worktrees/agent/src/copy.ts": "<<<<<<< HEAD\nexport const bad = 1;\n=======\nexport const bad = 2;\n>>>>>>> branch\n",
		});
		const inventory = buildFileInventory(cwd, detectWorkspace(cwd), buildEffectiveScanPolicy(cwd, {}));

		const result = runGitHygiene(cwd, inventory);

		expect(result.issues.filter((issue) => issue.rule === "merge-conflict")).toEqual([]);
	});
});
