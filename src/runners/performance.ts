/** Performance check — barrel imports, dynamic import opportunities, large bundles.
 *
 * Sub-checks:
 *   1. Barrel import smell — index.ts re-exports that defeat tree-shaking
 *   2. Heavy dependencies — bundled packages known to bloat output
 *   3. Dynamic import opportunities — large imports that could be lazy-loaded
 *   4. CSS-in-JS overhead — detects runtime CSS solutions vs zero-runtime alternatives
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { getProductionFiles, readDeps } from "../fs-utils.js";
import type { CheckResult, Issue } from "../types.js";
import { gradeFromScore } from "../types.js";

// Packages known to be heavy (bundled KB, approx)
const HEAVY_DEPS: Record<string, { kb: number; alt: string }> = {
	moment: { kb: 300, alt: "date-fns or dayjs (2-7KB)" },
	lodash: { kb: 70, alt: "lodash-es or native methods" },
	"lodash.js": { kb: 70, alt: "lodash-es or native methods" },
	rxjs: { kb: 50, alt: "only import operators you use" },
	"@fortawesome/fontawesome-svg-core": { kb: 60, alt: "lucide-react or heroicons (tree-shakeable)" },
	"@material-ui/core": { kb: 300, alt: "@mui/material with tree-shaking imports" },
	"chart.js": { kb: 200, alt: "lightweight-charts or uPlot" },
	firebase: { kb: 200, alt: "firebase/app + only needed modules" },
	"aws-sdk": { kb: 400, alt: "@aws-sdk/client-* (v3 modular)" },
	underscore: { kb: 25, alt: "native ES methods" },
};

export function runPerformance(cwd: string): CheckResult {
	const start = Date.now();
	const issues: Issue[] = [];
	const sourceFiles = getProductionFiles(cwd);

	if (sourceFiles.length === 0) {
		return {
			name: "performance",
			score: 100,
			grade: "A",
			details: { skipped: true, reason: "no source files" },
			issues: [],
			duration: Date.now() - start,
		};
	}

	let barrelImports = 0;
	let heavyDeps = 0;
	let dynamicOpportunities = 0;
	let cssInJsRuntime = 0;

	// ── 1. Barrel import detection ──
	// Find index.ts files that just re-export
	for (const f of sourceFiles) {
		if (f.base !== "index") continue;
		const lines = f.content.split("\n").filter((l) => l.trim().length > 0);
		const exportLines = lines.filter((l) => /^export\s/.test(l.trim()));
		// If >80% of non-empty lines are re-exports, it's a barrel
		if (lines.length > 0 && exportLines.length / lines.length > 0.8 && exportLines.length >= 3) {
			barrelImports++;
			issues.push({
				severity: "warning",
				message: `Barrel file with ${exportLines.length} re-exports — defeats tree-shaking in many bundlers`,
				file: f.path,
				rule: "barrel-import",
			});
		}
	}

	// Check for imports from barrel files (importing from directory index)
	for (const f of sourceFiles) {
		const lines = f.content.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const match = lines[i].match(/import\s+\{[^}]{50,}\}\s+from\s+['"](\.[^'"]+)['"]/);
			if (match) {
				issues.push({
					severity: "info",
					message: "Large destructured import — if from a barrel, only imported items should be bundled",
					file: f.path,
					line: i + 1,
					rule: "large-import",
				});
			}
		}
	}

	// ── 2. Heavy dependency detection ──
	const deps = readDeps(cwd);
	for (const [name, info] of Object.entries(HEAVY_DEPS)) {
		if (deps[name]) {
			heavyDeps++;
			issues.push({
				severity: "warning",
				message: `${name} (~${info.kb}KB) — consider ${info.alt}`,
				rule: "heavy-dependency",
			});
		}
	}

	// lodash without lodash-es (non-tree-shakeable)
	if (deps.lodash && !deps["lodash-es"]) {
		issues.push({
			severity: "warning",
			message: "lodash (not lodash-es) — CommonJS build defeats tree-shaking",
			rule: "non-esm-dep",
		});
	}

	// ── 3. Dynamic import opportunities ──
	// Large conditional imports that could be lazy-loaded
	for (const f of sourceFiles) {
		const lines = f.content.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i].trim();
			// Static import of known-heavy visualization/editor libraries
			if (/^import\s/.test(line) && /\b(monaco|codemirror|ace-builds|chart\.js|three|@react-three|recharts|d3)\b/.test(line)) {
				dynamicOpportunities++;
				issues.push({
					severity: "info",
					message: "Consider dynamic import() for heavy library — reduces initial bundle",
					file: f.path,
					line: i + 1,
					rule: "dynamic-import-opportunity",
				});
			}
		}
	}

	// ── 4. CSS-in-JS runtime overhead ──
	const runtimeCss = ["styled-components", "@emotion/styled", "@emotion/react"];
	for (const pkg of runtimeCss) {
		if (deps[pkg]) {
			cssInJsRuntime++;
			issues.push({
				severity: "info",
				message: `${pkg} adds runtime CSS overhead — consider Tailwind, CSS Modules, or vanilla-extract`,
				rule: "runtime-css",
			});
		}
	}

	// ── 5. Bundle size check (if dist/ exists) ──
	let bundleSizeKB = 0;
	const distDirs = ["dist", "build", ".next", "out"];
	for (const d of distDirs) {
		const distPath = join(cwd, d);
		if (existsSync(distPath)) {
			try {
				bundleSizeKB = Math.round(dirSizeKB(distPath));
			} catch { /* can't read dist */ }
			break;
		}
	}

	// Score
	const penalty = barrelImports * 3 + heavyDeps * 8 + dynamicOpportunities * 2 + cssInJsRuntime * 2;
	const score = Math.max(0, Math.min(100, 100 - penalty));

	return {
		name: "performance",
		score,
		grade: gradeFromScore(score),
		details: {
			filesScanned: sourceFiles.length,
			barrelImports,
			heavyDeps,
			dynamicOpportunities,
			cssInJsRuntime,
			...(bundleSizeKB > 0 ? { bundleSizeKB } : {}),
		},
		issues,
		duration: Date.now() - start,
	};
}

function dirSizeKB(dir: string): number {
	let total = 0;
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		const stat = statSync(full);
		if (stat.isDirectory()) {
			total += dirSizeKB(full);
		} else {
			total += stat.size;
		}
	}
	return total / 1024;
}
