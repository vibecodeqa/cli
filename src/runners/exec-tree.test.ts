/** vibecodeqa/cli#106 — the supervisor behind runWithTreeKill must leave no
 * process behind however the run ends: timeout, Ctrl-C, a signal to the
 * supervisor, the parent dying, or the parent giving up on its output. */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startToolRecording, takeToolRuns } from "./exec.js";
import { MAX_TIMER_MS, runWithTreeKill, supervisorSpawn } from "./exec-tree.js";

const posix = process.platform !== "win32";

// A separate parent process running the exact supervisor runWithTreeKill uses,
// so the test can signal or kill the parent (or the supervisor) mid-run.
const PARENT = `
const { spawnSync } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const spec = JSON.parse(process.argv[1]);
const res = spawnSync(spec.file, spec.args, { ...spec.options, cwd: spec.cwd });
writeFileSync(spec.cwd + "/result.json", JSON.stringify({ status: res.status, signal: res.signal, marker: res.output && res.output[3] }));
`;

const dirs: string[] = [];
const leftovers: number[] = [];
afterEach(() => {
	for (const pid of leftovers.splice(0)) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	}
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "vcqa-tree-"));
	dirs.push(dir);
	return dir;
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function waitFor(cond: () => boolean, ms = 5000): Promise<boolean> {
	const until = Date.now() + ms;
	while (Date.now() < until) {
		if (cond()) return true;
		await new Promise((r) => setTimeout(r, 25));
	}
	return cond();
}

/** Start a parent in its own process group (like a CLI in a terminal) running
 * `cmd` under the supervisor; resolves once `cmd` has written its pids. */
async function startParent(dir: string, cmd: string): Promise<{ parent: ChildProcess; pids: number[] }> {
	const spec = { ...supervisorSpawn(cmd, 60_000), cwd: dir };
	const parent = spawn(process.execPath, ["-e", PARENT, JSON.stringify(spec)], { detached: true, stdio: "ignore" });
	if (parent.pid) leftovers.push(parent.pid);
	const pidFile = join(dir, "pids");
	expect(await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf-8").trim().split(/\s+/).length >= 2)).toBe(true);
	const pids = readFileSync(pidFile, "utf-8").trim().split(/\s+/).map(Number);
	leftovers.push(...pids);
	return { parent, pids };
}

// `$$` is the shell, which execs into `sleep`; `$PPID` is the supervisor.
const SLEEPER = "echo $$ $PPID > pids; exec sleep 300";

describe.skipIf(!posix)("runWithTreeKill", () => {
	it("returns the output and exit status of a normal run", () => {
		const dir = tempDir();
		expect(runWithTreeKill("echo hello", dir, 10_000)).toEqual({ stdout: "hello\n", ok: true, timedOut: false });
		startToolRecording();
		const failed = runWithTreeKill("echo oops >&2; exit 3", dir, 10_000);
		const [r] = takeToolRuns();
		expect(failed).toMatchObject({ ok: false, timedOut: false, stdout: "oops" });
		expect(r).toMatchObject({ status: "failed", exitCode: 3, ok: false });
	});

	it("on timeout kills the whole group and records a timeout", () => {
		const dir = tempDir();
		startToolRecording();
		const res = runWithTreeKill("sleep 60 & echo $! > pids; exec sleep 60", dir, 300);
		const [r] = takeToolRuns();
		expect(res).toMatchObject({ ok: false, timedOut: true });
		expect(r).toMatchObject({ status: "timeout", timedOut: true, timeoutMs: 300, exitCode: null });
		expect(isAlive(Number(readFileSync(join(dir, "pids"), "utf-8")))).toBe(false);
	});

	it("is not held open by a process outside the group that keeps stdout", () => {
		const dir = tempDir();
		const helper =
			"node -e \"const c=require('child_process').spawn('sleep',['45'],{detached:true,stdio:['ignore','inherit','inherit']});require('fs').writeFileSync('helper',String(c.pid));c.unref()\"";
		const started = Date.now();
		const res = runWithTreeKill(`${helper}; echo report`, dir, 10_000);
		const elapsed = Date.now() - started;
		leftovers.push(Number(readFileSync(join(dir, "helper"), "utf-8")));
		expect(res).toEqual({ stdout: "report\n", ok: true, timedOut: false });
		expect(elapsed).toBeLessThan(5000);
	});

	it("clamps a limit too large for a timer instead of timing out at once", () => {
		const dir = tempDir();
		expect(supervisorSpawn("true", 3e9).limit).toBe(MAX_TIMER_MS);
		expect(runWithTreeKill("sleep 0.2; echo done", dir, 3e9)).toEqual({ stdout: "done\n", ok: true, timedOut: false });
	});

	it("kills the group when the parent gives up on its output (maxBuffer)", () => {
		const dir = tempDir();
		const res = runWithTreeKill("echo $$ > pids; exec yes", dir, 60_000);
		expect(res).toMatchObject({ ok: false, timedOut: false });
		expect(isAlive(Number(readFileSync(join(dir, "pids"), "utf-8")))).toBe(false);
	}, 30_000);

	it("Ctrl-C (SIGINT to the parent's process group) leaves nothing running", async () => {
		const dir = tempDir();
		const { parent, pids } = await startParent(dir, SLEEPER);
		process.kill(-(parent.pid as number), "SIGINT");
		expect(await waitFor(() => !isAlive(pids[0]))).toBe(true);
		expect(await waitFor(() => !isAlive(pids[1]))).toBe(true);
	});

	it("a SIGTERM to the supervisor kills the group and is reported as a failure", async () => {
		const dir = tempDir();
		const { pids } = await startParent(dir, SLEEPER);
		process.kill(pids[1], "SIGTERM");
		expect(await waitFor(() => existsSync(join(dir, "result.json")))).toBe(true);
		expect(isAlive(pids[0])).toBe(false);
		const result = JSON.parse(readFileSync(join(dir, "result.json"), "utf-8"));
		expect(result.status).toBe(143);
		expect(result.marker).not.toContain("vcqa:timed-out");
	});

	it("kills the group when the parent dies outright", async () => {
		const dir = tempDir();
		const { parent, pids } = await startParent(dir, SLEEPER);
		process.kill(parent.pid as number, "SIGKILL");
		expect(await waitFor(() => !isAlive(pids[0]))).toBe(true);
		expect(await waitFor(() => !isAlive(pids[1]))).toBe(true);
	});
});
