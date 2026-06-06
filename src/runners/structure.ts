/** Project structure check — does the repo have standard files and conventions? */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { collectSourceFiles } from "../fs-utils.js";
import type { CheckResult, Issue, StackInfo, WorkspaceInfo } from "../types.js";
import { gradeFromScore } from "../types.js";

interface FileCheck {
	name: string;
	path: string;
	required: boolean;
	description: string;
}

const NODE_FILES: FileCheck[] = [
	{ name: "package.json", path: "package.json", required: true, description: "Package manifest" },
	{ name: "tsconfig.json", path: "tsconfig.json", required: false, description: "TypeScript configuration" },
	{ name: "LICENSE", path: "LICENSE", required: true, description: "Open source license" },
	{ name: ".gitignore", path: ".gitignore", required: true, description: "Git ignore rules" },
	{ name: "README.md", path: "README.md", required: false, description: "Project documentation" },
];

const DART_FILES: FileCheck[] = [
	{ name: "pubspec.yaml", path: "pubspec.yaml", required: true, description: "Dart package manifest" },
	{ name: "analysis_options.yaml", path: "analysis_options.yaml", required: true, description: "Dart analysis options" },
	{ name: "LICENSE", path: "LICENSE", required: true, description: "Open source license" },
	{ name: ".gitignore", path: ".gitignore", required: true, description: "Git ignore rules" },
	{ name: "README.md", path: "README.md", required: false, description: "Project documentation" },
];

export function runStructure(cwd: string, stack: StackInfo, workspace?: WorkspaceInfo): CheckResult {
	const start = Date.now();
	const issues: Issue[] = [];
	const found: string[] = [];
	const missing: string[] = [];

	const isDart = stack.language === "dart";
	const EXPECTED_FILES = isDart ? DART_FILES : NODE_FILES;

	// Check standard files
	for (const fc of EXPECTED_FILES) {
		// tsconfig: in monorepos, tsconfig.base.json or per-package tsconfig is acceptable
		let required = fc.name === "tsconfig.json" ? stack.language === "typescript" : fc.required;
		if (fc.name === "tsconfig.json" && workspace?.isMonorepo) {
			if (existsSync(join(cwd, "tsconfig.base.json")) || existsSync(join(cwd, "tsconfig.json"))) {
				found.push(fc.name);
				continue;
			}
			const pkgHasTsconfig = workspace.packages.some((p) => existsSync(join(cwd, p.path, "tsconfig.json")));
			if (pkgHasTsconfig) {
				found.push("tsconfig (per-package)");
				continue;
			}
			required = true;
		}
		// Melos monorepo: pubspec.yaml and analysis_options.yaml live in packages, not root
		if ((fc.name === "pubspec.yaml" || fc.name === "analysis_options.yaml") && workspace?.isMonorepo && workspace.tool === "melos") {
			const inPkg = workspace.packages.some((p) => existsSync(join(cwd, p.path, fc.name)));
			if (inPkg) {
				found.push(`${fc.name} (per-package)`);
				continue;
			}
		}
		if (existsSync(join(cwd, fc.path))) {
			found.push(fc.name);
		} else {
			missing.push(fc.name);
			issues.push({
				severity: required ? "error" : "warning",
				message: `Missing ${fc.name} — ${fc.description}`,
				rule: "missing-file",
			});
		}
	}

	// Check for lockfile — in monorepos, lockfiles may be in packages
	const lockfiles = isDart ? ["pubspec.lock"] : ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lockb", "bun.lock"];
	let hasLock = lockfiles.some((f) => existsSync(join(cwd, f)));
	if (!hasLock && workspace?.isMonorepo) {
		hasLock = workspace.packages.some((p) => lockfiles.some((f) => existsSync(join(cwd, p.path, f))));
	}
	if (hasLock) {
		found.push("lockfile");
	} else {
		issues.push({ severity: "warning", message: "No lockfile found — builds may not be reproducible", rule: "missing-lockfile" });
	}

	// Check for source directory — monorepos have source in packages/*/src/
	const srcDirs = isDart ? ["lib"] : ["src", "web/src"];
	let hasSrc = srcDirs.some((d) => existsSync(join(cwd, d)));
	if (!hasSrc && workspace?.isMonorepo) {
		hasSrc = workspace.packages.some((p) => p.hasSrc);
	}
	if (!hasSrc) {
		issues.push({ severity: "error", message: `No ${srcDirs[0]}/ directory found`, rule: "no-src" });
	}

	// Count source vs test files (using workspace-aware roots)
	const srcRoots = workspace?.isMonorepo ? workspace.srcRoots : undefined;
	const allFiles = collectSourceFiles(cwd, { includeTests: true, srcRoots });
	const srcCount = allFiles.filter((f) => !f.isTest).length;
	const testCount = allFiles.filter((f) => f.isTest).length;
	const testRatio = srcCount > 0 ? testCount / srcCount : 0;

	if (testCount === 0 && srcCount > 0) {
		issues.push({ severity: "error", message: `No test files found (${srcCount} source files with zero tests)`, rule: "no-tests" });
	} else if (testRatio < 0.3 && srcCount > 3) {
		issues.push({
			severity: "warning",
			message: `Low test-to-source ratio: ${testCount} tests for ${srcCount} source files (${Math.round(testRatio * 100)}%)`,
			rule: "low-test-ratio",
		});
	}

	// Check manifest has essential config
	if (!isDart) {
		try {
			const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf-8"));
			const scripts = pkg.scripts || {};
			// Monorepos often have test scripts in packages, not root
			if (!scripts.test && !workspace?.isMonorepo) {
				issues.push({ severity: "warning", message: "No 'test' script in package.json", rule: "no-test-script" });
			}
			if (!scripts.build && !scripts.dev && !workspace?.isMonorepo)
				issues.push({ severity: "info", message: "No 'build' or 'dev' script in package.json", rule: "no-build-script" });
			// Server projects should have a start script
			const isServer = pkg.dependencies && (pkg.dependencies.express || pkg.dependencies.fastify || pkg.dependencies.hono || pkg.dependencies.koa);
			if (isServer && !scripts.start && !workspace?.isMonorepo) {
				issues.push({ severity: "info", message: "Server project with no 'start' script in package.json", rule: "no-start-script" });
			}
		} catch {
			/* no package.json or parse error */
		}
	}

	const errors = issues.filter((i) => i.severity === "error").length;
	const warnings = issues.filter((i) => i.severity === "warning").length;
	const score = Math.max(0, Math.min(100, 100 - errors * 15 - warnings * 5));

	return {
		name: "structure",
		score,
		grade: gradeFromScore(score),
		details: {
			found,
			missing,
			srcFiles: srcCount,
			testFiles: testCount,
			testRatio: `${Math.round(testRatio * 100)}%`,
			...(workspace?.isMonorepo ? { monorepo: true, workspaceTool: workspace.tool, packages: workspace.packages.length } : {}),
		},
		issues,
		duration: Date.now() - start,
	};
}
