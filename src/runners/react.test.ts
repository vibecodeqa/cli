import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectWorkspace } from "../detect.js";
import { buildFileInventory } from "../file-inventory.js";
import { buildEffectiveScanPolicy } from "../scan-policy.js";
import { parseReactEslintIssues, runReact } from "./react.js";

function makeProject(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "vcqa-react-"));
	writeFileSync(join(dir, "package.json"), "{}");
	mkdirSync(join(dir, "src"), { recursive: true });
	for (const [name, content] of Object.entries(files)) {
		const full = join(dir, "src", name);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, content);
	}
	return dir;
}

describe("runReact", () => {
	it("skips when there are no JSX/TSX files (framework gating is central, in core.ts)", () => {
		const dir = makeProject({ "util.ts": "export const x = 1;" });
		const result = runReact(dir);
		expect(result.score).toBe(100);
		expect((result.details as any).skipped).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("warns about missing Error Boundary (flat 5-point penalty)", () => {
		const dir = makeProject({ "App.tsx": `export function App() { return <div>hi</div>; }` });
		const result = runReact(dir);
		expect(result.issues.some((i) => i.rule === "no-error-boundary")).toBe(true);
		expect((result.details as any).hasErrorBoundary).toBe(false);
		expect(result.score).toBe(95);
		rmSync(dir, { recursive: true });
	});

	it("no boundary warning when an ErrorBoundary exists", () => {
		const dir = makeProject({
			"App.tsx": `export function App() { return <div>hi</div>; }`,
			"Boundary.tsx": `export class ErrorBoundary extends React.Component { componentDidCatch() {} render() { return this.props.children; } }`,
		});
		const result = runReact(dir);
		expect(result.issues.some((i) => i.rule === "no-error-boundary")).toBe(false);
		rmSync(dir, { recursive: true });
	});

	it("detects missing keys in .map()", () => {
		const dir = makeProject({
			"App.tsx": `export function App() {
  const items = [1, 2, 3];
  return <div>{items.map(i => <span>{i}</span>)}</div>;
}`,
		});
		const result = runReact(dir);
		expect(result.issues.some((i) => i.rule === "missing-key")).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("detects index as key", () => {
		const dir = makeProject({
			"App.tsx": `export function App() {
  return <div>{items.map((item, i) => <span key={i}>{item}</span>)}</div>;
}`,
		});
		const result = runReact(dir);
		expect(result.issues.some((i) => i.rule === "index-key")).toBe(true);
		rmSync(dir, { recursive: true });
	});

	// Regression: a self-contained single-line conditional `if (x) { foo(); }`
	// must not leave the brace depth stuck, falsely flagging a following top-level
	// hook as conditional.
	it("does not flag a hook after a self-closing single-line conditional", () => {
		const dir = makeProject({
			"App.tsx": `import { useState } from "react";
export function App() {
  if (globalThis.DEBUG) { console.log("debug"); }
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount(count + 1)}>{count}</button>;
}`,
		});
		const result = runReact(dir);
		expect(result.issues.some((i) => i.rule === "conditional-hook")).toBe(false);
		rmSync(dir, { recursive: true });
	});

	// Sanity: a hook genuinely inside an open conditional block IS still flagged.
	it("still flags a hook inside an open conditional block", () => {
		const dir = makeProject({
			"App.tsx": `import { useState } from "react";
export function App({ on }) {
  if (on) {
    const [count, setCount] = useState(0);
    return <span>{count}</span>;
  }
  return null;
}`,
		});
		const result = runReact(dir);
		expect(result.issues.some((i) => i.rule === "conditional-hook")).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("scores 100 for clean React code", () => {
		const dir = makeProject({
			"App.tsx": `import { useState } from "react";
export function App() {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount(c => c + 1)}>{count}</button>;
}`,
			"ErrorBoundary.tsx": `export class ErrorBoundary extends React.Component { componentDidCatch() {} render() { return this.props.children; } }`,
		});
		const result = runReact(dir);
		expect(result.score).toBe(100);
		rmSync(dir, { recursive: true });
	});

	// Regression: missing-key must NOT fire on .map() that doesn't return JSX.
	// The old /<\w/ heuristic mis-matched TS generics (Record<…>), comparisons, and
	// unrelated JSX further down the file.
	it("does not flag data maps that return values/objects", () => {
		const dir = makeProject({
			"data.tsx": `import { join } from "node:path";
type Rec = Record<string, number>;
export const paths = ["a", "b"].map((d) => join("/x", d));
export const objs = [{ name: "a" }].map((i) => ({ check: i.name }));
export const chars = [1, 2, 3].map((v) => \`#\${v}\`).join("");
export const cmp = [1, 2].map((v) => (v < 2 ? "lo" : "hi"));`,
		});
		const result = runReact(dir);
		expect(result.issues.some((i) => i.rule === "missing-key")).toBe(false);
		rmSync(dir, { recursive: true });
	});

	it("does not flag a non-JSX map even when JSX appears later in the file", () => {
		const dir = makeProject({
			"mixed.tsx": `export function widths(roots: string[]) {
  return roots.map((d) => d.length);
}
export function View({ items }: { items: string[] }) {
  return <ul>{items.map((x) => <li key={x}>{x}</li>)}</ul>;
}`,
		});
		const result = runReact(dir);
		expect(result.issues.some((i) => i.rule === "missing-key")).toBe(false);
		rmSync(dir, { recursive: true });
	});

	it("does not flag inline JSX map that has a key", () => {
		const dir = makeProject({
			"good.tsx": `export const L = (items: string[]) => <ul>{items.map((x) => <li key={x}>{x}</li>)}</ul>;`,
		});
		const result = runReact(dir);
		expect(result.issues.some((i) => i.rule === "missing-key")).toBe(false);
		rmSync(dir, { recursive: true });
	});

	it("flags a block-body JSX map without a key", () => {
		const dir = makeProject({
			"block.tsx": `export const B = (rows: string[]) => (
  <table>
    {rows.map((r) => {
      return <tr><td>{r}</td></tr>;
    })}
  </table>
);`,
		});
		const result = runReact(dir);
		expect(result.issues.some((i) => i.rule === "missing-key")).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("emits structured React health categories and tooling state", () => {
		const dir = makeProject({
			"App.tsx": `import { useEffect } from "react";
export function App({ items }: { items: string[] }) {
  useEffect(() => {
    document.querySelector("#root");
  });
  return <ul>{items.map((x, index) => <li key={index}>{x}</li>)}</ul>;
}`,
		});
		const result = runReact(dir);
		const details = result.details as any;
		expect(details.metrics).toContainEqual({ id: "jsxFiles", label: "JSX/TSX files", value: 1 });
		expect(details.tooling).toMatchObject({
			eslintPluginReactHooks: false,
			eslintPluginReact: false,
			eslintPluginReactRefresh: false,
			hooksCoveredByLint: false,
		});
		expect(details.categories).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "effects", issues: 1 }),
				expect.objectContaining({ id: "rendering", issues: 1 }),
				expect.objectContaining({ id: "component-structure", issues: 1 }),
				expect.objectContaining({ id: "error-boundary", issues: 1 }),
				expect.objectContaining({ id: "compiler-readiness", issues: 0 }),
			]),
		);
		rmSync(dir, { recursive: true });
	});

	it("does not parse JSX comments as real hooks, maps, DOM queries, or handlers", () => {
		const dir = makeProject({
			"App.tsx": `import { useState } from "react";
export class ErrorBoundary extends React.Component { componentDidCatch() {} render() { return this.props.children; } }
export function App() {
  return <div>{/*
    if (ready) { useState(0); }
    items.map((x) => <span>{x}</span>)
    <button onClick={() => document.querySelector("#x")}>bad</button>
  */}<span>ok</span></div>;
}`,
		});
		const result = runReact(dir);
		expect(result.issues.some((i) => ["conditional-hook", "missing-key", "direct-dom"].includes(i.rule ?? ""))).toBe(false);
		expect((result.details as any).inlineHandlers).toBe(0);
		rmSync(dir, { recursive: true });
	});

	it("does not parse non-markup template literals as direct DOM usage", () => {
		const dir = makeProject({
			"App.tsx": `export class ErrorBoundary extends React.Component { componentDidCatch() {} render() { return this.props.children; } }
export function App() {
  const debug = \`document.querySelector("#root") and onClick={() => run()}\`;
  return <div>{debug}</div>;
}`,
		});
		const result = runReact(dir);
		expect(result.issues.some((i) => i.rule === "direct-dom")).toBe(false);
		expect((result.details as any).inlineHandlers).toBe(0);
		rmSync(dir, { recursive: true });
	});

	it("classifies tested sanitizer boundaries for React raw HTML sinks as contextual info", () => {
		const dir = makeProject({
			"App.tsx": `export class ErrorBoundary extends React.Component { componentDidCatch() {} render() { return this.props.children; } }
const renderMd = (value: string) => value.replace(/</g, "&lt;");
export function App({ text }: { text: string }) {
  return <div dangerouslySetInnerHTML={{ __html: renderMd(text) }} />;
}`,
			"ui.test.ts": `import { expect, it } from "vitest";
it("escapes markdown html", () => {
  expect(renderMd("<script>x</script>")).not.toContain("<script>");
});`,
		});
		const result = runReact(dir);
		expect(result.issues).toContainEqual(
			expect.objectContaining({
				severity: "info",
				rule: "react-dangerous-html-sanitized",
				file: "src/App.tsx",
				snippet: "renderMd(text)",
			}),
		);
		expect(result.issues.some((i) => i.rule === "react-dangerous-html")).toBe(false);
		expect((result.details as any).sanitizedDangerousHtml).toBe(1);
		expect((result.details as any).sanitizedDangerousHtmlWithoutTests).toBe(0);
		expect((result.details as any).rawDangerousHtml).toBe(0);
		expect((result.details as any).dangerousHtmlContexts).toContainEqual(
			expect.objectContaining({
				classification: "sanitized-tested",
				sanitizer: "renderMd",
				sourceKind: "markdown-renderer",
				tested: true,
			}),
		);
		rmSync(dir, { recursive: true });
	});

	it("recognizes tested terminal renderer boundaries for React raw HTML sinks", () => {
		const dir = makeProject({
			"Terminal.tsx": `export class ErrorBoundary extends React.Component { componentDidCatch() {} render() { return this.props.children; } }
const renderTerminal = (value: string) => value.replace(/\\x1b\\[[0-9;]*m/g, "");
export function Terminal({ text }: { text: string }) {
  const rendered = renderTerminal(text);
  return <pre dangerouslySetInnerHTML={{ __html: rendered }} />;
}`,
			"terminal-render.test.ts": `import { expect, it } from "vitest";
it("renders terminal text safely", () => {
  expect(renderTerminal("\\x1b[31mred")).toContain("red");
});`,
		});
		const result = runReact(dir);
		expect(result.issues).toContainEqual(
			expect.objectContaining({
				severity: "info",
				rule: "react-dangerous-html-sanitized",
				file: "src/Terminal.tsx",
				snippet: "rendered",
			}),
		);
		expect((result.details as any).dangerousHtmlContexts).toContainEqual(
			expect.objectContaining({
				classification: "sanitized-tested",
				sanitizer: "renderTerminal",
				sourceKind: "terminal-renderer",
				evidence: "assigned-value",
			}),
		);
		rmSync(dir, { recursive: true });
	});

	it("keeps warning severity when a sanitizer boundary has no matching test coverage", () => {
		const dir = makeProject({
			"App.tsx": `export class ErrorBoundary extends React.Component { componentDidCatch() {} render() { return this.props.children; } }
import sanitizeHtml from "sanitize-html";
export function App({ html }: { html: string }) {
  return <div dangerouslySetInnerHTML={{ __html: sanitizeHtml(html) }} />;
}`,
		});
		const result = runReact(dir);
		expect(result.issues).toContainEqual(
			expect.objectContaining({
				severity: "warning",
				rule: "react-dangerous-html-sanitized",
				file: "src/App.tsx",
				snippet: "sanitizeHtml(html)",
			}),
		);
		expect((result.details as any).sanitizedDangerousHtml).toBe(1);
		expect((result.details as any).sanitizedDangerousHtmlWithoutTests).toBe(1);
		expect((result.details as any).dangerousHtmlContexts).toContainEqual(
			expect.objectContaining({
				classification: "sanitized-untested",
				sanitizer: "sanitizeHtml",
				sourceKind: "html-sanitizer",
				tested: false,
			}),
		);
		rmSync(dir, { recursive: true });
	});

	it("still warns for raw React HTML sinks", () => {
		const dir = makeProject({
			"App.tsx": `export class ErrorBoundary extends React.Component { componentDidCatch() {} render() { return this.props.children; } }
export function App({ html }: { html: string }) {
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}`,
		});
		const result = runReact(dir);
		expect(result.issues).toContainEqual(
			expect.objectContaining({
				severity: "warning",
				rule: "react-dangerous-html",
				file: "src/App.tsx",
				snippet: "html",
			}),
		);
		expect((result.details as any).rawDangerousHtml).toBe(1);
		expect((result.details as any).dangerousHtmlContexts).toContainEqual(
			expect.objectContaining({ classification: "raw", expression: "html" }),
		);
		rmSync(dir, { recursive: true });
	});

	it("scopes JSX analysis to React projects in a mixed monorepo", () => {
		const dir = mkdtempSync(join(tmpdir(), "vcqa-react-mixed-"));
		writeFileSync(join(dir, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
		mkdirSync(join(dir, "packages/web/src"), { recursive: true });
		mkdirSync(join(dir, "packages/core/src"), { recursive: true });
		writeFileSync(join(dir, "packages/web/package.json"), JSON.stringify({ dependencies: { react: "^19.0.0" } }));
		writeFileSync(join(dir, "packages/core/package.json"), JSON.stringify({ dependencies: {} }));
		writeFileSync(
			join(dir, "packages/web/src/App.tsx"),
			`export function App({ items }: { items: string[] }) {
  return <ul>{items.map((item) => <li>{item}</li>)}</ul>;
}`,
		);
		writeFileSync(
			join(dir, "packages/web/src/ErrorBoundary.tsx"),
			`export class ErrorBoundary extends React.Component { componentDidCatch() {} render() { return this.props.children; } }`,
		);
		writeFileSync(
			join(dir, "packages/core/src/Fake.tsx"),
			`export function Fake({ items }: { items: string[] }) {
  return <>{items.map((item) => <span>{item}</span>)}</>;
}`,
		);

		const workspace = detectWorkspace(dir);
		const result = runReact(dir, workspace);

		expect((result.details as any).jsxFiles).toBe(2);
		expect((result.details as any).projects).toEqual([expect.objectContaining({ path: "packages/web", jsxFiles: 2 })]);
		expect(result.issues.some((issue) => issue.file?.startsWith("packages/core/"))).toBe(false);
		expect(result.issues.some((issue) => issue.file === "packages/web/src/App.tsx" && issue.rule === "missing-key")).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("uses FileInventory and skips generated output and agent worktrees", () => {
		const dir = makeProject({
			"App.tsx": `export function App({ items }: { items: string[] }) {
  return <ul>{items.map((item) => <li key={item}>{item}</li>)}</ul>;
}`,
			"ErrorBoundary.tsx": `export class ErrorBoundary extends React.Component { componentDidCatch() {} render() { return this.props.children; } }`,
		});
		mkdirSync(join(dir, "dist"), { recursive: true });
		mkdirSync(join(dir, ".claude", "worktrees", "agent-a", "src"), { recursive: true });
		writeFileSync(
			join(dir, "dist", "Generated.tsx"),
			`export function Generated({ items }: { items: string[] }) { return <>{items.map((item) => <span>{item}</span>)}</>; }`,
		);
		writeFileSync(
			join(dir, ".claude", "worktrees", "agent-a", "src", "Agent.tsx"),
			`export function Agent({ items }: { items: string[] }) { return <>{items.map((item) => <span>{item}</span>)}</>; }`,
		);

		const inventory = buildFileInventory(dir, detectWorkspace(dir), buildEffectiveScanPolicy(dir, {}));
		const result = runReact(dir, undefined, inventory);

		expect(result.details).toMatchObject({ source: "file-inventory", jsxFiles: 2 });
		expect(result.issues.some((issue) => issue.file?.startsWith("dist/") || issue.file?.includes(".claude/worktrees"))).toBe(false);
		expect(result.issues.some((issue) => issue.rule === "missing-key")).toBe(false);
		rmSync(dir, { recursive: true });
	});
});

describe("parseReactEslintIssues", () => {
	it("keeps industry-standard React plugin diagnostics and drops generic lint", () => {
		const stdout = JSON.stringify([
			{
				filePath: "/repo/src/App.tsx",
				messages: [
					{ severity: 2, message: "Hook is called conditionally", line: 5, ruleId: "react-hooks/rules-of-hooks" },
					{ severity: 1, message: "Missing key", line: 8, ruleId: "react/jsx-key" },
					{ severity: 1, message: "Fast refresh warning", line: 1, ruleId: "react-refresh/only-export-components" },
					{ severity: 1, message: "Use const", line: 3, ruleId: "prefer-const" },
				],
			},
		]);
		expect(parseReactEslintIssues(stdout, "/repo")).toMatchObject([
			{ severity: "error", message: "Hook is called conditionally", file: "src/App.tsx", line: 5, rule: "react-hooks/rules-of-hooks" },
			{ severity: "warning", message: "Missing key", file: "src/App.tsx", line: 8, rule: "react/jsx-key" },
			{ severity: "warning", message: "Fast refresh warning", file: "src/App.tsx", line: 1, rule: "react-refresh/only-export-components" },
		]);
	});

	it("normalizes React eslint paths from nested package cwd", () => {
		const stdout = JSON.stringify([
			{
				filePath: "src/App.tsx",
				messages: [{ severity: 2, message: "Hook is called conditionally", line: 5, ruleId: "react-hooks/rules-of-hooks" }],
			},
			{
				filePath: "../../packages/web/src/CopilotView.tsx",
				messages: [{ severity: 1, message: "Missing key", line: 8, ruleId: "react/jsx-key" }],
			},
		]);

		const issues = parseReactEslintIssues(stdout, "/repo/apps/console", "/repo")!;

		expect(issues[0]).toMatchObject({
			file: "apps/console/src/App.tsx",
			details: {
				repoRelativePath: "apps/console/src/App.tsx",
				toolRelativePath: "src/App.tsx",
				toolCwd: "/repo/apps/console",
			},
		});
		expect(issues[1]).toMatchObject({
			file: "packages/web/src/CopilotView.tsx",
			details: {
				repoRelativePath: "packages/web/src/CopilotView.tsx",
				toolRelativePath: "../../packages/web/src/CopilotView.tsx",
			},
		});
	});
});
