import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { SourceFile } from "./fs-utils.js";
import type { EffectiveScanPolicy } from "./scan-policy.js";
import { evaluatePath } from "./scan-policy.js";
import type { ProjectContext, WorkspaceInfo } from "./types.js";

export type InventoryFileKind = "source" | "test" | "html" | "doc" | "config" | "env" | "lockfile" | "asset" | "unknown";

export interface InventoryFile {
	path: string;
	fullPath: string;
	ext: string;
	size: number;
	kind: InventoryFileKind;
	isTest: boolean;
	generated: boolean;
	securitySensitive: boolean;
	reasons: string[];
	projectId?: string;
	projectPath?: string;
}

export interface FileInventory {
	root: string;
	files: InventoryFile[];
	summary: {
		totalFiles: number;
		includedFiles: number;
		ignoredFiles: number;
		ignoredDirectories: number;
		generatedFiles: number;
		securitySensitiveFiles: number;
		byKind: Record<string, number>;
	};
}

export function buildFileInventory(cwd: string, workspace: WorkspaceInfo, policy: EffectiveScanPolicy): FileInventory {
	const files: InventoryFile[] = [];
	const counts = { totalFiles: 0, ignoredFiles: 0, ignoredDirectories: 0 };
	walk(cwd, "", workspace, policy, files, counts);
	const byKind: Record<string, number> = {};
	for (const file of files) byKind[file.kind] = (byKind[file.kind] ?? 0) + 1;
	return {
		root: cwd,
		files,
		summary: {
			totalFiles: counts.totalFiles,
			includedFiles: files.length,
			ignoredFiles: counts.ignoredFiles,
			ignoredDirectories: counts.ignoredDirectories,
			generatedFiles: files.filter((file) => file.generated).length,
			securitySensitiveFiles: files.filter((file) => file.securitySensitive).length,
			byKind,
		},
	};
}

export function inventoryFiles(
	inventory: FileInventory,
	opts: { kind?: InventoryFileKind; includeGenerated?: boolean } = {},
): InventoryFile[] {
	return inventory.files.filter((file) => {
		if (opts.kind && file.kind !== opts.kind) return false;
		if (!opts.includeGenerated && file.generated) return false;
		return true;
	});
}

export function inventorySourceFiles(inventory: FileInventory, opts: { includeTests?: boolean } = {}): SourceFile[] {
	return inventory.files
		.filter((file) => {
			if (file.kind !== "source" && file.kind !== "test") return false;
			if (!opts.includeTests && file.isTest) return false;
			if (file.generated || file.size > 1_000_000) return false;
			return true;
		})
		.map((file) => {
			const raw = readInventoryText(file);
			const isSfc = file.ext === ".vue" || file.ext === ".svelte";
			const content = isSfc ? extractScript(raw) : raw;
			return {
				path: file.path,
				fullPath: file.fullPath,
				base: basename(file.path, file.ext),
				ext: file.ext,
				content,
				rawContent: isSfc ? raw : undefined,
				lines: content.split("\n").length,
				isTest: file.isTest,
			};
		});
}

function walk(
	cwd: string,
	prefix: string,
	workspace: WorkspaceInfo,
	policy: EffectiveScanPolicy,
	out: InventoryFile[],
	counts: { totalFiles: number; ignoredFiles: number; ignoredDirectories: number },
): void {
	const dir = prefix ? join(cwd, prefix) : cwd;
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}

	for (const entry of entries) {
		const relPath = prefix ? `${prefix}/${entry}` : entry;
		const fullPath = join(cwd, relPath);
		const decision = evaluatePath(policy, relPath);
		try {
			if (lstatSync(fullPath).isSymbolicLink()) continue;
			const stat = statSync(fullPath);
			if (stat.isDirectory()) {
				if (decision.ignored) {
					counts.ignoredDirectories++;
					continue;
				}
				walk(cwd, relPath, workspace, policy, out, counts);
				continue;
			}

			counts.totalFiles++;
			if (decision.excluded) {
				counts.ignoredFiles++;
				continue;
			}
			out.push(classifyFile(relPath, fullPath, stat.size, workspace, decision));
		} catch {
			/* skip unreadable paths */
		}
	}
}

function classifyFile(
	path: string,
	fullPath: string,
	size: number,
	workspace: WorkspaceInfo,
	decision: ReturnType<typeof evaluatePath>,
): InventoryFile {
	const ext = extname(path);
	const project = projectForPath(workspace.projects ?? [], path);
	const isTest = isTestPath(basename(path), path);
	return {
		path,
		fullPath,
		ext,
		size,
		kind: fileKind(path, ext, isTest, decision.reasons),
		isTest,
		generated: decision.generated,
		securitySensitive: decision.securitySensitive,
		reasons: decision.reasons,
		projectId: project?.id,
		projectPath: project?.path,
	};
}

function projectForPath(projects: ProjectContext[], filePath: string): ProjectContext | undefined {
	const matches = projects.filter((project) => {
		const path = project.path.replace(/^\/+|\/+$/g, "") || ".";
		return path === "." || filePath === path || filePath.startsWith(`${path}/`);
	});
	return matches.sort((a, b) => b.path.length - a.path.length)[0];
}

function fileKind(path: string, ext: string, isTest: boolean, reasons: string[]): InventoryFileKind {
	if (isTest) return "test";
	if (ext === ".html" || ext === ".htm") return "html";
	if (ext === ".md" || ext === ".mdx") return "doc";
	if (path.startsWith(".env") || basename(path).startsWith(".env")) return "env";
	if (reasons.includes("lockfile")) return "lockfile";
	if (isConfigPath(path)) return "config";
	if ([".ts", ".tsx", ".js", ".jsx", ".dart", ".vue", ".svelte"].includes(ext)) return "source";
	if ([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico"].includes(ext)) return "asset";
	return "unknown";
}

function isConfigPath(path: string): boolean {
	const name = basename(path);
	return (
		name === "package.json" ||
		name === "tsconfig.json" ||
		name.startsWith("tsconfig.") ||
		name.startsWith("eslint.config.") ||
		name === "biome.json" ||
		name === "biome.jsonc" ||
		name === "vite.config.ts" ||
		name === "vite.config.js" ||
		name === "pubspec.yaml" ||
		name === "analysis_options.yaml" ||
		name === "wrangler.toml"
	);
}

function isTestPath(entry: string, relPath: string): boolean {
	return (
		entry.includes(".test.") ||
		entry.includes(".spec.") ||
		entry.endsWith("_test.dart") ||
		relPath.includes("__tests__/") ||
		relPath.includes("/test/") ||
		relPath.startsWith("test/") ||
		relPath.includes("/tests/") ||
		relPath.startsWith("tests/")
	);
}

export function readInventoryText(file: InventoryFile): string {
	try {
		return readFileSync(file.fullPath, "utf-8");
	} catch {
		return "";
	}
}

function extractScript(content: string): string {
	const scripts: string[] = [];
	for (const match of content.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)) {
		if (match[1]) scripts.push(match[1]);
	}
	return scripts.length > 0 ? scripts.join("\n") : content;
}
