import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scan } from "../core.js";
import { detectWorkspace } from "../detect.js";
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
		writeFileSync(
			join(dir, "package.json"),
			JSON.stringify({
				name: "test",
				dependencies: { "@mui/material": "^5", tailwindcss: "^3" },
			}),
		);
		writeFileSync(join(dir, "src", "App.tsx"), 'export function App() { return <div className="flex">hi</div>; }');
		const result = runFrontendHealth(dir);
		expect(result.issues.some((i) => i.rule === "framework-conflict")).toBe(true);
	});

	it("allows Tailwind + Radix (shadcn pattern)", () => {
		writeFileSync(
			join(dir, "package.json"),
			JSON.stringify({
				name: "test",
				dependencies: { tailwindcss: "^3", "@radix-ui/react-dialog": "^1" },
			}),
		);
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

	it("does not parse JSX comments as real images", () => {
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "test" }));
		writeFileSync(
			join(dir, "src", "Hero.tsx"),
			`export function Hero() {
  return <div>{/* <img src="/commented.jpg"> */}<span>ok</span></div>;
}`,
		);
		const result = runFrontendHealth(dir);
		expect(result.issues.some((i) => i.rule === "unoptimized-image")).toBe(false);
	});

	it("passes images with dimensions", () => {
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "test" }));
		writeFileSync(
			join(dir, "src", "Hero.tsx"),
			'export function Hero() { return <img src="/hero.jpg" width={800} height={400} alt="hero" />; }',
		);
		const result = runFrontendHealth(dir);
		expect(result.issues.some((i) => i.rule === "unoptimized-image")).toBe(false);
	});

	it("detects heavy imports", () => {
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "test" }));
		writeFileSync(
			join(dir, "src", "Utils.tsx"),
			'import * as _ from "lodash";\nexport function X() { return <div>{_.get({}, "a")}</div>; }',
		);
		const result = runFrontendHealth(dir);
		expect(result.issues.some((i) => i.rule === "heavy-import")).toBe(true);
	});

	it("does not treat SVG path elements as paragraph tags in nesting checks", () => {
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "test" }));
		writeFileSync(
			join(dir, "src", "Logo.tsx"),
			`export function Logo() {
  return (
    <p>
      <svg viewBox="0 0 24 24">
        <path d="M10 10h4v4z" />
      </svg>
    </p>
  );
}`,
		);
		const result = runFrontendHealth(dir);
		expect(result.issues.some((i) => i.rule === "dom-nesting")).toBe(false);
	});

	it("detects missing loading states", () => {
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "test" }));
		writeFileSync(
			join(dir, "src", "Data.tsx"),
			`
import { useEffect, useState } from "react";
export function Data() {
  const [data, setData] = useState(null);
  useEffect(() => { fetch("/api").then(r => r.json()).then(setData); }, []);
  return <div>{JSON.stringify(data)}</div>;
}
`,
		);
		const result = runFrontendHealth(dir);
		expect(result.issues.some((i) => i.rule === "no-loading-state")).toBe(true);
	});

	it("passes when loading state exists", () => {
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "test" }));
		writeFileSync(
			join(dir, "src", "Data.tsx"),
			`
import { useEffect, useState } from "react";
export function Data() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => { fetch("/api").then(r => r.json()).then(d => { setData(d); setLoading(false); }); }, []);
  if (loading) return <div>Loading...</div>;
  return <div>{JSON.stringify(data)}</div>;
}
`,
		);
		const result = runFrontendHealth(dir);
		expect(result.issues.some((i) => i.rule === "no-loading-state")).toBe(false);
	});

	it("does not report UI framework conflicts across separate frontend projects", () => {
		writeFileSync(join(dir, "package.json"), JSON.stringify({ workspaces: ["apps/*"] }));
		mkdirSync(join(dir, "apps/mui/src"), { recursive: true });
		mkdirSync(join(dir, "apps/tw/src"), { recursive: true });
		writeFileSync(join(dir, "apps/mui/package.json"), JSON.stringify({ dependencies: { react: "^19.0.0", "@mui/material": "^6" } }));
		writeFileSync(join(dir, "apps/tw/package.json"), JSON.stringify({ dependencies: { react: "^19.0.0", tailwindcss: "^4" } }));
		writeFileSync(join(dir, "apps/mui/src/App.tsx"), "export function App() { return <div>MUI</div>; }");
		writeFileSync(join(dir, "apps/tw/src/App.tsx"), 'export function App() { return <div className="flex">Tailwind</div>; }');

		const result = runFrontendHealth(dir, detectWorkspace(dir));

		expect(result.issues.some((i) => i.rule === "framework-conflict")).toBe(false);
		expect((result.details as any).projects).toEqual([
			expect.objectContaining({ path: "apps/mui", files: 1 }),
			expect.objectContaining({ path: "apps/tw", files: 1 }),
		]);
	});

	it("uses FileInventory through scan and omits generated component outputs", async () => {
		mkdirSync(join(dir, "src"), { recursive: true });
		mkdirSync(join(dir, "dist"), { recursive: true });
		writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { react: "^19.0.0" } }));
		writeFileSync(
			join(dir, "src", "Hero.tsx"),
			'export function Hero() { return <img src="/hero.jpg" width={800} height={400} alt="hero" />; }',
		);
		writeFileSync(join(dir, "dist", "Bad.tsx"), 'export function Bad() { return <img src="/bad.jpg" />; }');

		const report = await scan(dir, { skipTests: true, checks: ["frontend-health"] });
		const result = report.checks[0]!;

		expect(result.details).toMatchObject({ source: "file-inventory", componentFiles: 1 });
		expect(result.issues.some((issue) => issue.file?.includes("dist/"))).toBe(false);
	});
});
