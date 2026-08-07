/** Resource lifecycle — detects leak-prone patterns in TypeScript/JavaScript.
 *
 * The stable check id remains `memory-safety` for historical compatibility.
 */

import type { FileInventory } from "../file-inventory.js";
import { inventorySourceFiles } from "../file-inventory.js";
import { getProductionFiles } from "../fs-utils.js";
import type { CheckResult, Issue, WorkspaceInfo } from "../types.js";
import { gradeFromScore } from "../types.js";
import { filesForProjects, nonOverlappingProjects, projectContainsPath, projectSourceRoots } from "./project-scope.js";

interface Pattern {
	name: string;
	pattern: RegExp;
	severity: "error" | "warning";
	message: string;
	rule: string;
}

const PATTERNS: Pattern[] = [
	{
		name: "setInterval-no-clear",
		pattern: /\bsetInterval\s*\(/g,
		severity: "warning",
		message: "setInterval without clearInterval — potential memory leak",
		rule: "interval-leak",
	},
	{
		name: "addEventListener-no-remove",
		pattern: /\.addEventListener\s*\(/g,
		severity: "warning",
		message: "addEventListener without removeEventListener — may leak if component unmounts",
		rule: "listener-leak",
	},
	{
		name: "global-var-assignment",
		pattern: /(?:^|\n)\s*(?:window|globalThis|global)\.\w+\s*=/g,
		severity: "warning",
		message: "Global variable assignment — pollutes global scope, hard to garbage collect",
		rule: "global-pollution",
	},
	{
		name: "new-without-cleanup",
		pattern: /new\s+(?:MutationObserver|IntersectionObserver|ResizeObserver|PerformanceObserver)\s*\(/g,
		severity: "warning",
		message: "Observer created — ensure .disconnect() is called on cleanup",
		rule: "observer-leak",
	},
	{
		name: "websocket-no-close",
		pattern: /new\s+WebSocket\s*\(/g,
		severity: "warning",
		message: "WebSocket opened — ensure .close() is called on cleanup",
		rule: "websocket-leak",
	},
	{
		name: "event-emitter-leak",
		pattern: /\.on\s*\(\s*['"`]/g,
		severity: "warning",
		message: "Event listener registered — ensure .off() or .removeListener() on cleanup",
		rule: "emitter-leak",
	},
];

export function runMemorySafety(cwd: string, workspace?: WorkspaceInfo, inventory?: FileInventory): CheckResult {
	const start = Date.now();
	const issues: Issue[] = [];
	const projects = nonOverlappingProjects(workspace);
	const files = filesForProjects(
		inventory ? inventorySourceFiles(inventory) : getProductionFiles(cwd, projects ? projectSourceRoots(projects) : undefined),
		projects,
	);

	for (const f of files) {
		if (f.isTest) continue;
		const lines = f.content.split("\n");

		for (const pat of PATTERNS) {
			// Check if the file has the pattern
			const matches = f.content.match(pat.pattern);
			if (!matches) continue;

			// For interval/listener leaks, check if cleanup exists in the same file
			if (pat.rule === "interval-leak") {
				if (f.content.includes("clearInterval")) continue;
			}
			if (pat.rule === "listener-leak") {
				if (f.content.includes("removeEventListener")) continue;
			}
			if (pat.rule === "observer-leak") {
				if (f.content.includes(".disconnect()")) continue;
			}
			if (pat.rule === "websocket-leak") {
				if (f.content.includes(".close()")) continue;
			}
			if (pat.rule === "emitter-leak") {
				// Skip if .off or .removeListener or .removeAllListeners in same file
				if (f.content.includes(".off(") || f.content.includes(".removeListener(") || f.content.includes(".removeAllListeners(")) continue;
				// Skip Node.js event emitter patterns (server.on, app.on, router.on)
				if (/\b(?:server|app|router|express|fastify|hono)\b/.test(f.content)) continue;
			}

			// Find first occurrence line number
			for (let i = 0; i < lines.length; i++) {
				if (pat.pattern.test(lines[i])) {
					pat.pattern.lastIndex = 0; // reset regex
					issues.push({
						severity: pat.severity,
						message: pat.message,
						file: f.path,
						line: i + 1,
						rule: pat.rule,
					});
					break; // one per file per pattern
				}
			}
		}
	}

	const totalFiles = files.filter((f) => !f.isTest).length;
	const affectedFiles = new Set(issues.map((i) => i.file)).size;
	const ratio = totalFiles > 0 ? affectedFiles / totalFiles : 0;
	const score = Math.round(Math.max(0, 100 - ratio * 200));

	return {
		name: "memory-safety",
		score,
		grade: gradeFromScore(score),
		details: {
			label: "Resource Lifecycle",
			legacyId: "memory-safety",
			semantics: "js-ts-resource-lifecycle",
			source: inventory ? "file-inventory" : "legacy-walk",
			totalFiles,
			affectedFiles,
			patterns: issues.length,
			projects: projects?.map((project) => ({
				id: project.id,
				name: project.name,
				path: project.path,
				files: files.filter((file) => projectContainsPath(project.path, file.path)).length,
				issues: issues.filter((issue) => issue.file && projectContainsPath(project.path, issue.file)).length,
			})),
		},
		issues,
		duration: Date.now() - start,
	};
}
