import { createHash } from "node:crypto";
import type { Issue } from "./types.js";

export type FingerprintedIssue = Issue & { fingerprint?: string };

export interface IssueSnapshot {
	fingerprint: string;
	check: string;
	rule?: string;
	severity: Issue["severity"];
	file?: string;
	line?: number;
	message: string;
}

export function fingerprintIssue(checkName: string, issue: Issue): string {
	const parts = [checkName, issue.rule ?? "", normalizePath(issue.file), normalizeMessage(issue.message)];
	return createHash("sha1").update(parts.join("\0")).digest("hex").slice(0, 16);
}

export function withIssueFingerprints(checkName: string, issues: Issue[]): FingerprintedIssue[] {
	return issues.map((issue) => ({ ...issue, fingerprint: readIssueFingerprint(checkName, issue) }));
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

export function readIssueFingerprint(checkName: string, issue: Issue): string {
	const fp = (issue as FingerprintedIssue).fingerprint;
	return typeof fp === "string" && fp.length > 0 ? fp : fingerprintIssue(checkName, issue);
}

function normalizePath(path: string | undefined): string {
	return (path ?? "").replace(/\\/g, "/").replace(/^\.\//, "").trim();
}

function normalizeMessage(message: string): string {
	return message.replace(/\s+/g, " ").trim().toLowerCase();
}
