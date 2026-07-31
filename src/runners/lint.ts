/** Lint check — auto-detects biome or eslint.
 *
 * Monorepo-aware: if root linter config exists, lint the whole repo (biome check .).
 * If linter is "none" at root, checks if CI workflows run lint or if packages have configs.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isIgnoredPath } from "../fs-utils.js";
import type { CheckResult, Issue, StackInfo, WorkspaceInfo } from "../types.js";
import { gradeFromScore } from "../types.js";
import { run } from "./exec.js";

export function runLint(cwd: string, stack: StackInfo, workspace?: WorkspaceInfo): CheckResult {
	const start = Date.now();
	const issues: Issue[] = [];

	// Determine the target path for linting
	// Monorepos with root config: lint "." (biome/eslint will find all files)
	// Single-package: lint "src/"
	const lintTarget = workspace?.isMonorepo ? "." : existsSync(join(cwd, "src")) ? "src/" : ".";

	if (stack.linter === "biome") {
		const { stdout } = run(`npx biome check ${lintTarget} --reporter=json 2>/dev/null || true`, cwd);
		const parsed = parseBiomeLint(stdout);
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
		try {
			const files = JSON.parse(stdout);
			for (const file of files) {
				for (const msg of file.messages || []) {
					issues.push({
						severity: msg.severity === 2 ? "error" : "warning",
						message: msg.message,
						file: file.filePath,
						line: msg.line,
						rule: msg.ruleId,
					});
				}
			}
		} catch {
			/* eslint output parse failed */
		}
	} else if (stack.linter === "dart_analyze") {
		const dartRoots =
			workspace?.isMonorepo && workspace.packages.some((p) => existsSync(join(cwd, p.path, "pubspec.yaml")))
				? workspace.packages
						.filter((p) => existsSync(join(cwd, p.path, "pubspec.yaml")))
						.map((p) => ({ cwd: join(cwd, p.path), prefix: p.path }))
				: [{ cwd, prefix: "" }];
		for (const root of dartRoots) {
			const { stdout } = run("dart analyze --format=machine 2>/dev/null || true", root.cwd);
			parseDartAnalyze(stdout, root.cwd, root.prefix, issues, false);
		}
	} else {
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

function parseDartAnalyze(stdout: string, runCwd: string, prefix: string, issues: Issue[], errorsOnly: boolean): void {
	for (const line of stdout.split("\n")) {
		const parts = line.split("|");
		if (parts.length < 8) continue;
		if (errorsOnly && parts[0] !== "ERROR") continue;
		const severity = parts[0] === "ERROR" ? "error" : parts[0] === "WARNING" ? "warning" : "info";
		let filePath = parts[3];
		if (filePath.startsWith(runCwd)) filePath = filePath.slice(runCwd.length + 1);
		else if (filePath.startsWith(`/private${runCwd}`)) filePath = filePath.slice(`/private${runCwd}`.length + 1);
		else if (filePath.includes(runCwd.split("/").pop()!)) {
			const idx = filePath.indexOf(runCwd.split("/").pop()!);
			if (idx >= 0) filePath = filePath.slice(idx + runCwd.split("/").pop()!.length + 1);
		}
		const file = prefix && filePath && !filePath.startsWith(`${prefix}/`) ? `${prefix}/${filePath}` : filePath;
		issues.push({
			severity,
			message: parts[7],
			file,
			line: parseInt(parts[4], 10) || undefined,
			rule: parts[2],
		});
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
	const issues = parseBiomeLint(stdout);
	if (!issues) return null;
	// Biome walks the filesystem itself and doesn't know the scan's ignore config,
	// so drop any diagnostic for a path the scan is configured to exclude.
	return issues.filter((i) => !i.file || !isIgnoredPath(i.file));
}

/** Parse Biome's `--reporter=json` output into issues, or null if it isn't valid
 *  Biome JSON (older version, a crash, or the binary was absent). Shared by the
 *  configured-Biome path and the zero-config fallback. Skips generated files. */
export function parseBiomeLint(stdout: string): Issue[] | null {
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
		const file = typeof rawPath === "string" ? rawPath : rawPath?.file || undefined;
		if (file && (file.includes(".vibe-check/") || file.includes("node_modules/"))) continue;
		if (d.category === "parse") {
			const key = file ?? "";
			if (parseSeen.has(key)) continue;
			parseSeen.add(key);
		}
		issues.push({
			severity: d.severity === "error" ? "error" : d.severity === "warning" ? "warning" : "info",
			message: d.description || d.message || "lint issue",
			file,
			rule: d.category,
		});
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
