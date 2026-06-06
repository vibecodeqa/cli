/** Error handling check — detects poor error handling patterns. */

import { getProductionFiles } from "../fs-utils.js";
import type { CheckResult, Issue, StackInfo } from "../types.js";
import { gradeFromScore } from "../types.js";

export function runErrorHandling(cwd: string, stack: StackInfo): CheckResult {
	const start = Date.now();
	const issues: Issue[] = [];
	const files = getProductionFiles(cwd);

	if (files.length === 0) {
		return {
			name: "error-handling",
			score: 100,
			grade: "A",
			details: { skipped: true, reason: "no source files" },
			issues: [],
			duration: Date.now() - start,
		};
	}

	let emptyCatch = 0;
	let throwString = 0;
	let floatingPromises = 0;
	let catchIgnored = 0;

	for (const f of files) {
		const lines = f.content.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i].trim();
			if (line.startsWith("//") || line.startsWith("*")) continue;
			// Skip suppressed lines (// ok, // intentional, eslint-disable, biome-ignore)
			if (/\/\/\s*(?:ok|intentional|eslint-disable|biome-ignore)/.test(line)) continue;
			// Skip string-only lines, metadata definitions, and return statements with string literals
			if (/^\s*["'`].*["'`][,;]?\s*$/.test(lines[i])) continue;
			if (/\b(?:message|description|risk|recommendation|name)\s*:\s*["']/.test(line)) continue;
			if (/\breturn\s+["'`]/.test(line)) continue;
			if (/\brule\s*===?\s*["']/.test(line)) continue;

			if (/catch\s*\([^)]*\)\s*\{\s*\}/.test(line) || /catch\s*\{\s*\}/.test(line)) {
				// Skip intentional one-liner try-catch for optional browser APIs
				if (/try\s*\{.*(?:localStorage|sessionStorage|document\.).*\}\s*catch/.test(line)) continue;
				emptyCatch++;
				issues.push({ severity: "error", message: "Empty catch block", file: f.path, line: i + 1, rule: "empty-catch" });
			}

			if (/\bthrow\s+["'`]/.test(line)) {
				throwString++;
				issues.push({
					severity: "warning",
					message: "throw string literal — use throw new Error()",
					file: f.path,
					line: i + 1,
					rule: "throw-string",
				});
			}

			// Async anti-patterns
			// .catch(() => {}) — silently swallowing promise errors
			if (/\.catch\s*\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/.test(line)) {
				catchIgnored++;
				issues.push({
					severity: "warning",
					message: ".catch(() => {}) silently swallows errors — at least log them",
					file: f.path,
					line: i + 1,
					rule: "swallowed-promise",
				});
			}

			// Promise without .catch or await (floating promise)
			if (
				/^\s*(?:fetch|axios|new Promise)\s*\(/.test(line) &&
				!line.includes("await") &&
				!line.includes(".then") &&
				!line.includes(".catch") &&
				!line.includes("return")
			) {
				floatingPromises++;
				issues.push({
					severity: "warning",
					message: "Floating promise — missing await, .catch(), or return",
					file: f.path,
					line: i + 1,
					rule: "floating-promise",
				});
			}
		}
	}

	// ── Dangerous runtime patterns ──
	let jsonParseUnsafe = 0;
	let infiniteLoops = 0;
	let processExit = 0;

	for (const f of files) {
		const lines = f.content.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i].trim();
			if (line.startsWith("//") || line.startsWith("*")) continue;
			if (/\/\/\s*(?:ok|intentional|eslint-disable|biome-ignore)/.test(line)) continue;
			if (/^\s*["'`].*["'`][,;]?\s*$/.test(lines[i])) continue;
			if (/\b(?:message|description|risk|recommendation|name)\s*:\s*["']/.test(line)) continue;
			if (/\breturn\s+["'`]/.test(line)) continue;

			// JSON.parse of external input without try-catch
			if (/\bJSON\.parse\s*\(/.test(line)) {
				// Only flag if parsing user/network input (not internal known-safe files)
				const isKnownSafe = /package\.json|tsconfig|\.json"/.test(line);
				const isExternal =
					/\b(?:body|response|res|request|req|text|data|payload|input|event|stdout)\b/.test(line) || /\.text\(\)|\.json\(\)/.test(line);
				// Check if we're inside a try block
				const context = lines.slice(Math.max(0, i - 20), i).join("\n");
				const inTry = context.includes("try");
				if (isExternal && !inTry && !isKnownSafe) {
					jsonParseUnsafe++;
					issues.push({
						severity: "warning",
						message: "JSON.parse of external data without try-catch — crashes on malformed input",
						file: f.path,
						line: i + 1,
						rule: "unsafe-json-parse",
					});
				}
			}

			// while(true) / for(;;) without obvious break
			if (/\bwhile\s*\(\s*true\s*\)/.test(line) || /\bfor\s*\(\s*;\s*;\s*\)/.test(line)) {
				const block = lines.slice(i, Math.min(i + 20, lines.length)).join("\n");
				if (!block.includes("break") && !block.includes("return")) {
					infiniteLoops++;
					issues.push({
						severity: "error",
						message: "Potential infinite loop — no break or return found within 20 lines",
						file: f.path,
						line: i + 1,
						rule: "infinite-loop",
					});
				}
			}

			// Error info leakage — sending stack traces or error details to client
			if (/(?:res\.(?:json|send|status)|Response\.json|new Response)\s*\(.*(?:err\.stack|err\.message|error\.stack|error\.message)/.test(line)) {
				issues.push({
					severity: "warning",
					message: "Error details sent to client — stack traces reveal internal structure. Log server-side, return generic message",
					file: f.path,
					line: i + 1,
					rule: "error-info-leak",
				});
			}
			if (/catch\s*\([^)]*\)\s*\{[^}]*(?:return|res\.\w+\().*(?:\.message|\.stack)/.test(lines.slice(i, Math.min(i + 5, lines.length)).join(" "))) {
				const alreadyCaught = issues.some((iss) => iss.file === f.path && iss.line === i + 1 && iss.rule === "error-info-leak");
				if (!alreadyCaught) {
					issues.push({
						severity: "info",
						message: "Catch block may expose error details to caller — consider logging and returning a safe message",
						file: f.path,
						line: i + 1,
						rule: "error-info-leak",
					});
				}
			}

			// process.exit() in non-CLI files (library code shouldn't exit)
			if (/\bprocess\.exit\s*\(/.test(line) && !f.path.includes("cli") && !f.path.includes("bin/") && !f.path.includes("commands/") && !f.path.includes("monitor")) {
				processExit++;
				issues.push({
					severity: "warning",
					message: "process.exit() in library code — throw an error instead",
					file: f.path,
					line: i + 1,
					rule: "process-exit",
				});
			}
		}
	}

	// ── Server entry point checks ──
	const isServer = files.some(
		(f) =>
			f.content.includes("createServer") || f.content.includes("app.listen") || f.content.includes("Hono") || f.content.includes("express"),
	);
	if (isServer) {
		const hasRejectionHandler = files.some((f) => f.content.includes("unhandledRejection") || f.content.includes("uncaughtException"));
		if (!hasRejectionHandler) {
			issues.push({
				severity: "info",
				message: "Server with no process.on('unhandledRejection') handler — uncaught promise rejections crash in Node 15+",
				rule: "no-rejection-handler",
			});
		}
	}

	let hasErrorBoundary = false;
	if (stack.framework === "react") {
		for (const f of files) {
			if (f.content.includes("componentDidCatch") || f.content.includes("ErrorBoundary")) {
				hasErrorBoundary = true;
				break;
			}
		}
		if (!hasErrorBoundary && files.some((f) => f.ext === ".tsx")) {
			issues.push({ severity: "warning", message: "React project with no Error Boundary", rule: "no-error-boundary" });
		}
	}

	const totalFiles = files.length || 1;
	const emptyPenalty = Math.min(40, (emptyCatch / totalFiles) * 200);
	const throwPenalty = Math.min(15, (throwString / totalFiles) * 100);
	const promisePenalty = Math.min(15, ((floatingPromises + catchIgnored) / totalFiles) * 100);
	const runtimePenalty = Math.min(15, ((jsonParseUnsafe + infiniteLoops + processExit) / totalFiles) * 100);
	const boundaryPenalty = stack.framework === "react" && !hasErrorBoundary ? 5 : 0;
	const score = Math.max(
		0,
		Math.min(100, Math.round(100 - emptyPenalty - throwPenalty - promisePenalty - runtimePenalty - boundaryPenalty)),
	);

	return {
		name: "error-handling",
		score,
		grade: gradeFromScore(score),
		details: {
			emptyCatch,
			throwString,
			floatingPromises,
			jsonParseUnsafe,
			infiniteLoops,
			hasErrorBoundary: stack.framework === "react" ? hasErrorBoundary : "n/a",
			tool: "built-in",
		},
		issues,
		duration: Date.now() - start,
	};
}
