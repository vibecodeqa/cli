/** Security analysis — beyond secrets, checks for vulnerable code patterns. */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { FileInventory } from "../file-inventory.js";
import { inventorySourceFiles } from "../file-inventory.js";
import { getProductionFiles, isIgnoredPath, normalizeToolPath, readDeps } from "../fs-utils.js";
import type { CheckResult, Issue } from "../types.js";
import { gradeFromScore } from "../types.js";
import { run } from "./exec.js";

interface SecurityPattern {
	name: string;
	pattern: RegExp;
	severity: "error" | "warning" | "info";
	message: string;
	cwe?: string; // Common Weakness Enumeration ID
}

const PATTERNS: SecurityPattern[] = [
	// XSS
	{
		name: "innerHTML",
		pattern: /\.innerHTML\s*=/,
		severity: "warning",
		message: "XSS: innerHTML assignment — use textContent or DOM APIs",
		cwe: "CWE-79",
	},
	{
		name: "v-html",
		pattern: /v-html\s*=/,
		severity: "warning",
		message: "XSS: v-html renders raw HTML — sanitize user input first",
		cwe: "CWE-79",
	},
	{
		name: "svelte-html",
		pattern: /\{@html\b/,
		severity: "warning",
		message: "XSS: {@html} renders raw HTML in Svelte — sanitize user input first",
		cwe: "CWE-79",
	},
	{
		name: "dangerouslySetInnerHTML",
		pattern: /dangerouslySetInnerHTML/,
		severity: "error",
		message: "XSS: dangerouslySetInnerHTML bypasses React protection",
		cwe: "CWE-79",
	},
	{
		name: "document.write",
		pattern: /document\.write\s*\(/,
		severity: "error",
		message: "XSS: document.write is dangerous",
		cwe: "CWE-79",
	},
	{ name: "outerHTML", pattern: /\.outerHTML\s*=/, severity: "warning", message: "XSS: outerHTML assignment", cwe: "CWE-79" },
	{
		name: "insertAdjacentHTML",
		pattern: /\.insertAdjacentHTML\s*\(/,
		severity: "warning",
		message: "XSS: insertAdjacentHTML with user data",
		cwe: "CWE-79",
	},

	// Injection
	{ name: "eval", pattern: /\beval\s*\(/, severity: "error", message: "Injection: eval() executes arbitrary code", cwe: "CWE-94" },
	{
		name: "new Function",
		pattern: /new\s+Function\s*\(/,
		severity: "error",
		message: "Injection: new Function() is equivalent to eval()",
		cwe: "CWE-94",
	},
	{
		name: "child_process.exec",
		pattern: /\b(?:child_process|cp)\.exec(?:Sync)?\s*\(|(?:^|\s)execSync\s*\(/,
		severity: "warning",
		message: "Command injection risk: prefer execFile with argument array",
		cwe: "CWE-78",
	},
	{
		name: "template literal in SQL",
		pattern: /(?:query|prepare|execute)\s*\(\s*`[^`]*\$\{/,
		severity: "error",
		message: "SQL injection: use parameterized queries instead of template literals",
		cwe: "CWE-89",
	},

	// Crypto
	{
		name: "Math.random for security",
		pattern: /Math\.random\s*\(\).*(?:token|secret|key|password|nonce|salt)/i,
		severity: "error",
		message: "Weak randomness: use crypto.randomUUID() or crypto.getRandomValues()",
		cwe: "CWE-330",
	},
	{
		name: "MD5/SHA1",
		pattern: /\b(?:md5|sha1|SHA1|MD5)\b/,
		severity: "warning",
		message: "Weak hash: MD5/SHA1 are broken — use SHA-256+",
		cwe: "CWE-328",
	},

	// Prototype pollution
	{
		name: "Object.assign from user input",
		pattern: /Object\.assign\s*\(\s*\{\s*\}\s*,\s*(?:req|request|body|params|query)/,
		severity: "warning",
		message: "Prototype pollution risk: validate/sanitize before Object.assign",
		cwe: "CWE-1321",
	},
	{
		name: "spread from user input",
		pattern: /\{\s*\.\.\.(?:req|request|body|params|query)\./,
		severity: "warning",
		message: "Prototype pollution: spreading unvalidated user input",
		cwe: "CWE-1321",
	},

	// Path traversal
	{
		name: "path traversal",
		pattern: /(?:readFile|writeFile|access|stat)(?:Sync)?\s*\([^)]*(?:req|request|body|params|query)/,
		severity: "warning",
		message: "Path traversal: validate file paths from user input",
		cwe: "CWE-22",
	},

	// SSRF
	{
		name: "fetch with user URL",
		pattern: /fetch\s*\(\s*(?:req|request|body|params|query)\.(?:url|href|target)/,
		severity: "warning",
		message: "SSRF: validate URLs before fetching user-supplied targets",
		cwe: "CWE-918",
	},

	// Sensitive data
	{
		name: "password in URL",
		pattern: /(?:password|secret|api_?token)=[^&\s'"]{8,}/i,
		severity: "warning",
		message: "Sensitive data in URL query string",
		cwe: "CWE-598",
	},

	// Client-side storage of secrets
	{
		name: "token in localStorage key",
		pattern: /localStorage\.setItem\s*\(\s*['"][^'"]*(?:token|secret|password|apiKey|api_key|auth|session)[^'"]*['"]/i,
		severity: "warning",
		message: "Storing auth/secret data in localStorage — vulnerable to XSS. Consider HttpOnly cookies",
		cwe: "CWE-922",
	},
	{
		name: "token var in localStorage",
		pattern: /localStorage\.setItem\s*\([^,]+,\s*(?:token|secret|password|apiKey|accessToken|refreshToken|jwt)\b/i,
		severity: "warning",
		message: "Storing token/secret variable in localStorage — vulnerable to XSS",
		cwe: "CWE-922",
	},
	{
		name: "JSON with token in localStorage",
		pattern:
			/localStorage\.setItem\s*\([^,]+,\s*JSON\.stringify\s*\(\s*(?:\{[^}]*(?:token|secret|password|auth)[^}]*\}|[a-zA-Z]*(?:[Uu]ser|[Aa]uth|[Ss]ession))/,
		severity: "warning",
		message: "Storing object with auth data in localStorage — token accessible to XSS",
		cwe: "CWE-922",
	},
	{
		name: "secret in localStorage",
		pattern: /localStorage\.setItem\s*\([^)]*(?:private_?key|access_?token|refresh_?token|jwt)/i,
		severity: "error",
		message: "Secret/key in localStorage — accessible to any XSS attack. Use HttpOnly cookies",
		cwe: "CWE-922",
	},

	// sessionStorage (same XSS risk as localStorage)
	{
		name: "token in sessionStorage",
		pattern: /sessionStorage\.setItem\s*\(\s*['"][^'"]*(?:token|secret|password|apiKey|api_key|auth|session|jwt)[^'"]*['"]/i,
		severity: "warning",
		message: "Storing auth/secret data in sessionStorage — vulnerable to XSS. Use HttpOnly cookies",
		cwe: "CWE-922",
	},

	// Connection strings with embedded credentials
	{
		name: "connection string with password",
		pattern: /(?:postgres|mysql|mongodb|redis|amqp):\/\/[^:]+:[^@]+@/,
		severity: "error",
		message: "Connection string with embedded credentials — use environment variables",
		cwe: "CWE-798",
	},

	// Hardcoded credentials in config objects
	{
		name: "hardcoded password in config",
		pattern: /(?:password|passwd|secret)\s*[:=]\s*["'][^'"]{4,}["']/i,
		severity: "warning",
		message: "Hardcoded password/secret in code — use environment variables or a secret manager",
		cwe: "CWE-798",
	},

	// Frontend API key exposure (client-side files with server-side keys)
	{
		name: "API key in fetch header",
		pattern: /(?:Authorization|x-api-key|api-key)["']\s*[:=,]\s*["'`](?:Bearer\s+)?(?:sk-|key-|token-)/i,
		severity: "error",
		message: "API key hardcoded in request header — move to server-side proxy",
		cwe: "CWE-798",
	},

	// IndexedDB storing secrets
	{
		name: "token in IndexedDB",
		pattern: /(?:put|add)\s*\(\s*\{[^}]*(?:token|secret|password|apiKey|jwt)[^}]*\}/i,
		severity: "info",
		message: "Storing auth data in IndexedDB — same XSS risk as localStorage",
		cwe: "CWE-922",
	},

	// postMessage without origin check
	{
		name: "postMessage without origin",
		pattern: /addEventListener\s*\(\s*["']message["'][^)]*\)\s*(?:=>|\{)(?:(?!origin)[\s\S]){0,200}(?:token|secret|password|auth)/i,
		severity: "warning",
		message: "Message handler accesses auth data without origin validation — cross-origin credential leak",
		cwe: "CWE-346",
	},

	// Cookie security
	{
		name: "cookie without HttpOnly",
		pattern: /document\.cookie\s*=(?!.*[Hh]ttp[Oo]nly)/,
		severity: "warning",
		message: "Setting cookie via document.cookie (not HttpOnly) — accessible to XSS",
		cwe: "CWE-1004",
	},
	{
		name: "cookie without Secure",
		pattern: /(?:Set-Cookie|setCookie)['"]\s*[,:].*(?!.*[Ss]ecure)/,
		severity: "info",
		message: "Cookie may be missing Secure flag — can be sent over HTTP",
		cwe: "CWE-614",
	},

	// Permissive CORS
	{
		name: "CORS wildcard with credentials",
		pattern: /Access-Control-Allow-Origin["']\s*[:=,]\s*["']\*/,
		severity: "warning",
		message: "CORS allows all origins (*) — restrict to specific domains, especially with credentials",
		cwe: "CWE-346",
	},
	{
		name: "CORS wildcard header",
		pattern: /["']Access-Control-Allow-Origin["']\s*,\s*["']\*/,
		severity: "warning",
		message: "Permissive CORS: Access-Control-Allow-Origin set to * — allows any site to read responses",
		cwe: "CWE-346",
	},

	// HTTP without TLS
	{
		name: "HTTP URL in fetch",
		pattern: /fetch\s*\(\s*["'`]http:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0)/,
		severity: "warning",
		message: "Fetching over plain HTTP — use HTTPS to prevent man-in-the-middle attacks",
		cwe: "CWE-319",
	},

	// Unvalidated redirect
	{
		name: "redirect from user input",
		pattern: /(?:res\.redirect|location\.href|window\.location)\s*(?:=|\()\s*(?:req\.(?:query|params|body)|searchParams\.get)/,
		severity: "warning",
		message: "Unvalidated redirect from user input — validate against an allowlist of URLs",
		cwe: "CWE-601",
	},

	// Debug mode in production config
	{
		name: "debug mode enabled",
		pattern: /(?:debug|devtools|verbose)\s*[:=]\s*true/i,
		severity: "info",
		message: "Debug/devtools mode enabled — ensure this is disabled in production builds",
		cwe: "CWE-489",
	},

	// Missing security headers (in response construction)
	{
		name: "no-cache header missing",
		pattern: /new Response\([^)]*\{[^}]*["']Set-Cookie["']/,
		severity: "warning",
		message: "Set-Cookie without Cache-Control: no-store",
		cwe: "CWE-525",
	},
];

/**
 * Modules whose output is HTML-escaped or sanitized. Rendering their result through an
 * HTML sink is evidence *against* an XSS finding, so the `dangerouslySetInnerHTML` rule
 * grades its severity by whether one of these produced the string.
 */
const SANITIZER_MODULES: { match: RegExp; label: string }[] = [
	{ match: /^(?:isomorphic-)?dompurify$/i, label: "DOMPurify" },
	{ match: /^sanitize-html$/i, label: "sanitize-html" },
	{ match: /^xss$/i, label: "xss" },
	{ match: /^escape-html$/i, label: "escape-html" },
	{ match: /^he$/i, label: "he" },
	{ match: /^highlight\.js(?:\/.*)?$/i, label: "highlight.js" },
	{ match: /^shiki(?:\/.*)?$/i, label: "shiki" },
	{ match: /^prismjs(?:\/.*)?$/i, label: "Prism" },
];

function sanitizerModuleLabel(specifier: string): string | null {
	if (/\.(?:css|scss|sass|less)$/i.test(specifier)) return null; // theme imports are not sanitizers
	for (const mod of SANITIZER_MODULES) if (mod.match.test(specifier)) return mod.label;
	return null;
}

/** Local names bound to an import clause (`a`, `* as a`, `{ a, b as c }`). */
function importClauseBindings(clause: string): string[] {
	const names: string[] = [];
	const withoutBraces = clause.replace(/\{([^}]*)\}/g, (_full, inner: string) => {
		for (const part of inner.split(",")) {
			const name = part
				.trim()
				.replace(/^type\s+/, "")
				.split(/\s+as\s+/)
				.pop()
				?.trim();
			if (name && /^[A-Za-z_$][\w$]*$/.test(name)) names.push(name);
		}
		return "";
	});
	for (const part of withoutBraces.split(",")) {
		const name = part
			.trim()
			.replace(/^type\s+/, "")
			.replace(/^\*\s+as\s+/, "")
			.trim();
		if (name && /^[A-Za-z_$][\w$]*$/.test(name)) names.push(name);
	}
	return names;
}

/** Reads a balanced expression/body starting at `from`; stops at the end of the statement. */
function readBalancedSource(content: string, from: number, limit = 4000): string {
	let depth = 0;
	let opened = false;
	let quote = "";
	const end = Math.min(content.length, from + limit);
	for (let i = from; i < end; i++) {
		const char = content[i];
		if (quote) {
			if (char === "\\") i++;
			else if (char === quote) quote = "";
			continue;
		}
		if (char === '"' || char === "'" || char === "`") {
			quote = char;
			continue;
		}
		if (char === "{" || char === "(" || char === "[") {
			depth++;
			opened = true;
		} else if (char === "}" || char === ")" || char === "]") {
			if (depth === 0) return content.slice(from, i);
			depth--;
		} else if (depth === 0 && (char === ";" || (char === "\n" && opened))) {
			return content.slice(from, i);
		}
	}
	return content.slice(from, end);
}

/** Does `text` call one of the sanitizer bindings (directly or via a member such as `hljs.highlight`)? */
function sanitizerCallLabel(text: string, bindings: Map<string, string>): string | null {
	for (const [name, label] of bindings) {
		if (new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*(?:\\.\\s*\\w+\\s*)*\\(`).test(text)) return label;
	}
	return null;
}

/** Sanitizer evidence for one file: imported module labels + names that yield sanitized HTML. */
interface SanitizerScope {
	/** Local name → sanitizer label, for imports and for local helpers that wrap them. */
	bindings: Map<string, string>;
	/** Labels of sanitizer modules the file imports at all. */
	imported: string[];
}

/**
 * Sanitizer bindings for one file: the imported names plus local helpers that wrap them
 * (e.g. `function hl(line) { return hljs.highlight(line).value; }`).
 */
function sanitizerScope(content: string): SanitizerScope {
	const bindings = new Map<string, string>();
	const imported = new Set<string>();
	for (const match of content.matchAll(/import\s+([^;'"]*?)\s+from\s*["']([^"']+)["']/g)) {
		const label = sanitizerModuleLabel(match[2]);
		if (!label) continue;
		imported.add(label);
		for (const name of importClauseBindings(match[1])) bindings.set(name, label);
	}
	for (const match of content.matchAll(/(?:const|let|var)\s+([^=;]+?)\s*=\s*require\(\s*["']([^"']+)["']\s*\)/g)) {
		const label = sanitizerModuleLabel(match[2]);
		if (!label) continue;
		imported.add(label);
		for (const name of importClauseBindings(match[1])) bindings.set(name, label);
	}
	for (const match of content.matchAll(/import\s*\(\s*["']([^"']+)["']\s*\)/g)) {
		const label = sanitizerModuleLabel(match[1]);
		if (label) imported.add(label);
	}
	// Two passes so a helper calling a helper is still recognised.
	const declaration = /\b(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
	for (let pass = 0; pass < 2; pass++) {
		for (const match of content.matchAll(declaration)) {
			const name = match[1];
			if (bindings.has(name)) continue;
			const start = (match.index ?? 0) + match[0].length;
			const label = sanitizerCallLabel(readBalancedSource(content, start), bindings);
			if (label) bindings.set(name, label);
		}
	}
	return { bindings, imported: [...imported] };
}

/** The expression assigned to `__html` at or just after `lineIndex`. */
function dangerousHtmlValue(lines: string[], lineIndex: number): string {
	const window = lines.slice(lineIndex, Math.min(lines.length, lineIndex + 6)).join("\n");
	const at = window.indexOf("__html");
	if (at < 0) return "";
	const colon = window.indexOf(":", at);
	if (colon < 0) return "";
	return readBalancedSource(window, colon + 1, 400).trim();
}

const EXPRESSION_KEYWORDS = new Set(["true", "false", "null", "undefined", "new", "typeof", "await", "return", "this", "void"]);

/** The expression plus the local declarations of the identifiers it mentions (bounded, 2 hops). */
function expressionWithLocalSources(expression: string, content: string, depth = 2): string {
	if (depth <= 0) return expression;
	let combined = expression;
	for (const match of expression.matchAll(/[A-Za-z_$][\w$]*/g)) {
		const name = match[0];
		if (EXPRESSION_KEYWORDS.has(name)) continue;
		const decl = new RegExp(`\\b(?:const|let|var|function)\\s+${name}\\b`).exec(content);
		if (!decl) continue;
		const body = readBalancedSource(content, (decl.index ?? 0) + decl[0].length);
		combined += `\n${expressionWithLocalSources(body, content, depth - 1)}`;
	}
	return combined;
}

/**
 * Grades a `dangerouslySetInnerHTML` hit by the provenance of the HTML it renders:
 * traced to a sanitizer → info, sanitizer present in the file → warning, otherwise the
 * original error. Returning the pattern default keeps unsanitized sinks at `error`.
 */
function classifyDangerousHtml(
	pattern: SecurityPattern,
	lines: string[],
	lineIndex: number,
	content: string,
	scope: SanitizerScope,
): Pick<Issue, "severity" | "message"> {
	const { bindings, imported } = scope;
	if (imported.length === 0) return { severity: pattern.severity, message: pattern.message };

	const expression = dangerousHtmlValue(lines, lineIndex);
	const traced = expression ? sanitizerCallLabel(expressionWithLocalSources(expression, content), bindings) : null;
	if (traced) {
		return {
			severity: "info",
			message: `XSS: dangerouslySetInnerHTML renders ${traced} output, which escapes the HTML it produces — verify no unsanitized input is concatenated in`,
		};
	}
	return {
		severity: "warning",
		message: `XSS: dangerouslySetInnerHTML bypasses React protection — ${imported.join("/")} is imported in this file but the rendered HTML was not traced to it; confirm the input is sanitized`,
	};
}

function findSecureCookieHelpers(files: { rawContent?: string; content: string }[]): Set<string> {
	const helpers = new Set<string>();
	const declaration = /\b(?:export\s+)?(?:function|const)\s+([A-Za-z_$][\w$]*)\b/g;
	for (const sf of files) {
		const content = sf.rawContent || sf.content;
		for (const match of content.matchAll(declaration)) {
			const name = match[1];
			const body = content.slice(match.index ?? 0, (match.index ?? 0) + 1600);
			if (/\bSet-Cookie\b|cookie/i.test(body) && /\bHttpOnly\b/i.test(body) && /\bSecure\b/i.test(body) && /\bSameSite\b/i.test(body)) {
				helpers.add(name);
			}
		}
	}
	return helpers;
}

function contextWindow(lines: string[], lineIndex: number): string {
	return lines.slice(Math.max(0, lineIndex - 4), Math.min(lines.length, lineIndex + 5)).join("\n");
}

function isLocalDevContext(file: string, context: string): boolean {
	return (
		/(?:^|[/\\])(?:test|tests|__tests__|fixtures|dev|local)(?:[/\\]|$)|(?:\.test|\.spec)\.[^.]+$/i.test(file) ||
		/\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0|createServer|listen\s*\(|test-job|dev server|local dev)\b/i.test(context)
	);
}

function referencesHelper(line: string, helpers: Set<string>): boolean {
	for (const helper of helpers) {
		if (new RegExp(`\\b${helper.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(line)) return true;
	}
	return false;
}

function credentialedCorsContext(context: string): boolean {
	return /Access-Control-Allow-Credentials["']?\s*[:,]\s*["']?true/i.test(context) || /\bcredentials\s*:\s*["']include["']/i.test(context);
}

function publicMetadataContext(context: string): boolean {
	return /\b(?:llms\.txt|skills\.json|\.well-known|metadata|manifest|public docs?|static metadata)\b/i.test(context);
}

interface BrowserStorageClassification {
	severity?: Issue["severity"];
	message?: string;
	suppress?: boolean;
}

function browserStorageCall(line: string): { store: "localStorage" | "sessionStorage"; key?: string; value: string } | null {
	const match = /\b(localStorage|sessionStorage)\.setItem\s*\(\s*([^,]+)\s*,\s*(.*)/.exec(line);
	if (!match) return null;
	const keyMatch = /^\s*["'`]([^"'`]+)["'`]/.exec(match[2]);
	return {
		store: match[1] as "localStorage" | "sessionStorage",
		key: keyMatch?.[1],
		value: match[3] || "",
	};
}

function isSensitiveStorageKey(key: string): boolean {
	return /(?:^|[:._-])(?:access|auth|bearer|credential|jwt|oauth|password|refresh|secret|session|token)(?:$|[:._-])/i.test(key);
}

function isUiPreferenceStorageKey(key: string): boolean {
	return /(?:^|[:._-])(?:appearance|drawer|filter|font|fontsize|font-size|language|last-route|lastroute|layout|locale|onboarding|preference|preferences|prefs|route|sidebar|sort|tab|text-scale|textscale|theme|timezone|tour|ui|view)(?:$|[:._-])/i.test(
		key,
	);
}

function hasSensitiveStorageValue(value: string): boolean {
	return /\b(?:accessToken|apiKey|auth|bearer|credential|jwt|password|refreshToken|secret|session|token)\b/i.test(value);
}

function classifyBrowserStorageLine(line: string): BrowserStorageClassification | null {
	const call = browserStorageCall(line);
	if (!call) return null;
	const sensitiveKey = call.key ? isSensitiveStorageKey(call.key) : false;
	const uiPreferenceKey = call.key ? isUiPreferenceStorageKey(call.key) : false;
	const sensitiveValue = hasSensitiveStorageValue(call.value);

	if (uiPreferenceKey && !sensitiveValue) return { suppress: true };
	if (!sensitiveKey && !sensitiveValue) return null;

	const storageName = call.store === "localStorage" ? "localStorage" : "sessionStorage";
	const persistence = call.store === "localStorage" ? "persistent browser storage" : "browser session storage";
	return {
		severity: call.store === "localStorage" ? "error" : "warning",
		message: `Auth/session-like key or value in ${storageName} (${persistence}) — accessible to XSS. Prefer HttpOnly cookies`,
	};
}

interface FileScanContext {
	lines: string[];
	lineIndex: number;
	content: string;
	sanitizers: SanitizerScope;
}

function contextualizePatternIssue(
	pattern: SecurityPattern,
	line: string,
	file: string,
	context: string,
	secureCookieHelpers: Set<string>,
	fileContext: FileScanContext,
): Pick<Issue, "severity" | "message"> | null {
	if (pattern.name === "dangerouslySetInnerHTML") {
		return classifyDangerousHtml(pattern, fileContext.lines, fileContext.lineIndex, fileContext.content, fileContext.sanitizers);
	}

	if (
		pattern.name === "token in localStorage key" ||
		pattern.name === "token var in localStorage" ||
		pattern.name === "JSON with token in localStorage" ||
		pattern.name === "secret in localStorage" ||
		pattern.name === "token in sessionStorage"
	) {
		const storageClassification = classifyBrowserStorageLine(line);
		if (storageClassification?.suppress) return null;
		if (storageClassification?.severity && storageClassification.message) {
			return {
				severity: storageClassification.severity,
				message: storageClassification.message,
			};
		}
	}

	if (pattern.name === "cookie without Secure") {
		if (/\bSecure\b/i.test(line) || referencesHelper(line, secureCookieHelpers)) return null;
		if (isLocalDevContext(file, context)) {
			return {
				severity: "info",
				message: "Local/dev cookie may omit Secure flag — verify this path is not served over production HTTPS",
			};
		}
	}

	if (pattern.name === "CORS wildcard with credentials" || pattern.name === "CORS wildcard header") {
		if (credentialedCorsContext(context)) {
			return {
				severity: "warning",
				message: "Credentialed CORS uses wildcard origin — browsers reject this and it may expose API intent incorrectly",
			};
		}
		if (publicMetadataContext(context)) {
			return {
				severity: "info",
				message: "Public metadata endpoint uses wildcard CORS without credentials",
			};
		}
		return {
			severity: "info",
			message: "Wildcard CORS without credentials — verify the response is intentionally public",
		};
	}

	return { severity: pattern.severity, message: pattern.message };
}

export function runSecurity(cwd: string, inventory?: FileInventory): CheckResult {
	const start = Date.now();
	const issues: Issue[] = [];
	let tool: "built-in" | "eslint-plugin-security" = "built-in";

	// ── Delegate to eslint-plugin-security if installed ──
	const deps = readDeps(cwd);
	if (deps["eslint-plugin-security"]) {
		const eslintIssues = tryEslintPluginSecurity(cwd);
		if (eslintIssues) {
			tool = "eslint-plugin-security";
			issues.push(...eslintIssues);
		}
	}

	const sourceFiles = inventory ? inventorySourceFiles(inventory) : getProductionFiles(cwd);
	const secureCookieHelpers = findSecureCookieHelpers(sourceFiles);

	if (sourceFiles.length === 0) {
		return {
			name: "security",
			score: 100,
			grade: "A",
			details: { skipped: true, reason: "no source files" },
			issues: [],
			duration: Date.now() - start,
		};
	}

	const cwePrefixes = new Set<string>();

	for (const sf of sourceFiles) {
		// For SFC files (.vue/.svelte), scan both script AND template for security patterns
		const scanContent = sf.rawContent || sf.content;
		const lines = scanContent.split("\n");
		// Computed lazily: only the HTML-sink rules need it, and most files never hit them.
		let fileSanitizers: SanitizerScope | undefined;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const trimmed = line.trim();
			if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
			// Skip pattern/config definition lines and string-heavy metadata (prevents false positives on own code)
			if (
				/\bpattern\s*:|name:\s*["']|message:\s*["'`]|description:\s*["']|risk:\s*["']|recommendation:\s*["']|rule:\s*["']|severity:\s*["']/.test(
					trimmed,
				)
			)
				continue;
			// Skip lines that are primarily string content (check-meta descriptions, etc.)
			if (/^\s*["'`].*["'`][,;]?\s*$/.test(line)) continue;
			// Skip return statements returning string literals (e.g., fix suggestions mentioning patterns)
			if (/\breturn\s+["'`]/.test(trimmed)) continue;
			// Skip rule-matching conditionals (e.g., if (rule === "secret-detected") ...)
			if (/\brule\s*===?\s*["']/.test(trimmed) || /\bcheck\s*===?\s*["']/.test(trimmed)) continue;

			for (const p of PATTERNS) {
				if (p.pattern.test(line)) {
					if (!fileSanitizers) fileSanitizers = sanitizerScope(scanContent);
					const contextualIssue = contextualizePatternIssue(p, line, sf.path, contextWindow(lines, i), secureCookieHelpers, {
						lines,
						lineIndex: i,
						content: scanContent,
						sanitizers: fileSanitizers,
					});
					if (!contextualIssue) continue;
					issues.push({
						severity: contextualIssue.severity,
						message: contextualIssue.message,
						file: sf.path,
						line: i + 1,
						rule: p.cwe || p.name,
					});
					if (p.cwe) cwePrefixes.add(p.cwe);
				}
			}
		}
	}

	// ── Context-aware localStorage audit ──
	// Files that handle auth AND use localStorage are risky even if variable names are ambiguous
	for (const sf of sourceFiles) {
		// Skip files that DEFINE security patterns (the scanner itself)
		if (sf.path.includes("security") && sf.content.includes("SecurityPattern")) continue;

		const hasLocalStorage = sf.content.includes("localStorage.setItem");
		if (!hasLocalStorage) continue;

		const hasAuthContext = /\b(?:token|oauth|access_token|Bearer|authorization|authenticate|login|signIn)\b/i.test(sf.content);
		if (!hasAuthContext) continue;

		const lines = sf.content.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const trimmed = lines[i].trim();
			if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
			if (/\b(?:pattern|message|name)\s*[:=]\s*["'`/]/.test(trimmed)) continue;
			if (!trimmed.includes("localStorage.setItem")) continue;
			const alreadyCaught = issues.some((iss) => iss.file === sf.path && iss.line === i + 1 && iss.rule === "CWE-922");
			if (!alreadyCaught) {
				const storageClassification = classifyBrowserStorageLine(trimmed);
				if (storageClassification?.suppress) continue;
				issues.push({
					severity: storageClassification?.severity || "info",
					message:
						storageClassification?.message ||
						"Ambiguous localStorage.setItem in auth-related file — verify no tokens/secrets are persisted client-side",
					file: sf.path,
					line: i + 1,
					rule: "CWE-922",
				});
				cwePrefixes.add("CWE-922");
			}
		}
	}

	// Check for security-critical HTML files
	const htmlFiles = ["index.html", "web/index.html", "public/index.html"];
	for (const h of htmlFiles) {
		const full = join(cwd, h);
		if (!existsSync(full)) continue;
		const html = readFileSync(full, "utf-8");

		// Missing CSP
		if (!html.includes("Content-Security-Policy") && !html.includes("content-security-policy")) {
			issues.push({ severity: "info", message: "No Content-Security-Policy meta tag in HTML", file: h, rule: "CWE-1021" });
		}

		// External scripts without integrity
		const scripts = html.match(/<script[^>]*src=["'][^"']*["'][^>]*>/g) || [];
		for (const s of scripts) {
			if (s.includes("integrity=")) continue;
			if (s.includes("localhost") || s.includes("/src/")) continue; // local dev scripts
			if (!s.includes("integrity")) {
				issues.push({ severity: "info", message: "External script without subresource integrity (SRI)", file: h, rule: "CWE-829" });
			}
		}
	}

	// ── Data storage audit summary ──
	const storageIssues = issues.filter((i) => i.rule === "CWE-922" || i.rule === "CWE-798" || i.rule === "CWE-1004" || i.rule === "CWE-346");
	const storageAudit = {
		localStorageSecrets: issues.filter((i) => i.rule === "CWE-922" && i.message.includes("localStorage")).length,
		sessionStorageSecrets: issues.filter((i) => i.rule === "CWE-922" && i.message.includes("sessionStorage")).length,
		hardcodedCredentials: issues.filter((i) => i.rule === "CWE-798").length,
		insecureCookies: issues.filter((i) => i.rule === "CWE-1004" || i.rule === "CWE-614" || i.rule === "CWE-525").length,
		total: storageIssues.length,
	};

	const errors = issues.filter((i) => i.severity === "error").length;
	const warnings = issues.filter((i) => i.severity === "warning").length;
	// Errors are critical but scale slightly with codebase size
	const totalFiles = sourceFiles.length || 1;
	const errorPenalty = Math.min(70, errors * Math.max(10, 50 / Math.sqrt(totalFiles)));
	const warnPenalty = Math.min(25, warnings * Math.max(3, 20 / Math.sqrt(totalFiles)));
	const score = Math.max(0, Math.min(100, Math.round(100 - errorPenalty - warnPenalty)));

	return {
		name: "security",
		score,
		grade: gradeFromScore(score),
		details: {
			filesScanned: sourceFiles.length,
			patterns: issues.length,
			cweCategories: cwePrefixes.size,
			errors,
			warnings,
			storageAudit,
			tool,
		},
		issues,
		duration: Date.now() - start,
	};
}

/** Try running eslint-plugin-security. Returns issues or null if unavailable. */
function tryEslintPluginSecurity(cwd: string): Issue[] | null {
	// Run eslint with security plugin rules using inline config
	const rules = [
		"security/detect-unsafe-regex",
		"security/detect-buffer-noassert",
		"security/detect-child-process",
		"security/detect-eval-with-expression",
		"security/detect-no-csrf-before-method-override",
		"security/detect-non-literal-fs-filename",
		"security/detect-non-literal-regexp",
		"security/detect-non-literal-require",
		"security/detect-object-injection",
		"security/detect-possible-timing-attacks",
		"security/detect-pseudoRandomBytes",
	];
	const ruleConfig = rules.map((r) => `"${r}":"warn"`).join(",");
	const { stdout } = run(
		`npx eslint --no-eslintrc --plugin security --rule '{${ruleConfig}}' --format json src/ 2>/dev/null || true`,
		cwd,
		30_000,
	);

	return parseEslintSecurityJson(stdout, cwd, cwd);
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

function withPathDetails(issue: Issue, details: Record<string, string>): Issue {
	return { ...issue, details } as Issue;
}

export function parseEslintSecurityJson(stdout: string, repoCwd: string, toolCwd: string): Issue[] | null {
	try {
		const files = JSON.parse(stdout) as {
			filePath: string;
			messages: { severity: number; message: string; line: number; ruleId: string }[];
		}[];
		const issues: Issue[] = [];
		for (const file of files) {
			const path = pathMetadata(repoCwd, toolCwd, file.filePath);
			if (path.file && isIgnoredPath(path.file)) continue;
			for (const msg of file.messages) {
				if (!msg.ruleId?.startsWith("security/")) continue;
				issues.push(
					withPathDetails(
						{
							severity: msg.severity === 2 ? "error" : "warning",
							message: `[eslint-plugin-security] ${msg.message}`,
							file: path.file,
							line: msg.line,
							rule: msg.ruleId,
						},
						path.details,
					),
				);
			}
		}
		return issues.length > 0 ? issues : null;
	} catch {
		return null;
	}
}
