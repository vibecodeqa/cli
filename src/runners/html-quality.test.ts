import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scan } from "../core.js";
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

	it("ignores generated HTML inside hidden agent worktrees", () => {
		mkdirSync(join(dir, ".claude", "worktrees", "agent-a", "assets"), { recursive: true });
		writeFileSync(join(dir, ".claude", "worktrees", "agent-a", "assets", "screenshot.html"), "<html><head></head><body></body></html>");
		const result = runHtmlQuality(dir);
		expect((result.details as Record<string, unknown>).skipped).toBe(true);
	});

	it("uses FileInventory through scan and omits generated HTML outputs", async () => {
		mkdirSync(join(dir, "dist"), { recursive: true });
		mkdirSync(join(dir, ".claude", "worktrees", "agent-a"), { recursive: true });
		mkdirSync(join(dir, "site", "generated-docs"), { recursive: true });
		writeFileSync(join(dir, "package.json"), "{}");
		writeFileSync(join(dir, ".vcqa.json"), JSON.stringify({ ignore: ["site/generated-docs/**"] }));
		writeFileSync(join(dir, "src.ts"), "export const x = 1;\n");
		writeFileSync(
			join(dir, "index.html"),
			'<!DOCTYPE html><html lang="en"><head><title>T</title><meta name="viewport" content="width=device-width"></head><body></body></html>',
		);
		writeFileSync(join(dir, "dist", "bad.html"), "<html><head></head><body></body></html>");
		writeFileSync(join(dir, ".claude", "worktrees", "agent-a", "bad.html"), "<html><head></head><body></body></html>");
		writeFileSync(join(dir, "site", "generated-docs", "bad.html"), "<html><head></head><body></body></html>");

		const report = await scan(dir, { skipTests: true, checks: ["html-quality"] });
		const html = report.checks[0]!;

		expect(html.details).toMatchObject({ htmlFiles: 1, source: "file-inventory" });
		expect(report.meta.scanPolicy).toMatchObject({ configIgnorePatterns: 1 });
		expect(report.meta.fileInventory).toMatchObject({ includedFiles: expect.any(Number), ignoredDirectories: expect.any(Number) });
		expect(html.issues.some((issue) => /dist|\.claude|site\/generated-docs/.test(issue.file ?? ""))).toBe(false);
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

	it("resolves root-absolute static links from the detected site root", () => {
		mkdirSync(join(dir, "site", "skills"), { recursive: true });
		mkdirSync(join(dir, "site", "app", "terms"), { recursive: true });
		mkdirSync(join(dir, "site", "docs", "reference"), { recursive: true });
		writeFileSync(
			join(dir, "site", "index.html"),
			'<!DOCTYPE html><html lang="en"><head><title>Site Home</title></head><body></body></html>',
		);
		writeFileSync(
			join(dir, "site", "skills", "index.html"),
			'<!DOCTYPE html><html lang="en"><head><title>Skills Page</title></head><body></body></html>',
		);
		writeFileSync(
			join(dir, "site", "app", "terms", "index.html"),
			'<!DOCTYPE html><html lang="en"><head><title>Terms Page</title></head><body></body></html>',
		);
		writeFileSync(join(dir, "site", "skills.json"), '{"skills":[]}');
		writeFileSync(join(dir, "site", "llms.txt"), "VCQA static metadata");
		writeFileSync(
			join(dir, "site", "docs", "reference", "local.html"),
			'<!DOCTYPE html><html lang="en"><head><title>Local Page</title></head><body></body></html>',
		);
		writeFileSync(
			join(dir, "site", "docs", "reference", "page.html"),
			`<!DOCTYPE html>
<html lang="en">
<head><title>Nested Page</title></head>
<body>
<a href="/skills/">Skills</a>
<a href="/app/terms/">Terms</a>
<a href="/skills.json">Skills JSON</a>
<a href="/llms.txt">LLMs</a>
<a href="local.html">Local</a>
</body>
</html>`,
		);

		const result = runHtmlQuality(dir);
		expect(result.issues.filter((i) => i.rule === "broken-link")).toHaveLength(0);
	});

	it("does not treat links inside script template literals as emitted anchors", () => {
		writeFileSync(
			join(dir, "index.html"),
			`<!DOCTYPE html>
<html lang="en">
<head>
<title>Template Literal Page</title>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="description" content="A good description of the page content">
</head>
<body>
<h1>Welcome</h1>
<script>
const row = (href) => \`<a href="\${esc(href)}">Open</a>\`;
</script>
</body>
</html>`,
		);
		const result = runHtmlQuality(dir);
		expect(result.issues.some((i) => i.rule === "broken-link" && i.message.includes("esc"))).toBe(false);
	});

	it("does not parse SVG internals as page links or mixed content", () => {
		writeFileSync(
			join(dir, "index.html"),
			`<!DOCTYPE html>
<html lang="en">
<head>
<title>Inline SVG Page</title>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="description" content="A good description of the page content">
</head>
<body>
<h1>Logo</h1>
<svg viewBox="0 0 10 10"><path d="M1 1 http://example.com <a href='ghost.html'"></path></svg>
</body>
</html>`,
		);
		const result = runHtmlQuality(dir);
		expect(result.issues.some((i) => i.rule === "broken-link" && i.message.includes("ghost"))).toBe(false);
		expect(result.issues.some((i) => i.rule === "mixed-content")).toBe(false);
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
