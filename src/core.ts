/** @vibecodeqa/cli/core — Programmatic scan API.
 *
 * Usage:
 *   import { scan } from "@vibecodeqa/cli/core";
 *   const report = await scan("./src");
 *   console.log(report.score, report.grade);
 */

import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { CHECK_META, getCheckMeta, type CheckMeta } from "./check-meta.js";
import { getCheckIgnore, isCheckEnabled, loadConfig, type VcqaConfig } from "./config.js";
import { detectRepoUrl, detectStack, detectWorkspace } from "./detect.js";
import { setGlobalIgnore, setGlobalSrcRoots } from "./fs-utils.js";
import { runAccessibility } from "./runners/accessibility.js";
import { runArchitecture } from "./runners/architecture.js";
import { runBestPractices } from "./runners/best-practices.js";
import { runCodeCoherence } from "./runners/code-coherence.js";
import { runCommentStaleness } from "./runners/comment-staleness.js";
import { runComplexity } from "./runners/complexity.js";
import { runDeadPatterns } from "./runners/dead-patterns.js";
import { runTestAudit } from "./runners/test-audit.js";
import { runContainerHealth } from "./runners/container-health.js";
import { runConfusion } from "./runners/confusion.js";
import { runContext } from "./runners/context.js";
import { runDependencies } from "./runners/dependencies.js";
import { runEnvValidation } from "./runners/env-validation.js";
import { runGitHygiene } from "./runners/git-hygiene.js";
import { runDocCoherence } from "./runners/doc-coherence.js";
import { runDocs } from "./runners/docs.js";
import { runDuplication } from "./runners/duplication.js";
import { runErrorHandling } from "./runners/error-handling.js";
import { runLint } from "./runners/lint.js";
import { runMemorySafety } from "./runners/memory-safety.js";
import { runPerformance } from "./runners/performance.js";
import { runReact } from "./runners/react.js";
import { runSecrets } from "./runners/secrets.js";
import { runSecurity } from "./runners/security.js";
import { runStandards } from "./runners/standards.js";
import { runStructure } from "./runners/structure.js";
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

	const srcRoots = workspace.isMonorepo ? workspace.srcRoots : undefined;
	const skipTests = options.skipTests ?? false;

	const allRunners: { name: string; fn: () => CheckResult | Promise<CheckResult> }[] = [
		{ name: "structure", fn: () => runStructure(resolvedCwd, stack, workspace) },
		{ name: "lint", fn: () => runLint(resolvedCwd, stack, workspace) },
		{ name: "types", fn: () => runTypeCheck(resolvedCwd, isDart, workspace) },
		{ name: "type-safety", fn: () => runTypeSafety(resolvedCwd, isDart) },
		{ name: "standards", fn: () => runStandards(resolvedCwd, stack) },
		{ name: "complexity", fn: () => runComplexity(resolvedCwd) },
		{ name: "duplication", fn: () => runDuplication(resolvedCwd) },
		{ name: "error-handling", fn: () => runErrorHandling(resolvedCwd, stack) },
		{ name: "react", fn: () => runReact(resolvedCwd, stack) },
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
		{ name: "performance", fn: () => runPerformance(resolvedCwd) },
		{ name: "container-health", fn: () => runContainerHealth(resolvedCwd) },
		{ name: "confusion", fn: () => runConfusion(resolvedCwd) },
		{ name: "context", fn: () => runContext(resolvedCwd) },
		{ name: "doc-coherence", fn: () => runDocCoherence(resolvedCwd) },
		{ name: "code-coherence", fn: () => runCodeCoherence(resolvedCwd) },
		{ name: "comment-staleness", fn: () => runCommentStaleness(resolvedCwd) },
		{ name: "dead-patterns", fn: () => runDeadPatterns(resolvedCwd) },
		{ name: "test-audit", fn: () => runTestAudit(resolvedCwd) },
	];

	// Filter checks if specified
	const checkFilter = options.checks ? new Set(options.checks) : null;
	const runners = checkFilter
		? allRunners.filter((r) => checkFilter.has(r.name))
		: allRunners;

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
					if (p.endsWith("/**")) return f.startsWith(p.slice(0, -3) + "/");
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

export { CHECK_META, getCheckMeta, type CheckMeta };
export { computeScore } from "./score.js";
export { loadConfig, type VcqaConfig } from "./config.js";
export { detectStack, detectWorkspace } from "./detect.js";
export { gradeFromScore } from "./types.js";
export type { CheckResult, Issue, StackInfo, VibeReport, WorkspaceInfo, WorkspacePackage };
