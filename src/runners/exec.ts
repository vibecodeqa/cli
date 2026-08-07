/** Shared exec helper for runners, with provenance recording.
 *
 * Every delegated tool run (knip, gitleaks, tsc, eslint, npm audit, …) is
 * recorded: the exact command, the directory it ran in, exit status, duration,
 * and its output. Without that record a report is unfalsifiable — you cannot
 * tell "the tool ran and found nothing" from "the tool never ran" or "the tool
 * ran in the wrong directory". That last case is not hypothetical: knip run
 * from a monorepo root instead of the package holding its config reported 42
 * live modules as unused. The log is how a user checks our work.
 */

import { execSync } from "node:child_process";

export interface ToolRun {
	/** Best-effort tool name, taken from the command's first word. */
	tool: string;
	/** The exact command line as executed. */
	command: string;
	/** Directory the command ran in — the thing that was wrong above. */
	cwd: string;
	analyzerId?: string;
	analyzer?: string;
	projectId?: string;
	projectPath?: string;
	status: "success" | "failed";
	exitCode: number | null;
	ok: boolean;
	durationMs: number;
	/** Combined output, trimmed and capped so reports stay a sane size. */
	output: string;
	/** True when the binary was not found (as opposed to running and failing). */
	notFound: boolean;
}

const MAX_OUTPUT = 8000;
const MAX_BUFFER = 64 * 1024 * 1024;

let buffer: ToolRun[] = [];
let recording = false;
let defaultContext: ToolRunContext = {};

export interface ToolRunContext {
	analyzerId?: string;
	analyzer?: string;
	projectId?: string;
	projectPath?: string;
}

export interface ToolRunFilter {
	analyzerId?: string;
	analyzer?: string;
	projectId?: string;
	projectPath?: string;
}

/** Start collecting runs for one check. */
export function startToolRecording(context: ToolRunContext = {}): void {
	buffer = [];
	recording = true;
	defaultContext = context;
}

/** Stop collecting and return what this check ran. */
export function takeToolRuns(): ToolRun[] {
	recording = false;
	const runs = buffer;
	buffer = [];
	defaultContext = {};
	return runs;
}

function toolNameOf(cmd: string): string {
	const first = cmd.trim().split(/\s+/)[0] ?? cmd;
	// `npx knip …` / `npx --yes knip …` — the interesting name is the package.
	if (first === "npx") {
		const rest = cmd.trim().split(/\s+/).slice(1);
		return rest.find((a) => !a.startsWith("-")) ?? "npx";
	}
	return first;
}

function record(entry: ToolRun): void {
	if (recording) buffer.push(entry);
}

function normalizedContext(context: ToolRunContext): ToolRunContext {
	const analyzerId = context.analyzerId ?? context.analyzer;
	return {
		...context,
		...(analyzerId ? { analyzerId, analyzer: context.analyzer ?? analyzerId } : {}),
	};
}

function outputOf(error: any): string {
	const stdout = error?.stdout ? String(error.stdout) : "";
	const stderr = error?.stderr ? String(error.stderr) : "";
	const combined = `${stdout}${stdout && stderr ? "\n" : ""}${stderr}`.trim();
	return combined || String(error);
}

export function filterToolRuns(runs: ToolRun[], filter: ToolRunFilter = {}): ToolRun[] {
	const analyzerId = filter.analyzerId ?? filter.analyzer;
	return runs.filter((run) => {
		if (analyzerId && (run.analyzerId ?? run.analyzer) !== analyzerId) return false;
		if (filter.projectId && run.projectId !== filter.projectId) return false;
		if (filter.projectPath && run.projectPath !== filter.projectPath) return false;
		return true;
	});
}

export function run(cmd: string, cwd: string, timeout = 60_000, context: ToolRunContext = {}): { stdout: string; ok: boolean } {
	const started = Date.now();
	const runContext = normalizedContext({ ...defaultContext, ...context });
	try {
		const stdout = execSync(cmd, {
			cwd,
			timeout,
			encoding: "utf-8",
			maxBuffer: MAX_BUFFER,
			stdio: ["pipe", "pipe", "pipe"],
		});
		record({
			tool: toolNameOf(cmd),
			command: cmd,
			cwd,
			...runContext,
			status: "success",
			exitCode: 0,
			ok: true,
			durationMs: Date.now() - started,
			output: stdout.trim().slice(0, MAX_OUTPUT),
			notFound: false,
		});
		return { stdout, ok: true };
	} catch (e: any) {
		const output = outputOf(e);
		record({
			tool: toolNameOf(cmd),
			command: cmd,
			cwd,
			...runContext,
			status: "failed",
			exitCode: typeof e?.status === "number" ? e.status : null,
			ok: false,
			durationMs: Date.now() - started,
			output: output.trim().slice(0, MAX_OUTPUT),
			notFound: /not found|ENOENT|command not found/i.test(output),
		});
		return { stdout: output, ok: false };
	}
}

export function runJSON<T>(cmd: string, cwd: string, timeout = 60_000, context: ToolRunContext = {}): T | null {
	const { stdout } = run(cmd, cwd, timeout, context);
	try {
		return JSON.parse(stdout) as T;
	} catch {
		return null;
	}
}
