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

	it("keeps real-looking tokens in test files visible as probable leaks", async () => {
		setup({ "src/auth.test.ts": 'const token = "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";' });
		const result = await runSecrets(TMP);
		expect(result.issues.some((i) => i.severity === "error" && i.message.includes("GitHub"))).toBe(true);
		cleanup();
	});

	it("does not downgrade plausible provider tokens just because they are in tests", async () => {
		setup({
			"src/provider.test.ts": 'const key = "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz1234567890";',
		});
		const result = await runSecrets(TMP);
		expect(result.issues.some((i) => i.severity === "error" && i.message.includes("OpenAI"))).toBe(true);
		cleanup();
	});

	it("downgrades obvious fixture secrets instead of reporting high-severity leaks", async () => {
		setup({
			"workers/api/src/lib/gmail.test.ts": `
				const url = "https://example.test/callback?token=abc123def456ghi789";
				const second = "https://example.test/callback?token=abcdef0123456789abcdef";
			`,
			"workers/api/src/routes/keys.integration.test.ts": `
				const roundTrip = "sk-round-trip-1234567890";
				const ownerOnly = "sk-owner-only-000000";
				const shortFixture = "sk-x1234567890abc";
			`,
		});
		const result = await runSecrets(TMP);
		expect(result.issues.length).toBeGreaterThan(0);
		expect(result.issues.every((i) => i.severity !== "error")).toBe(true);
		expect(result.issues.every((i) => i.message.includes("likely test/docs placeholder"))).toBe(true);
		expect(result.score).toBeGreaterThanOrEqual(75);
		cleanup();
	});

	it("downgrades deterministic redaction and crypto fixtures in test files", async () => {
		setup({
			"packages/browser-runner/src/coding/engine-acts.test.ts": `
				expect(redactCommand("GH_TOKEN=ghp_abcdefghijklmnopqrstuvwx git push origin main")).toContain("GH_TOKEN=***");
				expect(redactCommand("git push https://x-access-token:ghs_secretsecret1234@github.com/o/r main")).toContain("https://***@github.com/o/r main");
				expect(redactCommand("curl -H 'x: sk-abcdefghijklmnopqrstuv' https://api")).toContain("sk-***");
			`,
			"workers/api/src/lib/crypto.test.ts": `
				expect(await decryptKey(ciphertext, dekWrapped, iv, TEST_KEK)).toBe("sk-test-1234567890abcdef");
				expect(await decryptKey(ciphertext, dekWrapped, iv, TEST_KEK)).toBe("sk-ant-api03-XXXXXXXXXXXXXXXXXXXX");
				expect(await decryptKey(ciphertext, dekWrapped, iv, TEST_KEK)).toBe("AIzaSyD-XXXXXXXXXXXXXXXXXXXXXXXXXXXX");
				expect(await decryptKey(ciphertext, dekWrapped, iv, TEST_KEK)).toBe("sk-secret-plaintext-value");
			`,
			"workers/api/src/routes/keys.integration.test.ts": `
				await json(app, env, "PUT", "/v1/keys/openai", { key: "sk-example-roundtrip-not-a-real-key" }, tok);
				await json(app, env, "PUT", "/v1/keys/openai", { key: "sk-example-owner-scoped-not-a-real-key" }, tok);
			`,
		});
		const result = await runSecrets(TMP);
		expect(result.issues.length).toBeGreaterThan(0);
		expect(result.issues.every((i) => i.severity !== "error")).toBe(true);
		expect(result.issues.every((i) => i.message.includes("likely test/docs placeholder"))).toBe(true);
		cleanup();
	});

	it("downgrades secret-detector and trace-redaction regression fixtures", async () => {
		setup({
			"packages/compliance/src/index.test.ts": `
				it("fails when OpenAI key is hardcoded", async () => {
					writeFiles(dir, {
						"src/index.ts": 'const key = "sk-aBcDeFgHiJkLmNoPqRsTuVwXyZ123456789012345";',
					});
					expect(results.find((r) => r.name === "security-no-hardcoded-secrets")?.pass).toBe(false);
				});
				it("fails when AWS key is hardcoded", async () => {
					writeFiles(dir, {
						"src/index.ts": 'const awsKey = "AKIAIOSFODNN7EXAMPLE";',
					});
					expect(results.find((r) => r.name === "security-no-hardcoded-secrets")?.pass).toBe(false);
				});
			`,
			"workers/api/src/lib/connectors/mcp.test.ts": `
				it("never writes the bearer token into the trace", async () => {
					const { ctx, events } = makeCtx({ token: "sk-live-supersecrettoken12345" });
					expect(JSON.stringify(events)).not.toContain("supersecrettoken");
				});
				it("logs the endpoint without its query string, because that query is often the credential", async () => {
					await callTool.handler(ctx, { url: "https://example.com/mcp?key=sk-live-abcdefghijklmnop", tool: "x" });
					expect(blob).not.toContain("abcdefghijklmnop");
				});
				it("keeps a credential out of the refusal text and the trace row", async () => {
					const { ctx, events } = makeCtx({ token: "sk-live-should-never-appear" });
					expect(JSON.stringify(events)).not.toContain("sk-live-should-never-appear");
				});
			`,
			"workers/api/src/lib/github-app.test.ts": `
				/** Export a generated RSA private key as PKCS#8 PEM. */
				async function makePem() {
					return { pem: \`-----BEGIN PRIVATE KEY-----\\n\${b64}\\n-----END PRIVATE KEY-----\` };
				}
			`,
		});
		const result = await runSecrets(TMP);
		expect(result.issues.length).toBeGreaterThan(0);
		expect(result.issues.every((i) => i.severity !== "error")).toBe(true);
		expect(result.issues.every((i) => i.message.includes("likely test/docs placeholder"))).toBe(true);
		cleanup();
	});

	it("downgrades documentation placeholders instead of treating them as leaked credentials", async () => {
		setup({ "store/get-started/index.html": "<code>curl -H 'Authorization: Bearer YOUR_TOKEN' https://api.example.test</code>\n" });
		const result = await runSecrets(TMP);
		expect(result.issues.length).toBeGreaterThan(0);
		expect(result.issues.every((i) => i.severity !== "error")).toBe(true);
		expect(result.issues.every((i) => i.message.includes("likely test/docs placeholder"))).toBe(true);
		cleanup();
	});

	it("detects modern OpenAI API keys (sk-proj-)", async () => {
		setup({ "src/ai.ts": 'const key = "sk-proj-abcdefghijklmnopqrstuvwxyz123456";' });
		const result = await runSecrets(TMP);
		expect(result.issues.some((i) => i.message.includes("OpenAI"))).toBe(true);
		cleanup();
	});

	it("ignores secrets inside generated agent worktrees", async () => {
		setup({
			"src/clean.ts": "export const clean = true;\n",
			".claude/worktrees/agent-a/src/copied.ts": 'const key = "sk-proj-abcdefghijklmnopqrstuvwxyz123456";\n',
		});
		const result = await runSecrets(TMP);
		expect(result.issues.some((i) => i.file?.includes(".claude/worktrees"))).toBe(false);
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
