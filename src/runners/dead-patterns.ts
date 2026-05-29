/** Dead Patterns — detects leftover code from incomplete refactors.
 *
 * Pro feature. Requires VCQA_PRO_KEY env var.
 *
 * Produces a Feature Map: clusters of files grouped by directory, each labeled
 * with a feature name by the LLM. Dead pattern findings are attached per-cluster.
 *
 * Local checks (always run with Pro key):
 *   - Legacy/deprecated naming suggesting parallel implementations
 *   - Hardcoded feature flags with dead branches
 *   - Try-catch fallbacks to old implementations
 *
 * LLM-powered analysis (via api.vibecodeqa.online):
 *   - Feature labeling per cluster
 *   - Fallback code paths that never fire
 *   - Parallel implementations (old + new coexisting)
 *   - Dead defensive guards for impossible states
 *   - Orphaned abstractions from removed implementations
 *   - Redundant wrappers left from refactors
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { getProductionFiles } from "../fs-utils.js";
import type { CheckResult, Issue } from "../types.js";
import { gradeFromScore } from "../types.js";

export interface FeatureCluster {
	dir: string;
	label: string;
	description: string;
	files: string[];
	fileCount: number;
	findings: Issue[];
}

interface ClusterCacheEntry {
	hash: string;
	label: string;
	description: string;
	findings: Issue[];
}

interface ClusterCache {
	version: number;
	clusters: Record<string, ClusterCacheEntry>;
}

interface ClusterAnalysis {
	label: string;
	description: string;
	findings: Issue[];
}

interface Cluster {
	dir: string;
	files: { path: string; content: string }[];
	hash: string;
}

export async function runDeadPatterns(cwd: string): Promise<CheckResult> {
	const start = Date.now();
	const proKey = process.env.VCQA_PRO_KEY || "";

	if (!proKey) {
		return {
			name: "dead-patterns",
			score: 0,
			grade: "F",
			details: {
				premium: true,
				comingSoon: true,
				reason: "Set VCQA_PRO_KEY to enable dead pattern detection",
				description:
					"Detects leftover code from incomplete refactors: fallback paths, parallel implementations, dead guards, hardcoded feature flags. Produces a Feature Map of your codebase.",
			},
			issues: [],
			duration: Date.now() - start,
		};
	}

	const files = getProductionFiles(cwd);
	const issues: Issue[] = [];

	// ── Local heuristic checks ──

	for (const f of files) {
		const lines = f.content.split("\n");

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];

			// Legacy/deprecated naming patterns
			const legacyMatch = line.match(
				/(?:export\s+)?(?:const|let|var|function|class|interface|type)\s+(\w*(?:Legacy|_legacy|Old|_old|Deprecated|_deprecated|_backup|_fallback|_original|_prev|Former|Previous|V1|_v1)\w*)\b/,
			);
			if (legacyMatch) {
				issues.push({
					severity: "info",
					message: `"${legacyMatch[1]}" — name suggests a leftover from a previous implementation`,
					file: f.path,
					line: i + 1,
					rule: "legacy-naming",
				});
			}

			// Hardcoded feature flags
			const flagMatch = line.match(
				/(?:const|let|var)\s+(USE_\w+|ENABLE_\w+|FEATURE_\w+|FLAG_\w+|WITH_\w+)\s*[=:]\s*(true|false)\b/,
			);
			if (flagMatch) {
				const flagName = flagMatch[1];
				const usedInCondition = f.content.includes(`if (${flagName}`) || f.content.includes(`if (!${flagName}`);
				if (usedInCondition) {
					issues.push({
						severity: "warning",
						message: `Hardcoded flag "${flagName} = ${flagMatch[2]}" — one branch is permanently dead, remove it`,
						file: f.path,
						line: i + 1,
						rule: "hardcoded-flag",
					});
				}
			}

			// Try-catch with substantial fallback logic (not just logging)
			if (/\bcatch\s*\(/.test(line) || /\bcatch\s*\{/.test(line)) {
				let braceDepth = 0;
				let catchBodyLines = 0;
				let hasFunctionCall = false;
				let started = false;
				for (let j = i; j < Math.min(i + 20, lines.length); j++) {
					const l = lines[j];
					braceDepth += (l.match(/\{/g) || []).length;
					braceDepth -= (l.match(/\}/g) || []).length;
					if (braceDepth > 0) started = true;
					if (started && j > i) {
						catchBodyLines++;
						if (/\w+\s*\(/.test(l) && !/console\.|\.log\(|\.error\(|\.warn\(|throw\s/.test(l)) {
							hasFunctionCall = true;
						}
					}
					if (started && braceDepth <= 0) break;
				}
				if (catchBodyLines >= 4 && hasFunctionCall) {
					issues.push({
						severity: "info",
						message: "Catch block with fallback logic — may be a leftover from a migration",
						file: f.path,
						line: i + 1,
						rule: "fallback-catch",
					});
				}
			}
		}
	}

	// ── Build clusters and feature map ──

	const allClusters = buildClusters(files, false);
	const analyzableClusters = allClusters.filter((c) => c.files.length >= 2);
	const cache = loadCache(cwd);
	const featureMap: FeatureCluster[] = [];
	let cacheHits = 0;

	// LLM-analyze largest multi-file clusters (limit to 10 for cost)
	const toAnalyze = analyzableClusters.sort((a, b) => b.files.length - a.files.length).slice(0, 10);

	for (const cluster of toAnalyze) {
		const cached = cache.clusters[cluster.dir];
		if (cached && cached.hash === cluster.hash) {
			issues.push(...cached.findings);
			featureMap.push({
				dir: cluster.dir,
				label: cached.label,
				description: cached.description,
				files: cluster.files.map((f) => f.path),
				fileCount: cluster.files.length,
				findings: cached.findings,
			});
			cacheHits++;
			continue;
		}

		const analysis = await analyzeCluster(cluster, proKey);
		if (analysis) {
			issues.push(...analysis.findings);
			cache.clusters[cluster.dir] = {
				hash: cluster.hash,
				label: analysis.label,
				description: analysis.description,
				findings: analysis.findings,
			};
			featureMap.push({
				dir: cluster.dir,
				label: analysis.label,
				description: analysis.description,
				files: cluster.files.map((f) => f.path),
				fileCount: cluster.files.length,
				findings: analysis.findings,
			});
		} else {
			// API failed — use dirname as label
			featureMap.push({
				dir: cluster.dir,
				label: labelFromDir(cluster.dir),
				description: "",
				files: cluster.files.map((f) => f.path),
				fileCount: cluster.files.length,
				findings: [],
			});
		}
	}

	// Add remaining clusters (not LLM-analyzed) to the feature map
	const analyzedDirs = new Set(toAnalyze.map((c) => c.dir));
	for (const cluster of allClusters) {
		if (analyzedDirs.has(cluster.dir)) continue;
		featureMap.push({
			dir: cluster.dir,
			label: labelFromDir(cluster.dir),
			description: "",
			files: cluster.files.map((f) => f.path),
			fileCount: cluster.files.length,
			findings: [],
		});
	}

	// Attach local heuristic findings to their feature clusters
	for (const iss of issues) {
		if (!iss.file) continue;
		const dir = dirname(iss.file) || ".";
		const cluster = featureMap.find((c) => c.dir === dir);
		if (cluster && !cluster.findings.includes(iss)) {
			cluster.findings.push(iss);
		}
	}

	saveCache(cwd, cache);

	// Sort feature map: clusters with findings first, then by file count
	featureMap.sort((a, b) => {
		if (a.findings.length > 0 && b.findings.length === 0) return -1;
		if (a.findings.length === 0 && b.findings.length > 0) return 1;
		return b.fileCount - a.fileCount;
	});

	const warningCount = issues.filter((i) => i.severity === "warning").length;
	const score = issues.length === 0 ? 100 : Math.max(15, 100 - warningCount * 10 - (issues.length - warningCount) * 3);

	return {
		name: "dead-patterns",
		score,
		grade: gradeFromScore(score),
		details: {
			premium: true,
			featureMap,
			clustersAnalyzed: toAnalyze.length,
			totalClusters: allClusters.length,
			cacheHits,
			localFindings: issues.length,
			tool: "pro-local+llm",
		},
		issues,
		duration: Date.now() - start,
	};
}

function labelFromDir(dir: string): string {
	const name = basename(dir) || dir;
	return name
		.replace(/[-_]/g, " ")
		.replace(/\b\w/g, (c) => c.toUpperCase())
		.replace(/^Src$/, "Source Root");
}

function buildClusters(files: { path: string; content: string }[], requireMultiple: boolean): Cluster[] {
	const dirMap = new Map<string, { path: string; content: string }[]>();

	for (const f of files) {
		const dir = dirname(f.path) || ".";
		const arr = dirMap.get(dir) || [];
		arr.push({ path: f.path, content: f.content });
		dirMap.set(dir, arr);
	}

	const clusters: Cluster[] = [];
	for (const [dir, dirFiles] of dirMap) {
		if (requireMultiple && dirFiles.length < 2) continue;
		const hash = computeClusterHash(dirFiles);
		clusters.push({ dir, files: dirFiles, hash });
	}

	return clusters;
}

function computeClusterHash(files: { path: string; content: string }[]): string {
	const h = createHash("sha256");
	for (const f of files.sort((a, b) => a.path.localeCompare(b.path))) {
		h.update(f.path);
		h.update(f.content);
	}
	return h.digest("hex").slice(0, 16);
}

async function analyzeCluster(cluster: Cluster, proKey: string): Promise<ClusterAnalysis | null> {
	const MAX_CHARS = 30_000;
	let totalChars = 0;
	const filePayloads: { path: string; content: string }[] = [];

	for (const f of cluster.files) {
		const truncated = f.content.slice(0, 3000);
		if (totalChars + truncated.length > MAX_CHARS) break;
		totalChars += truncated.length;
		filePayloads.push({ path: f.path, content: truncated });
	}

	try {
		const res = await fetch("https://api.vibecodeqa.online/api/pro/dead-patterns", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${proKey}`,
			},
			body: JSON.stringify({ cluster: cluster.dir, files: filePayloads }),
		});

		if (!res.ok) return null;

		const data = (await res.json()) as { label?: string; description?: string; findings?: Issue[] };
		return {
			label: data.label || labelFromDir(cluster.dir),
			description: data.description || "",
			findings: data.findings || [],
		};
	} catch {
		return null;
	}
}

function loadCache(cwd: string): ClusterCache {
	try {
		const cachePath = join(cwd, ".vibe-check", "dead-patterns-cache.json");
		if (existsSync(cachePath)) {
			const data = JSON.parse(readFileSync(cachePath, "utf-8"));
			if (data.version === 1) return data;
		}
	} catch {
		/* corrupt cache */
	}
	return { version: 1, clusters: {} };
}

function saveCache(cwd: string, cache: ClusterCache): void {
	try {
		const dir = join(cwd, ".vibe-check");
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "dead-patterns-cache.json"), JSON.stringify(cache));
	} catch {
		/* can't write cache */
	}
}
