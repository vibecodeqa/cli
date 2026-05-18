/** Performance check — barrel imports, dynamic import opportunities, large bundles.
 *
 * Sub-checks:
 *   1. Barrel import smell — index.ts re-exports that defeat tree-shaking
 *   2. Heavy dependencies — bundled packages known to bloat output
 *   3. Dynamic import opportunities — large imports that could be lazy-loaded
 *   4. CSS-in-JS overhead — detects runtime CSS solutions vs zero-runtime alternatives
 */

import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getProductionFiles, readDeps } from "../fs-utils.js";
import type { CheckResult, Issue } from "../types.js";
import { gradeFromScore } from "../types.js";
import { run } from "./exec.js";

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
	"@angular/core": { kb: 500, alt: "consider lighter framework if possible" },
	jquery: { kb: 90, alt: "native DOM APIs or Alpine.js" },
	"core-js": { kb: 150, alt: "target modern browsers, use browserslist" },
	numeral: { kb: 30, alt: "Intl.NumberFormat (built-in)" },
	"date-fns": { kb: 40, alt: "import only needed functions: date-fns/format" },
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
			} catch {
				/* can't read dist */
			}
			break;
		}
	}

	// ── 6. Dead code detection (via Knip) ──
	let deadExports = 0;
	let unusedFiles = 0;
	let unusedDeps = 0;
	const knipResult = tryKnip(cwd);
	if (knipResult) {
		deadExports = knipResult.exports;
		unusedFiles = knipResult.files;
		unusedDeps = knipResult.deps;
		if (unusedFiles > 0) {
			issues.push({
				severity: "warning",
				message: `${unusedFiles} unused files detected by Knip — consider removing`,
				rule: "dead-files",
			});
		}
		if (deadExports > 0) {
			issues.push({
				severity: "info",
				message: `${deadExports} unused exports detected by Knip — dead code`,
				rule: "dead-exports",
			});
		}
		if (unusedDeps > 0) {
			issues.push({
				severity: "warning",
				message: `${unusedDeps} unused dependencies detected by Knip — remove from package.json`,
				rule: "unused-deps",
			});
		}
	}

	// Score — proportional to codebase, capped per category
	const totalFiles = sourceFiles.length || 1;
	const barrelPenalty = Math.min(15, (barrelImports / totalFiles) * 200);
	const heavyPenalty = Math.min(30, heavyDeps * 8);
	const dynamicPenalty = Math.min(10, dynamicOpportunities * 3);
	const cssPenalty = Math.min(10, cssInJsRuntime * 5);
	const deadPenalty = knipResult ? Math.min(15, ((unusedFiles + unusedDeps) / totalFiles) * 100) : 0;
	const score = Math.max(0, Math.min(100, Math.round(100 - barrelPenalty - heavyPenalty - dynamicPenalty - cssPenalty - deadPenalty)));

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
			...(knipResult ? { deadExports, unusedFiles, unusedDeps, deadCodeTool: "knip" } : {}),
			...(bundleSizeKB > 0 ? { bundleSizeKB } : {}),
		},
		issues,
		duration: Date.now() - start,
	};
}

function dirSizeKB(dir: string, depth = 0): number {
	if (depth > 10) return 0; // prevent infinite recursion
	let total = 0;
	try {
		for (const entry of readdirSync(dir)) {
			if (entry === "node_modules" || entry === ".git") continue;
			const full = join(dir, entry);
			try {
				const lst = lstatSync(full);
				if (lst.isSymbolicLink()) continue; // skip symlinks
				if (lst.isDirectory()) {
					total += dirSizeKB(full, depth + 1);
				} else {
					total += lst.size;
				}
			} catch {
				/* skip inaccessible files */
			}
		}
	} catch {
		/* skip inaccessible dirs */
	}
	return total / 1024;
}

/** Try running Knip for dead code detection. Returns counts or null if not available. */
function tryKnip(cwd: string): { files: number; exports: number; deps: number } | null {
	const { stdout } = run("npx knip --reporter json 2>/dev/null || true", cwd, 30_000);
	try {
		const data = JSON.parse(stdout);
		return {
			files: Array.isArray(data.files) ? data.files.length : 0,
			exports: Array.isArray(data.exports) ? data.exports.length : 0,
			deps: Array.isArray(data.dependencies) ? data.dependencies.length : 0,
		};
	} catch {
		return null;
	}
}
