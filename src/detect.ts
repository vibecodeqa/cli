/** Auto-detect project stack and git repo from files in the working directory. */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { StackInfo } from "./types.js";

export function detectStack(cwd: string): StackInfo {
	const has = (f: string) => existsSync(join(cwd, f));
	const read = (f: string) => {
		try {
			return readFileSync(join(cwd, f), "utf-8");
		} catch {
			return "";
		}
	};

	// ── Dart/Flutter detection ──
	const pubspec = read("pubspec.yaml");
	if (pubspec || has("pubspec.lock")) {
		const isFlutter = pubspec.includes("flutter:") || pubspec.includes("flutter_test:");
		const hasTest = pubspec.includes("test:") || pubspec.includes("flutter_test:");
		const hasAnalysis = has("analysis_options.yaml");
		return {
			language: "dart",
			framework: isFlutter ? "flutter" : "none",
			bundler: "none",
			testRunner: isFlutter ? (hasTest ? "flutter_test" : "none") : hasTest ? "dart_test" : "none",
			linter: hasAnalysis ? "dart_analyze" : "none",
			packageManager: "pub",
		};
	}

	// ── Node.js/TypeScript detection ──
	const pkg = read("package.json");
	let allDeps: Record<string, string> = {};
	try {
		const deps = pkg ? JSON.parse(pkg) : {};
		allDeps = { ...deps.dependencies, ...deps.devDependencies };
	} catch {
		// invalid package.json
	}

	const language =
		has("tsconfig.json") || has("tsconfig.app.json") || allDeps.typescript
			? "typescript"
			: allDeps.react || allDeps.vue
				? "javascript"
				: "unknown";

	const framework = allDeps.react ? "react" : allDeps.vue ? "vue" : allDeps.svelte ? "svelte" : "none";

	const bundler = allDeps.vite ? "vite" : allDeps.webpack ? "webpack" : allDeps.esbuild ? "esbuild" : "none";

	const testRunner = allDeps.vitest ? "vitest" : allDeps.jest ? "jest" : "none";

	const linter = allDeps["@biomejs/biome"] ? "biome" : allDeps.eslint ? "eslint" : "none";

	const packageManager = has("pnpm-lock.yaml") ? "pnpm" : has("bun.lockb") ? "bun" : has("yarn.lock") ? "yarn" : "npm";

	return { language, framework, bundler, testRunner, linter, packageManager } as StackInfo;
}

/** Detect GitHub/GitLab repo URL from git remote. */
export function detectRepoUrl(cwd: string): { repoUrl: string | null; branch: string } {
	try {
		const remote = execSync("git remote get-url origin", { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
		const branch = execSync("git branch --show-current", { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim() || "main";
		// Convert SSH to HTTPS
		const url = remote
			.replace(/^git@github\.com:/, "https://github.com/")
			.replace(/^git@gitlab\.com:/, "https://gitlab.com/")
			.replace(/\.git$/, "");
		return { repoUrl: url, branch };
	} catch {
		return { repoUrl: null, branch: "main" };
	}
}
