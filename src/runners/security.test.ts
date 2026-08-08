import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectWorkspace } from "../detect.js";
import { buildFileInventory } from "../file-inventory.js";
import { setGlobalSrcRoots } from "../fs-utils.js";
import { buildEffectiveScanPolicy } from "../scan-policy.js";
import { parseEslintSecurityJson, runSecurity } from "./security.js";

function makeProject(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "vcqa-sec-"));
	writeFileSync(join(dir, "package.json"), "{}");
	for (const [name, content] of Object.entries(files)) {
		const full = join(dir, name);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, content);
	}
	return dir;
}

afterEach(() => setGlobalSrcRoots(undefined));

describe("parseEslintSecurityJson", () => {
	it("normalizes eslint-plugin-security paths from nested tool cwd", () => {
		const out = JSON.stringify([
			{
				filePath: "src/server.ts",
				messages: [{ severity: 1, message: "non-literal require", line: 11, ruleId: "security/detect-non-literal-require" }],
			},
			{
				filePath: "../../packages/web/src/terminal.ts",
				messages: [{ severity: 2, message: "child process", line: 4, ruleId: "security/detect-child-process" }],
			},
		]);

		const issues = parseEslintSecurityJson(out, "/repo", "/repo/apps/console")!;

		expect(issues[0]).toMatchObject({
			file: "apps/console/src/server.ts",
			details: {
				repoRelativePath: "apps/console/src/server.ts",
				toolRelativePath: "src/server.ts",
				toolCwd: "/repo/apps/console",
			},
		});
		expect(issues[1]).toMatchObject({
			file: "packages/web/src/terminal.ts",
			details: {
				repoRelativePath: "packages/web/src/terminal.ts",
				toolRelativePath: "../../packages/web/src/terminal.ts",
			},
		});
	});

	it("marks eslint-plugin-security paths outside the repo as non-clickable", () => {
		const out = JSON.stringify([
			{
				filePath: "../../../../outside.ts",
				messages: [{ severity: 2, message: "outside", line: 1, ruleId: "security/detect-eval-with-expression" }],
			},
		]);

		const issues = parseEslintSecurityJson(out, "/repo", "/repo/apps/console")!;

		expect(issues[0].file).toBeUndefined();
		expect((issues[0] as any).details).toMatchObject({
			toolRelativePath: "../../../../outside.ts",
			toolCwd: "/repo/apps/console",
			pathStatus: "outside-repo",
		});
	});
});

describe("runSecurity", () => {
	it("detects innerHTML XSS", () => {
		const dir = makeProject({ "src/app.ts": "el.innerHTML = userInput;\n" });
		const result = runSecurity(dir);
		expect(result.issues.some((i) => i.message.includes("XSS") && i.message.includes("innerHTML"))).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("detects dangerouslySetInnerHTML", () => {
		const dir = makeProject({ "src/App.tsx": "return <div dangerouslySetInnerHTML={{ __html: html }} />;\n" });
		const result = runSecurity(dir);
		expect(result.issues.some((i) => i.message.includes("dangerouslySetInnerHTML"))).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("keeps unsanitized dangerouslySetInnerHTML at error severity", () => {
		const dir = makeProject({
			"src/Comment.tsx": [
				"export function Comment({ userInput }: { userInput: string }) {",
				"\treturn <div dangerouslySetInnerHTML={{ __html: userInput }} />;",
				"}",
			].join("\n"),
		});
		const result = runSecurity(dir);
		const xss = result.issues.filter((i) => i.rule === "CWE-79" && i.file === "src/Comment.tsx");
		expect(xss).toHaveLength(1);
		expect(xss[0].severity).toBe("error");
		rmSync(dir, { recursive: true });
	});

	it("downgrades dangerouslySetInnerHTML fed by a sanitizer call on the same line", () => {
		const dir = makeProject({
			"src/Code.tsx": [
				'import DOMPurify from "dompurify";',
				"export function Code({ raw }: { raw: string }) {",
				"\treturn <div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(raw) }} />;",
				"}",
			].join("\n"),
		});
		const result = runSecurity(dir);
		const xss = result.issues.filter((i) => i.rule === "CWE-79" && i.file === "src/Code.tsx");
		expect(xss).toHaveLength(1);
		expect(xss[0].severity).toBe("info");
		expect(xss[0].message).toContain("DOMPurify");
		rmSync(dir, { recursive: true });
	});

	it("downgrades dangerouslySetInnerHTML fed by highlight.js through a local", () => {
		const dir = makeProject({
			"src/Highlighted.tsx": [
				'import hljs from "highlight.js/lib/common";',
				'import "highlight.js/styles/github-dark.css";',
				"export function Highlighted({ code, lang }: { code: string; lang: string }) {",
				"\tconst html = useMemo(() => {",
				"\t\tif (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value;",
				"\t\treturn hljs.highlightAuto(code).value;",
				"\t}, [code, lang]);",
				'\treturn <pre><code className="hljs" dangerouslySetInnerHTML={{ __html: html }} /></pre>;',
				"}",
			].join("\n"),
		});
		const result = runSecurity(dir);
		const xss = result.issues.filter((i) => i.rule === "CWE-79" && i.file === "src/Highlighted.tsx");
		expect(xss).toHaveLength(1);
		expect(xss[0].severity).toBe("info");
		expect(xss[0].message).toContain("highlight.js");
		rmSync(dir, { recursive: true });
	});

	it("traces dangerouslySetInnerHTML through a local helper that wraps the sanitizer", () => {
		const dir = makeProject({
			"src/Diff.tsx": [
				'import hljs from "highlight.js/lib/common";',
				"function hl(line: string, lang: string): string {",
				"\tif (lang && hljs.getLanguage(lang)) return hljs.highlight(line, { language: lang }).value;",
				"\treturn line;",
				"}",
				"export function Diff({ rows, lang }: { rows: string[]; lang: string }) {",
				"\tconst hlRows = rows.map((r) => hl(r, lang));",
				'\treturn <div>{hlRows.map((h, k) => <code key={k} dangerouslySetInnerHTML={{ __html: hlRows[k] ?? "" }} />)}</div>;',
				"}",
			].join("\n"),
		});
		const result = runSecurity(dir);
		const xss = result.issues.filter((i) => i.rule === "CWE-79" && i.file === "src/Diff.tsx");
		expect(xss).toHaveLength(1);
		expect(xss[0].severity).toBe("info");
		expect(xss[0].message).toContain("highlight.js");
		rmSync(dir, { recursive: true });
	});

	it("still reports an untraced dangerouslySetInnerHTML in a file that imports a sanitizer", () => {
		const dir = makeProject({
			"src/Mixed.tsx": [
				'import hljs from "highlight.js/lib/common";',
				"export function Mixed({ code, comment }: { code: string; comment: string }) {",
				"\tconst html = hljs.highlightAuto(code).value;",
				"\treturn (",
				"\t\t<div>",
				"\t\t\t<code dangerouslySetInnerHTML={{ __html: html }} />",
				"\t\t\t<p dangerouslySetInnerHTML={{ __html: comment }} />",
				"\t\t</div>",
				"\t);",
				"}",
			].join("\n"),
		});
		const result = runSecurity(dir);
		const xss = result.issues.filter((i) => i.rule === "CWE-79" && i.file === "src/Mixed.tsx");
		expect(xss.map((i) => i.severity)).toEqual(["info", "warning"]);
		expect(xss[1].message).toContain("highlight.js");
		expect(xss[1].message).toContain("not traced");
		rmSync(dir, { recursive: true });
	});

	it("detects eval()", () => {
		const dir = makeProject({ "src/app.ts": "eval(userInput);\n" });
		const result = runSecurity(dir);
		expect(result.issues.some((i) => i.message.includes("eval"))).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("detects SQL injection patterns", () => {
		const dir = makeProject({ "src/db.ts": "db.query(`SELECT * FROM users WHERE id = $" + "{userId}`);\n" });
		const result = runSecurity(dir);
		expect(result.issues.some((i) => i.message.includes("SQL"))).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("detects v-html in Vue SFCs", () => {
		const dir = makeProject({ "src/App.vue": '<template><div v-html="content"></div></template>\n<script>export default {}</script>\n' });
		const result = runSecurity(dir);
		expect(result.issues.some((i) => i.message.includes("v-html"))).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("detects {@html} in Svelte", () => {
		const dir = makeProject({ "src/App.svelte": '<p>{@html content}</p>\n<script>let content = "";</script>\n' });
		const result = runSecurity(dir);
		expect(result.issues.some((i) => i.message.includes("{@html}"))).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("returns clean score for safe code", () => {
		const dir = makeProject({
			"src/app.ts": "export function safe(input: string): string {\n  return input.trim();\n}\n",
		});
		const result = runSecurity(dir);
		expect(result.score).toBe(100);
		rmSync(dir, { recursive: true });
	});

	it("handles empty project", () => {
		const dir = makeProject({});
		const result = runSecurity(dir);
		expect(result.score).toBe(100);
		rmSync(dir, { recursive: true });
	});

	it("detects localStorage usage", () => {
		const dir = makeProject({ "src/auth.ts": 'localStorage.setItem("token", jwt);\n' });
		const result = runSecurity(dir);
		expect(result.issues.some((i) => i.message.includes("localStorage"))).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("classifies auth-like browser storage keys as high-signal", () => {
		const dir = makeProject({ "src/session.ts": 'localStorage.setItem("app:session", JSON.stringify(session));\n' });
		const result = runSecurity(dir);
		const storageIssue = result.issues.find((i) => i.rule === "CWE-922");
		expect(storageIssue?.severity).toBe("error");
		expect(storageIssue?.message).toContain("Auth/session-like");
		rmSync(dir, { recursive: true });
	});

	it("does not report UI preference storage in auth-related files", () => {
		const dir = makeProject({
			"src/auth-ui.ts":
				'const tokenLabel = "Sign in";\nlocalStorage.setItem("ui:text-scale", textScale);\nlocalStorage.setItem("last-route", pathname);\n',
		});
		const result = runSecurity(dir);
		expect(result.issues.filter((i) => i.rule === "CWE-922")).toEqual([]);
		rmSync(dir, { recursive: true });
	});

	it("keeps sensitive values visible even with UI-looking storage keys", () => {
		const dir = makeProject({ "src/preferences.ts": 'localStorage.setItem("last-route", accessToken);\n' });
		const result = runSecurity(dir);
		const storageIssue = result.issues.find((i) => i.rule === "CWE-922");
		expect(storageIssue?.severity).toBe("error");
		expect(storageIssue?.message).toContain("Auth/session-like");
		rmSync(dir, { recursive: true });
	});

	it("detects sessionStorage storing secrets", () => {
		const dir = makeProject({ "src/auth.ts": 'sessionStorage.setItem("authToken", token);\n' });
		const result = runSecurity(dir);
		expect(result.issues.some((i) => i.message.includes("sessionStorage"))).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("detects connection strings with embedded credentials", () => {
		const dir = makeProject({ "src/db.ts": 'const url = "postgres://admin:secretpass@db.example.com/mydb";\n' });
		const result = runSecurity(dir);
		expect(result.issues.some((i) => i.message.includes("Connection string"))).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("detects hardcoded passwords in config", () => {
		const dir = makeProject({ "src/config.ts": 'const config = { password: "admin123456" };\n' });
		const result = runSecurity(dir);
		expect(result.issues.some((i) => i.message.includes("Hardcoded password"))).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("detects API keys in fetch headers", () => {
		const dir = makeProject({
			"src/api.ts": 'const res = await fetch(url, { headers: { "Authorization": "Bearer sk-proj-abc123" } });\n',
		});
		const result = runSecurity(dir);
		expect(result.issues.some((i) => i.message.includes("API key hardcoded"))).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("detects permissive CORS", () => {
		const dir = makeProject({
			"src/server.ts": 'res.setHeader("Access-Control-Allow-Origin", "*");\n',
		});
		const result = runSecurity(dir);
		expect(result.issues.some((i) => i.message.includes("CORS"))).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("does not flag Set-Cookie calls that use a secure cookie helper", () => {
		const dir = makeProject({
			"src/oauth-nonce.ts":
				"export function oauthNonceCookie(value: string) {\n  return `oauth_nonce=$" + "{value}; HttpOnly; Secure; SameSite=Lax`;\n}\n",
			"src/routes/auth.ts": 'headers.set("Set-Cookie", oauthNonceCookie(nonce));\n',
		});
		const result = runSecurity(dir);
		expect(result.issues.some((i) => i.rule === "CWE-614")).toBe(false);
		rmSync(dir, { recursive: true });
	});

	it("lowers local dev cookies without Secure to info", () => {
		const dir = makeProject({
			"src/test-job-server-auth.ts":
				'server.listen(8787);\nheaders.set("Set-Cookie", `job_session=$' + "{session}; HttpOnly; SameSite=Lax`);\n",
		});
		const result = runSecurity(dir);
		const cookieIssue = result.issues.find((i) => i.rule === "CWE-614");
		expect(cookieIssue?.severity).toBe("info");
		expect(cookieIssue?.message).toContain("Local/dev");
		rmSync(dir, { recursive: true });
	});

	it("classifies public no-credential wildcard CORS as informational", () => {
		const dir = makeProject({
			"src/metadata.ts":
				'if (url.pathname === "/llms.txt") {\n  return new Response(body, { headers: { "Access-Control-Allow-Origin": "*" } });\n}\n',
		});
		const result = runSecurity(dir);
		const corsIssue = result.issues.find((i) => i.rule === "CWE-346");
		expect(corsIssue?.severity).toBe("info");
		expect(corsIssue?.message).toContain("Public metadata");
		rmSync(dir, { recursive: true });
	});

	it("keeps credentialed wildcard CORS as warning", () => {
		const dir = makeProject({
			"src/api.ts":
				'return new Response(body, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Credentials": "true" } });\n',
		});
		const result = runSecurity(dir);
		const corsIssue = result.issues.find((i) => i.rule === "CWE-346");
		expect(corsIssue?.severity).toBe("warning");
		expect(corsIssue?.message).toContain("Credentialed CORS");
		rmSync(dir, { recursive: true });
	});

	it("detects HTTP fetch (non-localhost)", () => {
		const dir = makeProject({
			"src/api.ts": 'const data = await fetch("http://api.example.com/data");\n',
		});
		const result = runSecurity(dir);
		expect(result.issues.some((i) => i.message.includes("HTTP"))).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("allows HTTP localhost fetch", () => {
		const dir = makeProject({
			"src/dev.ts": 'const data = await fetch("http://localhost:3000/api");\n',
		});
		const result = runSecurity(dir);
		expect(result.issues.some((i) => i.message.includes("plain HTTP"))).toBe(false);
		rmSync(dir, { recursive: true });
	});

	it("detects unvalidated redirect", () => {
		const dir = makeProject({
			"src/auth.ts": "res.redirect(req.query.returnUrl);\n",
		});
		const result = runSecurity(dir);
		expect(result.issues.some((i) => i.message.includes("redirect"))).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("detects debug mode enabled", () => {
		const dir = makeProject({
			"src/config.ts": "export const config = { debug: true, port: 3000 };\n",
		});
		const result = runSecurity(dir);
		expect(result.issues.some((i) => i.message.includes("Debug"))).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("reports storage audit summary", () => {
		const dir = makeProject({
			"src/auth.ts": 'localStorage.setItem("token", jwt);\nconst dbUrl = "postgres://root:pass@localhost/db";\n',
		});
		const result = runSecurity(dir);
		const audit = (result.details as any).storageAudit;
		expect(audit).toBeDefined();
		expect(audit.total).toBeGreaterThan(0);
		rmSync(dir, { recursive: true });
	});

	it("uses FileInventory and skips ignored/generated security findings", () => {
		const dir = makeProject({
			"src/app.ts": "export const safe = true;\n",
			"dist/generated.ts": "eval(userInput);\n",
			".claude/worktrees/agent/src/copy.ts": "eval(userInput);\n",
		});
		const inventory = buildFileInventory(dir, detectWorkspace(dir), buildEffectiveScanPolicy(dir, {}));
		const result = runSecurity(dir, inventory);

		expect(result.issues.some((issue) => issue.rule === "CWE-94")).toBe(false);
		expect((result.details as Record<string, unknown>).filesScanned).toBe(1);
		rmSync(dir, { recursive: true });
	});
});
