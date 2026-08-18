/** Lint check — auto-detects biome or eslint.
 *
 * Monorepo-aware: if root linter config exists, lint the whole repo (biome check .).
 * If linter is "none" at root, checks if CI workflows run lint or if packages have configs.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { hasFileWithExt, isIgnoredPath, normalizeToolPath } from "../fs-utils.js";
import type { CheckResult, Issue, ProjectContext, StackInfo, WorkspaceInfo } from "../types.js";
import { gradeFromScore } from "../types.js";
import { run } from "./exec.js";
import { DART_SDK_MISSING_REASON, hasDartSdk, unavailableResult } from "./toolchain.js";

export function runLint(cwd: string, stack: StackInfo, workspace?: WorkspaceInfo): CheckResult {
	const start = Date.now();
	const issues: Issue[] = [];

	const projectRuns = lintableProjects(workspace);
	if (stack.linter === "none" && projectRuns.length > 0) {
		const projects: Array<Record<string, unknown>> = [];
		let linted = 0;
		let dartUnavailable = 0;
		for (const project of projectRuns) {
			const projectCwd = project.path === "." ? cwd : join(cwd, project.path);
			// A Dart project we cannot analyze contributes no issues — which would
			// otherwise read as "this package lints clean" (#92). Record it as
			// unavailable and keep it out of the count of projects we really linted.
			if (project.stack.linter === "dart_analyze" && !hasDartSdk(cwd)) {
				dartUnavailable++;
				projects.push({
					id: project.id,
					path: project.path,
					linter: project.stack.linter,
					unavailable: true,
					reason: DART_SDK_MISSING_REASON,
				});
				continue;
			}
			linted++;
			const projectIssues = runConfiguredProjectLint(cwd, projectCwd, project);
			issues.push(...projectIssues);
			projects.push({
				id: project.id,
				path: project.path,
				linter: project.stack.linter,
				issues: projectIssues.length,
			});
		}
		// Nothing was actually linted — do not report a score for it.
		if (linted === 0 && dartUnavailable > 0) {
			return unavailableResult("lint", DART_SDK_MISSING_REASON, { linter: "dart_analyze", projects }, start);
		}
		const { score, errors, warnings } = scoreLint(issues);
		return {
			name: "lint",
			score,
			grade: gradeFromScore(score),
			details: {
				errors,
				warnings,
				linter: "project-scoped",
				projects,
				reason: "No root linter detected; ran configured project linters from their own directories",
			},
			issues,
			duration: Date.now() - start,
		};
	}

	// Determine the target path for linting
	// Monorepos with root config: lint "." (biome/eslint will find all files)
	// Single-package: lint "src/"
	const lintTarget = workspace?.isMonorepo ? "." : existsSync(join(cwd, "src")) ? "src/" : ".";

	if (stack.linter === "biome") {
		const { stdout } = run(`npx biome check ${lintTarget} --reporter=json 2>/dev/null || true`, cwd);
		const parsed = parseBiomeLint(stdout, { repoCwd: cwd, toolCwd: cwd });
		if (parsed) {
			issues.push(...parsed);
		} else {
			// Non-JSON output (older biome / a crash) — fall back to the text summary.
			const errors = stdout.match(/Found (\d+) error/)?.[1] || "0";
			const warnings = stdout.match(/Found (\d+) warning/)?.[1] || "0";
			for (let i = 0; i < parseInt(errors, 10); i++) issues.push({ severity: "error", message: "lint error" });
			for (let i = 0; i < parseInt(warnings, 10); i++) issues.push({ severity: "warning", message: "lint warning" });
		}
	} else if (stack.linter === "eslint") {
		const { stdout } = run(`npx eslint ${lintTarget} --format json 2>/dev/null || true`, cwd);
		issues.push(...parseEslintJson(stdout, { repoCwd: cwd, toolCwd: cwd }));
	} else if (stack.linter === "dart_analyze") {
		// Probe once before planning targets: without the SDK every `dart analyze`
		// below returns empty output, which parses as zero issues and scores A/100
		// for code that was never analyzed (#92).
		if (!hasDartSdk(cwd)) {
			return unavailableResult("lint", DART_SDK_MISSING_REASON, { linter: "dart_analyze" }, start);
		}
		issues.push(...dartAnalyzeIssues(cwd, workspace));
	} else {
		// ── Nothing declares a linter at the root ──
		// A Dart project with no analysis_options.yaml detects as `linter: "none"`
		// (detect.ts), but the tool that can read it is still `dart analyze` — not
		// a JavaScript linter. Claim it here, before the JS fallbacks below get a
		// chance to score Dart they cannot parse (#92).
		if (stack.language === "dart") {
			if (!hasDartSdk(cwd)) {
				return unavailableResult("lint", DART_SDK_MISSING_REASON, { linter: "dart_analyze" }, start);
			}
			const dartIssues = dartAnalyzeIssues(cwd, workspace);
			const { score, errors, warnings } = scoreLint(dartIssues);
			return {
				name: "lint",
				score,
				grade: gradeFromScore(score),
				details: {
					errors,
					warnings,
					linter: "dart_analyze",
					zeroConfig: true,
					reason: "No analysis_options.yaml — analyzed with the Dart SDK's default rules",
				},
				issues: dartIssues,
				duration: Date.now() - start,
			};
		}

		// No root linter detected — check if linting is happening elsewhere
		const lintInCI = detectLintInCI(cwd);
		const pkgLinters = workspace?.isMonorepo ? workspace.packages.filter((p) => p.hasLinter).length : 0;

		if (lintInCI || pkgLinters > 0) {
			// Linting IS happening, just not via a root config we can invoke
			const reason = lintInCI ? "Linting runs in CI workflows" : `${pkgLinters} workspace packages have linter configs`;
			return {
				name: "lint",
				score: 70, // Partial credit — linting exists but we can't run it from root
				grade: "B",
				details: { linter: "detected-in-pipeline", reason, lintInCI, pkgLinters },
				issues: [{ severity: "info", message: `No root linter config, but: ${reason}`, rule: "lint-not-root" }],
				duration: Date.now() - start,
			};
		}

		// Nothing configures a linter anywhere. Rather than skip, run Biome as an
		// ephemeral zero-config linter — the same "works without install/config"
		// approach we use for knip (dead code). Biome lints with its recommended
		// rules absent a biome.json; ESLint can't (it errors without one).
		//
		// Only where Biome can read the code, though: it exits 0 with zero
		// diagnostics on a tree it cannot parse, and zero diagnostics scores A/100
		// for code no linter ever looked at (#92).
		const plan = zeroConfigLintPlan(cwd, stack, lintTarget);
		if (plan.kind === "unavailable") {
			return unavailableResult(
				"lint",
				plan.reason,
				{ linter: "none", language: stack.language, lintTarget, lintableExtensions: BIOME_LINTABLE_EXTS },
				start,
			);
		}
		const zcIssues = runBiomeZeroConfig(cwd, lintTarget);
		if (zcIssues !== null) {
			const { score, errors, warnings } = scoreLint(zcIssues);
			return {
				name: "lint",
				score,
				grade: gradeFromScore(score),
				details: {
					errors,
					warnings,
					linter: "biome",
					zeroConfig: true,
					reason: "No linter configured — linted with Biome's recommended rules (zero-config)",
				},
				issues: zcIssues,
				duration: Date.now() - start,
			};
		}

		return {
			name: "lint",
			score: 0,
			grade: "F",
			details: { skipped: true, reason: "no linter detected" },
			issues: [],
			duration: Date.now() - start,
		};
	}

	const { score, errors, warnings } = scoreLint(issues);
	return {
		name: "lint",
		score,
		grade: gradeFromScore(score),
		details: { errors, warnings, linter: stack.linter },
		issues,
		duration: Date.now() - start,
	};
}

/** File extensions Biome's linter can actually parse.
 *
 * Everything else it walks straight past: a `.dart`, `.go`, `.py` or `.java`
 * tree produces zero diagnostics and exit 0 not because it is clean but because
 * Biome never read a line of it. Vue/Svelte/Astro are included — Biome lints the
 * embedded `<script>` blocks. `.json`/`.css` are deliberately excluded: Biome
 * parses them but has almost no lint rules for them, so a stray `package.json`
 * or stylesheet in a Dart repo must not count as "this project is lintable". */
const BIOME_LINTABLE_EXTS = [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".vue", ".svelte", ".astro"];

const LANGUAGE_LABELS: Record<string, string> = {
	typescript: "TypeScript",
	javascript: "JavaScript",
	dart: "Dart",
	go: "Go",
	rust: "Rust",
	java: "Java",
	python: "Python",
};

export type ZeroConfigLintPlan = { kind: "biome" } | { kind: "unavailable"; reason: string };

/** Decide whether the zero-config Biome fallback can measure anything here.
 *
 * The fallback exists so a project that configures no linter still gets a real
 * signal. It only *is* a signal where Biome can parse the sources; on a tree it
 * cannot read it reports zero findings, which the scorer reads as a flawless
 * pass (#92). No lintable file ⇒ no score, and an `unavailable` result that says
 * which linter the project is missing. */
export function zeroConfigLintPlan(cwd: string, stack: StackInfo, target: string): ZeroConfigLintPlan {
	// The fallback lints `target`, so ask about `target` — but a `src/` with no
	// scripts in an otherwise JS repo is still a JS repo, so fall back to the root.
	if (hasFileWithExt(cwd, BIOME_LINTABLE_EXTS, target) || hasFileWithExt(cwd, BIOME_LINTABLE_EXTS)) {
		return { kind: "biome" };
	}
	const label = LANGUAGE_LABELS[stack.language];
	return {
		kind: "unavailable",
		reason: `No linter available${label ? ` for this ${label} project` : ""} — none is configured, and the zero-config Biome fallback found no JavaScript/TypeScript sources to lint`,
	};
}

/** Run `dart analyze` over every Dart root and return what it found. Assumes the
 *  SDK has already been probed — see hasDartSdk(). */
function dartAnalyzeIssues(cwd: string, workspace?: WorkspaceInfo): Issue[] {
	const issues: Issue[] = [];
	const dartRoots =
		workspace?.isMonorepo && workspace.packages.some((p) => existsSync(join(cwd, p.path, "pubspec.yaml")))
			? workspace.packages.filter((p) => existsSync(join(cwd, p.path, "pubspec.yaml"))).map((p) => ({ cwd: join(cwd, p.path) }))
			: [{ cwd }];
	for (const root of dartRoots) {
		const { stdout } = run("dart analyze --format=machine 2>/dev/null || true", root.cwd);
		parseDartAnalyze(stdout, cwd, root.cwd, issues, false);
	}
	return issues;
}

function lintableProjects(workspace?: WorkspaceInfo): ProjectContext[] {
	return (workspace?.projects ?? []).filter((project) => project.path !== "." && project.stack.linter !== "none");
}

interface ToolPathOptions {
	repoCwd?: string;
	toolCwd?: string;
}

function pathMetadata(rawPath: string | undefined, opts?: ToolPathOptions): { file?: string; details?: Record<string, string> } {
	if (!rawPath || !opts?.repoCwd || !opts.toolCwd) return { file: rawPath };
	const repoRelativePath = normalizeToolPath(opts.repoCwd, opts.toolCwd, rawPath);
	const outsideRepo = repoRelativePath.startsWith("../") || repoRelativePath === ".." || isAbsolute(repoRelativePath);
	return {
		file: outsideRepo ? undefined : repoRelativePath,
		details: {
			...(outsideRepo ? {} : { repoRelativePath }),
			toolRelativePath: rawPath,
			toolCwd: opts.toolCwd,
			pathStatus: outsideRepo ? "outside-repo" : "normalized",
		},
	};
}

function withPathDetails(issue: Issue, details?: Record<string, string>): Issue {
	return details ? ({ ...issue, details } as Issue) : issue;
}

function runConfiguredProjectLint(repoCwd: string, projectCwd: string, project: ProjectContext): Issue[] {
	if (project.stack.linter === "biome") {
		const { stdout } = run("npx biome check . --reporter=json 2>/dev/null || true", projectCwd, 60_000, {
			projectId: project.id,
			projectPath: project.path,
		});
		const parsed = parseBiomeLint(stdout, { repoCwd, toolCwd: projectCwd });
		return parsed ?? [];
	}
	if (project.stack.linter === "eslint") {
		const { stdout } = run("npx eslint . --format json 2>/dev/null || true", projectCwd, 60_000, {
			projectId: project.id,
			projectPath: project.path,
		});
		return parseEslintJson(stdout, { repoCwd, toolCwd: projectCwd });
	}
	if (project.stack.linter === "dart_analyze") {
		const issues: Issue[] = [];
		const { stdout } = run("dart analyze --format=machine 2>/dev/null || true", projectCwd, 60_000, {
			projectId: project.id,
			projectPath: project.path,
		});
		parseDartAnalyze(stdout, repoCwd, projectCwd, issues, false);
		return issues;
	}
	return [];
}

export function parseEslintJson(stdout: string, opts?: ToolPathOptions): Issue[] {
	const issues: Issue[] = [];
	try {
		const files = JSON.parse(stdout);
		for (const file of files) {
			for (const msg of file.messages || []) {
				const path = pathMetadata(file.filePath, opts);
				if (path.file && isIgnoredPath(path.file)) continue;
				issues.push(
					withPathDetails(
						{
							severity: msg.severity === 2 ? "error" : "warning",
							message: msg.message,
							file: path.file,
							line: msg.line,
							rule: msg.ruleId,
						},
						path.details,
					),
				);
			}
		}
	} catch {
		/* eslint output parse failed */
	}
	return issues;
}

function parseDartAnalyze(stdout: string, repoCwd: string, runCwd: string, issues: Issue[], errorsOnly: boolean): void {
	for (const line of stdout.split("\n")) {
		const parts = line.split("|");
		if (parts.length < 8) continue;
		if (errorsOnly && parts[0] !== "ERROR") continue;
		const severity = parts[0] === "ERROR" ? "error" : parts[0] === "WARNING" ? "warning" : "info";
		const rawPath = parts[3].startsWith(`/private${runCwd}`) ? parts[3].slice("/private".length) : parts[3];
		const path = pathMetadata(rawPath, { repoCwd, toolCwd: runCwd });
		issues.push(
			withPathDetails(
				{
					severity,
					message: parts[7],
					file: path.file,
					line: parseInt(parts[4], 10) || undefined,
					rule: parts[2],
				},
				path.details,
			),
		);
	}
}

/** Lint score from issue counts — diminishing penalty so a large count can't
 *  drive the score arbitrarily negative. Shared by the configured-linter path
 *  and the zero-config Biome fallback. */
export function scoreLint(issues: Issue[]): { score: number; errors: number; warnings: number } {
	const errors = issues.filter((i) => i.severity === "error").length;
	const warnings = issues.filter((i) => i.severity === "warning").length;
	const errorPenalty = Math.min(70, errors * Math.min(10, 40 / Math.max(errors, 1)));
	const warnPenalty = Math.min(25, warnings * Math.min(2, 15 / Math.max(warnings, 1)));
	const score = Math.max(0, Math.min(100, Math.round(100 - errorPenalty - warnPenalty)));
	return { score, errors, warnings };
}

/** Run Biome's linter with no project config — recommended rules only — so a
 *  project that configures no linter still gets a real lint signal (like knip
 *  for dead code) instead of a bare "skipped". Uses `biome lint` (not `check`)
 *  to assess lint rules, not formatting. Returns the issues, or null if Biome
 *  couldn't produce parseable output (caller then keeps the honest skip). */
function runBiomeZeroConfig(cwd: string, target: string): Issue[] | null {
	// Bare `npx @biomejs/biome` (no `--yes`) so a locally-resolvable Biome runs
	// instantly without a registry round-trip; where it isn't installed npx
	// fetches it, exactly like the knip dead-code path. Bounded + `|| true` so an
	// offline/slow environment caps quickly and we keep the honest "no linter" skip.
	const { stdout } = run(`npx @biomejs/biome lint ${target} --reporter=json 2>/dev/null || true`, cwd, 30_000);
	const issues = parseBiomeLint(stdout, { repoCwd: cwd, toolCwd: cwd });
	if (!issues) return null;
	// Biome walks the filesystem itself and doesn't know the scan's ignore config,
	// so drop any diagnostic for a path the scan is configured to exclude.
	return issues.filter((i) => !i.file || !isIgnoredPath(i.file));
}

/** Parse Biome's `--reporter=json` output into issues, or null if it isn't valid
 *  Biome JSON (older version, a crash, or the binary was absent). Shared by the
 *  configured-Biome path and the zero-config fallback. Skips generated files. */
export function parseBiomeLint(stdout: string, opts?: ToolPathOptions): Issue[] | null {
	let data: { diagnostics?: unknown };
	try {
		data = JSON.parse(stdout);
	} catch {
		return null;
	}
	if (!Array.isArray(data.diagnostics)) return null;
	const issues: Issue[] = [];
	// Biome emits one `parse`-category error per parse failure *within* a file, so
	// a single unparseable file can explode into many errors and sink the score.
	// Collapse them to one issue per file — one "can't parse this file" signal.
	const parseSeen = new Set<string>();
	for (const d of data.diagnostics as Array<Record<string, any>>) {
		// biome path can be a string or {file: "..."} depending on version.
		const rawPath = d.location?.path;
		const toolPath = typeof rawPath === "string" ? rawPath : rawPath?.file || undefined;
		const path = pathMetadata(toolPath, opts);
		const file = path.file;
		if (file && isIgnoredPath(file)) continue;
		if (d.category === "parse") {
			const key = file ?? "";
			if (parseSeen.has(key)) continue;
			parseSeen.add(key);
		}
		issues.push(
			withPathDetails(
				{
					severity: d.severity === "error" ? "error" : d.severity === "warning" ? "warning" : "info",
					message: d.description || d.message || "lint issue",
					file,
					rule: d.category,
				},
				path.details,
			),
		);
	}
	return issues;
}

/** Check if CI workflows contain lint/check commands. */
function detectLintInCI(cwd: string): boolean {
	const workflowDir = join(cwd, ".github", "workflows");
	if (!existsSync(workflowDir)) return false;
	try {
		for (const f of readdirSync(workflowDir)) {
			if (!f.endsWith(".yml") && !f.endsWith(".yaml")) continue;
			const content = readFileSync(join(workflowDir, f), "utf-8");
			// Match real lint invocations only. A bare "check" matched step names and
			// comments ("Check out the code", "sanity check"), awarding unearned credit.
			if (/\b(biome|eslint|lint)\b/i.test(content)) return true;
		}
	} catch {
		/* can't read workflows */
	}
	return false;
}
