import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runStyling } from "./styling.js";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "vcqa-style-"));
	mkdirSync(join(dir, "src"), { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "test" }));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("styling", () => {
	it("skips when no component files", () => {
		writeFileSync(join(dir, "src", "utils.ts"), "export const x = 1;\n");
		const result = runStyling(dir);
		expect((result.details as Record<string, unknown>).skipped).toBe(true);
	});

	it("detects hardcoded colors", () => {
		writeFileSync(join(dir, "src", "Card.tsx"), `
export function Card() {
  return <div style={{ backgroundColor: "#3b82f6", color: "#ffffff" }}>Hello</div>;
}
`);
		const result = runStyling(dir);
		expect(result.issues.some((i) => i.rule === "hardcoded-color")).toBe(true);
	});

	it("detects inline style overuse", () => {
		const components = Array.from({ length: 5 }, (_, i) => `
export function Box${i}() {
  return <div style={{ padding: "8px", margin: "4px" }}>Box</div>;
}
`).join("\n");
		writeFileSync(join(dir, "src", "Boxes.tsx"), components);
		// Add more files to get above the 3-file threshold
		for (let i = 0; i < 4; i++) {
			writeFileSync(join(dir, "src", `C${i}.tsx`), `export function C${i}() { return <div style={{ color: "red" }}>x</div>; }`);
		}
		const result = runStyling(dir);
		expect(result.issues.some((i) => i.rule === "inline-style-ratio")).toBe(true);
	});

	it("detects !important abuse", () => {
		writeFileSync(join(dir, "src", "App.tsx"), `export function App() { return <div className="app">app</div>; }`);
		writeFileSync(join(dir, "src", "styles.css"), `
.app { color: red !important; }
.header { margin: 0 !important; }
.footer { padding: 0 !important; }
.main { display: flex !important; }
`);
		const result = runStyling(dir);
		expect(result.issues.some((i) => i.rule === "important-abuse")).toBe(true);
	});

	it("detects inconsistent spacing", () => {
		writeFileSync(join(dir, "src", "Layout.tsx"), `
export function Layout() {
  return (
    <div style={{ padding: "13px", margin: "7px", gap: "11px", width: "100%" }}>
      <div style={{ padding: "9px", margin: "5px" }}>inner</div>
    </div>
  );
}
`);
		const result = runStyling(dir);
		expect(result.issues.some((i) => i.rule === "inconsistent-spacing")).toBe(true);
	});

	it("detects mixed styling approaches", () => {
		// Tailwind usage
		for (let i = 0; i < 4; i++) {
			writeFileSync(join(dir, "src", `Tw${i}.tsx`), `export function Tw${i}() { return <div className="flex p-4 bg-blue-500 text-white">tw</div>; }`);
		}
		// styled-components usage
		for (let i = 0; i < 4; i++) {
			writeFileSync(join(dir, "src", `Sc${i}.tsx`), `import styled from 'styled-components';\nconst Box = styled.div\`padding: 8px;\`;\nexport function Sc${i}() { return <Box>sc</Box>; }`);
		}
		const result = runStyling(dir);
		expect(result.issues.some((i) => i.rule === "mixed-styling")).toBe(true);
	});

	it("passes clean Tailwind project", () => {
		writeFileSync(join(dir, "tailwind.config.js"), "module.exports = { content: ['./src/**/*.tsx'], theme: { extend: {} } }");
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "test", dependencies: { tailwindcss: "^3" } }));
		writeFileSync(join(dir, "src", "App.tsx"), `export function App() { return <div className="flex items-center p-4 bg-blue-500 text-white rounded-lg">Clean</div>; }`);
		const result = runStyling(dir);
		const warnings = result.issues.filter((i) => i.severity === "warning" || i.severity === "error");
		expect(warnings).toHaveLength(0);
	});

	it("detects duplicate Tailwind class strings", () => {
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "test", dependencies: { tailwindcss: "^3" } }));
		writeFileSync(join(dir, "tailwind.config.js"), "module.exports = {}");
		const sharedClasses = "flex items-center justify-between p-4 bg-white rounded-lg shadow-md";
		for (let i = 0; i < 4; i++) {
			writeFileSync(join(dir, "src", `Card${i}.tsx`), `export function Card${i}() { return <div className="${sharedClasses}">card</div>; }`);
		}
		const result = runStyling(dir);
		expect(result.issues.some((i) => i.rule === "duplicate-tailwind")).toBe(true);
	});
});
