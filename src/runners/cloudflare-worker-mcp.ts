/** Cloudflare Worker MCP check — static audit for remote MCP servers on Workers.
 *  Gated centrally via appliesTo { component: ["cloudflare-workers", "mcp-server"] }.
 *  No live endpoint probing; only code, config, docs, tests, and workflow evidence. */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { FileInventory } from "../file-inventory.js";
import { inventoryAllFiles, inventorySourceFiles } from "../file-inventory.js";
import type { CheckResult, Issue, WorkspaceInfo } from "../types.js";
import { gradeFromScore } from "../types.js";

interface TextFile {
	path: string;
	fullPath: string;
	content: string;
	isTest?: boolean;
}

interface WranglerConfig {
	path: string;
	dir: string;
	raw: string;
	main: string | null;
}

interface HelperEvidence {
	kind: "cloudflare-helper" | "sdk-transport" | "sdk-server" | "none";
	file?: string;
	value?: string;
}

const MCP_ROUTE = /["'`](\/(?:mcp|sse|\.well-known\/oauth-protected-resource)[^"'`]*)["'`]/g;
const SDK_IMPORT = /@modelcontextprotocol\/(?:sdk|server)|\bagents\/mcp(?:\/server)?\b/;
const HELPER_PATTERN = /\bcreate(?:Legacy)?McpHandler\b|\bMcpAgent(?:\.serve)?\b/;
const TRANSPORT_PATTERN = /\bWebStandardStreamableHTTPServerTransport\b|\bStreamableHTTPServerTransport\b/;
const SERVER_PATTERN = /\bMcpServer\b|\bserver\.(?:tool|registerTool)\s*\(/;
const MANUAL_PROTOCOL_PATTERN =
	/\bJsonRpc(?:Request|Response)\b|\bjsonrpc\s*:\s*["']2\.0["']|body\.method\s*={2,3}\s*["'](?:initialize|tools\/list|tools\/call)["']|jsonRpcError\(/;
const AUTH_HEADER_PATTERN = /headers\.get\(["']Authorization["']\)|\bAuthorization\b|\bWWW-Authenticate\b/i;
const BEARER_PATTERN = /Bearer\s+|startsWith\(["']Bearer\s["']\)/i;
const TOKEN_VALIDATION_PATTERN =
	/timingSafeEqual|jwtVerify|verifyJwt|verifyToken|validate(?:Bearer|Token|Auth|Access)|crypto\.subtle|cf-access-jwt-assertion|token\s*[!=]={1,2}\s*env\.[A-Z0-9_]+|env\.[A-Z0-9_]+\s*[!=]={1,2}\s*token/i;
const PROTECTED_METADATA_PATTERN = /oauth-protected-resource|resource_metadata|WWW-Authenticate|authorization_servers/i;
const VALIDATION_PATTERN = /\b(?:parse|safeParse|validate)\s*\(|\bz\.(?:object|string|number|boolean|enum|array)\s*\(/;
const RAW_ARGUMENT_PATTERN = /params\.arguments|arguments\s*\|\|\s*\{\}|as\s+Record<string,\s*unknown>|request\.json\(\)\s+as\s+/;
const BROAD_SCHEMA_PATTERN =
	/z\.(?:any|unknown)\s*\(|record\s*\(\s*(?:z\.)?(?:any|unknown)|additionalProperties\s*:\s*true|inputSchema\s*:\s*\{\s*type\s*:\s*["']object["']\s*\}/s;

function findConfigs(cwd: string, workspace?: WorkspaceInfo): WranglerConfig[] {
	const dirs = [cwd, ...(workspace?.packages.map((p) => join(cwd, p.path)) ?? [])];
	const configs: WranglerConfig[] = [];
	for (const dir of dirs) {
		for (const name of ["wrangler.toml", "wrangler.json", "wrangler.jsonc"]) {
			const full = join(dir, name);
			if (!existsSync(full)) continue;
			try {
				const raw = readFileSync(full, "utf-8");
				configs.push({
					path: full,
					dir,
					raw,
					main: raw.match(/^\s*main\s*=\s*"([^"]+)"/m)?.[1] ?? null,
				});
			} catch {
				/* unreadable */
			}
			break;
		}
	}
	return configs;
}

function repoRelative(cwd: string, file: string): string {
	const rel = relative(cwd, file).replace(/\\/g, "/");
	return rel && !rel.startsWith("..") ? rel : file;
}

function allTextFiles(cwd: string, inventory?: FileInventory): TextFile[] {
	if (inventory) {
		return inventoryAllFiles(inventory, { extraExts: true }).map((file) => ({
			path: file.path,
			fullPath: file.fullPath,
			content: file.rawContent ?? file.content,
			isTest: file.isTest,
		}));
	}

	const out: TextFile[] = [];
	const walk = (dir: string, depth: number) => {
		if (depth > 6 || !existsSync(dir)) return;
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry === "node_modules" || entry === "dist" || entry === "coverage" || entry === ".vibe-check") continue;
			const full = join(dir, entry);
			try {
				const stat = statSync(full);
				if (stat.isDirectory()) {
					if (!entry.startsWith(".") || entry === ".github") walk(full, depth + 1);
				} else if (/\.(ts|tsx|js|jsx|mjs|cjs|json|toml|md|mdx|yml|yaml|txt|sh)$/.test(entry) && stat.size <= 1_000_000) {
					out.push({
						path: repoRelative(cwd, full),
						fullPath: full,
						content: readFileSync(full, "utf-8"),
						isTest: /\.test\.|\.spec\.|\/test\//.test(repoRelative(cwd, full)),
					});
				}
			} catch {
				/* race or unreadable */
			}
		}
	};
	walk(cwd, 0);
	return out;
}

function sourceFilesForConfigs(cwd: string, configs: WranglerConfig[], inventory?: FileInventory): TextFile[] {
	if (inventory) {
		const source = inventorySourceFiles(inventory);
		return source.flatMap((file) => {
			if (!configs.some((cfg) => isWorkerSource(cfg, file.fullPath))) return [];
			return [{ path: file.path, fullPath: file.fullPath, content: file.rawContent ?? file.content, isTest: file.isTest }];
		});
	}
	const files = allTextFiles(cwd).filter((file) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file.path) && !file.isTest);
	return files.filter((file) => configs.some((cfg) => isWorkerSource(cfg, file.fullPath)));
}

function isWorkerSource(cfg: WranglerConfig, fullPath: string): boolean {
	if (!(fullPath === cfg.dir || fullPath.startsWith(`${cfg.dir}/`))) return false;
	const mainPath = cfg.main ? join(cfg.dir, cfg.main) : "";
	const mainDir = mainPath ? dirname(mainPath) : "";
	return (
		(!!mainPath && fullPath === mainPath) ||
		(!!mainDir && fullPath.startsWith(`${mainDir}/`)) ||
		["src", "functions", "worker"].some((subdir) => fullPath.startsWith(`${join(cfg.dir, subdir)}/`))
	);
}

function detectRoutes(files: TextFile[]): string[] {
	const routes = new Set<string>();
	for (const file of files) {
		for (const match of file.content.matchAll(MCP_ROUTE)) routes.add(match[1]);
	}
	return [...routes].sort();
}

function detectHelper(files: TextFile[]): HelperEvidence {
	for (const file of files) {
		const helper = file.content.match(HELPER_PATTERN);
		if (helper) return { kind: "cloudflare-helper", file: file.path, value: helper[0] };
		const transport = file.content.match(TRANSPORT_PATTERN);
		if (transport) return { kind: "sdk-transport", file: file.path, value: transport[0] };
		if (SDK_IMPORT.test(file.content) && SERVER_PATTERN.test(file.content)) {
			return { kind: "sdk-server", file: file.path, value: "MCP SDK server" };
		}
	}
	return { kind: "none" };
}

function countTools(files: TextFile[]): { count: number; schemaCount: number; evidence: string[] } {
	let count = 0;
	let schemaCount = 0;
	const evidence = new Set<string>();
	for (const file of files) {
		const toolRegistrations = [...file.content.matchAll(/\b(?:server\.tool|registerTool|tool)\s*\(/g)].length;
		const namedToolObjects = [...file.content.matchAll(/\bname\s*:\s*["'][a-zA-Z0-9_-]+["'][\s\S]{0,500}\b(?:inputSchema|schema)\s*:/g)]
			.length;
		const fileCount = toolRegistrations + namedToolObjects;
		if (fileCount > 0) {
			count += fileCount;
			evidence.add(`${file.path}: ${fileCount}`);
		}
		schemaCount += [...file.content.matchAll(/\b(?:inputSchema|schema)\s*:/g)].length;
		schemaCount += [...file.content.matchAll(/\bz\.object\s*\(/g)].length;
	}
	return { count, schemaCount, evidence: [...evidence].sort() };
}

function smokeEvidence(files: TextFile[]): {
	files: string[];
	hasInitialize: boolean;
	hasToolsList: boolean;
	hasToolsCall: boolean;
	hasAuthDenial: boolean;
} {
	const candidates = files.filter((file) =>
		/(^|\/)(?:test|tests|e2e|smoke|docs|runbooks|\.github\/workflows)(\/|$)|(?:test|spec|smoke)\./.test(file.path),
	);
	const filesWithEvidence = new Set<string>();
	const combined = candidates
		.map((file) => {
			const hasEvidence = /initialize|tools\/list|tools\/call|WWW-Authenticate|unauthorized|401|Authorization/.test(file.content);
			if (hasEvidence) filesWithEvidence.add(file.path);
			return file.content;
		})
		.join("\n");
	return {
		files: [...filesWithEvidence].sort(),
		hasInitialize: /["']initialize["']|method:\s*["']initialize["']/.test(combined),
		hasToolsList: /tools\/list/.test(combined),
		hasToolsCall: /tools\/call/.test(combined),
		hasAuthDenial: /WWW-Authenticate|resource_metadata|unauthorized|401|Authorization/.test(combined),
	};
}

function primaryMcpFile(files: TextFile[]): string | undefined {
	return files.find(
		(file) => HELPER_PATTERN.test(file.content) || TRANSPORT_PATTERN.test(file.content) || MANUAL_PROTOCOL_PATTERN.test(file.content),
	)?.path;
}

export function runCloudflareWorkerMcp(cwd: string, workspace?: WorkspaceInfo, inventory?: FileInventory): CheckResult {
	const start = Date.now();
	const issues: Issue[] = [];
	const configs = findConfigs(cwd, workspace);

	if (configs.length === 0) {
		return {
			name: "cloudflare-worker-mcp",
			score: 100,
			grade: "A",
			details: { skipped: true, reason: "no wrangler config found" },
			issues: [],
			duration: Date.now() - start,
		};
	}

	const allFiles = allTextFiles(cwd, inventory);
	const sources = sourceFilesForConfigs(cwd, configs, inventory);
	const code = sources.map((file) => file.content).join("\n");
	const primaryFile = primaryMcpFile(sources);
	const routes = detectRoutes(sources);
	const helper = detectHelper(sources);
	const tools = countTools(sources);
	const smoke = smokeEvidence(allFiles);
	const hasManualProtocol = MANUAL_PROTOCOL_PATTERN.test(code) || /["']tools\/(?:list|call)["']/.test(code);
	const hasAuth = AUTH_HEADER_PATTERN.test(code) || BEARER_PATTERN.test(code);
	const hasBearer = BEARER_PATTERN.test(code);
	const validatesToken = TOKEN_VALIDATION_PATTERN.test(code);
	const hasProtectedMetadata = PROTECTED_METADATA_PATTERN.test(code);
	const hasRuntimeValidation = VALIDATION_PATTERN.test(code);

	if (sources.length === 0) {
		issues.push({
			severity: "warning",
			message: "MCP server component detected but no Worker source files were found under the wrangler entrypoint",
			rule: "R-PROTO-1",
		});
	}

	if (helper.kind === "none" && hasManualProtocol) {
		issues.push({
			severity: "error",
			message:
				"Hand-rolled MCP JSON-RPC handling found — use the MCP SDK, Cloudflare Agents, or createMcpHandler for Streamable HTTP semantics",
			file: primaryFile,
			rule: "R-PROTO-1",
		});
	} else if (helper.kind === "none") {
		issues.push({
			severity: "warning",
			message: "MCP server signal found but no SDK transport, Cloudflare Agents helper, or createMcpHandler usage was detected",
			file: primaryFile,
			rule: "R-PROTO-1",
		});
	}

	if (/"2025-03-26"/.test(code) && helper.kind === "none") {
		issues.push({
			severity: "warning",
			message:
				"Hard-coded MCP protocolVersion 2025-03-26 found in custom protocol handling — declare and test supported protocol revisions",
			file: primaryFile,
			rule: "R-PROTO-5",
		});
	}

	if (!hasAuth) {
		issues.push({
			severity: "error",
			message:
				"No authorization evidence before MCP dispatch — remote tool endpoints must reject unauthenticated requests at the Worker boundary",
			file: primaryFile,
			rule: "R-AUTH-1",
		});
	} else if (hasBearer && !validatesToken) {
		issues.push({
			severity: "error",
			message:
				"Bearer auth appears to check header presence only — validate issuer/audience or compare against a Worker secret before tool dispatch",
			file: primaryFile,
			rule: "R-AUTH-1",
		});
	}

	if (!hasProtectedMetadata) {
		issues.push({
			severity: "warning",
			message: "No OAuth protected-resource metadata or WWW-Authenticate resource_metadata challenge was detected for the MCP endpoint",
			file: primaryFile,
			rule: "R-AUTH-2",
		});
	}

	if (tools.count > 0 && tools.schemaCount < tools.count) {
		issues.push({
			severity: "warning",
			message: `${tools.count} MCP tools detected but only ${tools.schemaCount} schema definitions were found — every tool should advertise a narrow input schema`,
			file: primaryFile,
			rule: "R-TOOL-1",
		});
	}
	if (BROAD_SCHEMA_PATTERN.test(code)) {
		issues.push({
			severity: "warning",
			message: "Broad MCP input schema detected — avoid z.any, z.unknown, catch-all records, or unconstrained object schemas",
			file: primaryFile,
			rule: "R-TOOL-1",
		});
	}

	if (RAW_ARGUMENT_PATTERN.test(code) && !hasRuntimeValidation) {
		issues.push({
			severity: "error",
			message:
				"Tool arguments appear to be cast from JSON-RPC params without runtime parsing — validate with Zod, JSON Schema, or equivalent before side effects",
			file: primaryFile,
			rule: "R-VAL-1",
		});
	}

	if (!smoke.hasInitialize || !smoke.hasToolsList || !smoke.hasToolsCall || !smoke.hasAuthDenial) {
		const missing = [
			!smoke.hasInitialize ? "initialize" : "",
			!smoke.hasToolsList ? "tools/list" : "",
			!smoke.hasToolsCall ? "tools/call" : "",
			!smoke.hasAuthDenial ? "auth denial" : "",
		].filter(Boolean);
		issues.push({
			severity: "warning",
			message: `No retained MCP smoke evidence found for ${missing.join(", ")} — production deploys should gate protocol and auth behavior`,
			rule: "R-DEPLOY-3",
		});
	}

	const errors = issues.filter((issue) => issue.severity === "error").length;
	const warnings = issues.filter((issue) => issue.severity === "warning").length;
	const score = Math.max(0, Math.min(100, 100 - errors * 15 - warnings * 5));

	return {
		name: "cloudflare-worker-mcp",
		score,
		grade: gradeFromScore(score),
		details: {
			configs: configs.map((cfg) => repoRelative(cwd, cfg.path)),
			detectedMcpRoutes: routes,
			sdkHelper: helper,
			authModeEvidence: {
				hasAuthorizationHeader: hasAuth,
				hasBearer,
				validatesToken,
				hasProtectedResourceMetadata: hasProtectedMetadata,
			},
			toolCountEvidence: {
				toolsDetected: tools.count,
				schemaDefinitions: tools.schemaCount,
				files: tools.evidence,
			},
			smokeEvidence: smoke,
			tool: "built-in",
			source: inventory ? "file-inventory" : "legacy-walk",
		},
		issues,
		duration: Date.now() - start,
	};
}
