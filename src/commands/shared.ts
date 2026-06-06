/** Shared utilities for CLI commands. */

import { existsSync, statSync } from "node:fs";

export function validateCwd(cwd: string): void {
	if (!existsSync(cwd)) {
		console.error(`  \x1b[31mError: path does not exist: ${cwd}\x1b[0m`);
		process.exit(1);
	}
	try {
		if (!statSync(cwd).isDirectory()) {
			console.error(`  \x1b[31mError: not a directory: ${cwd}\x1b[0m`);
			process.exit(1);
		}
	} catch {
		console.error(`  \x1b[31mError: cannot access: ${cwd}\x1b[0m`);
		process.exit(1);
	}
}

/** Map common issue rules to actionable fix suggestions. */
export function suggestFix(check: string, rule: string, message: string): string | null {
	if (rule === "empty-catch") return "Add error logging: catch(e) { console.error(e); }";
	if (rule === "throw-string") return 'Replace throw "msg" with throw new Error("msg")';
	if (rule === "swallowed-promise") return "Add logging: .catch((e) => { console.error(e); })";
	if (rule === "floating-promise") return "Add await or .catch() to handle the promise";
	if (rule === "unsafe-json-parse") return "Wrap in try-catch: try { JSON.parse(x) } catch { /* handle */ }";
	if (rule === "no-error-boundary") return "Add <ErrorBoundary> wrapper in your React app root";
	if (rule === "img-alt") return 'Add alt attribute: <img alt="description" ...>';
	if (rule === "click-events") return 'Add role="button" and onKeyDown handler';
	if (rule === "vue-v-for-key") return 'Add :key="item.id" to the v-for element';
	if (rule === "missing-key") return "Add key={item.id} to the JSX element in .map()";
	if (rule === "index-key") return "Use a stable unique ID instead of array index for key";
	if (rule === "conditional-hook") return "Move the hook call before any conditional (if/switch)";
	if (rule === "no-tests") return "Create a test file: src/__tests__/example.test.ts";
	if (rule === "no-readme") return "Create README.md with: project description, install, usage";
	if (rule === "no-changelog") return "Create CHANGELOG.md or use changesets: npx changeset init";
	if (rule === "env-not-ignored") return "Add .env to .gitignore";
	if (rule === "secret-detected") return "Move to environment variable, rotate the exposed secret";
	if (rule === "no-ci") return "Run: npx @vibecodeqa/cli init";
	if (rule === "missing-lockfile") return "Run: pnpm install (or npm install) to generate lockfile";
	if (rule === "missing-file" && message.includes("LICENSE")) return "Add LICENSE file: https://choosealicense.com/";
	if (rule === "long-function") return "Extract logic into smaller helper functions";
	if (rule === "high-complexity") return "Reduce nesting: use early returns, extract conditions";
	if (rule === "duplicate-code") return "Extract shared logic into a helper function";
	if (rule === "circular-dep") return "Extract shared types to a separate file both modules import";
	if (rule === "god-module") return "Split into focused interfaces — one responsibility per module";
	if (rule === "process-exit") return "Replace process.exit() with throw new Error()";
	if (check === "security" && message.includes("innerHTML")) return "Use textContent or DOM APIs instead";
	if (check === "security" && message.includes("ev" + "al")) return `Remove ${"ev" + "al"}() — use a safer alternative`;
	if (check === "security" && message.includes("v-html")) return 'Sanitize with DOMPurify: v-html="DOMPurify.sanitize(input)"';
	return null;
}
