/** @vibecodeqa/cli/core — Programmatic scan API.
 *
 * Usage:
 *   import { scan } from "@vibecodeqa/cli/core";
 *   const report = await scan("./src");
 *   console.log(report.score, report.grade);
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CHECK_META, type CheckMeta, getCheckMeta } from "./check-meta.js";
import { getCheckIgnore, isCheckEnabled, loadConfig, type VcqaConfig } from "./config.js";
import { detectRepoUrl, detectStack, detectWorkspace } from "./detect.js";
import { readEnvIgnoreNames, setGlobalIgnore, setGlobalIgnoreNames, setGlobalSrcRoots } from "./fs-utils.js";
import { runAccessibility } from "./runners/accessibility.js";
import { runArchitecture } from "./runners/architecture.js";
import { runBestPractices } from "./runners/best-practices.js";
import { runCloudflareWorkers } from "./runners/cloudflare-workers.js";
import { runCodeCoherence } from "./runners/code-coherence.js";
import { runCommentStaleness } from "./runners/comment-staleness.js";
import { runComplexity } from "./runners/complexity.js";
import { runConfusion } from "./runners/confusion.js";
import { runContainerHealth } from "./runners/container-health.js";
import { runContext } from "./runners/context.js";
import { runDeadPatterns } from "./runners/dead-patterns.js";
import { runDependencies } from "./runners/dependencies.js";
import { runDesignConsistency } from "./runners/design-consistency.js";
import { runDocCoherence } from "./runners/doc-coherence.js";
import { runDocs } from "./runners/docs.js";
import { runDuplication } from "./runners/duplication.js";
import { runEnvValidation } from "./runners/env-validation.js";
import { runErrorHandling } from "./runners/error-handling.js";
import { runFileCohesion } from "./runners/file-cohesion.js";
import { runFrontendHealth } from "./runners/frontend-health.js";
import { runGitHygiene } from "./runners/git-hygiene.js";
import { runHtmlQuality } from "./runners/html-quality.js";
import { runLint } from "./runners/lint.js";
import { runMemorySafety } from "./runners/memory-safety.js";
import { runPerformance } from "./runners/performance.js";
import { runReact } from "./runners/react.js";
import { runSecrets } from "./runners/secrets.js";
import { runSecurity } from "./runners/security.js";
import { runSqliteD1 } from "./runners/sqlite-d1.js";
import { runStandards } from "./runners/standards.js";
import { runStructure } from "./runners/structure.js";
import { runStyling } from "./runners/styling.js";
import { runTestAudit } from "./runners/test-audit.js";
import { runTesting } from "./runners/testing.js";
import { runTypeSafety } from "./runners/type-safety.js";
import { runTypeCheck } from "./runners/types-check.js";
import { computeScore } from "./score.js";
import type { CheckResult, Issue, StackInfo, VibeReport, WorkspaceInfo, WorkspacePackage } from "./types.js";
import { gradeFromScore } from "./types.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"));
const VERSION: string = pkg.version;

// ── Public API ──

export interface ScanOptions {
	/** Skip test execution (faster scan). Default: false */
	skipTests?: boolean;
	/** Only run these checks (by name). Default: all checks */
	checks?: string[];
	/** Override config (instead of loading from .vcqa.json). */
	config?: VcqaConfig;
	/** Extra directory/file names to skip (segment match), merged with VCQA_IGNORE. */
	ignoreNames?: string[];
	/** Progress callback — called for each completed check. */
	onProgress?: (check: string, result: CheckResult, index: number, total: number) => void;
}

/** Run a full code health scan. Returns a VibeReport with score, grade, and all check results. */
export async function scan(cwd: string, options: ScanOptions = {}): Promise<VibeReport> {
	const start = Date.now();
	const resolvedCwd = resolve(cwd);

	const config = options.config ?? loadConfig(resolvedCwd);
	const workspace = detectWorkspace(resolvedCwd);
	const stack = detectStack(resolvedCwd, workspace);
	const isDart = stack.language === "dart";

	setGlobalSrcRoots(workspace.isMonorepo ? workspace.srcRoots : undefined);
	setGlobalIgnore(config.ignore);
	// Extra ignore names: .vcqa.json config + the VCQA_IGNORE env var (the desktop
	// monitor's user "Ignored paths"). Merged so the scan skips the same folders
	// the watcher and graphs do.
	setGlobalIgnoreNames([...(options.ignoreNames ?? []), ...readEnvIgnoreNames(process.env.VCQA_IGNORE)]);

	const srcRoots = workspace.isMonorepo ? workspace.srcRoots : undefined;
	const skipTests = options.skipTests ?? false;

	const allRunners: { name: string; fn: () => CheckResult | Promise<CheckResult> }[] = [
		{ name: "structure", fn: () => runStructure(resolvedCwd, stack, workspace) },
		{ name: "lint", fn: () => runLint(resolvedCwd, stack, workspace) },
		{ name: "types", fn: () => runTypeCheck(resolvedCwd, isDart, workspace) },
		{ name: "type-safety", fn: () => runTypeSafety(resolvedCwd, isDart) },
		{ name: "standards", fn: () => runStandards(resolvedCwd, stack, workspace) },
		{ name: "complexity", fn: () => runComplexity(resolvedCwd) },
		{ name: "duplication", fn: () => runDuplication(resolvedCwd) },
		{ name: "error-handling", fn: () => runErrorHandling(resolvedCwd) },
		{ name: "react", fn: () => runReact(resolvedCwd) },
		{ name: "accessibility", fn: () => runAccessibility(resolvedCwd) },
		{ name: "docs", fn: () => runDocs(resolvedCwd) },
		{ name: "best-practices", fn: () => runBestPractices(resolvedCwd, workspace) },
		{ name: "env-validation", fn: () => runEnvValidation(resolvedCwd) },
		{ name: "git-hygiene", fn: () => runGitHygiene(resolvedCwd) },
		{ name: "memory-safety", fn: () => runMemorySafety(resolvedCwd) },
		{ name: "testing", fn: () => runTesting(resolvedCwd, stack, skipTests, srcRoots) },
		{ name: "secrets", fn: () => runSecrets(resolvedCwd) },
		{ name: "security", fn: () => runSecurity(resolvedCwd) },
		{ name: "dependencies", fn: () => runDependencies(resolvedCwd, stack) },
		{ name: "architecture", fn: () => runArchitecture(resolvedCwd, workspace) },
		{ name: "performance", fn: () => runPerformance(resolvedCwd, workspace) },
		{ name: "container-health", fn: () => runContainerHealth(resolvedCwd) },
		{ name: "cloudflare-workers", fn: () => runCloudflareWorkers(resolvedCwd, workspace) },
		{ name: "sqlite-d1", fn: () => runSqliteD1(resolvedCwd, workspace) },
		{ name: "confusion", fn: () => runConfusion(resolvedCwd) },
		{ name: "context", fn: () => runContext(resolvedCwd) },
		{ name: "doc-coherence", fn: () => runDocCoherence(resolvedCwd) },
		{ name: "code-coherence", fn: () => runCodeCoherence(resolvedCwd) },
		{ name: "comment-staleness", fn: () => runCommentStaleness(resolvedCwd) },
		{ name: "html-quality", fn: () => runHtmlQuality(resolvedCwd) },
		{ name: "frontend-health", fn: () => runFrontendHealth(resolvedCwd) },
		{ name: "styling", fn: () => runStyling(resolvedCwd) },
		{ name: "dead-patterns", fn: () => runDeadPatterns(resolvedCwd) },
		{ name: "test-audit", fn: () => runTestAudit(resolvedCwd) },
		{ name: "file-cohesion", fn: () => runFileCohesion(resolvedCwd) },
		{ name: "design-consistency", fn: () => runDesignConsistency(resolvedCwd) },
	];

	// Filter checks if specified
	const checkFilter = options.checks ? new Set(options.checks) : null;
	const runners = checkFilter ? allRunners.filter((r) => checkFilter.has(r.name)) : allRunners;

	const checks: CheckResult[] = [];
	const total = runners.length;

	for (let i = 0; i < total; i++) {
		const runner = runners[i];

		if (!isCheckEnabled(config, runner.name)) {
			const skipped: CheckResult = {
				name: runner.name,
				score: 0,
				grade: "F",
				details: { skipped: true, reason: "disabled in config" },
				issues: [],
				duration: 0,
			};
			checks.push(skipped);
			options.onProgress?.(runner.name, skipped, i, total);
			continue;
		}

		// Central stack gating: a check either declares appliesTo in CheckMeta or is
		// stack-blind. Runners must not re-implement this (see CLAUDE.md).
		const applies = getCheckMeta(runner.name).appliesTo;
		if (applies) {
			const langOk = !applies.language || applies.language.includes(stack.language);
			const fwOk = !applies.framework || applies.framework.includes(stack.framework);
			const compOk = !applies.component || applies.component.every((c) => stack.components?.includes(c));
			if (!langOk || !fwOk || !compOk) {
				const parts: string[] = [];
				if (applies.framework) parts.push(`framework: ${applies.framework.join("/")}`);
				if (applies.language) parts.push(`language: ${applies.language.join("/")}`);
				if (applies.component) parts.push(`component: ${applies.component.join(" + ")}`);
				const gated: CheckResult = {
					name: runner.name,
					score: 100,
					grade: "A",
					details: { skipped: true, reason: `not applicable to this stack (requires ${parts.join(", ")})` },
					issues: [],
					duration: 0,
				};
				checks.push(gated);
				options.onProgress?.(runner.name, gated, i, total);
				continue;
			}
		}

		let result: CheckResult;
		try {
			const maybeResult = runner.fn();
			result = maybeResult instanceof Promise ? await maybeResult : maybeResult;
		} catch (err) {
			result = {
				name: runner.name,
				score: 0,
				grade: "F",
				details: { skipped: true, reason: `runner error: ${err instanceof Error ? err.message : "unknown"}` },
				issues: [],
				duration: 0,
			};
		}

		// Apply per-check ignore patterns
		const patterns = getCheckIgnore(config, result.name);
		if (patterns?.length) {
			result.issues = result.issues.filter((issue) => {
				if (!issue.file || typeof issue.file !== "string") return true;
				const f = issue.file;
				return !patterns.some((p) => {
					if (p.endsWith("/**")) return f.startsWith(`${p.slice(0, -3)}/`);
					if (p.startsWith("*")) return f.endsWith(p.slice(1));
					return f.startsWith(p);
				});
			});
		}

		checks.push(result);
		options.onProgress?.(runner.name, result, i, total);
	}

	const score = computeScore(checks);
	const grade = gradeFromScore(score);
	const { repoUrl, branch } = detectRepoUrl(resolvedCwd);

	return {
		version: VERSION,
		timestamp: new Date().toISOString(),
		score,
		grade,
		checks,
		meta: {
			cwd: resolvedCwd,
			node: process.version,
			duration: Date.now() - start,
			stack,
			workspace,
			repoUrl,
			branch,
		},
	};
}

// ── Re-exports ──

export { loadConfig, type VcqaConfig } from "./config.js";
export { computeDelta, formatDeltaMarkdown, type ScanDelta } from "./delta.js";
export { detectStack, detectWorkspace } from "./detect.js";
export { computeScore } from "./score.js";
export { gradeFromScore } from "./types.js";
export type { CheckResult, Issue, StackInfo, VibeReport, WorkspaceInfo, WorkspacePackage };
export { CHECK_META, type CheckMeta, getCheckMeta };
