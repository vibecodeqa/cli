import type {
	CheckResult,
	Issue,
	VibeReport as SchemaVibeReport,
	WorkspaceInfo as SchemaWorkspaceInfo,
	StackInfo,
	WorkspacePackage,
} from "@vibecodeqa/schema";

export { gradeFromScore } from "@vibecodeqa/schema";
export type { CheckResult, Issue, StackInfo, WorkspacePackage };

export interface AnalyzerMetric {
	id: string;
	label: string;
	value: number | string | boolean;
	unit?: "count" | "percent" | "ms" | "bytes" | "score";
	trend?: "higher-is-better" | "lower-is-better" | "neutral";
}

export interface AnalyzerSnapshot {
	analyzerId: string;
	status: "passed" | "failed" | "skipped" | "unavailable" | "error" | (string & {});
	score?: number;
	findingCount: number;
	severityCounts: Record<string, number>;
	metrics: AnalyzerMetric[];
	durationMs: number;
}

export interface ProjectDiscoveryEvidence {
	kind: "manifest" | "config" | "convention" | "source" | "tooling" | "rejected" | (string & {});
	description: string;
	file?: string;
	path?: string;
	value?: string;
}

export interface ProjectToolCommand {
	tool: string;
	cwd: string;
	command: string[];
}

export interface ProjectContext {
	id: string;
	name: string;
	path: string;
	kind: "root" | "package" | "app" | "service" | "library" | "unknown" | (string & {});
	stack: StackInfo;
	srcRoots: string[];
	testRoots: string[];
	configFiles: string[];
	manifestFiles: string[];
	evidence: ProjectDiscoveryEvidence[];
	confidence: number;
	toolCommands: {
		lint?: ProjectToolCommand[];
		typecheck?: ProjectToolCommand[];
		test?: ProjectToolCommand[];
		audit?: ProjectToolCommand[];
	};
}

export interface WorkspaceInfo extends SchemaWorkspaceInfo {
	projects?: ProjectContext[];
	discovery?: {
		mode: "manifest" | "convention" | "single" | (string & {});
		evidence: ProjectDiscoveryEvidence[];
	};
}

export interface VibeReport extends Omit<SchemaVibeReport, "meta"> {
	meta: Omit<SchemaVibeReport["meta"], "workspace"> & {
		workspace?: WorkspaceInfo;
		scanPolicy?: Record<string, unknown>;
		fileInventory?: Record<string, unknown>;
		analyzerSnapshots?: AnalyzerSnapshot[];
	};
}
