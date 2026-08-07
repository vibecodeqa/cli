/** File Cohesion — detects files with multiple responsibilities.
 *
 * Pro feature. Requires VCQA_PRO_KEY env var.
 *
 * Two-phase analysis:
 *   1. Local heuristics (always run with Pro key):
 *      - Files with exports spanning multiple domains (auth + email + db)
 *      - Mixed concern signals: HTTP handlers + business logic + data access
 *      - High export count relative to file purpose
 *
 *   2. LLM-powered analysis (via api.vibecodeqa.online):
 *      - Labels each file's responsibility clusters
 *      - Suggests concrete split points
 *      - "This file handles auth, session, AND email — split into 3 modules"
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FileInventory } from "../file-inventory.js";
import { inventorySourceFiles } from "../file-inventory.js";
import { getProductionFiles } from "../fs-utils.js";
import type { CheckResult, Issue } from "../types.js";
import { gradeFromScore } from "../types.js";

interface CohesionCache {
	version: number;
	files: Record<string, { hash: string; concerns: string[]; suggestion: string }>;
}

const CONCERN_PATTERNS: { name: string; patterns: RegExp[] }[] = [
	{
		name: "HTTP/routing",
		patterns: [
			/\b(app|router|server)\.(get|post|put|delete|patch|use)\b/,
			/\bRequest\b.*\bResponse\b/,
			/\breq\s*,\s*res\b/,
			/\bfastify\b|\bhono\b|\bexpress\b/,
		],
	},
	{
		name: "database",
		patterns: [/\b(prisma|sequelize|typeorm|knex|drizzle)\b/, /\bSELECT\b.*\bFROM\b/i, /\.query\s*\(/, /\bcreateClient\b.*\bsupabase\b/i],
	},
	{
		name: "auth",
		patterns: [
			/\b(jwt|token|session|cookie|passport|oauth|login|signup|signIn|signUp)\b/i,
			/\bverify(Token|Session|Auth)\b/,
			/\bbcrypt|argon2|scrypt\b/,
		],
	},
	{ name: "email", patterns: [/\bsendMail|sendEmail|transporter|nodemailer|resend|postmark\b/i, /\bsmtp\b/i] },
	{
		name: "file I/O",
		patterns: [/\breadFileSync|writeFileSync|createReadStream|createWriteStream\b/, /\bfs\.(read|write|mkdir|unlink|stat)\b/],
	},
	{
		name: "validation",
		patterns: [
			/\bz\.(string|number|object|array)\b/,
			/\bJoi\.(string|number|object)\b/,
			/\byup\.(string|number|object)\b/,
			/\bvalidate\w*Schema\b/,
		],
	},
	{
		name: "UI rendering",
		patterns: [/\bJSX\b|\breturn\s*\(?\s*</, /\buseState|useEffect|useRef|useMemo\b/, /\brender\(\)/, /\bcomponent\b/i],
	},
	{
		name: "state management",
		patterns: [/\bcreateStore|useStore|createSlice|createReducer\b/, /\bdispatch\(|getState\(\)/, /\buseSelector|useDispatch\b/],
	},
	{
		name: "testing",
		patterns: [/\bdescribe\s*\(|it\s*\(|test\s*\(|expect\s*\(/, /\bbeforeEach|afterEach|beforeAll\b/, /\bjest\.|vitest\./],
	},
	{ name: "CLI", patterns: [/\bprocess\.argv\b/, /\bcommander|yargs|meow|cac\b/, /\bparse(Args|Options)\b/] },
];

export async function runFileCohesion(cwd: string, inventory?: FileInventory): Promise<CheckResult> {
	const start = Date.now();
	const proKey = process.env.VCQA_PRO_KEY || "";

	if (!proKey) {
		return {
			name: "file-cohesion",
			score: 0,
			grade: "F",
			details: {
				premium: true,
				comingSoon: true,
				reason: "Set VCQA_PRO_KEY to enable file cohesion analysis",
				description:
					"Detects files with multiple responsibilities — the #1 code smell in AI-generated code. Labels each file's concern clusters and suggests concrete split points.",
			},
			issues: [],
			duration: Date.now() - start,
		};
	}

	const files = inventory ? inventorySourceFiles(inventory) : getProductionFiles(cwd);
	const issues: Issue[] = [];
	const cache = loadCache(cwd);
	let cacheHits = 0;

	// Phase 1: local heuristics — detect multi-concern files
	const candidates: { path: string; content: string; concerns: string[]; lines: number }[] = [];

	for (const f of files) {
		if (f.isTest) continue;
		const lines = f.content.split("\n").length;
		if (lines < 100) continue; // small files rarely have cohesion problems

		const detectedConcerns: string[] = [];
		for (const concern of CONCERN_PATTERNS) {
			if (concern.patterns.some((p) => p.test(f.content))) {
				detectedConcerns.push(concern.name);
			}
		}

		if (detectedConcerns.length >= 2) {
			candidates.push({ path: f.path, content: f.content, concerns: detectedConcerns, lines });

			// Local issue for 2+ concerns
			issues.push({
				severity: detectedConcerns.length >= 3 ? "error" : "warning",
				message: `${detectedConcerns.length} concerns detected: ${detectedConcerns.join(", ")} — consider splitting`,
				file: f.path,
				rule: "multi-concern",
			});
		}
	}

	// Phase 2: LLM analysis for top candidates (by line count, most likely to benefit from splitting)
	const topCandidates = candidates.sort((a, b) => b.lines - a.lines).slice(0, 5);

	for (const candidate of topCandidates) {
		const hash = createHash("sha256").update(candidate.content).digest("hex").slice(0, 16);

		// Check cache
		const cached = cache.files[candidate.path];
		if (cached && cached.hash === hash) {
			cacheHits++;
			if (cached.suggestion) {
				issues.push({
					severity: "warning",
					message: cached.suggestion,
					file: candidate.path,
					rule: "split-suggestion",
				});
			}
			continue;
		}

		// Call LLM for concrete split suggestions
		const analysis = await analyzeCohesion(candidate.path, candidate.content, proKey);
		if (analysis) {
			cache.files[candidate.path] = { hash, concerns: analysis.concerns, suggestion: analysis.suggestion };
			if (analysis.suggestion) {
				issues.push({
					severity: "warning",
					message: analysis.suggestion,
					file: candidate.path,
					rule: "split-suggestion",
				});
			}
		}
	}

	saveCache(cwd, cache);

	const totalFiles = files.filter((f) => !f.isTest).length;
	const multiConcernFiles = candidates.length;
	const ratio = totalFiles > 0 ? multiConcernFiles / totalFiles : 0;
	const score = Math.round(Math.max(0, 100 - ratio * 300));

	return {
		name: "file-cohesion",
		score,
		grade: gradeFromScore(score),
		details: {
			premium: true,
			totalFiles,
			multiConcernFiles,
			cacheHits,
			source: inventory ? "file-inventory" : "legacy-walk",
			candidates: candidates.map((c) => ({ path: c.path, concerns: c.concerns, lines: c.lines })),
		},
		issues,
		duration: Date.now() - start,
	};
}

async function analyzeCohesion(
	filePath: string,
	content: string,
	proKey: string,
): Promise<{ concerns: string[]; suggestion: string } | null> {
	const truncated = content.slice(0, 4000);

	try {
		const res = await fetch("https://api.vibecodeqa.online/api/pro/file-cohesion", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${proKey}`,
			},
			body: JSON.stringify({ file: filePath, content: truncated }),
		});

		if (!res.ok) return null;

		const data = (await res.json()) as { concerns?: string[]; suggestion?: string };
		return {
			concerns: data.concerns || [],
			suggestion: data.suggestion || "",
		};
	} catch {
		return null;
	}
}

function loadCache(cwd: string): CohesionCache {
	try {
		const cachePath = join(cwd, ".vibe-check", "file-cohesion-cache.json");
		if (existsSync(cachePath)) {
			const data = JSON.parse(readFileSync(cachePath, "utf-8"));
			if (data.version === 1) return data;
		}
	} catch {
		/* corrupt cache */
	}
	return { version: 1, files: {} };
}

function saveCache(cwd: string, cache: CohesionCache): void {
	try {
		const dir = join(cwd, ".vibe-check");
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "file-cohesion-cache.json"), JSON.stringify(cache));
	} catch {
		/* write failed */
	}
}
