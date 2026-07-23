import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runReact } from "./react.js";

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
});
