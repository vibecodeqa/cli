import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectWorkspace } from "../detect.js";
import { buildFileInventory } from "../file-inventory.js";
import { buildEffectiveScanPolicy } from "../scan-policy.js";
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

function makeReactViteProject(files: Record<string, string>, pkg: Record<string, unknown> = {}): string {
	const dir = mkdtempSync(join(tmpdir(), "vcqa-a11y-react-vite-"));
	writeFileSync(
		join(dir, "package.json"),
		JSON.stringify({
			dependencies: { react: "^19.0.0", vite: "^7.0.0" },
			...pkg,
		}),
	);
	mkdirSync(join(dir, "src"), { recursive: true });
	for (const [name, content] of Object.entries(files)) {
		const full = join(dir, "src", name);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, content);
	}
	return dir;
}

describe("runAccessibility", () => {
	it("skips when no JSX files", () => {
		const dir = makeProject({ "util.ts": "export const x = 1;" });
		const result = runAccessibility(dir);
		expect(result.score).toBe(100);
		expect((result.details as any).skipped).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("detects missing alt on img", () => {
		const dir = makeProject({
			"App.tsx": `export function App() { return <img src="photo.jpg" />; }`,
		});
		const result = runAccessibility(dir);
		const issue = result.issues.find((i) => i.rule === "img-alt") as any;
		expect(issue).toBeTruthy();
		expect(issue.wcag).toBe("WCAG 1.1.1");
		expect(issue.fix).toContain("alt");
		rmSync(dir, { recursive: true });
	});

	it("detects onClick on div without role", () => {
		const dir = makeProject({
			"App.tsx": `export function App() { return <div onClick={handleClick}>click me</div>; }`,
		});
		const result = runAccessibility(dir);
		expect(result.issues.some((i) => i.rule === "click-events")).toBe(true);
		rmSync(dir, { recursive: true });
	});

	// #68 — html-quality is the canonical owner of `<html lang>` and the viewport
	// meta. This check used to emit `html-lang` and its own `missing-viewport` for
	// the very same index.html, so a project with both HTML and JSX was billed
	// twice for one defect. See the cross-runner test below for the other half.
	it("leaves <html lang> and viewport meta to html-quality (#68)", () => {
		const dir = makeProject({ "App.tsx": `export function App() { return <div>hi</div>; }` });
		writeFileSync(join(dir, "index.html"), "<!DOCTYPE html><html><head></head><body></body></html>");
		const result = runAccessibility(dir);
		expect(result.issues.some((i) => i.rule === "html-lang")).toBe(false);
		expect(result.issues.some((i) => i.rule === "missing-viewport")).toBe(false);
		// The detail counter that only fed the removed rule is gone too.
		expect(result.details).not.toHaveProperty("missingLang");
		rmSync(dir, { recursive: true });
	});

	it("scores 100 for accessible code", () => {
		const dir = makeProject({
			"App.tsx": `export function App() {
  return (
    <div>
      <img src="photo.jpg" alt="A nice photo" />
      <button onClick={handleClick}>Click</button>
    </div>
  );
}`,
		});
		const result = runAccessibility(dir);
		expect(result.score).toBe(100);
		rmSync(dir, { recursive: true });
	});

	it("does not flag buttons whose label comes from a JSX expression", () => {
		const dir = makeProject({
			"Labels.tsx": `export function Labels({ repo, scanning, copied }) {
  return (
    <div>
      <button className="a" onClick={view}>{repo.name}</button>
      <button className="b" onClick={scan}>{scanning ? "Queued" : "Scan"}</button>
      <button className="c" onClick={copy}><span className="x">{copied}</span></button>
      <button className="d" onClick={save}>{t("actions.save")}</button>
    </div>
  );
}`,
		});
		const result = runAccessibility(dir);
		expect(result.issues.filter((i) => i.rule === "button-name")).toHaveLength(0);
		rmSync(dir, { recursive: true });
	});

	it("does not flag a multi-line button whose label follows a long handler", () => {
		const dir = makeProject({
			"Card.tsx": `export function Card({ repo, scanning }) {
  return (
    <button
      className="btn-ghost"
      style={{ fontSize: "0.65rem", padding: "0.2rem 0.5rem" }}
      disabled={scanning === repo.fullName}
      onClick={async (e) => {
        e.stopPropagation();
        setScanning(repo.fullName);
        try {
          await fetch(\`/api/repos/\${repo.fullName}/scan\`, { method: "POST" });
        } catch { /* trigger failed */ }
        setTimeout(() => setScanning(null), 3000);
      }}
    >
      {scanning === repo.fullName ? "Queued" : "Scan"}
    </button>
  );
}`,
		});
		const result = runAccessibility(dir);
		expect(result.issues.filter((i) => i.rule === "button-name")).toHaveLength(0);
		rmSync(dir, { recursive: true });
	});

	it("still flags icon-only buttons with no accessible name", () => {
		const dir = makeProject({
			"Icons.tsx": `export function Icons() {
  return (
    <div>
      <button className="a" onClick={close}><Icon /></button>
      <button className="b" onClick={close}>{<CloseIcon />}</button>
      <button className="c" onClick={close}>&times;</button>
      <button className="d" onClick={close} />
    </div>
  );
}`,
		});
		const result = runAccessibility(dir);
		expect(result.issues.filter((i) => i.rule === "button-name")).toHaveLength(4);
		rmSync(dir, { recursive: true });
	});

	it("respects an explicit accessible name on an icon-only button", () => {
		const dir = makeProject({
			"Close.tsx": `export function Close() {
  return <button aria-label="Close dialog" onClick={close}><Icon /></button>;
}`,
		});
		const result = runAccessibility(dir);
		expect(result.issues.filter((i) => i.rule === "button-name")).toHaveLength(0);
		rmSync(dir, { recursive: true });
	});

	it("reports button-name on the line that opens the button", () => {
		const source = `export function Toolbar() {
  return (
    <div>
      <span>Toolbar</span>
      <button className="close" onClick={close}><Icon /></button>
    </div>
  );
}`;
		const dir = makeProject({ "Toolbar.tsx": source });
		const result = runAccessibility(dir);
		const lines = source.split("\n");
		const found = result.issues.filter((i) => i.rule === "button-name");
		expect(found).toHaveLength(1);
		for (const found_issue of found) expect(lines[(found_issue.line ?? 0) - 1]).toContain("<button");
		rmSync(dir, { recursive: true });
	});

	it("runs as a first-class React/Vite accessibility group", () => {
		const dir = makeReactViteProject({
			"App.tsx": `export function App() {
  return (
    <main>
      <h1>Dashboard</h1>
      <button><SearchIcon /></button>
      <input id="email" />
      <section><h3>Skipped heading</h3></section>
    </main>
  );
}`,
		});

		const result = runAccessibility(dir, detectWorkspace(dir));

		expect((result.details as any).reactViteApp).toBe(true);
		expect(result.issues.some((i) => i.rule === "button-name")).toBe(true);
		expect(result.issues.some((i) => i.rule === "form-label")).toBe(true);
		expect(result.issues.some((i) => i.rule === "heading-order")).toBe(true);
		expect(result.issues.every((i: any) => i.category === "Accessibility")).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("uses eslint-plugin-jsx-a11y evidence when configured and locally runnable", () => {
		const dir = makeReactViteProject(
			{
				"App.tsx": `export function App() { return <main><img src="photo.jpg" /></main>; }`,
			},
			{
				devDependencies: { "eslint-plugin-jsx-a11y": "^6.10.0", eslint: "^9.0.0" },
			},
		);
		writeFileSync(join(dir, "eslint.config.js"), "export default [{ plugins: { 'jsx-a11y': {} } }];");
		mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
		const eslintBin = join(dir, "node_modules", ".bin", "eslint");
		writeFileSync(
			eslintBin,
			`#!/bin/sh
cat <<'JSON'
[{"filePath":"src/App.tsx","messages":[{"severity":2,"message":"img elements must have an alt prop","line":1,"ruleId":"jsx-a11y/alt-text"}]}]
JSON
`,
		);
		chmodSync(eslintBin, 0o755);

		const result = runAccessibility(dir, detectWorkspace(dir));

		expect((result.details as any).standardSignals["eslint-plugin-jsx-a11y"]).toMatchObject({
			installed: true,
			configured: true,
			ran: true,
			issues: 1,
		});
		expect(result.issues).toContainEqual(
			expect.objectContaining({
				rule: "jsx-a11y/alt-text",
				file: "src/App.tsx",
				source: "eslint-plugin-jsx-a11y",
				wcag: "WCAG 1.1.1",
			}),
		);
		rmSync(dir, { recursive: true });
	});

	it("falls back to VCQA heuristics when jsx-a11y is installed but not runnable", () => {
		const dir = makeReactViteProject(
			{
				"App.tsx": `export function App() { return <main><img src="photo.jpg" /></main>; }`,
			},
			{
				devDependencies: { "eslint-plugin-jsx-a11y": "^6.10.0" },
			},
		);
		writeFileSync(join(dir, "eslint.config.js"), "export default [{ plugins: { 'jsx-a11y': {} } }];");

		const result = runAccessibility(dir, detectWorkspace(dir));

		expect((result.details as any).standardSignals["eslint-plugin-jsx-a11y"]).toMatchObject({
			installed: true,
			configured: true,
			ran: false,
		});
		expect(result.issues).toContainEqual(expect.objectContaining({ rule: "img-alt", source: "vcqa-heuristic" }));
		rmSync(dir, { recursive: true });
	});

	it("skips TSX utility packages that are not frontend apps", () => {
		const dir = makeProject({ "Fake.tsx": `export function Fake() { return <img src="fake.jpg" />; }` });

		const result = runAccessibility(dir, detectWorkspace(dir));

		expect((result.details as any).skipped).toBe(true);
		expect((result.details as any).reason).toBe("no frontend app projects detected");
		expect(result.issues).toEqual([]);
		rmSync(dir, { recursive: true });
	});

	it("scopes component analysis to frontend projects in a mixed monorepo", () => {
		const dir = mkdtempSync(join(tmpdir(), "vcqa-a11y-mixed-"));
		writeFileSync(join(dir, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
		mkdirSync(join(dir, "packages/web/src"), { recursive: true });
		mkdirSync(join(dir, "packages/core/src"), { recursive: true });
		writeFileSync(join(dir, "packages/web/package.json"), JSON.stringify({ dependencies: { react: "^19.0.0" } }));
		writeFileSync(join(dir, "packages/core/package.json"), JSON.stringify({ dependencies: {} }));
		writeFileSync(join(dir, "packages/web/src/App.tsx"), `export function App() { return <img src="photo.jpg" alt="Photo" />; }`);
		writeFileSync(join(dir, "packages/core/src/Fake.tsx"), `export function Fake() { return <img src="fake.jpg" />; }`);

		const result = runAccessibility(dir, detectWorkspace(dir));

		expect(result.issues.some((issue) => issue.file?.startsWith("packages/core/"))).toBe(false);
		expect((result.details as any).projects).toEqual([expect.objectContaining({ path: "packages/web", files: 1 })]);
		rmSync(dir, { recursive: true });
	});

	it("uses FileInventory and skips generated output and agent worktrees", () => {
		const dir = makeProject({
			"App.tsx": `export function App() {
  return <main><h1>Dashboard</h1><img src="photo.jpg" alt="Photo" /></main>;
}`,
		});
		mkdirSync(join(dir, "dist"), { recursive: true });
		mkdirSync(join(dir, ".claude", "worktrees", "agent-a", "src"), { recursive: true });
		writeFileSync(join(dir, "dist", "Generated.tsx"), `export function Generated() { return <img src="generated.jpg" />; }`);
		writeFileSync(
			join(dir, ".claude", "worktrees", "agent-a", "src", "Agent.tsx"),
			`export function Agent() { return <img src="agent.jpg" />; }`,
		);

		const inventory = buildFileInventory(dir, detectWorkspace(dir), buildEffectiveScanPolicy(dir, {}));
		const result = runAccessibility(dir, undefined, inventory);

		expect(result.details).toMatchObject({ source: "file-inventory", jsxFiles: 1 });
		expect(result.issues.some((issue) => issue.file?.startsWith("dist/") || issue.file?.includes(".claude/worktrees"))).toBe(false);
		expect(result.issues.some((issue) => issue.rule === "img-alt")).toBe(false);
		rmSync(dir, { recursive: true });
	});
});
