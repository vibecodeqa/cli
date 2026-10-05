import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run, startToolRecording, takeToolRuns } from "./exec.js";
import { fakeBody, fakeGithubPat, leakedWindows } from "./fake-credentials.test-helper.js";
import { redactSecrets } from "./redact.js";

const p = (...parts: string[]) => parts.join("");

describe("redactSecrets", () => {
	const cases: Array<[string, () => { text: string; body: string }]> = [
		[
			"GitHub classic PAT",
			() => {
				const t = fakeGithubPat();
				return { text: `token is ${t.value} here`, body: t.body };
			},
		],
		["GitHub fine-grained PAT", () => ((b) => ({ text: p("github", "_pat_", b), body: b }))(fakeBody(82))],
		["AWS access key id", () => ((b) => ({ text: `id=${p("AK", "IA")}${b}`, body: b }))(fakeBody(16))],
		["OpenAI key", () => ((b) => ({ text: `"${p("sk", "-proj-")}${b}"`, body: b }))(fakeBody(48))],
		["Anthropic key", () => ((b) => ({ text: p("sk", "-ant-api03-", b), body: b }))(fakeBody(95))],
		["Slack token", () => ((b) => ({ text: p("xo", "xb-", "2345-", b), body: b }))(fakeBody(24))],
		["Stripe key", () => ((b) => ({ text: p("sk", "_live_", b), body: b }))(fakeBody(32))],
		["Google API key", () => ((b) => ({ text: p("AI", "za", b), body: b }))(fakeBody(35))],
		["npm token", () => ((b) => ({ text: `//registry/:_authToken=${p("np", "m_")}${b}`, body: b }))(fakeBody(36))],
		["GitLab PAT", () => ((b) => ({ text: p("gl", "pat-", b), body: b }))(fakeBody(24))],
		["URL password", () => ((b) => ({ text: `postgres://admin:${b}@db.internal:5432/app`, body: b }))(fakeBody(24))],
		["env-style secret", () => ((b) => ({ text: `SESSION_SECRET=${b}\n`, body: b }))(fakeBody(32))],
		["JSON secret field", () => ((b) => ({ text: `{"apiKey": "${b}"}`, body: b }))(fakeBody(28))],
		[
			"PEM private key body",
			() =>
				((b) => ({
					text: `${p("-----BEGIN ", "RSA PRIVATE KEY-----")}\\n${b}\\n${p("-----END ", "RSA PRIVATE KEY-----")}`,
					body: b,
				}))(fakeBody(120)),
		],
	];

	for (const [name, make] of cases) {
		it(`removes every 5-char window of a ${name}`, () => {
			const { text, body } = make();
			const out = redactSecrets(text);
			expect(leakedWindows(body, out)).toEqual([]);
			expect(out).toContain("[REDACTED]");
		});
	}

	it("keeps the labels that make a log readable", () => {
		const b = fakeBody(24);
		expect(redactSecrets(`SESSION_SECRET=${b}`)).toBe("SESSION_SECRET=[REDACTED]");
		expect(redactSecrets(`postgres://admin:${b}@db.internal/app`)).toBe("postgres://admin:[REDACTED]@db.internal/app");
	});

	it("leaves ordinary tool output alone", () => {
		const text = 'src/a.ts:12:3 lint/style/useConst  tokens: 1234  "Secret": "REDACTED"  ruleId: no-unused-vars';
		expect(redactSecrets(text)).toBe(text);
	});
});

describe("run() records redacted output", () => {
	let dir = "";
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = "";
	});

	it("redacts on a successful run", () => {
		const t = fakeGithubPat();
		dir = mkdtempSync(join(tmpdir(), "vcqa-redact-"));
		writeFileSync(join(dir, "out.txt"), `found ${t.value}\n`);
		startToolRecording();
		const { stdout } = run("cat out.txt", dir);
		const [rec] = takeToolRuns();
		expect(stdout).toContain(t.value); // callers still parse the real output
		expect(leakedWindows(t.body, rec.output)).toEqual([]);
		expect(rec.output).toContain("found [REDACTED]");
	});

	it("redacts on the failure branch (non-zero exit, like gitleaks with findings)", () => {
		const t = fakeGithubPat();
		dir = mkdtempSync(join(tmpdir(), "vcqa-redact-"));
		writeFileSync(join(dir, "out.txt"), `{"Match": "${t.value}"}\n`);
		startToolRecording();
		const { ok } = run("cat out.txt; exit 1", dir);
		const [rec] = takeToolRuns();
		expect(ok).toBe(false);
		expect(rec.exitCode).toBe(1);
		expect(leakedWindows(t.body, rec.output)).toEqual([]);
	});

	it("redacts the full output before truncating it, so a value straddling the cap cannot survive in part", () => {
		const t = fakeGithubPat();
		dir = mkdtempSync(join(tmpdir(), "vcqa-redact-"));
		// Place the token so the 8000-char cap falls in the middle of its body.
		const pad = "x".repeat(8000 - 4 - 18);
		writeFileSync(join(dir, "out.txt"), `${pad}${t.value}${"y".repeat(500)}`);
		startToolRecording();
		run("cat out.txt", dir);
		const [rec] = takeToolRuns();
		expect(rec.output.length).toBeLessThanOrEqual(8000);
		expect(leakedWindows(t.body, rec.output)).toEqual([]);
	});
});
