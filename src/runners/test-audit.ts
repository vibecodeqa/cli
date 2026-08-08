/** Test Audit — detects fake, shallow, and misleading tests.
 *
 * Pro feature. Requires VCQA_PRO_KEY env var.
 *
 * Local checks (always run with Pro key):
 *   - Empty test bodies (it/test blocks with no assertions)
 *   - Trivial assertions (expect(true).toBe(true), expect(1).toBe(1))
 *   - Weak-only tests (only .toBeDefined, .toBeTruthy, .not.toBeNull)
 *   - Tautological assertions (expect(x).toBe(x) with same literal)
 *   - it.skip / it.todo / xit / xdescribe counting
 *   - Console-only tests (log output without assertions)
 *   - Mock-heavy tests (more mocks than assertions)
 *
 * LLM-powered analysis (via api.vibecodeqa.online):
 *   - Tests whose assertions don't match their description
 *   - Tests that test implementation details not behavior
 *   - Copy-pasted test structures
 *   - Tests that mock the thing being tested
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type FileInventory, inventoryTestFiles } from "../file-inventory.js";
import { getTestFiles } from "../fs-utils.js";
import type { CheckResult, Issue } from "../types.js";
import { gradeFromScore } from "../types.js";

interface CacheEntry {
	hash: string;
	findings: Issue[];
}

interface AuditCache {
	version: number;
	files: Record<string, CacheEntry>;
}

export async function runTestAudit(cwd: string, inventory?: FileInventory): Promise<CheckResult> {
	const start = Date.now();
	const proKey = process.env.VCQA_PRO_KEY || "";

	if (!proKey) {
		return {
			name: "test-audit",
			score: 0,
			grade: "F",
			details: {
				premium: true,
				comingSoon: true,
				reason: "Set VCQA_PRO_KEY to enable test audit",
				description:
					"Detects fake and shallow tests: empty test bodies, trivial assertions, tautologies, mock-heavy tests, and tests whose names don't match what they actually verify.",
			},
			issues: [],
			duration: Date.now() - start,
		};
	}

	const testFiles = inventory ? inventoryTestFiles(inventory) : getTestFiles(cwd);
	if (testFiles.length === 0) {
		return {
			name: "test-audit",
			score: 100,
			grade: "A",
			details: { premium: true, reason: "No test files found", tool: "pro-local" },
			issues: [],
			duration: Date.now() - start,
		};
	}

	const issues: Issue[] = [];
	let totalTests = 0;
	let emptyTests = 0;
	let trivialTests = 0;
	let weakTests = 0;
	let skippedTests = 0;
	let mockHeavyTests = 0;

	// ── Local heuristic checks ──

	for (const f of testFiles) {
		const lines = f.content.split("\n");

		// Extract test blocks: it(...) / test(...)
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i].trim();

			// Count skipped/todo tests
			if (/^\s*(it|test)\.skip\s*\(/.test(lines[i]) || /^\s*xit\s*\(/.test(lines[i])) {
				skippedTests++;
				issues.push({
					severity: "info",
					message: "Skipped test — remove or fix",
					file: f.path,
					line: i + 1,
					rule: "skipped-test",
				});
				continue;
			}
			if (/^\s*(it|test)\.todo\s*\(/.test(lines[i])) {
				skippedTests++;
				issues.push({
					severity: "info",
					message: "TODO test — placeholder without implementation",
					file: f.path,
					line: i + 1,
					rule: "todo-test",
				});
				continue;
			}
			if (/^\s*xdescribe\s*\(/.test(lines[i])) {
				issues.push({
					severity: "info",
					message: "Disabled describe block",
					file: f.path,
					line: i + 1,
					rule: "disabled-suite",
				});
				continue;
			}

			// Detect it/test blocks
			const testMatch = line.match(/^(?:it|test)\s*\(/);
			if (!testMatch) continue;
			totalTests++;

			// Collect the test body (up to 30 lines or closing brace)
			let braceDepth = 0;
			let bodyStart = -1;
			const bodyLines: string[] = [];
			for (let j = i; j < Math.min(i + 40, lines.length); j++) {
				const l = lines[j];
				braceDepth += (l.match(/\{/g) || []).length;
				braceDepth -= (l.match(/\}/g) || []).length;
				if (bodyStart === -1 && l.includes("{")) bodyStart = j;
				if (bodyStart >= 0 && j > bodyStart) bodyLines.push(l);
				if (bodyStart >= 0 && braceDepth <= 0) break;
			}

			const body = bodyLines.join("\n");
			const bodyTrimmed = body.replace(/\s+/g, " ").trim();

			// 1. Empty test body — only closing braces/parens, no real code
			const bodyCode = bodyTrimmed.replace(/[});\s]/g, "");
			if (bodyCode.length === 0) {
				emptyTests++;
				issues.push({
					severity: "warning",
					message: "Empty test body — no assertions, no logic",
					file: f.path,
					line: i + 1,
					rule: "empty-test",
				});
				continue;
			}

			// Count assertions and mocks in body
			const assertCount =
				(body.match(/\bexpect\s*\(/g) || []).length + (body.match(/\bassert[.(]/g) || []).length + (body.match(/\bshould\./g) || []).length;
			const mockCount = (
				body.match(
					/\b(vi\.fn|jest\.fn|vi\.mock|jest\.mock|vi\.spyOn|jest\.spyOn|sinon\.(stub|spy|mock)|\.mockResolvedValue|\.mockReturnValue|\.mockImplementation)\b/g,
				) || []
			).length;

			// 2. No assertions
			if (assertCount === 0) {
				emptyTests++;
				issues.push({
					severity: "warning",
					message: "Test has no assertions — it always passes",
					file: f.path,
					line: i + 1,
					rule: "no-assertions",
				});
				continue;
			}

			// 3. Trivial assertions
			const trivialPatterns = [
				/expect\s*\(\s*true\s*\)\s*\.toBe\s*\(\s*true\s*\)/,
				/expect\s*\(\s*false\s*\)\s*\.toBe\s*\(\s*false\s*\)/,
				/expect\s*\(\s*1\s*\)\s*\.toBe\s*\(\s*1\s*\)/,
				/expect\s*\(\s*"[^"]*"\s*\)\s*\.toBe\s*\(\s*"[^"]*"\s*\)/, // string literal == string literal
				/expect\s*\(\s*null\s*\)\s*\.toBeNull\s*\(\s*\)/,
				/expect\s*\(\s*undefined\s*\)\s*\.toBeUndefined\s*\(\s*\)/,
			];
			const trivialCount = trivialPatterns.reduce((s, p) => s + (body.match(p) ? 1 : 0), 0);
			if (trivialCount > 0 && trivialCount >= assertCount) {
				trivialTests++;
				issues.push({
					severity: "warning",
					message: `All ${assertCount} assertion(s) are trivial — testing constants, not behavior`,
					file: f.path,
					line: i + 1,
					rule: "trivial-assertions",
				});
				continue;
			}

			// 4. Weak-only assertions (only .toBeDefined, .toBeTruthy, .not.toBeNull)
			const weakPatterns = /\.(toBeDefined|toBeTruthy|not\.toBeNull|not\.toBeUndefined|toBeInstanceOf)\s*\(/g;
			const weakCount = (body.match(weakPatterns) || []).length;
			if (weakCount > 0 && weakCount >= assertCount) {
				weakTests++;
				issues.push({
					severity: "info",
					message: `All ${assertCount} assertion(s) are weak — only checks existence, not correctness`,
					file: f.path,
					line: i + 1,
					rule: "weak-assertions",
				});
			}

			// 5. Console-only test (has console.log but no assertions beyond weak)
			const hasConsole = /console\.(log|info|debug|dir)\(/.test(body);
			if (hasConsole && assertCount === 0) {
				issues.push({
					severity: "warning",
					message: "Test only logs output — no assertions to verify behavior",
					file: f.path,
					line: i + 1,
					rule: "console-only-test",
				});
			}

			// 6. Mock-heavy: more mocks than assertions
			if (mockCount > 0 && mockCount > assertCount * 2) {
				mockHeavyTests++;
				issues.push({
					severity: "info",
					message: `Mock-heavy: ${mockCount} mocks vs ${assertCount} assertions — may be testing mocks, not code`,
					file: f.path,
					line: i + 1,
					rule: "mock-heavy",
				});
			}
		}
	}

	// ── LLM-powered analysis ──

	const cache = loadCache(cwd);
	const llmFindings: Issue[] = [];

	// Send test files to LLM for deeper analysis (batch by file, limit to 8 largest)
	const sortedFiles = testFiles
		.filter((f) => f.content.split("\n").length > 10) // skip tiny files
		.sort((a, b) => b.content.length - a.content.length)
		.slice(0, 8);

	for (const f of sortedFiles) {
		const hash = createHash("sha256").update(f.content).digest("hex").slice(0, 16);
		const cached = cache.files[f.path];
		if (cached && cached.hash === hash) {
			llmFindings.push(...cached.findings);
			continue;
		}

		const findings = await analyzeTestFile(f.path, f.content, proKey);
		if (findings) {
			llmFindings.push(...findings);
			cache.files[f.path] = { hash, findings };
		}
	}

	saveCache(cwd, cache);
	issues.push(...llmFindings);

	const warningCount = issues.filter((i) => i.severity === "warning").length;
	const score = totalTests === 0 ? 100 : Math.max(10, 100 - warningCount * 12 - (issues.length - warningCount) * 3);

	return {
		name: "test-audit",
		score,
		grade: gradeFromScore(score),
		details: {
			premium: true,
			testFiles: testFiles.length,
			totalTests,
			emptyTests,
			trivialTests,
			weakTests,
			skippedTests,
			mockHeavyTests,
			llmFindings: llmFindings.length,
			tool: "pro-local+llm",
		},
		issues,
		duration: Date.now() - start,
	};
}

async function analyzeTestFile(path: string, content: string, proKey: string): Promise<Issue[] | null> {
	const truncated = content.slice(0, 5000);
	try {
		const res = await fetch("https://api.vibecodeqa.online/api/pro/test-audit", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${proKey}`,
			},
			body: JSON.stringify({ file: path, content: truncated }),
		});
		if (!res.ok) return null;
		const data = (await res.json()) as { findings?: Issue[] };
		return data.findings || [];
	} catch {
		return null;
	}
}

function loadCache(cwd: string): AuditCache {
	try {
		const p = join(cwd, ".vibe-check", "test-audit-cache.json");
		if (existsSync(p)) {
			const data = JSON.parse(readFileSync(p, "utf-8"));
			if (data.version === 1) return data;
		}
	} catch {
		/* corrupt */
	}
	return { version: 1, files: {} };
}

function saveCache(cwd: string, cache: AuditCache): void {
	try {
		const dir = join(cwd, ".vibe-check");
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "test-audit-cache.json"), JSON.stringify(cache));
	} catch {
		/* can't write */
	}
}
