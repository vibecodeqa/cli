import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAccessibility } from "./accessibility.js";

function makeProject(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "vcqa-a11y-"));
	writeFileSync(join(dir, "package.json"), "{}");
	mkdirSync(join(dir, "src"), { recursive: true });
	for (const [name, content] of Object.entries(files)) {
		const full = join(dir, "src", name);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, content);
	}
	return dir;
}

describe("runAccessibility", () => {
	it("skips when no JSX files", async () => {
		const dir = makeProject({ "util.ts": "export const x = 1;" });
		const result = await runAccessibility(dir);
		expect(result.score).toBe(100);
		expect((result.details as any).skipped).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("detects missing alt on img", async () => {
		const dir = makeProject({
			"App.tsx": `export function App() { return <img src="photo.jpg" />; }`,
		});
		const result = await runAccessibility(dir);
		expect(result.issues.some((i) => i.rule === "jsx-a11y/alt-text")).toBe(true);
		expect((result.details as any).standardToolIssues).toBeGreaterThan(0);
		rmSync(dir, { recursive: true });
	});

	it("detects onClick on div without role", async () => {
		const dir = makeProject({
			"App.tsx": `export function App() { return <div onClick={handleClick}>click me</div>; }`,
		});
		const result = await runAccessibility(dir);
		expect(result.issues.some((i) => i.rule === "jsx-a11y/click-events-have-key-events")).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("detects missing html lang", async () => {
		const dir = makeProject({ "App.tsx": `export function App() { return <main>hi</main>; }` });
		writeFileSync(join(dir, "index.html"), "<!DOCTYPE html><html><head></head><body></body></html>");
		const result = await runAccessibility(dir);
		expect(result.issues.some((i) => i.rule === "element-required-attributes")).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("scores 100 for accessible code", async () => {
		const dir = makeProject({
			"App.tsx": `export function App() {
	return (
    <main>
      <img src="photo.jpg" alt="Mountain landscape" />
      <button onClick={handleClick}>Click</button>
    </main>
  );
}`,
		});
		const result = await runAccessibility(dir);
		expect(result.score).toBe(100);
		rmSync(dir, { recursive: true });
	});

	it("keeps built-in heuristics active when eslint-plugin-jsx-a11y is installed", async () => {
		const dir = makeProject({
			"App.tsx": `export function App() { return <button><SearchIcon /></button>; }`,
		});
		writeFileSync(join(dir, "package.json"), JSON.stringify({ devDependencies: { "eslint-plugin-jsx-a11y": "^6.0.0" } }));
		const result = await runAccessibility(dir);
		expect(result.issues.some((i) => i.rule === "button-name")).toBe(true);
		expect((result.details as any).eslintPluginJsxA11y).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("reports wcag, selector, and suggestions for accessibility issues", async () => {
		const dir = makeProject({
			"App.tsx": `export function App() { return <main><img src="photo.jpg" /></main>; }`,
		});
		const result = await runAccessibility(dir);
		const issue = result.issues.find((i) => i.rule === "jsx-a11y/alt-text");
		expect(issue?.wcag).toContain("1.1.1");
		expect(issue?.selector).toContain("img");
		expect(issue?.suggestion).toContain("alt");
		rmSync(dir, { recursive: true });
	});

	it("uses html-validate for static HTML accessibility rules", async () => {
		const dir = makeProject({});
		writeFileSync(join(dir, "index.html"), "<!DOCTYPE html><html><body><main><img src='x'></main></body></html>");
		const result = await runAccessibility(dir);
		expect(result.issues.some((i) => i.rule === "wcag/h37")).toBe(true);
		expect((result.details as any).tools.htmlValidate).toContain("html-validate");
		rmSync(dir, { recursive: true });
	});

	it("detects heading skips, low contrast, and removed focus outlines", async () => {
		const dir = makeProject({
			"App.tsx": `export function App() { return <main><h1>Title</h1><h3>Skipped</h3></main>; }`,
			"style.css": `.bad { color: #777; background: #888; }\nbutton:focus { outline: none; }`,
		});
		const result = await runAccessibility(dir);
		expect(result.issues.some((i) => i.rule === "heading-order")).toBe(true);
		expect(result.issues.some((i) => i.rule === "color-contrast")).toBe(true);
		expect(result.issues.some((i) => i.rule === "focus-visible")).toBe(true);
		rmSync(dir, { recursive: true });
	});
});
