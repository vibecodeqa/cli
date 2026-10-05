import { describe, expect, it } from "vitest";
import { e, fileLink, gc, linkRef, pc } from "./components.js";

describe("e (HTML escape)", () => {
	it("escapes all dangerous characters", () => {
		expect(e('<script>alert("xss")</script>')).toBe("&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;");
	});

	it("escapes ampersands", () => {
		expect(e("a & b")).toBe("a &amp; b");
	});

	it("escapes single quotes", () => {
		expect(e("it's")).toBe("it&#39;s");
	});

	it("passes through safe strings unchanged", () => {
		expect(e("hello world 123")).toBe("hello world 123");
	});
});

describe("fileLink", () => {
	it("returns plain text when no repoUrl", () => {
		expect(fileLink("src/foo.ts", undefined, null, "main")).toBe("src/foo.ts");
	});

	it("generates GitHub link", () => {
		const result = fileLink("src/foo.ts", 42, "https://github.com/org/repo", "main");
		expect(result).toContain("https://github.com/org/repo/blob/main/src/foo.ts#L42");
		expect(result).toContain('target="_blank"');
		expect(result).toContain("noopener");
	});

	it("strips :line from href but keeps in display text", () => {
		const result = fileLink("src/foo.ts:10", undefined, "https://github.com/org/repo", "main");
		expect(result).toContain('href="https://github.com/org/repo/blob/main/src/foo.ts"');
		expect(result).toContain(">src/foo.ts:10</a>"); // display text preserves original
	});

	it("links to a commit sha as a permalink", () => {
		const sha = "a".repeat(40);
		expect(fileLink("src/foo.ts", 3, "https://github.com/org/repo", sha)).toContain(
			`https://github.com/org/repo/blob/${sha}/src/foo.ts#L3`,
		);
	});

	it("renders plain text instead of a /blob// link when there is no ref", () => {
		const result = fileLink("src/foo.ts", 3, "https://github.com/org/repo", "");
		expect(result).toBe("src/foo.ts");
		expect(result).not.toContain("/blob//");
	});

	it("escapes special characters in path", () => {
		const result = fileLink("src/a&b.ts", undefined, "https://github.com/org/repo", "main");
		expect(result).toContain("&amp;");
	});
});

describe("linkRef", () => {
	it("prefers the scanned commit sha over the branch", () => {
		expect(linkRef({ branch: "main", git: { sha: "abc123" } })).toBe("abc123");
	});

	it("follows the scan's own decision in meta.linkRef (unpushed HEAD → branch)", () => {
		expect(linkRef({ branch: "main", git: { sha: "abc123" }, linkRef: "main" })).toBe("main");
		expect(linkRef({ branch: "", git: { sha: "abc123" }, linkRef: "" })).toBe("");
	});

	it("falls back to the branch, then to no ref", () => {
		expect(linkRef({ branch: "main", git: { sha: null } })).toBe("main");
		expect(linkRef({ branch: "" })).toBe("");
	});
});

describe("gc (grade color)", () => {
	it("returns green for A", () => {
		expect(gc("A")).toBe("#22c55e");
	});

	it("returns red for F", () => {
		expect(gc("F")).toBe("#ef4444");
	});

	it("returns fallback for unknown grade", () => {
		expect(gc("X")).toBe("#6b7280");
	});
});

describe("pc (priority color)", () => {
	it("returns red for critical", () => {
		expect(pc("critical")).toBe("#ef4444");
	});

	it("returns gray for low", () => {
		expect(pc("low")).toBe("#6b7280");
	});
});
