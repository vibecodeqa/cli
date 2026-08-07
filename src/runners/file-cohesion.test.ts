import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectWorkspace } from "../detect.js";
import { buildFileInventory } from "../file-inventory.js";
import { buildEffectiveScanPolicy } from "../scan-policy.js";
import { runFileCohesion } from "./file-cohesion.js";

const originalProKey = process.env.VCQA_PRO_KEY;

function makeProject(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "vcqa-cohesion-"));
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

function multiConcernContent(prefix: string): string {
	return Array.from({ length: 120 }, (_, i) =>
		i % 2 === 0
			? `export async function ${prefix}Query${i}(db: { query(sql: string): unknown }) { return db.query("SELECT * FROM users"); }`
			: `export function ${prefix}Auth${i}(token: string) { return token.includes("session"); }`,
	).join("\n");
}

afterEach(() => {
	if (originalProKey === undefined) {
		delete process.env.VCQA_PRO_KEY;
	} else {
		process.env.VCQA_PRO_KEY = originalProKey;
	}
});

describe("runFileCohesion", () => {
	it("uses FileInventory and excludes ignored/generated source", async () => {
		process.env.VCQA_PRO_KEY = "test-key";
		const dir = makeProject({
			"src/app.ts": "export const app = 1;\n",
			"dist/generated.ts": multiConcernContent("dist"),
			".claude/worktrees/agent-a/src/generated.ts": multiConcernContent("agent"),
		});

		const result = await runFileCohesion(dir, inventory(dir));

		expect(result.details).toMatchObject({ totalFiles: 1, multiConcernFiles: 0, source: "file-inventory" });
		expect(result.issues.some((i) => i.file?.includes(".claude/worktrees") || i.file?.startsWith("dist/"))).toBe(false);
		rmSync(dir, { recursive: true });
	});
});
