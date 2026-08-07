import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { discoveryConventions } from "./discovery-conventions.js";
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

export interface StaticSiteEvidence {
	source: "html-index" | "vite-config" | "astro-config" | "next-convention" | "cloudflare-pages" | "convention";
	file?: string;
	value?: string;
	description: string;
}

export interface StaticSiteRoot {
	path: string;
	fullPath: string;
	evidence: StaticSiteEvidence[];
}

export interface StaticSiteContext {
	rootPath: string;
	fullRootPath: string;
	publicRoots: StaticSiteRoot[];
	outputRoots: StaticSiteRoot[];
	evidence: StaticSiteEvidence[];
}

interface StaticSiteCollector {
	ensure: (rootPath: string, evidence: StaticSiteEvidence) => StaticSiteContext;
	addRoot: (context: StaticSiteContext, kind: "publicRoots" | "outputRoots", path: string, evidence: StaticSiteEvidence) => void;
}

export interface FileInventory {
	root: string;
	files: InventoryFile[];
	staticSites: StaticSiteContext[];
	summary: {
		totalFiles: number;
		includedFiles: number;
		ignoredFiles: number;
		ignoredDirectories: number;
		generatedFiles: number;
		securitySensitiveFiles: number;
		staticSiteRoots: number;
		byKind: Record<string, number>;
	};
}

export function buildFileInventory(cwd: string, workspace: WorkspaceInfo, policy: EffectiveScanPolicy): FileInventory {
	const files: InventoryFile[] = [];
	const counts = { totalFiles: 0, ignoredFiles: 0, ignoredDirectories: 0 };
	walk(cwd, "", workspace, policy, files, counts);
	const byKind: Record<string, number> = {};
	for (const file of files) byKind[file.kind] = (byKind[file.kind] ?? 0) + 1;
	const staticSites = detectStaticSiteContexts(cwd, workspace, files);
	return {
		root: cwd,
		files,
		staticSites,
		summary: {
			totalFiles: counts.totalFiles,
			includedFiles: files.length,
			ignoredFiles: counts.ignoredFiles,
			ignoredDirectories: counts.ignoredDirectories,
			generatedFiles: files.filter((file) => file.generated).length,
			securitySensitiveFiles: files.filter((file) => file.securitySensitive).length,
			staticSiteRoots: staticSites.length,
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
	if (discoveryConventions.sourceFileExtensions.includes(ext)) return "source";
	if ([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico"].includes(ext)) return "asset";
	return "unknown";
}

function isConfigPath(path: string): boolean {
	const name = basename(path);
	return (
		discoveryConventions.projectManifestFiles.includes(name) ||
		discoveryConventions.projectConfigFiles.includes(name) ||
		name === "pnpm-workspace.yaml" ||
		name === "package-lock.json"
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

function detectStaticSiteContexts(cwd: string, workspace: WorkspaceInfo, files: InventoryFile[]): StaticSiteContext[] {
	const contexts = new Map<string, StaticSiteContext>();
	const collector: StaticSiteCollector = {
		ensure: (rootPath, evidence) => {
			const clean = cleanRel(rootPath);
			const existing = contexts.get(clean);
			if (existing) {
				addEvidence(existing.evidence, evidence);
				return existing;
			}
			const context: StaticSiteContext = {
				rootPath: clean,
				fullRootPath: fullForRel(cwd, clean),
				publicRoots: [],
				outputRoots: [],
				evidence: [evidence],
			};
			contexts.set(clean, context);
			return context;
		},
		addRoot: (context, kind, path, evidence) => {
			const clean = cleanRel(path);
			const roots = context[kind];
			const existing = roots.find((root) => root.path === clean);
			if (existing) {
				addEvidence(existing.evidence, evidence);
				return;
			}
			roots.push({ path: clean, fullPath: fullForRel(cwd, clean), evidence: [evidence] });
		},
	};

	addIndexHtmlStaticSites(files, collector);
	addConfigBackedStaticSites(cwd, workspace, collector);
	addConventionalStaticSites(cwd, collector);

	return [...contexts.values()].sort((a, b) => a.rootPath.localeCompare(b.rootPath));
}

function addIndexHtmlStaticSites(files: InventoryFile[], collector: StaticSiteCollector): void {
	for (const file of files) {
		if (file.kind !== "html") continue;
		if (!isIndexHtml(file.path)) continue;
		const rootPath = cleanRel(dirname(file.path));
		collector.ensure(rootPath, { source: "html-index", file: file.path, description: "Index HTML file marks a static site root" });
	}
}

function addConfigBackedStaticSites(cwd: string, workspace: WorkspaceInfo, collector: StaticSiteCollector): void {
	for (const project of workspace.projects ?? []) {
		const rootPath = cleanRel(project.path);
		const configFiles = project.configFiles;
		addFrameworkStaticSite(cwd, rootPath, configFiles, "vite-config", "vite.config.", "Vite", collector);
		addFrameworkStaticSite(cwd, rootPath, configFiles, "astro-config", "astro.config.", "Astro", collector);
		addNextStaticSite(cwd, rootPath, configFiles, collector);
		addCloudflarePagesStaticSite(cwd, rootPath, configFiles, collector);
	}
}

function addConventionalStaticSites(cwd: string, collector: StaticSiteCollector): void {
	for (const rootName of discoveryConventions.staticSiteRootNames) {
		if (!existsSync(join(cwd, rootName))) continue;
		if (!hasAnyStaticMarker(cwd, rootName)) continue;
		collector.ensure(rootName, {
			source: "convention",
			value: rootName,
			description: "Common static site directory contains static web markers",
		});
	}
}

function addFrameworkStaticSite(
	cwd: string,
	rootPath: string,
	configFiles: string[],
	source: "vite-config" | "astro-config",
	configPrefix: string,
	label: "Vite" | "Astro",
	collector: StaticSiteCollector,
): void {
	const configFile = configFiles.find((file) => basename(file).startsWith(configPrefix));
	if (!configFile) return;
	const parsed = parseStaticConfigObject(readFile(cwd, configFile));
	const context = collector.ensure(resolveProjectRel(rootPath, parsed.root ?? "."), {
		source,
		file: configFile,
		value: parsed.root,
		description: `${label} config declares or implies the site root`,
	});
	collector.addRoot(context, "publicRoots", resolveProjectRel(rootPath, parsed.publicDir ?? (label === "Vite" ? "public" : "public")), {
		source,
		file: configFile,
		value: parsed.publicDir ?? "public",
		description: label === "Vite" ? "Vite publicDir is served from the web root" : "Astro publicDir is copied unchanged to the web root",
	});
	collector.addRoot(context, "outputRoots", resolveProjectRel(rootPath, parsed.outDir ?? "dist"), {
		source,
		file: configFile,
		value: parsed.outDir ?? "dist",
		description: `${label} output directory is generated output`,
	});
}

function addNextStaticSite(cwd: string, rootPath: string, configFiles: string[], collector: StaticSiteCollector): void {
	const hasNext =
		configFiles.some((file) => basename(file).startsWith("next.config.")) ||
		existsSync(fullForRel(cwd, resolveProjectRel(rootPath, "next-env.d.ts")));
	if (!hasNext) return;
	const context = collector.ensure(rootPath, {
		source: "next-convention",
		description: "Next.js project root inferred from config or framework files",
	});
	collector.addRoot(context, "publicRoots", resolveProjectRel(rootPath, "public"), {
		source: "next-convention",
		value: "public",
		description: "Next.js public directory is served from the web root",
	});
	collector.addRoot(context, "outputRoots", resolveProjectRel(rootPath, "out"), {
		source: "next-convention",
		value: "out",
		description: "Next.js static export output",
	});
}

function addCloudflarePagesStaticSite(cwd: string, rootPath: string, configFiles: string[], collector: StaticSiteCollector): void {
	const configFile = configFiles.find((file) => ["wrangler.toml", "wrangler.json", "wrangler.jsonc"].includes(basename(file)));
	if (!configFile) return;
	const pagesOutput = parseCloudflarePagesOutput(readFile(cwd, configFile));
	if (!pagesOutput) return;
	const outputPath = resolveProjectRel(rootPath, pagesOutput);
	const context = collector.ensure(outputPath, {
		source: "cloudflare-pages",
		file: configFile,
		value: pagesOutput,
		description: "Cloudflare Pages output directory is the static site root",
	});
	collector.addRoot(context, "outputRoots", outputPath, {
		source: "cloudflare-pages",
		file: configFile,
		value: pagesOutput,
		description: "Cloudflare Pages publishes this generated output directory",
	});
}

function addEvidence(target: StaticSiteEvidence[], evidence: StaticSiteEvidence): void {
	if (target.some((item) => item.source === evidence.source && item.file === evidence.file && item.value === evidence.value)) return;
	target.push(evidence);
}

function cleanRel(path: string): string {
	const clean = path.replace(/\\/g, "/").replace(/^\.\/|^\/+|\/+$/g, "");
	return clean === "" || clean === "." ? "." : clean;
}

function fullForRel(cwd: string, relPath: string): string {
	return relPath === "." ? cwd : join(cwd, relPath);
}

function resolveProjectRel(projectPath: string, relPath: string): string {
	const cleanProject = cleanRel(projectPath);
	const cleanRelPath = cleanRel(relPath);
	if (cleanRelPath === ".") return cleanProject;
	if (cleanRelPath.startsWith("/")) return cleanRel(cleanRelPath);
	return cleanProject === "." ? cleanRelPath : cleanRel(join(cleanProject, cleanRelPath));
}

function isIndexHtml(path: string): boolean {
	const name = basename(path).toLowerCase();
	return name === "index.html" || name === "index.htm";
}

function readFile(cwd: string, relPath: string): string {
	try {
		return readFileSync(join(cwd, relPath), "utf-8");
	} catch {
		return "";
	}
}

function parseStaticConfigObject(content: string): { root?: string; publicDir?: string; outDir?: string } {
	return {
		root: matchStringOption(content, "root"),
		publicDir: matchStringOption(content, "publicDir"),
		outDir: content.match(/\bbuild\s*:\s*\{[\s\S]*?\boutDir\s*:\s*["']([^"']+)["']/m)?.[1] ?? matchStringOption(content, "outDir"),
	};
}

function matchStringOption(content: string, key: string): string | undefined {
	return content.match(new RegExp(`\\b${key}\\s*:\\s*["']([^"']+)["']`, "m"))?.[1];
}

function parseCloudflarePagesOutput(content: string): string | undefined {
	return (
		content.match(/\bpages_build_output_dir\s*=\s*["']([^"']+)["']/)?.[1] ??
		content.match(/["']pages_build_output_dir["']\s*:\s*["']([^"']+)["']/)?.[1]
	);
}

function hasAnyStaticMarker(cwd: string, relPath: string): boolean {
	return ["index.html", "index.htm", "robots.txt", "sitemap.xml"].some((name) => existsSync(join(cwd, relPath, name)));
}

function extractScript(content: string): string {
	const scripts: string[] = [];
	for (const match of content.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)) {
		if (match[1]) scripts.push(match[1]);
	}
	return scripts.length > 0 ? scripts.join("\n") : content;
}
