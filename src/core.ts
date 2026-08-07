/** @vibecodeqa/cli/core — Programmatic scan API.
 *
 * Usage:
 *   import { scan } from "@vibecodeqa/cli/core";
 *   const report = await scan("./src");
 *   console.log(report.score, report.grade);
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildAnalyzerSnapshots } from "./analyzer-snapshot.js";
import { CHECK_META, type CheckMeta, getCheckMeta } from "./check-meta.js";
import { getCheckIgnore, isCheckEnabled, loadConfig, type VcqaConfig } from "./config.js";
import { detectRepoUrl, detectStack, detectWorkspace } from "./detect.js";
import { buildFileInventory } from "./file-inventory.js";
import { setGlobalIgnore, setGlobalIgnoreNames, setGlobalSrcRoots } from "./fs-utils.js";
import { withIssueFingerprints } from "./issue-fingerprint.js";
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
import { startToolRecording, takeToolRuns } from "./runners/exec.js";
import { runFileCohesion } from "./runners/file-cohesion.js";
import { runFlutter } from "./runners/flutter.js";
import { runFrontendHealth } from "./runners/frontend-health.js";
import { runGitHygiene } from "./runners/git-hygiene.js";
import { runHtmlQuality } from "./runners/html-quality.js";
import { runLint } from "./runners/lint.js";
import { runMemorySafety } from "./runners/memory-safety.js";
import { deadCodeCheckFromPerformance, runPerformance } from "./runners/performance.js";
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
import { buildEffectiveScanPolicy, policyIgnoreNames, scanPolicySummary } from "./scan-policy.js";
import { computeScore, normalizeScore } from "./score.js";
import type {
	CheckResult,
	Issue,
	ProjectContext,
	ProjectDiscoveryEvidence,
	StackInfo,
	VibeReport,
	WorkspaceInfo,
	WorkspacePackage,
} from "./types.js";
import { gradeFromScore } from "./types.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"));
const VERSION: string = pkg.version;
type CheckStatus = "passed" | "failed" | "skipped" | "unavailable";
type NormalizedCheckResult = CheckResult & { status: CheckStatus };
type AppliesTo = NonNullable<CheckMeta["appliesTo"]>;
type ScoreMode = "available-scored" | "available-unscored" | "not-applicable" | "unavailable";

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

function appliesToStack(applies: AppliesTo, stack: StackInfo, workspace: WorkspaceInfo): boolean {
	const projectStacks = workspace.projects?.map((project) => project.stack) ?? [];
	const langOk =
		!applies.language || applies.language.includes(stack.language) || projectStacks.some((s) => applies.language?.includes(s.language));
	const fwOk =
		!applies.framework ||
		applies.framework.includes(stack.framework) ||
		projectStacks.some((s) => applies.framework?.includes(s.framework));
	const components = new Set([...(stack.components ?? []), ...projectStacks.flatMap((s) => s.components ?? [])]);
	const compOk = !applies.component || applies.component.every((component) => components.has(component));
	return langOk && fwOk && compOk;
}

/** Run a full code health scan. Returns a VibeReport with score, grade, and all check results. */
export async function scan(cwd: string, options: ScanOptions = {}): Promise<VibeReport> {
	const start = Date.now();
	const resolvedCwd = resolve(cwd);

	const config = options.config ?? loadConfig(resolvedCwd);
	const workspace = detectWorkspace(resolvedCwd);
	const stack = detectStack(resolvedCwd, workspace);
	const isDart = stack.language === "dart";
	const scanPolicy = buildEffectiveScanPolicy(resolvedCwd, config, {
		ignoreNames: options.ignoreNames,
		envIgnore: process.env.VCQA_IGNORE,
	});
	const fileInventory = buildFileInventory(resolvedCwd, workspace, scanPolicy);

	setGlobalSrcRoots(workspace.isMonorepo ? workspace.srcRoots : undefined);
	setGlobalIgnore(config.ignore);
	// Extra ignore names: .vcqa.json config + the VCQA_IGNORE env var (the desktop
	// monitor's user "Ignored paths"). Merged so the scan skips the same folders
	// the watcher and graphs do.
	setGlobalIgnoreNames(policyIgnoreNames(scanPolicy));

	const srcRoots = workspace.isMonorepo ? workspace.srcRoots : undefined;
	const skipTests = options.skipTests ?? false;
	let performanceResult: CheckResult | null = null;

	const allRunners: { name: string; fn: () => CheckResult | Promise<CheckResult> }[] = [
		{ name: "structure", fn: () => runStructure(resolvedCwd, stack, workspace, fileInventory) },
		{ name: "lint", fn: () => runLint(resolvedCwd, stack, workspace) },
		{ name: "types", fn: () => runTypeCheck(resolvedCwd, isDart, workspace) },
		{ name: "type-safety", fn: () => runTypeSafety(resolvedCwd, isDart, workspace, fileInventory) },
		{ name: "standards", fn: () => runStandards(resolvedCwd, stack, workspace, fileInventory) },
		{ name: "complexity", fn: () => runComplexity(resolvedCwd, fileInventory) },
		{ name: "duplication", fn: () => runDuplication(resolvedCwd) },
		{ name: "error-handling", fn: () => runErrorHandling(resolvedCwd, workspace, fileInventory) },
		{ name: "react", fn: () => runReact(resolvedCwd, workspace, fileInventory) },
		{ name: "flutter", fn: () => runFlutter(resolvedCwd, workspace) },
		{ name: "accessibility", fn: () => runAccessibility(resolvedCwd, workspace, fileInventory) },
		{ name: "docs", fn: () => runDocs(resolvedCwd, fileInventory) },
		{ name: "best-practices", fn: () => runBestPractices(resolvedCwd, workspace) },
		{ name: "env-validation", fn: () => runEnvValidation(resolvedCwd) },
		{ name: "git-hygiene", fn: () => runGitHygiene(resolvedCwd, fileInventory) },
		{ name: "memory-safety", fn: () => runMemorySafety(resolvedCwd, workspace, fileInventory) },
		{ name: "testing", fn: () => runTesting(resolvedCwd, stack, skipTests, srcRoots, workspace, fileInventory) },
		{ name: "secrets", fn: () => runSecrets(resolvedCwd) },
		{ name: "security", fn: () => runSecurity(resolvedCwd, fileInventory) },
		{ name: "dependencies", fn: () => runDependencies(resolvedCwd, stack) },
		{ name: "architecture", fn: () => runArchitecture(resolvedCwd, workspace, fileInventory) },
		{
			name: "performance",
			fn: () => {
				performanceResult = runPerformance(resolvedCwd, workspace, fileInventory);
				return performanceResult;
			},
		},
		{
			name: "dead-code",
			fn: () => {
				if (!performanceResult) {
					performanceResult = runPerformance(resolvedCwd, workspace, fileInventory);
				}
				return deadCodeCheckFromPerformance(performanceResult);
			},
		},
		{ name: "container-health", fn: () => runContainerHealth(resolvedCwd) },
		{ name: "cloudflare-workers", fn: () => runCloudflareWorkers(resolvedCwd, workspace, fileInventory) },
		{ name: "sqlite-d1", fn: () => runSqliteD1(resolvedCwd, workspace, fileInventory) },
		{ name: "confusion", fn: () => runConfusion(resolvedCwd, fileInventory) },
		{ name: "context", fn: () => runContext(resolvedCwd, fileInventory) },
		{ name: "doc-coherence", fn: () => runDocCoherence(resolvedCwd, fileInventory) },
		{ name: "code-coherence", fn: () => runCodeCoherence(resolvedCwd, fileInventory) },
		{ name: "comment-staleness", fn: () => runCommentStaleness(resolvedCwd, fileInventory) },
		{ name: "html-quality", fn: () => runHtmlQuality(resolvedCwd, fileInventory) },
		{ name: "frontend-health", fn: () => runFrontendHealth(resolvedCwd, workspace, fileInventory) },
		{ name: "styling", fn: () => runStyling(resolvedCwd, workspace, fileInventory) },
		{ name: "dead-patterns", fn: () => runDeadPatterns(resolvedCwd, fileInventory) },
		{ name: "test-audit", fn: () => runTestAudit(resolvedCwd) },
		{ name: "file-cohesion", fn: () => runFileCohesion(resolvedCwd, fileInventory) },
		{ name: "design-consistency", fn: () => runDesignConsistency(resolvedCwd, fileInventory) },
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
				status: "skipped",
				score: 100,
				grade: "A",
				details: { skipped: true, status: "skipped", reason: "disabled in config" },
				issues: [],
				duration: 0,
			} as NormalizedCheckResult;
			checks.push(skipped);
			options.onProgress?.(runner.name, skipped, i, total);
			continue;
		}

		// Central stack gating: a check either declares appliesTo in CheckMeta or is
		// stack-blind. Runners must not re-implement this (see CLAUDE.md).
		const applies = getCheckMeta(runner.name).appliesTo;
		if (applies) {
			if (!appliesToStack(applies, stack, workspace)) {
				const parts: string[] = [];
				if (applies.framework) parts.push(`framework: ${applies.framework.join("/")}`);
				if (applies.language) parts.push(`language: ${applies.language.join("/")}`);
				if (applies.component) parts.push(`component: ${applies.component.join(" + ")}`);
				const gated: CheckResult = {
					name: runner.name,
					status: "skipped",
					score: 100,
					grade: "A",
					details: {
						skipped: true,
						status: "skipped",
						scoreMode: "not-applicable",
						scoreImpact: false,
						reason: `not applicable to this stack (requires ${parts.join(", ")})`,
					},
					issues: [],
					duration: 0,
				} as NormalizedCheckResult;
				checks.push(gated);
				options.onProgress?.(runner.name, gated, i, total);
				continue;
			}
		}

		let result: CheckResult;
		startToolRecording({ analyzerId: runner.name, projectId: "root", projectPath: "." });
		try {
			const maybeResult = runner.fn();
			result = maybeResult instanceof Promise ? await maybeResult : maybeResult;
		} catch (err) {
			result = {
				name: runner.name,
				status: "failed",
				score: 0,
				grade: "F",
				details: { skipped: true, status: "failed", reason: `runner error: ${err instanceof Error ? err.message : "unknown"}` },
				issues: [],
				duration: 0,
			} as NormalizedCheckResult;
		}

		// Provenance: what this check actually shelled out to, where, and what came
		// back. A report without this cannot be audited — see exec.ts.
		const toolRuns = takeToolRuns();
		if (toolRuns.length > 0) {
			result.details = { ...result.details, toolRuns };
		}

		result = normalizeCheckResult(result);

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

	const inventorySourceCount = fileInventory.files.filter(
		(file) => (file.kind === "source" || file.kind === "test") && !file.generated,
	).length;
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
			// What the scan actually looked at — so a reader can sanity-check the
			// result against the size of their project instead of taking it on faith.
			filesScanned: inventorySourceCount,
			stack,
			workspace,
			scanPolicy: scanPolicySummary(scanPolicy),
			fileInventory: fileInventory.summary,
			analyzerSnapshots: buildAnalyzerSnapshots(checks),
			repoUrl,
			branch,
		},
	};
}

function normalizeCheckResult(result: CheckResult): NormalizedCheckResult {
	const originalScore = result.score;
	const issues = [...(Array.isArray(result.issues) ? result.issues : [])];
	const details = { ...(result.details ?? {}) };
	const excludedFromScore = shouldRenderAsSkipped(details, issues);
	const score = excludedFromScore ? 100 : normalizeScore(originalScore);

	if (!excludedFromScore && (score !== originalScore || !Number.isFinite(Number(originalScore)))) {
		details.invalidScore = originalScore;
		issues.unshift({
			severity: "error",
			rule: "vcqa-internal-invalid-score",
			message: `VCQA internal error: ${result.name} returned a non-finite score; normalized to ${score}/100`,
		});
	}

	const availabilityStatus = checkAvailabilityStatus(details);
	const scoreMode = runtimeScoreMode(result.name, details, availabilityStatus ?? "passed");
	const advisoryFindings = scoreMode === "available-unscored" && !availabilityStatus && (issues.length > 0 || score < 60);
	const status = availabilityStatus ?? checkStatus(issues, score, scoreMode);
	const normalizedDetails: Record<string, unknown> = { ...details, status, scoreMode, scoreImpact: scoreMode === "available-scored" };
	if (advisoryFindings) normalizedDetails.advisoryFindings = true;
	return {
		...result,
		status,
		score,
		grade: gradeFromScore(score),
		details: normalizedDetails,
		issues: withIssueFingerprints(result.name, issues),
	};
}

function shouldRenderAsSkipped(details: Record<string, unknown>, issues: Issue[]): boolean {
	if (issues.length > 0) return false;
	if (!details.skipped && !details.comingSoon) return false;
	const reason = typeof details.reason === "string" ? details.reason : "";
	return !reason.startsWith("runner error:");
}

function checkAvailabilityStatus(details: Record<string, unknown>): CheckStatus | null {
	const reason = typeof details.reason === "string" ? details.reason : "";
	if (reason.startsWith("runner error:")) return "failed";
	if (details.comingSoon) return "unavailable";
	if (details.skipped) return "skipped";
	return null;
}

function checkStatus(issues: Issue[], score: number, scoreMode: ScoreMode): CheckStatus {
	if (scoreMode === "available-unscored") return "passed";
	if (issues.some((i) => i.severity === "error") || score < 60) return "failed";
	return "passed";
}

function runtimeScoreMode(checkName: string, details: Record<string, unknown>, status: CheckStatus): ScoreMode {
	if (status === "unavailable" || details.comingSoon) return "unavailable";
	if (status === "skipped" || details.skipped) return "not-applicable";
	const meta = getCheckMeta(checkName);
	const declaredScoreMode = (meta as CheckMeta & { scoreMode?: ScoreMode }).scoreMode;
	if (details.synthetic || meta.weight === 0 || declaredScoreMode === "available-unscored") return "available-unscored";
	return "available-scored";
}

// ── Re-exports ──

export { loadConfig, type VcqaConfig } from "./config.js";
export { computeDelta, formatDeltaMarkdown, type ScanDelta } from "./delta.js";
export { detectStack, detectWorkspace } from "./detect.js";
export { computeScore } from "./score.js";
export { gradeFromScore } from "./types.js";
export type { CheckResult, Issue, ProjectContext, ProjectDiscoveryEvidence, StackInfo, VibeReport, WorkspaceInfo, WorkspacePackage };
export { CHECK_META, type CheckMeta, getCheckMeta };
