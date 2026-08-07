/** Documentation check — README, JSDoc, code comments. */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FileInventory } from "../file-inventory.js";
import { inventorySourceFiles } from "../file-inventory.js";
import { getProductionFiles } from "../fs-utils.js";
import type { CheckResult, Issue } from "../types.js";
import { gradeFromScore } from "../types.js";

export function runDocs(cwd: string, inventory?: FileInventory): CheckResult {
	const start = Date.now();
	const issues: Issue[] = [];
	let readmeScore = 0;
	let exportDocScore = 0;

	// Check README
	const readmePath = join(cwd, "README.md");
	let readmeLines = 0;
	if (!existsSync(readmePath)) {
		issues.push({ severity: "error", message: "No README.md — project has no documentation", rule: "no-readme" });
	} else {
		const readme = readFileSync(readmePath, "utf-8");
		const lines = readme.split("\n").length;
		readmeLines = lines;
		if (lines < 5) {
			issues.push({ severity: "warning", message: `README.md is only ${lines} lines — minimal documentation`, rule: "short-readme" });
			readmeScore = 30;
		} else if (lines < 20) {
			readmeScore = 60;
		} else {
			readmeScore = 100;
		}

		// Check README sections
		const hasInstall = /install|getting started|setup|usage/i.test(readme);
		const hasDescription = readme.length > 100;
		if (!hasInstall) issues.push({ severity: "info", message: "README missing install/usage section", rule: "readme-no-install" });
		if (!hasDescription) issues.push({ severity: "warning", message: "README has very little content", rule: "readme-sparse" });
	}

	// Check exported function documentation
	const sourceFiles = inventory ? inventorySourceFiles(inventory) : getProductionFiles(cwd);

	let totalExports = 0;
	let documentedExports = 0;

	for (const sf of sourceFiles) {
		const lines = sf.content.split("\n");

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i].trim();
			if (
				line.startsWith("export function ") ||
				line.startsWith("export async function ") ||
				line.startsWith("export class ") ||
				line.startsWith("export interface ")
			) {
				totalExports++;
				// Check if preceded by a JSDoc or // comment (look back up to 3 lines for blank-line gaps)
				let documented = false;
				for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
					const prev = lines[j].trim();
					if (prev === "") continue; // skip blank lines
					if (prev.endsWith("*/") || prev.startsWith("//") || prev.startsWith("/**") || prev.startsWith("* ")) {
						documented = true;
					}
					break;
				}
				if (documented) documentedExports++;
			}
		}
	}

	if (totalExports > 0) {
		const pct = Math.round((documentedExports / totalExports) * 100);
		exportDocScore = pct;
		if (pct < 30) {
			issues.push({
				severity: "warning",
				message: `Only ${pct}% of exports have documentation (${documentedExports}/${totalExports})`,
				rule: "undocumented-exports",
			});
		}
	} else {
		exportDocScore = 100; // no exports = nothing to document
	}

	// Check for CHANGELOG
	let changelogScore = 50; // neutral by default
	if (existsSync(join(cwd, "CHANGELOG.md")) || existsSync(join(cwd, "CHANGES.md"))) {
		changelogScore = 100;
	} else if (existsSync(join(cwd, ".changeset"))) {
		changelogScore = 80; // using changesets = will have changelog
	} else {
		issues.push({ severity: "info", message: "No CHANGELOG.md — version history not documented", rule: "no-changelog" });
		changelogScore = 30;
	}

	const score = Math.round(readmeScore * 0.4 + exportDocScore * 0.4 + changelogScore * 0.2);

	return {
		name: "docs",
		score,
		grade: gradeFromScore(score),
		details: {
			readmeLines,
			totalExports,
			documentedExports,
			documentedPct: totalExports > 0 ? `${Math.round((documentedExports / totalExports) * 100)}%` : "n/a",
			hasChangelog: changelogScore >= 80,
			source: inventory ? "file-inventory" : "legacy-walk",
		},
		issues,
		duration: Date.now() - start,
	};
}
