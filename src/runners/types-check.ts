/** TypeScript type checking runner.
 *
 * Monorepo-aware: if tsconfig.json references project references or a build tsconfig,
 * uses `tsc -b --noEmit`. Also accepts tsconfig.base.json.
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { isIgnoredPath, normalizeToolPath } from "../fs-utils.js";
import type { CheckResult, Issue, ProjectContext, WorkspaceInfo } from "../types.js";
import { gradeFromScore } from "../types.js";
import { run } from "./exec.js";

interface TypeCheckTarget {
	cwd: string;
	prefix: string;
	projectId?: string;
	projectPath?: string;
	tool: "tsc" | "dart";
	mode: "project" | "build" | "script";
	command: string;
	authoritative: true;
	reason: string;
}

interface ExcludedTypeCheckTarget {
	projectId: string;
	projectPath: string;
	tool: "tsc";
	mode: "fallback";
	command: string;
	reason: string;
}

interface TypeCheckPlan {
	targets: TypeCheckTarget[];
	excluded: ExcludedTypeCheckTarget[];
	strategy: string;
}

export function runTypeCheck(cwd: string, isDart = false, workspace?: WorkspaceInfo): CheckResult {
	const start = Date.now();
	const issues: Issue[] = [];
	const plan = buildTypeCheckPlan(cwd, isDart, workspace);
	const targets = plan.targets;

	if (targets.length === 0) {
		return {
			name: "types",
			score: 0,
			grade: "F",
			details: {
				skipped: true,
				reason: isDart ? "no pubspec.yaml" : "no tsconfig.json",
				excluded: plan.excluded,
				strategy: plan.strategy,
			},
			issues: [],
			duration: Date.now() - start,
		};
	}

	if (isDart) {
		for (const root of targets) {
			parseDartAnalyzeErrors(
				run(`${root.command} 2>/dev/null || true`, root.cwd, 30_000, {
					projectId: root.projectId,
					projectPath: root.projectPath,
				}).stdout,
				cwd,
				root.cwd,
				issues,
			);
		}
	} else {
		for (const target of targets) {
			parseTscOutput(
				run(`${target.command} 2>&1 || true`, target.cwd, target.mode === "build" || target.mode === "script" ? 60_000 : 30_000, {
					projectId: target.projectId,
					projectPath: target.projectPath,
				}).stdout,
				issues,
				cwd,
				target.cwd,
			);
		}
	}

	const errorCount = issues.length;
	const score = errorCount === 0 ? 100 : Math.max(0, 100 - errorCount * 5);

	return {
		name: "types",
		score,
		grade: gradeFromScore(score),
		details: {
			errors: errorCount,
			ok: errorCount === 0,
			projects: targets.map((t) => ({
				id: t.projectId ?? "root",
				path: t.projectPath ?? ".",
				tool: t.tool,
				mode: t.mode,
				command: t.command,
				authoritative: t.authoritative,
				reason: t.reason,
			})),
			excluded: plan.excluded,
			excludedRootFallback: plan.excluded.some((target) => target.projectPath === "."),
			strategy: plan.strategy,
		},
		issues,
		duration: Date.now() - start,
	};
}

export function typeCheckTargets(cwd: string, isDart = false, workspace?: WorkspaceInfo): TypeCheckTarget[] {
	return buildTypeCheckPlan(cwd, isDart, workspace).targets;
}

export function buildTypeCheckPlan(cwd: string, isDart = false, workspace?: WorkspaceInfo): TypeCheckPlan {
	if (isDart) return dartTargets(cwd, workspace);
	const rootTsconfig = readTsconfig(cwd, "tsconfig.json");
	if (workspace?.isMonorepo && (rootTsconfig?.references?.length ?? 0) > 0) {
		return {
			targets: [
				{
					cwd,
					prefix: "",
					projectId: "root",
					projectPath: ".",
					tool: "tsc",
					mode: "build",
					command: "npx tsc -b --noEmit",
					authoritative: true,
					reason: "root project references define the monorepo typecheck graph",
				},
			],
			excluded: [],
			strategy: "root-project-references",
		};
	}
	const projectTargets = projectTypeTargets(cwd, workspace?.projects ?? []);
	const nonRootProjectTargets = projectTargets.filter((target) => target.projectPath !== ".");
	if (workspace?.isMonorepo && nonRootProjectTargets.length > 0) {
		return {
			targets: nonRootProjectTargets,
			excluded: rootFallbackExclusions(cwd, "project typecheck targets are authoritative in this monorepo"),
			strategy: "monorepo-project-targets",
		};
	}
	const packageTargets =
		workspace?.isMonorepo && workspace.packages.length > 0
			? workspace.packages
					.map((p) => ({ pkgDir: join(cwd, p.path), path: p.path }))
					.filter((p) => existsSync(join(p.pkgDir, "tsconfig.json")))
					.map((p) => ({
						cwd: p.pkgDir,
						prefix: p.path,
						projectId: p.path.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "") || "project",
						projectPath: p.path,
						tool: "tsc" as const,
						mode: "project" as const,
						command: "npx tsc --noEmit",
						authoritative: true as const,
						reason: "workspace package tsconfig is authoritative for this package",
					}))
			: [];
	if (packageTargets.length > 0) {
		return {
			targets: packageTargets,
			excluded: rootFallbackExclusions(cwd, "package tsconfigs are authoritative in this monorepo"),
			strategy: "monorepo-package-targets",
		};
	}
	const rootScript = rootTypecheckScript(cwd, workspace);
	if (rootScript) {
		return {
			targets: [
				{
					cwd,
					prefix: "",
					projectId: "root",
					projectPath: ".",
					tool: "tsc",
					mode: "script",
					command: rootScript,
					authoritative: true,
					reason: "root package.json typecheck script is authoritative",
				},
			],
			excluded: [],
			strategy: "root-typecheck-script",
		};
	}
	if (projectTargets.length > 0) {
		return { targets: projectTargets, excluded: [], strategy: "project-targets" };
	}
	const hasRootTsconfig =
		existsSync(join(cwd, "tsconfig.json")) || existsSync(join(cwd, "tsconfig.app.json")) || existsSync(join(cwd, "tsconfig.base.json"));
	return hasRootTsconfig
		? {
				targets: [
					{
						cwd,
						prefix: "",
						projectId: "root",
						projectPath: ".",
						tool: "tsc",
						mode: "project",
						command: "npx tsc --noEmit",
						authoritative: true,
						reason: workspace?.isMonorepo
							? "root tsconfig is the only discovered TypeScript target"
							: "root tsconfig is authoritative for this project",
					},
				],
				excluded: [],
				strategy: workspace?.isMonorepo ? "monorepo-root-only" : "single-root",
			}
		: { targets: [], excluded: [], strategy: "none" };
}

function projectTypeTargets(cwd: string, projects: ProjectContext[]): TypeCheckTarget[] {
	return projects
		.filter((project) => project.stack.language === "typescript" || project.stack.language === "javascript")
		.map((project) => ({ project, dir: project.path === "." ? cwd : join(cwd, project.path) }))
		.filter(({ dir }) => existsSync(join(dir, "tsconfig.json")))
		.map(({ project, dir }) => ({
			cwd: dir,
			prefix: project.path === "." ? "" : project.path,
			projectId: project.id,
			projectPath: project.path,
			tool: "tsc" as const,
			mode: "project" as const,
			command: "npx tsc --noEmit",
			authoritative: true as const,
			reason: project.path === "." ? "root project tsconfig is authoritative" : "project tsconfig is authoritative",
		}));
}

function dartTargets(cwd: string, workspace?: WorkspaceInfo): TypeCheckPlan {
	const projectTargets = (workspace?.projects ?? [])
		.filter((project) => project.stack.language === "dart")
		.map((project) => ({ project, dir: project.path === "." ? cwd : join(cwd, project.path) }))
		.filter(({ dir }) => existsSync(join(dir, "pubspec.yaml")))
		.map(({ project, dir }) => ({
			cwd: dir,
			prefix: project.path === "." ? "" : project.path,
			projectId: project.id,
			projectPath: project.path,
			tool: "dart" as const,
			mode: "project" as const,
			command: "dart analyze --format=machine",
			authoritative: true as const,
			reason: project.path === "." ? "root pubspec is authoritative" : "project pubspec is authoritative",
		}));
	if (projectTargets.length > 0) return { targets: projectTargets, excluded: [], strategy: "dart-project-targets" };
	const packageTargets =
		workspace?.isMonorepo && workspace.packages.some((p) => existsSync(join(cwd, p.path, "pubspec.yaml")))
			? workspace.packages
					.filter((p) => existsSync(join(cwd, p.path, "pubspec.yaml")))
					.map((p) => ({
						cwd: join(cwd, p.path),
						prefix: p.path,
						projectId: p.path.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "") || "project",
						projectPath: p.path,
						tool: "dart" as const,
						mode: "project" as const,
						command: "dart analyze --format=machine",
						authoritative: true as const,
						reason: "workspace package pubspec is authoritative for this package",
					}))
			: [];
	if (packageTargets.length > 0) return { targets: packageTargets, excluded: [], strategy: "dart-package-targets" };
	return existsSync(join(cwd, "pubspec.yaml"))
		? {
				targets: [
					{
						cwd,
						prefix: "",
						projectId: "root",
						projectPath: ".",
						tool: "dart",
						mode: "project",
						command: "dart analyze --format=machine",
						authoritative: true,
						reason: "root pubspec is authoritative",
					},
				],
				excluded: [],
				strategy: "dart-root",
			}
		: { targets: [], excluded: [], strategy: "none" };
}

function rootFallbackExclusions(cwd: string, reason: string): ExcludedTypeCheckTarget[] {
	const hasRootTsconfig =
		existsSync(join(cwd, "tsconfig.json")) || existsSync(join(cwd, "tsconfig.app.json")) || existsSync(join(cwd, "tsconfig.base.json"));
	return hasRootTsconfig
		? [{ projectId: "root", projectPath: ".", tool: "tsc", mode: "fallback", command: "npx tsc --noEmit", reason }]
		: [];
}

function rootTypecheckScript(cwd: string, workspace?: WorkspaceInfo): string | null {
	const rootProject = workspace?.projects?.find((project) => project.path === ".");
	const packageManager = rootProject?.stack.packageManager ?? "npm";
	try {
		const parsed = JSON.parse(readFileSync(join(cwd, "package.json"), "utf-8"));
		if (!parsed?.scripts?.typecheck) return null;
		if (packageManager === "pnpm") return "pnpm typecheck";
		if (packageManager === "yarn") return "yarn typecheck";
		if (packageManager === "bun") return "bun run typecheck";
		return "npm run typecheck";
	} catch {
		return null;
	}
}

function pathMetadata(repoCwd: string, toolCwd: string, rawPath: string): { file?: string; details: Record<string, string> } {
	const repoRelativePath = normalizeToolPath(repoCwd, toolCwd, rawPath);
	const outsideRepo = repoRelativePath.startsWith("../") || repoRelativePath === ".." || isAbsolute(repoRelativePath);
	return {
		file: outsideRepo ? undefined : repoRelativePath,
		details: {
			...(outsideRepo ? {} : { repoRelativePath }),
			toolRelativePath: rawPath,
			toolCwd,
			pathStatus: outsideRepo ? "outside-repo" : "normalized",
		},
	};
}

function withToolPath(issue: Issue, details: Record<string, string>): Issue {
	return { ...issue, details } as Issue;
}

function parseDartAnalyzeErrors(stdout: string, repoCwd: string, runCwd: string, issues: Issue[]): void {
	for (const line of stdout.split("\n")) {
		const parts = line.split("|");
		if (parts.length < 8 || parts[0] !== "ERROR") continue;
		const rawPath = parts[3].startsWith(`/private${runCwd}`) ? parts[3].slice("/private".length) : parts[3];
		const path = pathMetadata(repoCwd, runCwd, rawPath);
		issues.push(
			withToolPath(
				{
					severity: "error",
					file: path.file,
					line: parseInt(parts[4], 10) || undefined,
					rule: parts[2],
					message: parts[7],
				},
				path.details,
			),
		);
	}
}

export function parseTscOutput(stdout: string, issues: Issue[], cwd: string, toolCwd = cwd): void {
	for (const line of stdout.split("\n")) {
		const match = line.match(/^(.+)\((\d+),\d+\): error (TS\d+): (.+)/);
		if (match) {
			const path = pathMetadata(cwd, toolCwd, match[1]);
			if (path.file && isIgnoredPath(path.file)) continue;
			issues.push(
				withToolPath(
					{
						severity: "error",
						file: path.file,
						line: parseInt(match[2], 10),
						rule: match[3],
						message: match[4],
					},
					path.details,
				),
			);
		}
	}
}

function readTsconfig(cwd: string, name: string): { references?: { path: string }[] } | null {
	try {
		// Strip comments from tsconfig before parsing
		const raw = readFileSync(join(cwd, name), "utf-8");
		const stripped = raw.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
		return JSON.parse(stripped);
	} catch {
		return null;
	}
}
