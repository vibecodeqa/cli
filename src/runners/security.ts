/** Security analysis — beyond secrets, checks for vulnerable code patterns. */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getProductionFiles, readDeps } from "../fs-utils.js";
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

export function runSecurity(cwd: string): CheckResult {
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

	const sourceFiles = getProductionFiles(cwd);

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

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const trimmed = line.trim();
			if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
			// Skip pattern/config definition lines and string-heavy metadata (prevents false positives on own code)
			if (/\bpattern\s*:|name:\s*["']|message:\s*["']|description:\s*["']|risk:\s*["']|recommendation:\s*["']/.test(trimmed)) continue;
			// Skip lines that are primarily string content (check-meta descriptions, etc.)
			if (/^\s*["'`].*["'`][,;]?\s*$/.test(line)) continue;

			for (const p of PATTERNS) {
				if (p.pattern.test(line)) {
					issues.push({
						severity: p.severity,
						message: p.message,
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
				issues.push({
					severity: "info",
					message: "localStorage.setItem in auth-related file — verify no tokens/secrets are persisted client-side",
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
		details: { filesScanned: sourceFiles.length, patterns: issues.length, cweCategories: cwePrefixes.size, errors, warnings, storageAudit, tool },
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

	try {
		const files = JSON.parse(stdout) as { filePath: string; messages: { severity: number; message: string; line: number; ruleId: string }[] }[];
		const issues: Issue[] = [];
		for (const file of files) {
			const relPath = file.filePath.replace(`${cwd}/`, "");
			for (const msg of file.messages) {
				if (!msg.ruleId?.startsWith("security/")) continue;
				issues.push({
					severity: msg.severity === 2 ? "error" : "warning",
					message: `[eslint-plugin-security] ${msg.message}`,
					file: relPath,
					line: msg.line,
					rule: msg.ruleId,
				});
			}
		}
		return issues.length > 0 ? issues : null;
	} catch {
		return null;
	}
}
