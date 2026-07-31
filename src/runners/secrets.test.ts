import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runSecrets } from "./secrets.js";

let TMP = "";

function setup(files: Record<string, string>) {
	TMP = mkdtempSync(join(tmpdir(), "vcqa-secrets-"));
	mkdirSync(join(TMP, "src"), { recursive: true });
	for (const [path, content] of Object.entries(files)) {
		const full = join(TMP, path);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, content);
	}
}

function cleanup() {
	if (TMP) rmSync(TMP, { recursive: true, force: true });
	TMP = "";
}

describe("runSecrets", () => {
	it("gives A for clean code", async () => {
		setup({ "src/clean.ts": 'const API_URL = "https://api.example.com";\nexport const config = { url: API_URL };' });
		const result = await runSecrets(TMP);
		expect(result.grade).toBe("A");
		expect(result.score).toBe(100);
		cleanup();
	});

	it("detects GitHub PAT", async () => {
		setup({ "src/bad.ts": 'const token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";' });
		const result = await runSecrets(TMP);
		expect(result.issues.length).toBeGreaterThan(0);
		expect(result.issues[0].message).toContain("GitHub");
		expect(result.score).toBeLessThan(100);
		cleanup();
	});

	it("detects AWS access key", async () => {
		setup({ "src/aws.ts": 'const key = "AKIAIOSFODNN7EXAMPLE";' });
		const result = await runSecrets(TMP);
		expect(result.issues.some((i) => i.message.includes("AWS"))).toBe(true);
		cleanup();
	});

	it("detects private key", async () => {
		setup({ "src/key.ts": 'const pk = "-----BEGIN RSA PRIVATE KEY-----\\nMII...";' });
		const result = await runSecrets(TMP);
		expect(result.issues.some((i) => i.message.includes("Private Key"))).toBe(true);
		cleanup();
	});

	it("ignores test files", async () => {
		setup({ "src/auth.test.ts": 'const token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";' });
		const result = await runSecrets(TMP);
		expect(result.issues).toHaveLength(0);
		cleanup();
	});

	it("detects modern OpenAI API keys (sk-proj-)", async () => {
		setup({ "src/ai.ts": 'const key = "sk-proj-abcdefghijklmnopqrstuvwxyz123456";' });
		const result = await runSecrets(TMP);
		expect(result.issues.some((i) => i.message.includes("OpenAI"))).toBe(true);
		cleanup();
	});

	it("gives A for empty project", async () => {
		setup({});
		const result = await runSecrets(TMP);
		expect(result.score).toBe(100);
		cleanup();
	});

	it("suggests gitleaks in details when not installed", async () => {
		setup({ "src/app.ts": "export const x = 1;\n" });
		const result = await runSecrets(TMP);
		const details = result.details as Record<string, unknown>;
		expect(details.suggestion).toContain("gitleaks");
		// Suggestion should NOT be in issues
		expect(result.issues.some((i) => (i as any).rule === "suggest-gitleaks")).toBe(false);
		cleanup();
	});
});
