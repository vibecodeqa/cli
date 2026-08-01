/** Flutter framework health.
 *
 * This is intentionally static for v0. `lint`/`types` own `dart analyze`
 * execution and `testing` owns test execution. This check answers the
 * Flutter-specific question: does the repo/package layout have the expected
 * Flutter analysis, test, generated-file, and pubspec hygiene signals?
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { CheckResult, Issue, WorkspaceInfo } from "../types.js";
import { gradeFromScore } from "../types.js";

interface FlutterPackage {
	name: string;
	path: string;
	dir: string;
	pubspec: string;
	isFlutter: boolean;
	isApp: boolean;
	hasAnalysisOptions: boolean;
	hasFlutterLints: boolean;
	hasFlutterTest: boolean;
	hasIntegrationTestDep: boolean;
	hasSdkConstraint: boolean;
	sourceFiles: number;
	generatedFiles: number;
	unitTests: number;
	widgetTests: number;
	integrationTests: number;
	testDriverFiles: number;
	assetEntries: number;
}

export function runFlutter(cwd: string, workspace?: WorkspaceInfo): CheckResult {
	const start = Date.now();
	const packages = findFlutterPackages(cwd, workspace);

	if (packages.length === 0) {
		return {
			name: "flutter",
			score: 100,
			grade: "A",
			details: { skipped: true, reason: "no Flutter packages detected" },
			issues: [],
			duration: Date.now() - start,
		};
	}

	const rootAnalysis = existsSync(join(cwd, "analysis_options.yaml"));
	const issues = packages.flatMap((pkg) => packageIssues(pkg, rootAnalysis));

	const appCount = packages.filter((p) => p.isApp).length;
	const sourceFiles = packages.reduce((sum, p) => sum + p.sourceFiles, 0);
	const unitTests = packages.reduce((sum, p) => sum + p.unitTests, 0);
	const widgetTests = packages.reduce((sum, p) => sum + p.widgetTests, 0);
	const integrationTests = packages.reduce((sum, p) => sum + p.integrationTests, 0);
	const generatedFiles = packages.reduce((sum, p) => sum + p.generatedFiles, 0);
	const errors = issues.filter((i) => i.severity === "error").length;
	const warnings = issues.filter((i) => i.severity === "warning").length;
	const infos = issues.filter((i) => i.severity === "info").length;
	const score = Math.max(0, Math.min(100, 100 - errors * 20 - warnings * 8 - Math.min(20, infos * 2)));

	return {
		name: "flutter",
		score,
		grade: gradeFromScore(score),
		details: {
			packages: packages.map((pkg) => ({
				name: pkg.name,
				path: pkg.path,
				kind: pkg.isApp ? "app" : "package",
				sourceFiles: pkg.sourceFiles,
				unitTests: pkg.unitTests,
				widgetTests: pkg.widgetTests,
				integrationTests: pkg.integrationTests,
				generatedFiles: pkg.generatedFiles,
				hasAnalysisOptions: pkg.hasAnalysisOptions || rootAnalysis,
				hasFlutterLints: pkg.hasFlutterLints,
				hasFlutterTest: pkg.hasFlutterTest,
				hasIntegrationTestDep: pkg.hasIntegrationTestDep,
			})),
			metrics: [
				{ id: "packages", label: "Flutter packages", value: packages.length, unit: "count", trend: "neutral" },
				{ id: "apps", label: "Flutter apps", value: appCount, unit: "count", trend: "neutral" },
				{ id: "sourceFiles", label: "Dart source files", value: sourceFiles, unit: "count", trend: "neutral" },
				{ id: "widgetTests", label: "Widget tests", value: widgetTests, unit: "count", trend: "higher-is-better" },
				{ id: "integrationTests", label: "Integration tests", value: integrationTests, unit: "count", trend: "higher-is-better" },
				{ id: "generatedFiles", label: "Generated Dart files", value: generatedFiles, unit: "count", trend: "neutral" },
			],
			rootAnalysisOptions: rootAnalysis,
			sourceFiles,
			unitTests,
			widgetTests,
			integrationTests,
			generatedFiles,
			errors,
			warnings,
			infos,
		},
		issues,
		duration: Date.now() - start,
	};
}

function packageIssues(pkg: FlutterPackage, rootAnalysis: boolean): Issue[] {
	const issues: Issue[] = [];
	if (!pkg.hasAnalysisOptions && !rootAnalysis) {
		issues.push({
			severity: pkg.isApp ? "warning" : "info",
			file: `${pkg.path}/pubspec.yaml`,
			rule: "missing-analysis-options",
			message: `${pkg.path} has no analysis_options.yaml and no root analysis_options.yaml`,
		});
	}
	if (!pkg.hasFlutterLints && !rootAnalysis) {
		issues.push({
			severity: "info",
			file: `${pkg.path}/pubspec.yaml`,
			rule: "missing-flutter-lints",
			message: `${pkg.path} does not declare flutter_lints/custom linting; analysis may be too weak`,
		});
	}
	if (!pkg.hasSdkConstraint) {
		issues.push({
			severity: "warning",
			file: `${pkg.path}/pubspec.yaml`,
			rule: "missing-sdk-constraint",
			message: `${pkg.path} has no Dart SDK constraint in pubspec.yaml`,
		});
	}
	if (!pkg.hasFlutterTest && (pkg.isApp || pkg.sourceFiles > 0)) {
		issues.push({
			severity: "warning",
			file: `${pkg.path}/pubspec.yaml`,
			rule: "missing-flutter-test",
			message: `${pkg.path} has Flutter source but no flutter_test dev dependency`,
		});
	}
	if (pkg.integrationTests > 0 && !pkg.hasIntegrationTestDep) {
		issues.push({
			severity: "warning",
			file: `${pkg.path}/pubspec.yaml`,
			rule: "missing-integration-test-dep",
			message: `${pkg.path} has integration_test files but no integration_test dev dependency`,
		});
	}
	if (pkg.isApp && pkg.widgetTests === 0) {
		issues.push({
			severity: "warning",
			file: pkg.path,
			rule: "missing-widget-tests",
			message: `${pkg.path} is a Flutter app but has no widget tests under test/`,
		});
	}
	if (pkg.isApp && pkg.integrationTests === 0) {
		issues.push({
			severity: "info",
			file: pkg.path,
			rule: "missing-integration-tests",
			message: `${pkg.path} is a Flutter app but has no integration_test/ coverage`,
		});
	}
	if (pkg.generatedFiles > 0) {
		issues.push({
			severity: "info",
			file: pkg.path,
			rule: "generated-files-neutral",
			message: `${pkg.path} has ${pkg.generatedFiles} generated Dart files; treat them as generated/visual-neutral in quality maps`,
		});
	}
	return issues;
}

function findFlutterPackages(cwd: string, workspace?: WorkspaceInfo): FlutterPackage[] {
	const candidates = new Set<string>();
	if (existsSync(join(cwd, "pubspec.yaml"))) candidates.add(".");
	for (const pkg of workspace?.packages ?? []) {
		if (existsSync(join(cwd, pkg.path, "pubspec.yaml"))) candidates.add(pkg.path);
	}
	if (candidates.size === 0) {
		for (const rel of findPubspecDirs(cwd, cwd, 2)) candidates.add(rel);
	}

	const packages: FlutterPackage[] = [];
	for (const relPath of [...candidates].sort()) {
		const dir = relPath === "." ? cwd : join(cwd, relPath);
		const pubspecPath = join(dir, "pubspec.yaml");
		if (!existsSync(pubspecPath)) continue;
		let pubspec = "";
		try {
			pubspec = readFileSync(pubspecPath, "utf-8");
		} catch {
			continue;
		}
		const isFlutter = hasPubspecKey(pubspec, "flutter");
		const hasFlutterTest = hasPubspecKey(pubspec, "flutter_test");
		if (!isFlutter && !hasFlutterTest) continue;
		const files = walkDartFiles(dir);
		const testFiles = files.filter((f) => f.startsWith("test/") || f.startsWith("integration_test/") || f.startsWith("test_driver/"));
		packages.push({
			name: readPubspecName(pubspec) || (relPath === "." ? "." : relPath.split("/").at(-1) || relPath),
			path: relPath,
			dir,
			pubspec,
			isFlutter,
			isApp: existsSync(join(dir, "lib", "main.dart")),
			hasAnalysisOptions: existsSync(join(dir, "analysis_options.yaml")),
			hasFlutterLints: hasPubspecKey(pubspec, "flutter_lints") || hasPubspecKey(pubspec, "very_good_analysis"),
			hasFlutterTest,
			hasIntegrationTestDep: hasPubspecKey(pubspec, "integration_test"),
			// A real Dart SDK constraint value looks like a version range (^, >, <, =,
			// ~, or a digit). Requiring that avoids matching `sdk: flutter` under a
			// `flutter:`/`flutter_test:` dependency, which every Flutter app has — that
			// false match made `missing-sdk-constraint` dead code.
			hasSdkConstraint: /^\s*sdk:\s*["']?[\^><=~\d]/m.test(pubspec),
			sourceFiles: files.filter((f) => f.startsWith("lib/") && !isGeneratedDart(f)).length,
			generatedFiles: files.filter(isGeneratedDart).length,
			unitTests: testFiles.filter((f) => f.startsWith("test/") && !isWidgetTest(join(dir, f))).length,
			widgetTests: testFiles.filter((f) => f.startsWith("test/") && isWidgetTest(join(dir, f))).length,
			integrationTests: testFiles.filter((f) => f.startsWith("integration_test/")).length,
			testDriverFiles: testFiles.filter((f) => f.startsWith("test_driver/")).length,
			assetEntries: countAssetEntries(pubspec),
		});
	}
	return packages;
}

function findPubspecDirs(root: string, dir: string, depth: number): string[] {
	if (depth < 0) return [];
	const found: string[] = [];
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return found;
	}
	for (const entry of entries) {
		if (entry === ".git" || entry === "node_modules" || entry === "build" || entry === ".dart_tool" || entry.startsWith(".")) continue;
		const full = join(dir, entry);
		try {
			if (!statSync(full).isDirectory()) continue;
		} catch {
			continue;
		}
		if (existsSync(join(full, "pubspec.yaml"))) {
			found.push(relative(root, full) || ".");
			continue;
		}
		found.push(...findPubspecDirs(root, full, depth - 1));
	}
	return found;
}

function walkDartFiles(dir: string, prefix = ""): string[] {
	const out: string[] = [];
	let entries: string[];
	try {
		entries = readdirSync(join(dir, prefix));
	} catch {
		return out;
	}
	for (const entry of entries) {
		if (entry === ".dart_tool" || entry === "build" || entry === ".git") continue;
		const rel = prefix ? `${prefix}/${entry}` : entry;
		const full = join(dir, rel);
		try {
			if (statSync(full).isDirectory()) {
				out.push(...walkDartFiles(dir, rel));
			} else if (entry.endsWith(".dart")) {
				out.push(rel);
			}
		} catch {
			/* skip unreadable */
		}
	}
	return out;
}

function hasPubspecKey(pubspec: string, key: string): boolean {
	return new RegExp(`^\\s{0,4}${escapeRegExp(key)}\\s*:`, "m").test(pubspec);
}

function readPubspecName(pubspec: string): string | null {
	return pubspec.match(/^name:\s*([A-Za-z0-9_-]+)/m)?.[1] ?? null;
}

function isGeneratedDart(path: string): boolean {
	return (
		path.endsWith(".g.dart") ||
		path.endsWith(".freezed.dart") ||
		path.endsWith(".gr.dart") ||
		path.endsWith(".gen.dart") ||
		path.endsWith(".pb.dart") ||
		path.endsWith(".pbenum.dart") ||
		path.endsWith(".pbjson.dart")
	);
}

function isWidgetTest(path: string): boolean {
	try {
		const content = readFileSync(path, "utf-8");
		return /\btestWidgets\s*\(|\bWidgetTester\b|\bpumpWidget\s*\(/.test(content);
	} catch {
		return false;
	}
}

function countAssetEntries(pubspec: string): number {
	const lines = pubspec.split("\n");
	let inAssets = false;
	let count = 0;
	for (const line of lines) {
		if (/^\s{2}assets:\s*$/.test(line)) {
			inAssets = true;
			continue;
		}
		if (inAssets && /^\s{2}\S/.test(line)) break;
		if (inAssets && /^\s{4}-\s+/.test(line)) count++;
	}
	return count;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
