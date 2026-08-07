import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC_ROOT = join(import.meta.dirname!, ".");

function productionFiles(dir: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		const stat = statSync(full);
		if (stat.isDirectory()) {
			files.push(...productionFiles(full));
			continue;
		}
		if (entry.endsWith(".ts") && !entry.endsWith(".test.ts") && !entry.endsWith(".d.ts")) {
			files.push(full);
		}
	}
	return files;
}

describe("downstream fixture guard", () => {
	it("keeps production scanner code free of downstream repo-specific names", () => {
		const forbidden = [
			["PA", "GS"].join(""),
			["Pro", "Agent", "Store"].join(""),
			["pags", ":session"].join(""),
			["store", "docs"].join("/"),
			["workers", "api"].join("/"),
			["agents", "coder", "web"].join("/"),
		];

		const violations = productionFiles(SRC_ROOT).flatMap((file) => {
			const content = readFileSync(file, "utf-8");
			return forbidden.filter((needle) => content.includes(needle)).map((needle) => ({ file: relative(SRC_ROOT, file), needle }));
		});

		expect(violations).toEqual([]);
	});
});
