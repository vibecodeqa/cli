import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { StackInfo } from "../types.js";
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

const reactStack: StackInfo = {
	language: "typescript",
	framework: "react",
	bundler: "vite",
	testRunner: "vitest",
	linter: "biome",
	packageManager: "pnpm",
};
const nodeStack: StackInfo = {
	language: "typescript",
	framework: "none",
	bundler: "none",
	testRunner: "vitest",
	linter: "biome",
	packageManager: "pnpm",
};

describe("runReact", () => {
	it("skips for non-React projects", () => {
		const result = runReact("/tmp/empty", nodeStack);
		expect(result.score).toBe(100);
		expect((result.details as any).skipped).toBe(true);
	});

	it("detects missing keys in .map()", () => {
		const dir = makeProject({
			"App.tsx": `export function App() {
  const items = [1, 2, 3];
  return <div>{items.map(i => <span>{i}</span>)}</div>;
}`,
		});
		const result = runReact(dir, reactStack);
		expect(result.issues.some((i) => i.rule === "missing-key")).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("detects index as key", () => {
		const dir = makeProject({
			"App.tsx": `export function App() {
  return <div>{items.map((item, i) => <span key={i}>{item}</span>)}</div>;
}`,
		});
		const result = runReact(dir, reactStack);
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
		});
		const result = runReact(dir, reactStack);
		expect(result.score).toBe(100);
		rmSync(dir, { recursive: true });
	});
});
