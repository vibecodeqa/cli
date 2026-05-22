import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setGlobalSrcRoots } from "../fs-utils.js";
import { runSecurity } from "./security.js";

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

describe("runSecurity", () => {
	it("detects innerHTML XSS", () => {
		const dir = makeProject({ "src/app.ts": 'el.innerHTML = userInput;\n' });
		const result = runSecurity(dir);
		expect(result.issues.some((i) => i.message.includes("XSS") && i.message.includes("innerHTML"))).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("detects dangerouslySetInnerHTML", () => {
		const dir = makeProject({ "src/App.tsx": 'return <div dangerouslySetInnerHTML={{ __html: html }} />;\n' });
		const result = runSecurity(dir);
		expect(result.issues.some((i) => i.message.includes("dangerouslySetInnerHTML"))).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("detects eval()", () => {
		const dir = makeProject({ "src/app.ts": 'eval(userInput);\n' });
		const result = runSecurity(dir);
		expect(result.issues.some((i) => i.message.includes("eval"))).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("detects SQL injection patterns", () => {
		const dir = makeProject({ "src/db.ts": 'db.query(`SELECT * FROM users WHERE id = ${userId}`);\n' });
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
});
