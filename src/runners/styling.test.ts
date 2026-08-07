import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scan } from "../core.js";
import { detectWorkspace } from "../detect.js";
import { runStyling, stylingScore } from "./styling.js";

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
		writeFileSync(
			join(dir, "src", "Card.tsx"),
			`
export function Card() {
  return <div style={{ backgroundColor: "#3b82f6", color: "#ffffff" }}>Hello</div>;
}
`,
		);
		const result = runStyling(dir);
		expect(result.issues.some((i) => i.rule === "hardcoded-color")).toBe(true);
	});

	it("detects inline style overuse", () => {
		const components = Array.from(
			{ length: 5 },
			(_, i) => `
export function Box${i}() {
  return <div style={{ padding: "8px", margin: "4px" }}>Box</div>;
}
`,
		).join("\n");
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
		writeFileSync(
			join(dir, "src", "styles.css"),
			`
.app { color: red !important; }
.header { margin: 0 !important; }
.footer { padding: 0 !important; }
.main { display: flex !important; }
`,
		);
		const result = runStyling(dir);
		expect(result.issues.some((i) => i.rule === "important-abuse")).toBe(true);
	});

	it("detects inconsistent spacing", () => {
		writeFileSync(
			join(dir, "src", "Layout.tsx"),
			`
export function Layout() {
  return (
    <div style={{ padding: "13px", margin: "7px", gap: "11px", width: "100%" }}>
      <div style={{ padding: "9px", margin: "5px" }}>inner</div>
    </div>
  );
}
`,
		);
		const result = runStyling(dir);
		expect(result.issues.some((i) => i.rule === "inconsistent-spacing")).toBe(true);
	});

	it("detects mixed styling approaches", () => {
		// Tailwind usage
		for (let i = 0; i < 4; i++) {
			writeFileSync(
				join(dir, "src", `Tw${i}.tsx`),
				`export function Tw${i}() { return <div className="flex p-4 bg-blue-500 text-white">tw</div>; }`,
			);
		}
		// styled-components usage
		for (let i = 0; i < 4; i++) {
			writeFileSync(
				join(dir, "src", `Sc${i}.tsx`),
				`import styled from 'styled-components';\nconst Box = styled.div\`padding: 8px;\`;\nexport function Sc${i}() { return <Box>sc</Box>; }`,
			);
		}
		const result = runStyling(dir);
		expect(result.issues.some((i) => i.rule === "mixed-styling")).toBe(true);
	});

	it("passes clean Tailwind project", () => {
		writeFileSync(join(dir, "tailwind.config.js"), "module.exports = { content: ['./src/**/*.tsx'], theme: { extend: {} } }");
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "test", dependencies: { tailwindcss: "^3" } }));
		writeFileSync(
			join(dir, "src", "App.tsx"),
			`export function App() { return <div className="flex items-center p-4 bg-blue-500 text-white rounded-lg">Clean</div>; }`,
		);
		const result = runStyling(dir);
		const warnings = result.issues.filter((i) => i.severity === "warning" || i.severity === "error");
		expect(warnings).toHaveLength(0);
	});

	it("detects duplicate Tailwind class strings", () => {
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "test", dependencies: { tailwindcss: "^3" } }));
		writeFileSync(join(dir, "tailwind.config.js"), "module.exports = {}");
		const sharedClasses = "flex items-center justify-between p-4 bg-white rounded-lg shadow-md";
		for (let i = 0; i < 4; i++) {
			writeFileSync(
				join(dir, "src", `Card${i}.tsx`),
				`export function Card${i}() { return <div className="${sharedClasses}">card</div>; }`,
			);
		}
		const result = runStyling(dir);
		expect(result.issues.some((i) => i.rule === "duplicate-tailwind")).toBe(true);
	});

	it("does not fail warning/info-only design-system consistency debt", () => {
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "test", dependencies: { tailwindcss: "^3" } }));
		writeFileSync(join(dir, "tailwind.config.js"), "module.exports = {}");
		const sharedClasses = "flex items-center justify-between p-4 bg-white rounded-lg shadow-md";
		for (let i = 0; i < 8; i++) {
			writeFileSync(
				join(dir, "src", `Card${i}.tsx`),
				`export function Card${i}() { return <div className="${sharedClasses}" style={{ backgroundColor: "#123456", padding: "${7 + i}px" }}>card</div>; }`,
			);
		}

		const result = runStyling(dir);

		expect(result.issues.length).toBeGreaterThan(0);
		expect(result.issues.some((issue) => issue.severity === "error")).toBe(false);
		expect(result.score).toBeGreaterThanOrEqual(60);
		expect(result.grade).not.toBe("F");
		expect(result.details).toMatchObject({
			hardFailure: false,
			scoring: expect.objectContaining({
				note: expect.stringContaining("design-system consistency debt"),
			}),
		});
	});

	it("keeps explicit styling errors as hard failures", () => {
		const errorPenaltyResult = stylingScore(
			[{ severity: "error", message: "Stylelint parse error", file: "src/App.css", rule: "stylelint-error" }],
			4,
		);

		expect(errorPenaltyResult.score).toBeLessThan(80);
		expect(errorPenaltyResult.hardFailure).toBe(true);
	});

	it("suggests Stylelint when not installed and CSS files exist", () => {
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "test" }));
		writeFileSync(join(dir, "src", "App.tsx"), 'export function App() { return <div className="app">app</div>; }');
		writeFileSync(join(dir, "src", "styles.css"), ".app { color: red; }");
		const result = runStyling(dir);
		const details = result.details as Record<string, unknown>;
		expect(details.suggestion).toContain("Stylelint");
		expect(details.tool).toBe("built-in");
		// Suggestion should NOT be in issues (keeps issue list clean)
		expect(result.issues.some((i) => i.rule === "suggest-stylelint")).toBe(false);
	});

	it("does not suggest Stylelint when no CSS files", () => {
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "test" }));
		writeFileSync(join(dir, "src", "App.tsx"), "export function App() { return <div>no css</div>; }");
		const result = runStyling(dir);
		const details = result.details as Record<string, unknown>;
		expect(details.suggestion).toContain("Stylelint");
	});

	it("scopes styling analysis to frontend projects in a mixed monorepo", () => {
		rmSync(dir, { recursive: true, force: true });
		dir = mkdtempSync(join(tmpdir(), "vcqa-style-mixed-"));
		writeFileSync(join(dir, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
		mkdirSync(join(dir, "packages/web/src"), { recursive: true });
		mkdirSync(join(dir, "packages/core/src"), { recursive: true });
		writeFileSync(join(dir, "packages/web/package.json"), JSON.stringify({ dependencies: { react: "^19.0.0" } }));
		writeFileSync(join(dir, "packages/core/package.json"), JSON.stringify({ dependencies: {} }));
		writeFileSync(join(dir, "packages/web/src/App.tsx"), `export function App() { return <div className="app">ok</div>; }`);
		writeFileSync(
			join(dir, "packages/core/src/Fake.tsx"),
			`export function Fake() { return <div style={{ backgroundColor: "#123456" }}>fake</div>; }`,
		);

		const result = runStyling(dir, detectWorkspace(dir));

		expect(result.issues.some((issue) => issue.file?.startsWith("packages/core/"))).toBe(false);
		expect((result.details as any).projects).toEqual([expect.objectContaining({ path: "packages/web", files: 1 })]);
	});

	it("uses FileInventory through scan and omits generated component outputs", async () => {
		mkdirSync(join(dir, "dist"), { recursive: true });
		writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { react: "^19.0.0" } }));
		writeFileSync(join(dir, "src", "App.tsx"), 'export function App() { return <div className="app">ok</div>; }');
		writeFileSync(join(dir, "dist", "Bad.tsx"), 'export function Bad() { return <div style={{ backgroundColor: "#123456" }}>bad</div>; }');

		const report = await scan(dir, { skipTests: true, checks: ["styling"] });
		const result = report.checks[0]!;

		expect(result.details).toMatchObject({ source: "file-inventory", totalComponentFiles: 1 });
		expect(result.issues.some((issue) => issue.file?.includes("dist/"))).toBe(false);
	});
});
