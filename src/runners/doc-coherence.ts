/** Doc Coherence — detects contradictions between documentation and code.
 *
 * Premium feature (powered by LLM). Scans README, CLAUDE.md, JSDoc, and inline
 * comments for claims that contradict the actual code:
 *   - README says "supports X" but feature X was removed
 *   - JSDoc says "@param required" but param has a default
 *   - Comment says "never throws" but function has throw statements
 *   - CHANGELOG references files that no longer exist
 *   - API docs describe endpoints/functions that were renamed or deleted
 *
 * Currently returns a "coming soon" placeholder.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { getProductionFiles } from "../fs-utils.js";
import type { CheckResult } from "../types.js";

export function runDocCoherence(cwd: string): CheckResult {
	const start = Date.now();

	// Detect if docs exist (useful info even in placeholder mode)
	const docFiles: string[] = [];
	const candidates = ["README.md", "CLAUDE.md", "ARCHITECTURE.md", "CONTRIBUTING.md", "CHANGELOG.md", "API.md", "docs/README.md"];
	for (const f of candidates) {
		if (existsSync(join(cwd, f))) docFiles.push(f);
	}

	let hasJSDoc = false;
	try {
		const files = getProductionFiles(cwd);
		hasJSDoc = files.some((f) => /\/\*\*/.test(f.content));
	} catch {
		// no source files
	}

	return {
		name: "doc-coherence",
		score: 0,
		grade: "F",
		details: {
			premium: true,
			comingSoon: true,
			reason: "LLM-powered analysis — coming soon",
			docFiles,
			hasJSDoc,
			description:
				"Detects contradictions between documentation and code. Finds stale README claims, incorrect JSDoc, outdated API docs, and misleading comments.",
		},
		issues: [],
		duration: Date.now() - start,
	};
}
