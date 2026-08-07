import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoveryConventions, projectMarkerFiles } from "./discovery-conventions.js";

function duplicates(values: string[]): string[] {
	return values.filter((value, index) => values.indexOf(value) !== index);
}

describe("discovery convention registry", () => {
	it("keeps maintained discovery lists unique and cross-linked", () => {
		expect(discoveryConventions.version).toBe(1);
		expect(duplicates(discoveryConventions.projectManifestFiles)).toEqual([]);
		expect(duplicates(discoveryConventions.projectConfigFiles)).toEqual([]);
		expect(duplicates(discoveryConventions.sourceRoots)).toEqual([]);
		expect(duplicates(discoveryConventions.rootSourceRoots)).toEqual([]);
		expect(duplicates(discoveryConventions.testRoots)).toEqual([]);
		expect(duplicates(discoveryConventions.sourceFileExtensions)).toEqual([]);
		expect(duplicates(discoveryConventions.discoverySourceFileExtensions ?? [])).toEqual([]);
		expect(
			(discoveryConventions.discoverySourceFileExtensions ?? []).filter((ext) => discoveryConventions.sourceFileExtensions.includes(ext)),
		).toEqual([]);
		expect(duplicates(discoveryConventions.conventionalContainerRoots)).toEqual([]);
		expect(duplicates(discoveryConventions.staticSiteRootNames)).toEqual([]);
		expect(duplicates(projectMarkerFiles)).toEqual([]);

		expect(discoveryConventions.projectManifestFiles).toEqual(expect.arrayContaining(["package.json", "pubspec.yaml"]));
		expect(discoveryConventions.confidenceScoring).toMatchObject({
			base: expect.any(Number),
			manifestFileBonus: expect.any(Number),
			configFileBonus: expect.any(Number),
			sourceRootBonus: expect.any(Number),
		});
		expect(discoveryConventions.projectConfigFiles).toEqual(
			expect.arrayContaining(["tsconfig.json", "vite.config.ts", "astro.config.mjs", "next.config.mjs", "wrangler.toml"]),
		);
		expect(discoveryConventions.conventionalContainerRoots).toEqual(
			expect.arrayContaining(["apps", "packages", "libs", "services", "workers", "functions", "jobs", "tools", "examples"]),
		);
	});

	it("documents the registry as the source of truth for discovery conventions", () => {
		const docs = readFileSync(join(import.meta.dirname!, "..", "docs", "repo-discovery.md"), "utf-8");
		expect(docs).toContain("src/data/discovery-conventions.json");
		expect(docs).toContain("explicit config > manifest workspace > ecosystem config > conservative convention > single-project fallback");
	});
});
