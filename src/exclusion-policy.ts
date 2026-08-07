import defaultExclusions from "./data/default-exclusions.json" with { type: "json" };

export type DefaultExclusionReasonCode = keyof typeof defaultExclusions.reasons & string;

export interface DefaultExclusionPolicy {
	version: number;
	ignoreHiddenDirectories: boolean;
	directoryNames: string[];
	generatedPathPrefixes: string[];
	filePatterns: string[];
	reasons: Record<DefaultExclusionReasonCode, string[]>;
}

export const defaultExclusionPolicy = defaultExclusions as DefaultExclusionPolicy;

export function defaultExclusionReasonCodes(): DefaultExclusionReasonCode[] {
	return Object.keys(defaultExclusionPolicy.reasons).sort() as DefaultExclusionReasonCode[];
}

export function defaultExclusionTokens(): string[] {
	return [
		...defaultExclusionPolicy.directoryNames,
		...defaultExclusionPolicy.generatedPathPrefixes,
		...defaultExclusionPolicy.filePatterns,
	];
}

export function defaultExclusionPolicySummary() {
	return {
		version: defaultExclusionPolicy.version,
		ignoreHiddenDirectories: defaultExclusionPolicy.ignoreHiddenDirectories,
		directoryNames: defaultExclusionPolicy.directoryNames.length,
		generatedPathPrefixes: defaultExclusionPolicy.generatedPathPrefixes.length,
		filePatterns: defaultExclusionPolicy.filePatterns.length,
		reasonCodes: defaultExclusionReasonCodes(),
	};
}
