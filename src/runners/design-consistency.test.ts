import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectWorkspace } from "../detect.js";
import { buildFileInventory } from "../file-inventory.js";
import { buildEffectiveScanPolicy } from "../scan-policy.js";
import { runDesignConsistency } from "./design-consistency.js";

function makeProject(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "vcqa-design-consistency-"));
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

describe("runDesignConsistency", () => {
	it("keeps coming-soon behavior without a Pro key", async () => {
		const original = process.env.VCQA_PRO_KEY;
		delete process.env.VCQA_PRO_KEY;
		const dir = makeProject({ "src/App.tsx": "export function App() { return <main />; }\n" });
		const result = await runDesignConsistency(dir, inventory(dir));
		expect(result.details).toMatchObject({ premium: true, comingSoon: true });
		expect(result.issues).toHaveLength(0);
		if (original === undefined) delete process.env.VCQA_PRO_KEY;
		else process.env.VCQA_PRO_KEY = original;
		rmSync(dir, { recursive: true });
	});

	it("uses FileInventory and excludes ignored/generated components", async () => {
		const original = process.env.VCQA_PRO_KEY;
		process.env.VCQA_PRO_KEY = "test-key";
		const dir = makeProject({
			"src/App.tsx": 'export function App() { return <main className="p-4" />; }\n',
			"dist/Generated.tsx": 'export function Generated() { return <main className="p-4" />; }\n',
			".claude/worktrees/agent-a/src/Work.tsx": 'export function Work() { return <main className="p-4" />; }\n',
		});
		const result = await runDesignConsistency(dir, inventory(dir));
		expect(result.details).toMatchObject({ componentsAnalyzed: 1, source: "file-inventory" });
		expect(result.issues).toHaveLength(0);
		if (original === undefined) delete process.env.VCQA_PRO_KEY;
		else process.env.VCQA_PRO_KEY = original;
		rmSync(dir, { recursive: true });
	});
});
