/** End to end: a credential in a git-ignored local file must not reach any
 *  artifact a scan produces — report.json, history, HTML pages, SARIF,
 *  markdown, `--json` stdout, the upload body or the PR comment. Runs the built
 *  CLI (like cli.test.ts), once with gitleaks and once with it unavailable. */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCommentBody } from "./pr-comment.js";
import { fakeBody, fakeGithubPat, gitleaksInstalled, leakedWindows } from "./runners/fake-credentials.test-helper.js";
import type { VibeReport } from "./types.js";
import { buildReportUploadPayload } from "./upload.js";

const CLI = join(import.meta.dirname!, "..", "dist", "cli.js");

let project = "";
let stubDir = "";

afterEach(() => {
	for (const d of [project, stubDir]) if (d) rmSync(d, { recursive: true, force: true });
	project = "";
	stubDir = "";
});

function makeProject(): string[] {
	project = mkdtempSync(join(tmpdir(), "vcqa-hygiene-"));
	mkdirSync(join(project, "src"));
	writeFileSync(join(project, "package.json"), JSON.stringify({ name: "hygiene-fixture" }));
	writeFileSync(join(project, "src", "index.ts"), "export const x = 1;\n");
	writeFileSync(join(project, ".gitignore"), ".dev.vars\n.vibe-check/\n");
	const pat = fakeGithubPat();
	const generic = fakeBody(32);
	writeFileSync(join(project, ".dev.vars"), `GITHUB_TOKEN=${pat.value}\nSESSION_SECRET=${generic}\n`);
	// A tracked file too, so built-in findings (and their HTML rendering) are exercised.
	const tracked = fakeGithubPat();
	writeFileSync(join(project, "src", "client.ts"), `export const token = "${tracked.value}";\n`);
	execFileSync("git", ["init", "-q"], { cwd: project });
	execFileSync("git", ["remote", "add", "origin", "https://github.com/example-owner/example-repo.git"], { cwd: project });
	return [pat.body, generic, tracked.body];
}

function cli(args: string[], env: NodeJS.ProcessEnv): string {
	try {
		return execFileSync(process.execPath, [CLI, ...args], { cwd: project, encoding: "utf-8", timeout: 120_000, env });
	} catch (e: any) {
		return `${e.stdout ?? ""}${e.stderr ?? ""}`;
	}
}

function filesUnder(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const full = join(dir, name);
		return statSync(full).isDirectory() ? filesUnder(full) : [full];
	});
}

function scanAndCollect(env: NodeJS.ProcessEnv): Record<string, string> {
	const base = ["--skip-tests"];
	const env2 = { ...env, VCQA_NO_UPDATE_CHECK: "1", CI: "1" };
	const outputs: Record<string, string> = {};
	cli([...base, "--sarif"], env2); // report.json, history, HTML pages, SARIF
	outputs["--json stdout"] = cli([...base, "--json"], env2); // rescans with .vibe-check/ present
	outputs["--markdown stdout"] = cli([...base, "--markdown"], env2);
	for (const file of filesUnder(join(project, ".vibe-check"))) {
		outputs[file.slice(project.length + 1)] = readFileSync(file, "utf-8");
	}
	const report = JSON.parse(readFileSync(join(project, ".vibe-check", "report.json"), "utf-8")) as VibeReport;
	outputs["upload body"] = JSON.stringify(buildReportUploadPayload(report, "0".repeat(40)));
	outputs["PR comment"] = buildCommentBody(report, null);
	return outputs;
}

function expectNoLeaks(bodies: string[], outputs: Record<string, string>): void {
	expect(Object.keys(outputs)).toEqual(
		expect.arrayContaining([".vibe-check/report.json", ".vibe-check/report.sarif", ".vibe-check/report/security.html"]),
	);
	expect(Object.keys(outputs).some((k) => k.startsWith(".vibe-check/history/"))).toBe(true);
	const leaks: string[] = [];
	for (const [name, text] of Object.entries(outputs)) {
		for (const body of bodies) if (leakedWindows(body, text).length > 0) leaks.push(name);
	}
	expect(leaks).toEqual([]);
}

describe("scan artifacts never carry a local credential's value", () => {
	it.skipIf(!gitleaksInstalled())("with gitleaks installed", { timeout: 300_000 }, () => {
		const bodies = makeProject();
		const outputs = scanAndCollect(process.env);
		const report = JSON.parse(outputs[".vibe-check/report.json"]!) as VibeReport;
		const secrets = report.checks.find((c) => c.name === "secrets")!;
		const runs = (secrets.details as { toolRuns?: Array<{ tool: string; output: string }> }).toolRuns ?? [];
		// Provenance kept: the redacted gitleaks log is still in the report.
		expect(runs.find((r) => r.tool === "gitleaks")?.output).toContain("REDACTED");
		expect(secrets.issues.some((i) => i.file === ".dev.vars")).toBe(true);
		expectNoLeaks(bodies, outputs);
	});

	it("with gitleaks unavailable", { timeout: 300_000 }, () => {
		const bodies = makeProject();
		stubDir = mkdtempSync(join(tmpdir(), "vcqa-nogitleaks-"));
		writeFileSync(join(stubDir, "gitleaks"), '#!/bin/sh\necho "gitleaks: command not found" >&2\nexit 127\n', { mode: 0o755 });
		const outputs = scanAndCollect({ ...process.env, PATH: `${stubDir}:${process.env.PATH}` });
		const report = JSON.parse(outputs[".vibe-check/report.json"]!) as VibeReport;
		const secrets = report.checks.find((c) => c.name === "secrets")!;
		expect((secrets.details as Record<string, unknown>).tool).toBe("secretlint");
		expect(secrets.issues.some((i) => i.file === "src/client.ts")).toBe(true);
		expectNoLeaks(bodies, outputs);
	});
});
