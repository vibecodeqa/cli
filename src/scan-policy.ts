import { basename } from "node:path";
import type { VcqaConfig } from "./config.js";
import { defaultExclusionPolicy as defaultExclusions } from "./exclusion-policy.js";
import { readEnvIgnoreNames, readGitIgnoreDirectoryNames } from "./fs-utils.js";

export type PolicyAction = "include" | "exclude" | "include-security-sensitive";
export type PathClassification = "normal" | "generated" | "lockfile" | "security-sensitive";
export type PolicyEvidenceSource =
	| "default-directory"
	| "default-file-pattern"
	| "generated-prefix"
	| "config-ignore"
	| "user-ignore"
	| "env-ignore"
	| "gitignore-directory"
	| "security-sensitive";
export type PolicyReasonCode =
	| "agent-artifact"
	| "build-output"
	| "config-ignore"
	| "default-exclusion"
	| "dependency"
	| "env-ignore"
	| "framework-cache"
	| "generated-file"
	| "gitignore-directory"
	| "hidden-directory"
	| "lockfile"
	| "runtime-cache"
	| "security-sensitive"
	| "test-output"
	| "user-ignore"
	| "vcqa"
	| "vcs";

export interface PolicyEvidence {
	source: PolicyEvidenceSource;
	value: string;
	reason: PolicyReasonCode;
	precedence: number;
}

export interface EffectiveScanPolicy {
	version: number;
	ignoreHiddenDirectories: boolean;
	defaultDirectoryNames: string[];
	defaultFilePatterns: string[];
	generatedPathPrefixes: string[];
	configIgnorePatterns: string[];
	userIgnoreNames: string[];
	envIgnoreNames: string[];
	gitignoreDirectoryNames: string[];
}

export interface PolicyDecision {
	action: PolicyAction;
	ignored: boolean;
	excluded: boolean;
	generated: boolean;
	securitySensitive: boolean;
	includedBySecurityOverride: boolean;
	classification: PathClassification;
	reasons: PolicyReasonCode[];
	evidence: PolicyEvidence[];
}

const PRECEDENCE = {
	securitySensitive: 10,
	configIgnore: 20,
	userIgnore: 30,
	envIgnore: 31,
	defaultExclusion: 40,
	generatedPrefix: 41,
	gitignoreDirectory: 50,
};
const GENERATED_REASON_CODES = new Set<PolicyReasonCode>([
	"agent-artifact",
	"build-output",
	"framework-cache",
	"generated-file",
	"runtime-cache",
	"test-output",
	"vcqa",
]);
const SECURITY_OVERRIDABLE_REASONS = new Set<PolicyReasonCode>(["config-ignore", "user-ignore", "env-ignore", "gitignore-directory"]);

export function buildEffectiveScanPolicy(
	cwd: string,
	config: VcqaConfig,
	options: { ignoreNames?: string[]; envIgnore?: string } = {},
): EffectiveScanPolicy {
	return {
		version: Number(defaultExclusions.version ?? 1),
		ignoreHiddenDirectories: Boolean(defaultExclusions.ignoreHiddenDirectories),
		defaultDirectoryNames: [...defaultExclusions.directoryNames],
		defaultFilePatterns: [...defaultExclusions.filePatterns],
		generatedPathPrefixes: [...defaultExclusions.generatedPathPrefixes],
		configIgnorePatterns: [...(config.ignore ?? [])],
		userIgnoreNames: [...new Set(options.ignoreNames ?? [])],
		envIgnoreNames: readEnvIgnoreNames(options.envIgnore),
		gitignoreDirectoryNames: readGitIgnoreDirectoryNames(cwd),
	};
}

export function policyIgnoreNames(policy: EffectiveScanPolicy): string[] {
	return [...new Set([...policy.userIgnoreNames, ...policy.envIgnoreNames, ...policy.gitignoreDirectoryNames])];
}

export function evaluatePath(policy: EffectiveScanPolicy, relPath: string): PolicyDecision {
	const clean = relPath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
	const segments = clean.split("/").filter(Boolean);
	const fileName = basename(clean);
	const evidence: PolicyEvidence[] = [];

	addSegmentReasons(policy, segments, evidence);
	addConfiguredSubpathReasons(policy, clean, evidence);
	addGeneratedPrefixReasons(policy, clean, evidence);
	addPatternReasons(policy, clean, fileName, evidence);

	const securitySensitive = /^\.env(?:\.|$)/.test(fileName) || /\.(?:pem|key|p12|pfx)$/i.test(fileName);
	if (securitySensitive) {
		addEvidence(evidence, "security-sensitive", fileName, "security-sensitive", PRECEDENCE.securitySensitive);
	}

	const reasonList = [...new Set(evidence.map((item) => item.reason))].filter(Boolean).sort();
	const generated = reasonList.some((reason) => GENERATED_REASON_CODES.has(reason));
	const ignored = evidence.some((item) => item.source !== "security-sensitive");
	const canOverrideForSecurity =
		securitySensitive &&
		ignored &&
		evidence.filter((item) => item.source !== "security-sensitive").every((item) => SECURITY_OVERRIDABLE_REASONS.has(item.reason));
	const action: PolicyAction = !ignored ? "include" : canOverrideForSecurity ? "include-security-sensitive" : "exclude";
	return {
		action,
		ignored,
		excluded: action === "exclude",
		generated,
		securitySensitive,
		includedBySecurityOverride: action === "include-security-sensitive",
		classification: classifyDecision(generated, securitySensitive, reasonList),
		reasons: reasonList,
		evidence: evidence.sort((a, b) => a.precedence - b.precedence || a.source.localeCompare(b.source) || a.value.localeCompare(b.value)),
	};
}

function addSegmentReasons(policy: EffectiveScanPolicy, segments: string[], evidence: PolicyEvidence[]): void {
	for (const segment of segments) {
		if (policy.defaultDirectoryNames.includes(segment)) {
			addEvidence(evidence, "default-directory", segment, reasonForToken(segment), PRECEDENCE.defaultExclusion);
		}
		if (policy.userIgnoreNames.includes(segment)) addEvidence(evidence, "user-ignore", segment, "user-ignore", PRECEDENCE.userIgnore);
		if (policy.envIgnoreNames.includes(segment)) addEvidence(evidence, "env-ignore", segment, "env-ignore", PRECEDENCE.envIgnore);
		if (policy.gitignoreDirectoryNames.includes(segment)) {
			addEvidence(evidence, "gitignore-directory", segment, "gitignore-directory", PRECEDENCE.gitignoreDirectory);
		}
		if (policy.ignoreHiddenDirectories && segment.startsWith(".")) {
			addEvidence(evidence, "default-directory", segment, "hidden-directory", PRECEDENCE.defaultExclusion);
		}
	}
}

function addConfiguredSubpathReasons(policy: EffectiveScanPolicy, clean: string, evidence: PolicyEvidence[]): void {
	for (const subpath of [...policy.userIgnoreNames, ...policy.envIgnoreNames, ...policy.gitignoreDirectoryNames].filter((name) =>
		name.includes("/"),
	)) {
		const bounded = `/${clean}/`;
		if (!bounded.includes(`/${subpath.replace(/^\/+|\/+$/g, "")}/`)) continue;
		if (policy.userIgnoreNames.includes(subpath)) addEvidence(evidence, "user-ignore", subpath, "user-ignore", PRECEDENCE.userIgnore);
		if (policy.envIgnoreNames.includes(subpath)) addEvidence(evidence, "env-ignore", subpath, "env-ignore", PRECEDENCE.envIgnore);
		if (policy.gitignoreDirectoryNames.includes(subpath)) {
			addEvidence(evidence, "gitignore-directory", subpath, "gitignore-directory", PRECEDENCE.gitignoreDirectory);
		}
	}
}

function addGeneratedPrefixReasons(policy: EffectiveScanPolicy, clean: string, evidence: PolicyEvidence[]): void {
	for (const prefix of policy.generatedPathPrefixes) {
		if (clean === prefix || clean.startsWith(`${prefix}/`)) {
			addEvidence(evidence, "generated-prefix", prefix, reasonForToken(prefix), PRECEDENCE.generatedPrefix);
		}
	}
}

function addPatternReasons(policy: EffectiveScanPolicy, clean: string, fileName: string, evidence: PolicyEvidence[]): void {
	for (const pattern of policy.defaultFilePatterns) {
		if (matchesPathPattern(clean, fileName, pattern)) {
			addEvidence(evidence, "default-file-pattern", pattern, reasonForToken(pattern), PRECEDENCE.defaultExclusion);
		}
	}
	for (const pattern of policy.configIgnorePatterns) {
		if (matchesConfigPattern(clean, pattern)) addEvidence(evidence, "config-ignore", pattern, "config-ignore", PRECEDENCE.configIgnore);
	}
}

export function scanPolicySummary(policy: EffectiveScanPolicy) {
	return {
		version: policy.version,
		precedence: [
			"security-sensitive override",
			".vcqa/package vcqa ignore",
			"user ignore names",
			"VCQA_IGNORE names",
			"default exclusions and generated classification",
			".gitignore directory rules",
			"per-check finding filters",
		],
		securitySensitiveOverride: {
			enabled: true,
			appliesToReasonCodes: [...SECURITY_OVERRIDABLE_REASONS].sort(),
			blockedByGeneratedOrDefaultArtifact: true,
		},
		reasonCodes: [
			...new Set([
				...Object.keys(defaultExclusions.reasons),
				"config-ignore",
				"user-ignore",
				"env-ignore",
				"gitignore-directory",
				"hidden-directory",
				"security-sensitive",
			]),
		].sort(),
		defaultDirectoryNames: policy.defaultDirectoryNames.length,
		defaultDirectoryNameValues: policy.defaultDirectoryNames,
		defaultFilePatterns: policy.defaultFilePatterns.length,
		defaultFilePatternValues: policy.defaultFilePatterns,
		generatedPathPrefixes: policy.generatedPathPrefixes.length,
		generatedPathPrefixValues: policy.generatedPathPrefixes,
		configIgnorePatterns: policy.configIgnorePatterns.length,
		configIgnorePatternValues: policy.configIgnorePatterns,
		userIgnoreNames: policy.userIgnoreNames.length,
		userIgnoreNameValues: policy.userIgnoreNames,
		envIgnoreNames: policy.envIgnoreNames.length,
		envIgnoreNameValues: policy.envIgnoreNames,
		gitignoreDirectoryNames: policy.gitignoreDirectoryNames.length,
		gitignoreDirectoryNameValues: policy.gitignoreDirectoryNames,
		ignoreHiddenDirectories: policy.ignoreHiddenDirectories,
	};
}

function addEvidence(
	evidence: PolicyEvidence[],
	source: PolicyEvidenceSource,
	value: string,
	reason: PolicyReasonCode,
	precedence: number,
): void {
	if (evidence.some((item) => item.source === source && item.value === value && item.reason === reason)) return;
	evidence.push({ source, value, reason, precedence });
}

function classifyDecision(generated: boolean, securitySensitive: boolean, reasons: PolicyReasonCode[]): PathClassification {
	if (generated) return "generated";
	if (reasons.includes("lockfile")) return "lockfile";
	if (securitySensitive) return "security-sensitive";
	return "normal";
}

function reasonForToken(token: string): PolicyReasonCode {
	for (const [reason, tokens] of Object.entries(defaultExclusions.reasons)) {
		if ((tokens as string[]).some((known) => token === known || token.startsWith(`${known}/`))) return reason as PolicyReasonCode;
	}
	return "default-exclusion";
}

function matchesConfigPattern(relPath: string, pattern: string): boolean {
	if (pattern.endsWith("/**")) {
		const prefix = pattern.slice(0, -3);
		return relPath === prefix || relPath.startsWith(`${prefix}/`);
	}
	if (pattern.startsWith("*")) return relPath.endsWith(pattern.slice(1));
	return relPath === pattern || relPath.startsWith(`${pattern.replace(/\/+$/g, "")}/`) || relPath.startsWith(pattern);
}

function matchesPathPattern(relPath: string, fileName: string, pattern: string): boolean {
	if (pattern.startsWith("*.") || pattern.startsWith("*")) return fileName.endsWith(pattern.slice(1));
	if (pattern.endsWith("*")) return fileName.startsWith(pattern.slice(0, -1));
	const star = pattern.indexOf("*");
	if (star >= 0) {
		const before = pattern.slice(0, star);
		const after = pattern.slice(star + 1);
		return fileName.startsWith(before) && fileName.endsWith(after);
	}
	return relPath === pattern || fileName === pattern;
}
