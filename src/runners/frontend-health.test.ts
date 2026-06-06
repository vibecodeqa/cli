import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runFrontendHealth } from "./frontend-health.js";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "vcqa-fh-"));
	mkdirSync(join(dir, "src"), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("frontend-health", () => {
	it("skips when no component files", () => {
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "test" }));
		writeFileSync(join(dir, "src", "utils.ts"), "export const x = 1;\n");
		const result = runFrontendHealth(dir);
		expect((result.details as Record<string, unknown>).skipped).toBe(true);
	});

	it("detects conflicting UI frameworks", () => {
		writeFileSync(join(dir, "package.json"), JSON.stringify({
			name: "test",
			dependencies: { "@mui/material": "^5", tailwindcss: "^3" },
		}));
		writeFileSync(join(dir, "src", "App.tsx"), 'export function App() { return <div className="flex">hi</div>; }');
		const result = runFrontendHealth(dir);
		expect(result.issues.some((i) => i.rule === "framework-conflict")).toBe(true);
	});

	it("allows Tailwind + Radix (shadcn pattern)", () => {
		writeFileSync(join(dir, "package.json"), JSON.stringify({
			name: "test",
			dependencies: { tailwindcss: "^3", "@radix-ui/react-dialog": "^1" },
		}));
		writeFileSync(join(dir, "src", "App.tsx"), 'export function App() { return <div className="flex">hi</div>; }');
		const result = runFrontendHealth(dir);
		expect(result.issues.some((i) => i.rule === "framework-conflict")).toBe(false);
	});

	it("detects mixed icon libraries", () => {
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "test" }));
		writeFileSync(join(dir, "src", "A.tsx"), 'import { Home } from "lucide-react";\nexport function A() { return <Home />; }');
		writeFileSync(join(dir, "src", "B.tsx"), 'import { FaHome } from "react-icons/fa";\nexport function B() { return <FaHome />; }');
		const result = runFrontendHealth(dir);
		expect(result.issues.some((i) => i.rule === "mixed-icons")).toBe(true);
	});

	it("detects unoptimized images", () => {
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "test" }));
		writeFileSync(join(dir, "src", "Hero.tsx"), 'export function Hero() { return <img src="/hero.jpg" alt="hero" />; }');
		const result = runFrontendHealth(dir);
		expect(result.issues.some((i) => i.rule === "unoptimized-image")).toBe(true);
	});

	it("passes images with dimensions", () => {
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "test" }));
		writeFileSync(join(dir, "src", "Hero.tsx"), 'export function Hero() { return <img src="/hero.jpg" width={800} height={400} alt="hero" />; }');
		const result = runFrontendHealth(dir);
		expect(result.issues.some((i) => i.rule === "unoptimized-image")).toBe(false);
	});

	it("detects heavy imports", () => {
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "test" }));
		writeFileSync(join(dir, "src", "Utils.tsx"), 'import * as _ from "lodash";\nexport function X() { return <div>{_.get({}, "a")}</div>; }');
		const result = runFrontendHealth(dir);
		expect(result.issues.some((i) => i.rule === "heavy-import")).toBe(true);
	});

	it("detects missing loading states", () => {
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "test" }));
		writeFileSync(join(dir, "src", "Data.tsx"), `
import { useEffect, useState } from "react";
export function Data() {
  const [data, setData] = useState(null);
  useEffect(() => { fetch("/api").then(r => r.json()).then(setData); }, []);
  return <div>{JSON.stringify(data)}</div>;
}
`);
		const result = runFrontendHealth(dir);
		expect(result.issues.some((i) => i.rule === "no-loading-state")).toBe(true);
	});

	it("passes when loading state exists", () => {
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "test" }));
		writeFileSync(join(dir, "src", "Data.tsx"), `
import { useEffect, useState } from "react";
export function Data() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => { fetch("/api").then(r => r.json()).then(d => { setData(d); setLoading(false); }); }, []);
  if (loading) return <div>Loading...</div>;
  return <div>{JSON.stringify(data)}</div>;
}
`);
		const result = runFrontendHealth(dir);
		expect(result.issues.some((i) => i.rule === "no-loading-state")).toBe(false);
	});
});
