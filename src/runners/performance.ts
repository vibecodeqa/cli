/** Performance check — barrel imports, dynamic import opportunities, large bundles.
 *
 * Sub-checks:
 *   1. Barrel import smell — index.ts re-exports that defeat tree-shaking
 *   2. Heavy dependencies — bundled packages known to bloat output
 *   3. Dynamic import opportunities — large imports that could be lazy-loaded
 *   4. CSS-in-JS overhead — detects runtime CSS solutions vs zero-runtime alternatives
 */

import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getProductionFiles, readDeps } from "../fs-utils.js";
import type { CheckResult, Issue, WorkspaceInfo } from "../types.js";
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

export function runPerformance(cwd: string, workspace?: WorkspaceInfo): CheckResult {
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
	const knipResult = tryKnip(cwd, workspace);
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

	// ── 7. PWA readiness (web projects only) ──
	const isWebProject = !!(deps.react || deps.vue || deps.svelte || deps["@sveltejs/kit"] || deps.next || deps.nuxt);
	if (isWebProject) {
		const manifestPaths = ["public/manifest.json", "public/manifest.webmanifest", "manifest.json", "web/manifest.json"];
		const hasManifest = manifestPaths.some((p) => existsSync(join(cwd, p)));
		if (!hasManifest) {
			issues.push({ severity: "info", message: "No web app manifest — can't install as PWA or add to home screen", rule: "no-manifest" });
		}
		const swPaths = ["public/sw.js", "public/service-worker.js", "src/service-worker.ts", "src/sw.ts"];
		const hasSW =
			swPaths.some((p) => existsSync(join(cwd, p))) || !!(deps["workbox-webpack-plugin"] || deps["vite-plugin-pwa"] || deps["next-pwa"]);
		if (!hasSW) {
			issues.push({ severity: "info", message: "No service worker — app won't work offline", rule: "no-service-worker" });
		}
	}

	// ── 8. CSS best practices ──
	const cssFiles = getProductionFiles(cwd).filter((f) => f.ext === ".css");
	for (const f of cssFiles) {
		const lines = f.content.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			// !important overuse
			if (/!important/.test(line)) {
				issues.push({
					severity: "info",
					message: "!important — specificity escape hatch, usually a sign of CSS architecture issues",
					file: f.path,
					line: i + 1,
					rule: "css-important",
				});
			}
		}
		// No media queries in CSS with fixed layouts
		if (f.content.length > 500 && !/@media/.test(f.content) && /width:\s*\d{3,}px/.test(f.content)) {
			issues.push({
				severity: "info",
				message: "CSS with fixed widths but no @media queries — likely not responsive",
				file: f.path,
				rule: "no-media-queries",
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
			...(knipResult
				? {
						deadExports,
						unusedFiles,
						unusedDeps,
						deadCodeTool: "knip",
						// False when nothing configured knip — its entry points are then
						// guesses and "unused" can mean "unreachable from a wrong start".
						deadCodeConfigured: knipResult.configured,
						// Item lists, not just counts — the Dead Code page needs the
						// actual candidates (vibecodeqa/app#7). Capped so a pathological
						// project cannot bloat the report.
						deadCode: {
							files: knipResult.unusedFiles.slice(0, 500),
							exports: knipResult.unusedExports.slice(0, 1000),
							types: knipResult.unusedTypes.slice(0, 500),
							deps: knipResult.unusedDeps.slice(0, 200),
						},
					}
				: {}),
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
export interface DeadCodeItem {
	/** File the finding belongs to (repo-relative, as Knip reports it). */
	file: string;
	/** Export/dependency name. Absent for whole-file findings. */
	name?: string;
	line?: number;
	col?: number;
}

export interface KnipFindings {
	unusedFiles: DeadCodeItem[];
	unusedExports: DeadCodeItem[];
	unusedTypes: DeadCodeItem[];
	unusedDeps: DeadCodeItem[];
}

export function deadCodeCheckFromPerformance(performance: CheckResult): CheckResult {
	const details = performance.details as Record<string, unknown>;
	const deadCode = details.deadCode as Record<string, unknown> | undefined;
	const unusedFiles = Number(details.unusedFiles) || 0;
	const unusedDeps = Number(details.unusedDeps) || 0;
	const deadExports = Number(details.deadExports) || 0;
	const total = unusedFiles + unusedDeps + deadExports;
	const issues = performance.issues.filter((i) => ["dead-files", "dead-exports", "unused-deps"].includes(i.rule ?? ""));

	if (details.deadCodeTool !== "knip") {
		return {
			name: "dead-code",
			score: 0,
			grade: "F",
			details: {
				synthetic: true,
				skipped: true,
				reason: "Knip did not produce a parseable dead-code report",
			},
			issues: [],
			duration: 0,
		};
	}

	const score = total === 0 ? 100 : Math.max(0, 100 - Math.min(90, unusedFiles * 10 + unusedDeps * 8 + deadExports * 2));
	return {
		name: "dead-code",
		score,
		grade: gradeFromScore(score),
		details: {
			synthetic: true,
			sourceCheck: "performance",
			deadCodeTool: "knip",
			deadCodeConfigured: details.deadCodeConfigured,
			unusedFiles,
			unusedDeps,
			deadExports,
			deadCode: deadCode ?? { files: [], exports: [], types: [], deps: [] },
			toolRuns: details.toolRuns,
		},
		issues,
		duration: 0,
	};
}

/** Parse Knip's JSON reporter. Modern Knip emits `{ issues: [ { file, exports[],
 *  types[], dependencies[], files[] } ] }` — a per-file grouping, NOT the flat
 *  top-level arrays an older shape used. Reading the old keys silently yielded
 *  zero for every project, so both shapes are handled here. */
export function parseKnipJson(stdout: string): KnipFindings | null {
	let data: unknown;
	try {
		data = JSON.parse(stdout);
	} catch {
		return null;
	}
	const out: KnipFindings = { unusedFiles: [], unusedExports: [], unusedTypes: [], unusedDeps: [] };
	const asItems = (file: string, arr: unknown): DeadCodeItem[] =>
		Array.isArray(arr)
			? arr.map((e) =>
					typeof e === "string"
						? { file, name: e }
						: {
								file: typeof (e as { file?: string }).file === "string" ? (e as { file: string }).file : file,
								name: (e as { name?: string }).name,
								line: (e as { line?: number }).line,
								col: (e as { col?: number }).col,
							},
				)
			: [];

	const record = data as Record<string, unknown>;
	const issues = record.issues;
	if (Array.isArray(issues)) {
		for (const raw of issues) {
			const entry = raw as Record<string, unknown>;
			const file = typeof entry.file === "string" ? entry.file : "";
			out.unusedFiles.push(...asItems(file, entry.files));
			out.unusedExports.push(...asItems(file, entry.exports));
			out.unusedTypes.push(...asItems(file, entry.types));
			out.unusedDeps.push(...asItems(file, entry.dependencies), ...asItems(file, entry.devDependencies));
		}
		return out;
	}
	// Legacy flat shape.
	out.unusedFiles.push(...asItems("", record.files));
	out.unusedExports.push(...asItems("", record.exports));
	out.unusedDeps.push(...asItems("", record.dependencies));
	return out;
}

const KNIP_CONFIGS = ["knip.json", "knip.jsonc", "knip.config.ts", "knip.config.js", "knip.config.mjs", ".knip.json"];

/** Does this directory configure knip (file, or a `knip` key in package.json)? */
export function hasKnipConfig(dir: string): boolean {
	if (KNIP_CONFIGS.some((f) => existsSync(join(dir, f)))) return true;
	try {
		const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
		return typeof pkg.knip === "object" && pkg.knip !== null;
	} catch {
		return false;
	}
}

/** Where knip should actually run.
 *
 *  Knip's answer is only as good as its entry points, and entry globs are
 *  relative to the directory holding the config. Running at a monorepo root
 *  whose config lives in a package means knip starts from nothing and calls the
 *  whole package unreachable — which reported 42 live Cloudflare Pages Function
 *  modules as "unused files" on a real project. So: run where the config is. */
export function knipRoots(cwd: string, workspace?: WorkspaceInfo): { dir: string; rel: string; configured: boolean }[] {
	if (hasKnipConfig(cwd)) return [{ dir: cwd, rel: "", configured: true }];
	const pkgRoots = (workspace?.packages ?? [])
		.map((p) => ({ dir: join(cwd, p.path), rel: p.path, configured: true }))
		.filter((r) => hasKnipConfig(r.dir));
	if (pkgRoots.length > 0) return pkgRoots;
	// Nothing configures knip — run at the root, but mark it so consumers can
	// say so rather than presenting unverified output as fact.
	return [{ dir: cwd, rel: "", configured: false }];
}

function tryKnip(
	cwd: string,
	workspace?: WorkspaceInfo,
): (KnipFindings & { files: number; exports: number; deps: number; configured: boolean }) | null {
	const roots = knipRoots(cwd, workspace);
	const merged: KnipFindings = { unusedFiles: [], unusedExports: [], unusedTypes: [], unusedDeps: [] };
	let any = false;
	let configured = true;
	for (const root of roots) {
		const { stdout } = run("npx knip --reporter json 2>/dev/null || true", root.dir, 60_000);
		const parsed = parseKnipJson(stdout);
		if (!parsed) continue;
		any = true;
		if (!root.configured) configured = false;
		const prefix = (f: string) => (root.rel && f && !f.startsWith(root.rel) ? `${root.rel}/${f}` : f);
		for (const key of ["unusedFiles", "unusedExports", "unusedTypes", "unusedDeps"] as const) {
			for (const item of parsed[key]) merged[key].push({ ...item, file: prefix(item.file) });
		}
	}
	if (!any) return null;
	return {
		...merged,
		configured,
		files: merged.unusedFiles.length,
		exports: merged.unusedExports.length + merged.unusedTypes.length,
		deps: merged.unusedDeps.length,
	};
}
