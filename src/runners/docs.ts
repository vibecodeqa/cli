/** Documentation check — README, JSDoc, code comments. */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getProductionFiles } from "../fs-utils.js";
import type { CheckResult, Issue } from "../types.js";
import { gradeFromScore } from "../types.js";

export function runDocs(cwd: string): CheckResult {
	const start = Date.now();
	const issues: Issue[] = [];
	let readmeScore = 0;
	let exportDocScore = 0;

	// Check README
	const readmePath = join(cwd, "README.md");
	if (!existsSync(readmePath)) {
		issues.push({ severity: "error", message: "No README.md — project has no documentation", rule: "no-readme" });
	} else {
		const readme = readFileSync(readmePath, "utf-8");
		const lines = readme.split("\n").length;
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
	const sourceFiles = getProductionFiles(cwd);

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
				// Check if preceded by a JSDoc or // comment
				const prevLine = i > 0 ? lines[i - 1].trim() : "";
				if (prevLine.endsWith("*/") || prevLine.startsWith("//") || prevLine.startsWith("/**")) {
					documentedExports++;
				}
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

	const score = Math.round(readmeScore * 0.5 + exportDocScore * 0.5);

	return {
		name: "docs",
		score,
		grade: gradeFromScore(score),
		details: {
			readmeLines: existsSync(join(cwd, "README.md")) ? readFileSync(join(cwd, "README.md"), "utf-8").split("\n").length : 0,
			totalExports,
			documentedExports,
			documentedPct: totalExports > 0 ? `${Math.round((documentedExports / totalExports) * 100)}%` : "n/a",
		},
		issues,
		duration: Date.now() - start,
	};
}
