/** Project structure check — does the repo have standard files and conventions? */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { collectSourceFiles } from "../fs-utils.js";
import type { CheckResult, Issue, StackInfo } from "../types.js";
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

export function runStructure(cwd: string, stack: StackInfo): CheckResult {
	const start = Date.now();
	const issues: Issue[] = [];
	const found: string[] = [];
	const missing: string[] = [];

	const isDart = stack.language === "dart";
	const EXPECTED_FILES = isDart ? DART_FILES : NODE_FILES;

	// Check standard files
	for (const fc of EXPECTED_FILES) {
		// tsconfig is required only for TS projects
		const required = fc.name === "tsconfig.json" ? stack.language === "typescript" : fc.required;
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

	// Check for lockfile
	const lockfiles = isDart ? ["pubspec.lock"] : ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lockb"];
	const hasLock = lockfiles.some((f) => existsSync(join(cwd, f)));
	if (hasLock) {
		found.push("lockfile");
	} else {
		issues.push({ severity: "warning", message: "No lockfile found — builds may not be reproducible", rule: "missing-lockfile" });
	}

	// Check for source directory
	const srcDirs = isDart ? ["lib"] : ["src", "web/src"];
	const hasSrc = srcDirs.some((d) => existsSync(join(cwd, d)));
	if (!hasSrc) {
		issues.push({ severity: "error", message: `No ${srcDirs[0]}/ directory found`, rule: "no-src" });
	}

	// Count source vs test files
	const allFiles = collectSourceFiles(cwd, { includeTests: true });
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
			if (!scripts.test) issues.push({ severity: "warning", message: "No 'test' script in package.json", rule: "no-test-script" });
			if (!scripts.build && !scripts.dev)
				issues.push({ severity: "info", message: "No 'build' or 'dev' script in package.json", rule: "no-build-script" });
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
		details: { found, missing, srcFiles: srcCount, testFiles: testCount, testRatio: `${Math.round(testRatio * 100)}%` },
		issues,
		duration: Date.now() - start,
	};
}
