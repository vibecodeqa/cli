import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runHtmlQuality } from "./html-quality.js";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "vcqa-html-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("html-quality", () => {
	it("skips when no HTML files", () => {
		writeFileSync(join(dir, "app.ts"), "export const x = 1;");
		const result = runHtmlQuality(dir);
		expect((result.details as Record<string, unknown>).skipped).toBe(true);
	});

	it("detects missing title", () => {
		writeFileSync(join(dir, "index.html"), "<!DOCTYPE html><html><head></head><body>hi</body></html>");
		const result = runHtmlQuality(dir);
		expect(result.issues.some((i) => i.rule === "missing-title")).toBe(true);
	});

	it("detects missing viewport", () => {
		writeFileSync(join(dir, "index.html"), "<!DOCTYPE html><html><head><title>Test</title></head><body></body></html>");
		const result = runHtmlQuality(dir);
		expect(result.issues.some((i) => i.rule === "missing-viewport")).toBe(true);
	});

	it("detects missing meta description", () => {
		writeFileSync(
			join(dir, "index.html"),
			'<!DOCTYPE html><html><head><title>Test</title><meta name="viewport" content="width=device-width"></head><body></body></html>',
		);
		const result = runHtmlQuality(dir);
		expect(result.issues.some((i) => i.rule === "missing-description")).toBe(true);
	});

	it("detects missing alt on images", () => {
		writeFileSync(
			join(dir, "index.html"),
			'<!DOCTYPE html><html lang="en"><head><title>Test</title></head><body><img src="photo.jpg"></body></html>',
		);
		const result = runHtmlQuality(dir);
		expect(result.issues.some((i) => i.rule === "img-no-alt")).toBe(true);
	});

	it("detects missing image dimensions", () => {
		writeFileSync(
			join(dir, "index.html"),
			'<!DOCTYPE html><html lang="en"><head><title>Test</title></head><body><img src="photo.jpg" alt="photo"></body></html>',
		);
		const result = runHtmlQuality(dir);
		expect(result.issues.some((i) => i.rule === "img-no-dimensions")).toBe(true);
	});

	it("detects missing lang attribute", () => {
		writeFileSync(join(dir, "index.html"), "<!DOCTYPE html><html><head><title>Test</title></head><body></body></html>");
		const result = runHtmlQuality(dir);
		expect(result.issues.some((i) => i.rule === "missing-lang")).toBe(true);
	});

	it("detects heading hierarchy skip", () => {
		writeFileSync(
			join(dir, "index.html"),
			'<!DOCTYPE html><html lang="en"><head><title>Test</title></head><body><h1>Title</h1><h4>Skipped</h4></body></html>',
		);
		const result = runHtmlQuality(dir);
		expect(result.issues.some((i) => i.rule === "heading-skip")).toBe(true);
	});

	it("detects render-blocking scripts", () => {
		writeFileSync(
			join(dir, "index.html"),
			'<!DOCTYPE html><html lang="en"><head><title>T</title><script src="app.js"></script></head><body></body></html>',
		);
		const result = runHtmlQuality(dir);
		expect(result.issues.some((i) => i.rule === "render-blocking")).toBe(true);
	});

	it("allows scripts with async/defer", () => {
		writeFileSync(
			join(dir, "index.html"),
			'<!DOCTYPE html><html lang="en"><head><title>T</title><script src="app.js" defer></script></head><body></body></html>',
		);
		const result = runHtmlQuality(dir);
		expect(result.issues.some((i) => i.rule === "render-blocking")).toBe(false);
	});

	it("detects HTTP links", () => {
		writeFileSync(
			join(dir, "index.html"),
			'<!DOCTYPE html><html lang="en"><head><title>T</title></head><body><a href="http://example.com">link</a></body></html>',
		);
		const result = runHtmlQuality(dir);
		expect(result.issues.some((i) => i.rule === "http-link")).toBe(true);
	});

	it("detects missing noopener on target=_blank", () => {
		writeFileSync(
			join(dir, "index.html"),
			'<!DOCTYPE html><html lang="en"><head><title>T</title></head><body><a href="https://x.com" target="_blank">link</a></body></html>',
		);
		const result = runHtmlQuality(dir);
		expect(result.issues.some((i) => i.rule === "missing-noopener")).toBe(true);
	});

	it("detects broken internal links", () => {
		writeFileSync(
			join(dir, "index.html"),
			'<!DOCTYPE html><html lang="en"><head><title>T</title></head><body><a href="about.html">About</a></body></html>',
		);
		const result = runHtmlQuality(dir);
		expect(result.issues.some((i) => i.rule === "broken-link")).toBe(true);
	});

	it("passes valid internal links", () => {
		writeFileSync(
			join(dir, "index.html"),
			'<!DOCTYPE html><html lang="en"><head><title>T</title></head><body><a href="about.html">About</a></body></html>',
		);
		writeFileSync(join(dir, "about.html"), '<!DOCTYPE html><html lang="en"><head><title>About</title></head><body></body></html>');
		const result = runHtmlQuality(dir);
		expect(result.issues.some((i) => i.rule === "broken-link")).toBe(false);
	});

	it("detects duplicate titles", () => {
		writeFileSync(join(dir, "index.html"), '<!DOCTYPE html><html lang="en"><head><title>Same Title</title></head><body></body></html>');
		writeFileSync(join(dir, "about.html"), '<!DOCTYPE html><html lang="en"><head><title>Same Title</title></head><body></body></html>');
		const result = runHtmlQuality(dir);
		expect(result.issues.some((i) => i.rule === "duplicate-title")).toBe(true);
	});

	it("passes a well-formed page", () => {
		writeFileSync(join(dir, "robots.txt"), "User-agent: *\nAllow: /");
		writeFileSync(join(dir, "sitemap.xml"), "<urlset></urlset>");
		writeFileSync(
			join(dir, "index.html"),
			`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="description" content="A good description of the page content">
<meta property="og:title" content="My Site">
<link rel="canonical" href="https://example.com">
<link rel="icon" href="/favicon.svg">
<title>My Site — Homepage</title>
<script src="app.js" defer></script>
</head>
<body>
<h1>Welcome</h1>
<h2>Section</h2>
<img src="hero.jpg" alt="Hero image" width="800" height="400" loading="lazy">
<a href="https://example.com" target="_blank" rel="noopener">External</a>
</body>
</html>`,
		);
		const result = runHtmlQuality(dir);
		const errors = result.issues.filter((i) => i.severity === "error");
		const warnings = result.issues.filter((i) => i.severity === "warning");
		expect(errors).toHaveLength(0);
		expect(warnings).toHaveLength(0);
		expect(result.score).toBe(100);
	});
});
