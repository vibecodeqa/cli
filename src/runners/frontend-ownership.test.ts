/** Cross-runner ownership contract for the frontend check family (#68).
 *
 *  Every frontend rule must have exactly one canonical owner. Where two runners
 *  used to report the same defect on the same file, this suite pins which one
 *  survives — and pins the duplicates that are still outstanding, so the set can
 *  only shrink.
 *
 *  `<html lang>` and `<meta name="viewport">` belong to `html-quality`:
 *  `accessibility` returns early with "no JSX/TSX/Vue/Svelte files", so it cannot
 *  be relied on for a static site at all, and it only ever inspected four
 *  hardcoded HTML paths where html-quality walks every HTML file in the inventory.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setGlobalSrcRoots } from "../fs-utils.js";
import { runAccessibility } from "./accessibility.js";
import { runHtmlQuality } from "./html-quality.js";

const BAD_HTML = "<!DOCTYPE html><html><head><title>A long enough title</title></head><body><p>hi</p></body></html>";
const APP_TSX = `export function App() { return <div>hi</div>; }`;

let dir: string;

beforeEach(() => {
	// `scan()` sets the module-global source roots and never clears them, so a test
	// file that ran earlier in this worker can otherwise starve the runners below.
	setGlobalSrcRoots(undefined);
	dir = mkdtempSync(join(tmpdir(), "vcqa-frontend-own-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A React project that also ships a static index.html — the shape where both
 *  runners used to fire on the very same file. */
function reactPlusHtml() {
	writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { react: "^18.0.0" } }));
	writeFileSync(join(dir, "index.html"), BAD_HTML);
	mkdirSync(join(dir, "src"), { recursive: true });
	writeFileSync(join(dir, "src", "App.tsx"), APP_TSX);
	const a11y = runAccessibility(dir);
	const html = runHtmlQuality(dir);
	return { a11y, html, all: [...a11y.issues, ...html.issues] };
}

describe("frontend check ownership (#68)", () => {
	it("runs both checks on this fixture — otherwise the assertions below are vacuous", () => {
		const { a11y, html } = reactPlusHtml();
		expect((a11y.details as Record<string, unknown>).skipped).toBeUndefined();
		expect((html.details as Record<string, unknown>).skipped).toBeUndefined();
		expect(a11y.issues.length).toBeGreaterThan(0);
		expect(html.issues.length).toBeGreaterThan(0);
	});

	it("reports <html lang> exactly once, from html-quality", () => {
		const { a11y, html, all } = reactPlusHtml();
		expect(html.issues.filter((i) => i.rule === "missing-lang")).toHaveLength(1);
		expect(a11y.issues.some((i) => i.rule === "html-lang")).toBe(false);
		// One defect, one finding — counted across both runners.
		expect(all.filter((i) => i.rule === "missing-lang" || i.rule === "html-lang")).toHaveLength(1);
	});

	it("reports the viewport meta exactly once, from html-quality", () => {
		const { a11y, html, all } = reactPlusHtml();
		expect(html.issues.filter((i) => i.rule === "missing-viewport")).toHaveLength(1);
		expect(a11y.issues.some((i) => i.rule === "missing-viewport")).toBe(false);
		// Previously two findings under the SAME rule id, in two categories.
		expect(all.filter((i) => i.rule === "missing-viewport")).toHaveLength(1);
	});

	it("keeps the surviving owner's guidance, including the WCAG reference", () => {
		const { html } = reactPlusHtml();
		const lang = html.issues.find((i) => i.rule === "missing-lang");
		expect(lang?.message).toContain("WCAG 3.1.1");
		expect(lang?.message).toContain('lang="en"');
		const viewport = html.issues.find((i) => i.rule === "missing-viewport");
		expect(viewport?.message).toContain("width=device-width");
	});

	it("pins the rule ids still emitted by both runners for the same file", () => {
		const { a11y, html } = reactPlusHtml();
		const a11yRules = new Set(a11y.issues.filter((i) => i.file === "index.html").map((i) => i.rule));
		const htmlRules = new Set(html.issues.filter((i) => i.file === "index.html").map((i) => i.rule));
		const shared = [...a11yRules].filter((rule) => htmlRules.has(rule)).sort();
		expect(shared).not.toContain("missing-lang");
		expect(shared).not.toContain("html-lang");
		expect(shared).not.toContain("missing-viewport");
		// `missing-charset` is the remaining same-id duplicate; the
		// missing-icon/missing-favicon pair duplicates the same defect under two
		// ids. Both are left for the maintainer on #68 — pinned here so the set
		// cannot grow unnoticed.
		expect(shared).toEqual(["missing-charset"]);
	});

	it("still reports lang and viewport on a pure static site, where accessibility does not run at all", () => {
		writeFileSync(join(dir, "index.html"), BAD_HTML);
		const a11y = runAccessibility(dir);
		const html = runHtmlQuality(dir);
		expect((a11y.details as Record<string, unknown>).skipped).toBe(true);
		expect(html.issues.some((i) => i.rule === "missing-lang")).toBe(true);
		expect(html.issues.some((i) => i.rule === "missing-viewport")).toBe(true);
	});

	it("heading order is NOT a duplicate: the two runners cover disjoint file classes", () => {
		writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { react: "^18.0.0" } }));
		writeFileSync(
			join(dir, "index.html"),
			'<!DOCTYPE html><html lang="en"><head><title>A long enough title</title><meta name="viewport" content="width=device-width"><meta charset="utf-8"></head><body><h1>Top</h1><h4>Skip</h4></body></html>',
		);
		mkdirSync(join(dir, "src"), { recursive: true });
		writeFileSync(
			join(dir, "src", "App.tsx"),
			"export function App() {\n  return (\n    <div>\n      <h1>Top</h1>\n      <h3>Skip</h3>\n    </div>\n  );\n}\n",
		);
		const a11y = runAccessibility(dir);
		const html = runHtmlQuality(dir);
		// accessibility scans source files only; html-quality scans .html only.
		const headingOrder = a11y.issues.filter((i) => i.rule === "heading-order");
		const headingSkip = html.issues.filter((i) => i.rule === "heading-skip");
		expect(headingOrder.map((i) => i.file)).toEqual(["src/App.tsx"]);
		expect(headingSkip.map((i) => i.file)).toEqual(["index.html"]);
		// Neither runner ever sees the other's file, so merging them would lose
		// coverage rather than remove a duplicate.
		expect(a11y.issues.some((i) => i.file === "index.html" && i.rule === "heading-order")).toBe(false);
		expect(html.issues.some((i) => i.file?.endsWith(".tsx"))).toBe(false);
	});
});
