import { createHash } from "node:crypto";
import { type FileInventory, readInventoryText } from "./file-inventory.js";
import type { Issue } from "./types.js";

/**
 * Fingerprint scheme written into `meta.fingerprintVersion` (#97).
 *
 * - v1 (reports without the field): check + rule + normalised path + lower-cased
 *   message. A measurement in the message ("65 lines (max 60)") re-identified the
 *   finding whenever the number moved, and repeated findings collided.
 * - v2: per-runner `subject` replaces path + message where a runner declares one;
 *   other line-anchored findings add a hash of the source line they point at, and
 *   only findings that are still identical get an occurrence ordinal.
 */
export const FINGERPRINT_VERSION = 2;

/**
 * Issue fields declared by @vibecodeqa/schema 0.6.0 (`fingerprint`, `subject`)
 * that the pinned 0.5.0 does not declare yet. They survive validation through
 * `.passthrough()`; when the dependency moves to 0.6.0 this becomes `Issue`.
 */
export type FingerprintedIssue = Issue & {
	fingerprint?: string;
	/**
	 * What the finding is about, as the runner identifies it — e.g. a file for a
	 * file-scoped measured rule, a file + function for complexity. When set, it
	 * replaces path + message in the v2 key, so a changed measurement keeps the
	 * fingerprint. Self-contained: include the path when the path is part of it.
	 */
	subject?: string;
};

export interface IssueSnapshot {
	fingerprint: string;
	check: string;
	rule?: string;
	severity: Issue["severity"];
	file?: string;
	line?: number;
	message: string;
}

/** Reads one 1-based line of a file's raw text, or undefined when unavailable. */
export type SourceLineReader = (file: string, line: number) => string | undefined;

/**
 * Line reader over the scan's FileInventory. Reads the raw file (not the
 * SFC-extracted script), so a reported line number means the same line a
 * reader sees. Files are read at most once per scan.
 */
export function inventoryLineReader(inventory: FileInventory): SourceLineReader {
	const byPath = new Map([...inventory.files, ...inventory.ignoredFiles].map((f) => [normalizePath(f.path), f]));
	const cache = new Map<string, string[] | null>();
	return (file, line) => {
		let lines = cache.get(file);
		if (lines === undefined) {
			const entry = byPath.get(file);
			const text = entry ? readInventoryText(entry) : "";
			lines = text ? text.split(/\r?\n/) : null;
			cache.set(file, lines);
		}
		return lines ? lines[line - 1] : undefined;
	};
}

/** v1 fingerprint: check + rule + path + message. Still what v1 reports hold. */
export function fingerprintIssue(checkName: string, issue: Issue): string {
	return hash([checkName, issue.rule ?? "", normalizePath(issue.file), normalizeMessage(issue.message)]);
}

/** Alias kept explicit for the v1/v2 boundary in trend.ts and delta.ts. */
export const fingerprintIssueV1 = fingerprintIssue;

/**
 * Attach v2 fingerprints to one check's issues. Context matters in v2 (the
 * source line, and which other findings are identical), so this works on the
 * whole list rather than per issue. An issue that already carries a
 * fingerprint keeps it.
 */
export function withIssueFingerprints(checkName: string, issues: Issue[], readLine?: SourceLineReader): FingerprintedIssue[] {
	const keys = issues.map((issue) => v2Key(checkName, issue as FingerprintedIssue, readLine));

	// Group still-identical keys; within a group, order by line (then emission)
	// and suffix every occurrence after the first with its ordinal. The first
	// keeps the un-suffixed fingerprint, so 1 → 2 occurrences leaves it intact.
	const groups = new Map<string, number[]>();
	keys.forEach((key, i) => {
		const id = key.join("\0");
		const g = groups.get(id);
		if (g) g.push(i);
		else groups.set(id, [i]);
	});
	const ordinals = new Array<number>(issues.length).fill(0);
	for (const idxs of groups.values()) {
		if (idxs.length < 2) continue;
		const sorted = [...idxs].sort((a, b) => (issues[a].line ?? 0) - (issues[b].line ?? 0) || a - b);
		sorted.forEach((idx, ord) => {
			ordinals[idx] = ord;
		});
	}

	return issues.map((issue, i) => {
		const existing = (issue as FingerprintedIssue).fingerprint;
		if (typeof existing === "string" && existing.length > 0) return { ...issue };
		const fingerprint = ordinals[i] === 0 ? hash(keys[i]) : hash([...keys[i], `#${ordinals[i]}`]);
		return { ...issue, fingerprint };
	});
}

export function issueSnapshot(checkName: string, issue: Issue): IssueSnapshot {
	return {
		fingerprint: readIssueFingerprint(checkName, issue),
		check: checkName,
		rule: issue.rule,
		severity: issue.severity,
		file: issue.file,
		line: issue.line,
		message: issue.message,
	};
}

/**
 * The stored fingerprint, else a v1 recomputation. Only valid for comparing two
 * reports of the same fingerprint version — across versions use
 * {@link comparableFingerprints}.
 */
export function readIssueFingerprint(checkName: string, issue: Issue): string {
	const fp = (issue as FingerprintedIssue).fingerprint;
	return typeof fp === "string" && fp.length > 0 ? fp : fingerprintIssue(checkName, issue);
}

/** A report's fingerprint version; reports written before v2 carry none (= 1). */
export function reportFingerprintVersion(report: { meta?: unknown }): number {
	const v = (report.meta as { fingerprintVersion?: unknown } | undefined)?.fingerprintVersion;
	return typeof v === "number" && Number.isFinite(v) ? v : 1;
}

/**
 * How to key issues when comparing two reports. Same version: the stored
 * fingerprints. Different versions: recompute v1 on both sides from
 * check/rule/file/message — preferring the stored value would compare a v1
 * hash with a v2 hash and report every finding as fixed + new.
 */
export function comparableFingerprints(a: { meta?: unknown }, b: { meta?: unknown }): (checkName: string, issue: Issue) => string {
	return reportFingerprintVersion(a) === reportFingerprintVersion(b) ? readIssueFingerprint : fingerprintIssueV1;
}

/** Short hash of a whitespace-normalised clone snippet (duplication subject). */
export function snippetDigest(snippet: string): string {
	return createHash("sha1").update(snippet.replace(/\s+/g, " ").trim()).digest("hex").slice(0, 12);
}

export function normalizePath(path: string | undefined): string {
	return (path ?? "").replace(/\\/g, "/").replace(/^\.\//, "").trim();
}

function v2Key(checkName: string, issue: FingerprintedIssue, readLine?: SourceLineReader): string[] {
	const rule = issue.rule ?? "";
	if (typeof issue.subject === "string" && issue.subject.length > 0) {
		return ["v2", checkName, rule, "subject", issue.subject];
	}
	const base = [checkName, rule, normalizePath(issue.file), normalizeMessage(issue.message)];
	const anchor = contentAnchor(issue, readLine);
	// No anchor and no repeat: identical to the v1 key.
	return anchor ? [...base, `@${anchor}`] : base;
}

function contentAnchor(issue: Issue, readLine?: SourceLineReader): string | undefined {
	if (!readLine || !issue.file || typeof issue.line !== "number" || issue.line < 1) return undefined;
	const text = readLine(normalizePath(issue.file), issue.line);
	if (text === undefined) return undefined;
	return createHash("sha1").update(text.replace(/\s+/g, " ").trim()).digest("hex").slice(0, 12);
}

function hash(parts: string[]): string {
	return createHash("sha1").update(parts.join("\0")).digest("hex").slice(0, 16);
}

function normalizeMessage(message: string): string {
	return message.replace(/\s+/g, " ").trim().toLowerCase();
}
