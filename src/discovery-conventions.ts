import registry from "./data/discovery-conventions.json" with { type: "json" };

export interface DiscoveryConventions {
	version: number;
	workspaceManifestDefaults: Record<string, { file: string; listKey?: string; jsonField?: string; defaultGlobs: string[] }>;
	projectManifestFiles: string[];
	projectConfigFiles: string[];
	sourceRoots: string[];
	rootSourceRoots: string[];
	testRoots: string[];
	sourceFileExtensions: string[];
	discoverySourceFileExtensions?: string[];
	ecosystemProfiles?: Record<
		string,
		{
			language: string;
			framework: string;
			bundler: string;
			testRunner: string;
			linter: string;
			packageManager: string;
			supported: boolean;
			manifests: string[];
			workspaceManifests?: string[];
			sourceRoots: string[];
			testRoots: string[];
		}
	>;
	frontendFrameworks: string[];
	projectKindRules: {
		appRoots: string[];
		serviceRoots: string[];
		libraryRoots: string[];
		servicePathIncludes: string[];
		libraryPathIncludes: string[];
	};
	confidenceScoring: {
		base: number;
		manifestFileBonus: number;
		configFileBonus: number;
		sourceRootBonus: number;
		manifestEvidenceBonus: number;
		conventionEvidencePenalty: number;
	};
	pairedConventionLayouts: string[][];
	conventionalContainerRoots: string[];
	staticSiteRootNames: string[];
	componentConfigFiles: string[];
	linterConfigFiles: string[];
	ignoredConventionEntries: string[];
}

export const discoveryConventions = registry as DiscoveryConventions;

export const projectMarkerFiles = [...new Set([...discoveryConventions.projectManifestFiles, ...discoveryConventions.projectConfigFiles])];

export function hasRegistryMarker(fileNames: Iterable<string>): boolean {
	const markers = new Set(projectMarkerFiles);
	for (const name of fileNames) {
		if (markers.has(name)) return true;
	}
	return false;
}
