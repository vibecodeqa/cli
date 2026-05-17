/** Security analysis — beyond secrets, checks for vulnerable code patterns. */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getProductionFiles } from "../fs-utils.js";
import type { CheckResult, Issue } from "../types.js";
import { gradeFromScore } from "../types.js";

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
		pattern: /localStorage\.setItem\s*\([^,]+,\s*JSON\.stringify\s*\(\s*(?:\{[^}]*(?:token|secret|password|auth)[^}]*\}|[a-zA-Z]*(?:[Uu]ser|[Aa]uth|[Ss]ession))/,
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
		const lines = sf.content.split("\n");

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
		const hasLocalStorage = sf.content.includes("localStorage.setItem");
		if (!hasLocalStorage) continue;

		const hasAuthContext =
			/\b(?:token|oauth|access_token|Bearer|authorization|authenticate|login|signIn)\b/i.test(sf.content);
		if (!hasAuthContext) continue;

		// This file handles auth and persists to localStorage
		const lines = sf.content.split("\n");
		for (let i = 0; i < lines.length; i++) {
			if (lines[i].includes("localStorage.setItem")) {
				// Check if this setItem wasn't already caught by pattern rules
				const alreadyCaught = issues.some(
					(iss) => iss.file === sf.path && iss.line === i + 1 && iss.rule === "CWE-922",
				);
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
		details: { filesScanned: sourceFiles.length, patterns: issues.length, cweCategories: cwePrefixes.size, errors, warnings },
		issues,
		duration: Date.now() - start,
	};
}
