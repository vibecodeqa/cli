import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runSecrets } from "./secrets.js";

const TMP = join(import.meta.dirname!, "__test_secrets__");

function setup(files: Record<string, string>) {
	rmSync(TMP, { recursive: true, force: true });
	mkdirSync(join(TMP, "src"), { recursive: true });
	for (const [path, content] of Object.entries(files)) {
		const full = join(TMP, path);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, content);
	}
}

function cleanup() {
	rmSync(TMP, { recursive: true, force: true });
}

describe("runSecrets", () => {
	it("gives A for clean code", () => {
		setup({ "src/clean.ts": 'const API_URL = "https://api.example.com";\nexport const config = { url: API_URL };' });
		const result = runSecrets(TMP);
		expect(result.grade).toBe("A");
		expect(result.score).toBe(100);
		cleanup();
	});

	it("detects GitHub PAT", () => {
		setup({ "src/bad.ts": 'const token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";' });
		const result = runSecrets(TMP);
		expect(result.issues.length).toBeGreaterThan(0);
		expect(result.issues[0].message).toContain("GitHub");
		expect(result.score).toBeLessThan(100);
		cleanup();
	});

	it("detects AWS access key", () => {
		setup({ "src/aws.ts": 'const key = "AKIAIOSFODNN7EXAMPLE";' });
		const result = runSecrets(TMP);
		expect(result.issues.some((i) => i.message.includes("AWS"))).toBe(true);
		cleanup();
	});

	it("detects private key", () => {
		setup({ "src/key.ts": 'const pk = "-----BEGIN RSA PRIVATE KEY-----\\nMII...";' });
		const result = runSecrets(TMP);
		expect(result.issues.some((i) => i.message.includes("Private Key"))).toBe(true);
		cleanup();
	});

	it("ignores test files", () => {
		setup({ "src/auth.test.ts": 'const token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";' });
		const result = runSecrets(TMP);
		expect(result.issues).toHaveLength(0);
		cleanup();
	});

	it("detects modern OpenAI API keys (sk-proj-)", () => {
		setup({ "src/ai.ts": 'const key = "sk-proj-abcdefghijklmnopqrstuvwxyz123456";' });
		const result = runSecrets(TMP);
		expect(result.issues.some((i) => i.message.includes("OpenAI"))).toBe(true);
		cleanup();
	});

	it("gives A for empty project", () => {
		setup({});
		// No src files to scan
		const result = runSecrets(TMP);
		expect(result.score).toBe(100);
		cleanup();
	});
});
