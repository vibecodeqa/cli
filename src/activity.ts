import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { collectSourceFiles } from "./fs-utils.js";
import type { CheckResult } from "./types.js";

export type ActivityStatus = "M" | "A" | "D" | "?" | "R" | "clean";

export interface FileActivity {
	file: string;
	status: ActivityStatus;
	lines: number;
	added: number;
	removed: number;
	recent: number;
	issues: {
		errors: number;
		warnings: number;
		infos: number;
		total: number;
	};
	heat: number;
}

function normalizePath(path: string): string {
	return path.replace(/\\/g, "/");
}

function parsePorcelainStatus(line: string): { status: ActivityStatus; file: string } | null {
	if (line.length < 4) return null;
	const raw = line.slice(0, 2);
	const status = raw.includes("R") ? "R" : raw.includes("A") ? "A" : raw.includes("D") ? "D" : line[0] === "?" ? "?" : "M";
	const filePart = line.slice(3).trim();
	const file = filePart.includes(" -> ") ? filePart.split(" -> ").pop()! : filePart;
	return { status, file: normalizePath(file) };
}

function gitStatus(cwd: string): Map<string, ActivityStatus> {
	const statuses = new Map<string, ActivityStatus>();
	try {
		const out = execSync("git status --porcelain", { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trimEnd();
		if (!out.trim()) return statuses;
		for (const line of out.split("\n")) {
			const parsed = parsePorcelainStatus(line);
			if (parsed) statuses.set(parsed.file, parsed.status);
		}
	} catch {
		/* not a git repo */
	}
	return statuses;
}

function gitNumstat(cwd: string): Map<string, { added: number; removed: number }> {
	const stats = new Map<string, { added: number; removed: number }>();
	try {
		const out = execSync("git diff --numstat HEAD --", { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
		if (!out) return stats;
		for (const line of out.split("\n")) {
			const [addedRaw, removedRaw, ...fileParts] = line.split(/\t+/);
			const filePart = fileParts.join("\t").trim();
			if (!filePart) continue;
			const file = normalizePath(filePart.includes(" => ") ? filePart.split(" => ").pop()! : filePart);
			const added = /^\d+$/.test(addedRaw) ? Number(addedRaw) : 0;
			const removed = /^\d+$/.test(removedRaw) ? Number(removedRaw) : 0;
			stats.set(file, { added, removed });
		}
	} catch {
		/* no HEAD yet, or not a git repo */
	}
	return stats;
}

function countLines(cwd: string, file: string): number {
	try {
		const path = join(cwd, file);
		if (!existsSync(path)) return 0;
		return readFileSync(path, "utf-8").split("\n").length;
	} catch {
		return 0;
	}
}

function issueCounts(checks: CheckResult[]): Map<string, FileActivity["issues"]> {
	const counts = new Map<string, FileActivity["issues"]>();
	for (const check of checks) {
		for (const issue of check.issues) {
			if (!issue.file || typeof issue.file !== "string") continue;
			const file = normalizePath(issue.file);
			const entry = counts.get(file) ?? { errors: 0, warnings: 0, infos: 0, total: 0 };
			if (issue.severity === "error") entry.errors++;
			else if (issue.severity === "warning") entry.warnings++;
			else entry.infos++;
			entry.total++;
			counts.set(file, entry);
		}
	}
	return counts;
}

function heatFor(file: Omit<FileActivity, "heat">): number {
	const churn = file.added + file.removed;
	const statusWeight =
		file.status === "A" || file.status === "?" ? 8 : file.status === "D" ? 6 : file.status === "M" || file.status === "R" ? 4 : 0;
	const issueWeight = file.issues.errors * 5 + file.issues.warnings * 2 + file.issues.infos;
	const sizeWeight = Math.min(8, Math.ceil(file.lines / 80));
	return churn + file.recent * 6 + statusWeight + issueWeight + sizeWeight;
}

export function collectFileActivity(
	cwd: string,
	checks: CheckResult[],
	recentChanges: Record<string, number> = {},
	srcRoots?: string[],
): FileActivity[] {
	const byFile = new Map<string, Omit<FileActivity, "heat">>();
	const issues = issueCounts(checks);
	const statuses = gitStatus(cwd);
	const diffs = gitNumstat(cwd);

	const ensure = (file: string): Omit<FileActivity, "heat"> => {
		const normalized = normalizePath(file);
		const existing = byFile.get(normalized);
		if (existing) return existing;
		const next: Omit<FileActivity, "heat"> = {
			file: normalized,
			status: statuses.get(normalized) ?? "clean",
			lines: 0,
			added: diffs.get(normalized)?.added ?? 0,
			removed: diffs.get(normalized)?.removed ?? 0,
			recent: recentChanges[normalized] ?? 0,
			issues: issues.get(normalized) ?? { errors: 0, warnings: 0, infos: 0, total: 0 },
		};
		byFile.set(normalized, next);
		return next;
	};

	for (const source of collectSourceFiles(cwd, { includeTests: true, extraExts: true, srcRoots })) {
		ensure(source.path).lines = source.lines;
	}
	for (const file of new Set([...issues.keys(), ...statuses.keys(), ...diffs.keys(), ...Object.keys(recentChanges)])) {
		const entry = ensure(file);
		if (entry.lines === 0) entry.lines = countLines(cwd, file);
	}

	return [...byFile.values()]
		.map((file) => ({ ...file, heat: heatFor(file) }))
		.sort((a, b) => b.heat - a.heat || b.issues.total - a.issues.total || a.file.localeCompare(b.file));
}
