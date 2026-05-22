import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getCheckIgnore, isCheckEnabled, loadConfig } from "./config.js";

function makeDir(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "vcqa-config-"));
	for (const [name, content] of Object.entries(files)) {
		const full = join(dir, name);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, content);
	}
	return dir;
}

describe("loadConfig", () => {
	it("loads .vcqa.json", () => {
		const dir = makeDir({
			".vcqa.json": JSON.stringify({ checks: { confusion: { enabled: false } }, failUnder: 70 }),
		});
		const config = loadConfig(dir);
		expect(config.checks?.confusion?.enabled).toBe(false);
		expect(config.failUnder).toBe(70);
		rmSync(dir, { recursive: true });
	});

	it("loads vcqa field from package.json", () => {
		const dir = makeDir({
			"package.json": JSON.stringify({ name: "test", vcqa: { checks: { react: { enabled: false } } } }),
		});
		const config = loadConfig(dir);
		expect(config.checks?.react?.enabled).toBe(false);
		rmSync(dir, { recursive: true });
	});

	it("prefers .vcqa.json over package.json", () => {
		const dir = makeDir({
			".vcqa.json": JSON.stringify({ failUnder: 80 }),
			"package.json": JSON.stringify({ vcqa: { failUnder: 50 } }),
		});
		const config = loadConfig(dir);
		expect(config.failUnder).toBe(80);
		rmSync(dir, { recursive: true });
	});

	it("returns empty config when nothing found", () => {
		const dir = makeDir({ "package.json": "{}" });
		const config = loadConfig(dir);
		expect(config).toEqual({});
		rmSync(dir, { recursive: true });
	});

	it("handles invalid JSON gracefully", () => {
		const dir = makeDir({ ".vcqa.json": "not json {{{" });
		const config = loadConfig(dir);
		expect(config).toEqual({});
		rmSync(dir, { recursive: true });
	});

	it("loads ignore patterns", () => {
		const dir = makeDir({
			".vcqa.json": JSON.stringify({ ignore: ["generated/**", "*.pb.ts"] }),
		});
		const config = loadConfig(dir);
		expect(config.ignore).toEqual(["generated/**", "*.pb.ts"]);
		rmSync(dir, { recursive: true });
	});
});

describe("getCheckIgnore", () => {
	it("returns undefined for checks without ignore", () => {
		expect(getCheckIgnore({}, "lint")).toBeUndefined();
	});

	it("returns ignore patterns for configured checks", () => {
		const config = { checks: { standards: { ignore: ["generated/**"] } } };
		expect(getCheckIgnore(config, "standards")).toEqual(["generated/**"]);
	});
});

describe("isCheckEnabled", () => {
	it("returns true for checks not mentioned", () => {
		expect(isCheckEnabled({}, "lint")).toBe(true);
	});

	it("returns false for disabled checks", () => {
		expect(isCheckEnabled({ checks: { lint: { enabled: false } } }, "lint")).toBe(false);
	});

	it("returns true for explicitly enabled checks", () => {
		expect(isCheckEnabled({ checks: { lint: { enabled: true } } }, "lint")).toBe(true);
	});
});
