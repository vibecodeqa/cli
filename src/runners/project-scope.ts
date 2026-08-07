import { join } from "node:path";
import { discoveryConventions } from "../discovery-conventions.js";
import { readDeps, type SourceFile } from "../fs-utils.js";
import type { ProjectContext, WorkspaceInfo } from "../types.js";

const FRONTEND_FRAMEWORKS = new Set(discoveryConventions.frontendFrameworks);

export function frontendProjects(workspace?: WorkspaceInfo): ProjectContext[] | null {
	if (!workspace?.projects) return null;
	return workspace.projects.filter((project) => FRONTEND_FRAMEWORKS.has(project.stack.framework));
}

export function nonOverlappingProjects(workspace?: WorkspaceInfo): ProjectContext[] | null {
	if (!workspace?.projects) return null;
	if (!workspace.isMonorepo) return workspace.projects;
	const nonRoot = workspace.projects.filter((project) => project.path !== ".");
	return nonRoot.length > 0 ? nonRoot : workspace.projects;
}

export function cleanProjectPath(projectPath: string): string {
	const clean = projectPath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
	return clean || ".";
}

export function projectContainsPath(projectPath: string, filePath: string): boolean {
	const clean = cleanProjectPath(projectPath);
	return clean === "." || filePath === clean || filePath.startsWith(`${clean}/`);
}

export function projectSourceRoots(projects: ProjectContext[]): string[] {
	const roots = new Set<string>();
	for (const project of projects) {
		if (project.srcRoots.length === 0) {
			roots.add(project.path);
			continue;
		}
		for (const root of project.srcRoots) roots.add(root);
	}
	return [...roots];
}

export function filesForProjects(files: SourceFile[], projects: ProjectContext[] | null): SourceFile[] {
	if (!projects) return files;
	return files.filter((file) => projects.some((project) => projectContainsPath(project.path, file.path)));
}

export function depsForProjects(cwd: string, projects: ProjectContext[] | null): Record<string, string> {
	const deps = { ...readDeps(cwd) };
	for (const project of projects ?? []) {
		if (project.path === ".") continue;
		Object.assign(deps, readDeps(join(cwd, project.path)));
	}
	return deps;
}

export function projectDetails(projects: ProjectContext[] | null, files: SourceFile[]) {
	return projects?.map((project) => ({
		id: project.id,
		name: project.name,
		path: project.path,
		files: files.filter((file) => projectContainsPath(project.path, file.path)).length,
	}));
}
