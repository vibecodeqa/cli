/** Shared types for vibe-check */

export interface CheckResult {
	name: string;
	score: number; // 0-100
	grade: "A" | "B" | "C" | "D" | "F";
	details: Record<string, unknown>;
	issues: Issue[];
	duration: number; // ms
}

export interface Issue {
	severity: "error" | "warning" | "info";
	message: string;
	file?: string;
	line?: number;
	rule?: string;
	snippet?: string; // copyable code snippet (e.g., duplicated block for search)
}

export interface VibeReport {
	version: string;
	timestamp: string;
	score: number; // 0-100 composite
	grade: "A" | "B" | "C" | "D" | "F";
	checks: CheckResult[];
	meta: {
		cwd: string;
		node: string;
		duration: number; // total ms
		stack: StackInfo;
		workspace?: WorkspaceInfo;
		repoUrl: string | null; // GitHub/GitLab URL for file links
		branch: string;
	};
}

export interface StackInfo {
	language: "typescript" | "javascript" | "dart" | "unknown";
	framework: "react" | "vue" | "svelte" | "flutter" | "none" | "unknown";
	bundler: "vite" | "webpack" | "esbuild" | "none" | "unknown";
	testRunner: "vitest" | "jest" | "flutter_test" | "dart_test" | "none" | "unknown";
	linter: "biome" | "eslint" | "dart_analyze" | "none" | "unknown";
	packageManager: "pnpm" | "npm" | "yarn" | "bun" | "pub" | "unknown";
}

export interface WorkspacePackage {
	name: string; // e.g. "@org/sdk"
	path: string; // relative path e.g. "packages/sdk"
	hasSrc: boolean; // has src/, app/, or lib/ directory
	hasRootCode: boolean; // source files directly in package root (no src/ dir)
	hasTests: boolean;
	hasLinter: boolean;
}

export interface WorkspaceInfo {
	isMonorepo: boolean;
	tool: "pnpm" | "npm" | "yarn" | "bun" | "lerna" | "turborepo" | "nx" | "melos" | "none";
	packages: WorkspacePackage[];
	/** All directories containing source code (resolved from workspace packages) */
	srcRoots: string[];
}

export function gradeFromScore(score: number): "A" | "B" | "C" | "D" | "F" {
	if (score >= 90) return "A";
	if (score >= 75) return "B";
	if (score >= 60) return "C";
	if (score >= 40) return "D";
	return "F";
}
