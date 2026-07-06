import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectFileActivity } from "./activity.js";
import type { CheckResult } from "./types.js";

function makeProject(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "vcqa-activity-"));
	writeFileSync(join(dir, "package.json"), "{}");
	for (const [name, content] of Object.entries(files)) {
		const full = join(dir, name);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, content);
	}
	return dir;
}

function checkWithIssue(file: string): CheckResult {
	return {
		name: "standards",
		score: 50,
		grade: "D",
		details: {},
		duration: 1,
		issues: [{ severity: "warning", message: "large file", file, rule: "large-file" }],
	};
}

describe("collectFileActivity", () => {
	it("combines source lines, issue counts, and recent changes", () => {
		const dir = makeProject({ "src/app.ts": "export const a = 1;\nexport const b = 2;\n" });
		const activity = collectFileActivity(dir, [checkWithIssue("src/app.ts")], { "src/app.ts": 2 });
		const app = activity.find((item) => item.file === "src/app.ts");

		expect(app).toMatchObject({
			file: "src/app.ts",
			lines: 3,
			recent: 2,
			issues: { warnings: 1, total: 1 },
		});
		expect(app!.heat).toBeGreaterThan(0);
		rmSync(dir, { recursive: true });
	});

	it("includes changed and untracked git files", () => {
		const dir = makeProject({ "src/app.ts": "export const a = 1;\n" });
		execSync("git init && git config user.email 'test@test.com' && git config user.name 'Test' && git add -A && git commit -m init", {
			cwd: dir,
			stdio: "pipe",
		});
		writeFileSync(join(dir, "src", "app.ts"), "export const a = 1;\nexport const b = 2;\n");
		writeFileSync(join(dir, "src", "new.ts"), "export const c = 3;\n");

		const activity = collectFileActivity(dir, [], {});
		const app = activity.find((item) => item.file === "src/app.ts");
		const added = activity.find((item) => item.file === "src/new.ts");

		expect(app?.status).toBe("M");
		expect(app?.added).toBeGreaterThan(0);
		expect(added?.status).toBe("?");
		rmSync(dir, { recursive: true });
	});
});
