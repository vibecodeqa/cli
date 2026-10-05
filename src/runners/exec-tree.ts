/** Run a command with a time limit that kills its whole process tree.
 *
 * `execSync`'s timeout signals only the `/bin/sh` it spawned. Everything that
 * shell started — `npx` → `vitest` → worker pools — is reparented and keeps
 * running after the scan has given up on it (vibecodeqa/cli#106).
 *
 * The runners are synchronous and `spawnSync` cannot start a detached child,
 * so the command runs under a tiny Node supervisor. It starts the command in
 * its own process group (`detached`) and tears the group down — SIGTERM, then
 * SIGKILL after a grace period, waiting until no member is left — whenever the
 * run ends for any reason:
 *
 * - the time limit passes;
 * - the supervisor is signalled (SIGINT/SIGTERM/SIGHUP). Ctrl-C at a terminal
 *   reaches the supervisor, which sits in the CLI's process group, but not the
 *   detached command, so the supervisor must pass it on;
 * - the parent goes away: the supervisor holds one end of a pipe (fd 4) whose
 *   other end only the parent holds, and sees EOF on it when the parent dies;
 * - the parent gives up on it (output past `maxBuffer`, or the backstop
 *   timeout): `spawnSync` then sends SIGTERM, which is handled as above.
 *
 * The command's output is relayed through the supervisor rather than inherited,
 * so a process outside the group that keeps the command's stdout open (a
 * `detached` helper) cannot hold the run open: the supervisor stops relaying
 * shortly after the command exits, and its exit closes the parent's pipes.
 *
 * The supervisor reports on fd 3 — a timeout marker, or the command's exit
 * code — so the outcome cannot be confused with anything the command prints.
 */

import { spawnSync } from "node:child_process";
import { recordToolRun, type ToolRunContext } from "./exec.js";

const MAX_BUFFER = 64 * 1024 * 1024;
const TIMEOUT_MARKER = "vcqa:timed-out";
const EXIT_MARKER = "vcqa:exit:";
/** Largest delay `setTimeout` honours; anything above fires after 1 ms. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

// Runs as `node -e`. argv: [cmd, timeoutMs]. Plain JS — it is not compiled.
const SUPERVISOR = `
const { spawn, execFileSync } = require("node:child_process");
const { writeSync } = require("node:fs");
const [cmd, timeoutArg] = process.argv.slice(1);
const timeoutMs = Number(timeoutArg);
const win = process.platform === "win32";
const child = spawn(cmd, { shell: true, detached: !win, stdio: ["ignore", "pipe", "pipe"] });
let ending = false;
function report(text) { try { writeSync(3, text); } catch {} }
function writeAll(fd, buf) {
	let off = 0;
	while (off < buf.length) {
		try { off += writeSync(fd, buf, off); }
		catch (e) { if (e.code !== "EAGAIN") throw e; }
	}
}
function signalTree(sig) {
	try {
		if (win) execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
		else process.kill(-child.pid, sig);
	} catch {}
}
function groupAlive() {
	if (win) return false;
	try { process.kill(-child.pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}
// Tear the group down and exit. The single exit path for every abnormal end.
function stop(code, timedOut) {
	if (ending) return;
	ending = true;
	clearTimeout(timer);
	signalTree("SIGTERM");
	const started = Date.now();
	let killed = false;
	const finish = () => { if (timedOut) report("${TIMEOUT_MARKER}"); process.exit(code); };
	if (!child.pid) finish();
	const poll = setInterval(() => {
		if (!groupAlive()) { clearInterval(poll); finish(); return; }
		const waited = Date.now() - started;
		if (!killed && waited >= 2000) { killed = true; signalTree("SIGKILL"); }
		if (waited >= 10000) { clearInterval(poll); finish(); }
	}, 20);
}
const relay = (fd) => (chunk) => {
	try { writeAll(fd, chunk); } catch { stop(129, false); } // parent stopped reading
};
child.stdout.on("data", relay(1));
child.stderr.on("data", relay(2));
const timer = setTimeout(() => stop(124, true), timeoutMs);
for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129], ["SIGQUIT", 131]]) process.on(sig, () => stop(code, false));
if (!win) {
	try {
		const watch = new (require("node:net").Socket)({ fd: 4, readable: true, writable: false });
		const gone = () => stop(129, false);
		watch.on("end", gone); watch.on("close", gone); watch.on("error", gone);
	} catch {}
}
child.on("error", (e) => {
	if (ending) return;
	ending = true;
	clearTimeout(timer);
	try { writeAll(2, Buffer.from(String(e && e.message))); } catch {}
	report("${EXIT_MARKER}127");
	process.exit(127);
});
child.on("exit", (code, signal) => {
	if (ending) return;
	ending = true;
	clearTimeout(timer);
	// Grandchildren that outlive the command (a stray watcher) go too.
	signalTree("SIGKILL");
	const status = code ?? (signal ? 128 + (require("node:os").constants.signals[signal] ?? 0) : 1);
	// Relay what is still buffered, but do not wait on a process outside the
	// group that holds the pipes open: stop once they close, go quiet, or 2 s pass.
	const done = () => { report("${EXIT_MARKER}" + status); process.exit(status); };
	const streams = [child.stdout, child.stderr].filter((s) => !s.closed);
	if (streams.length === 0) done();
	let open = streams.length;
	for (const s of streams) s.on("close", () => { if (--open === 0) done(); });
	let quietTimer = setTimeout(done, 200);
	const busy = () => { clearTimeout(quietTimer); quietTimer = setTimeout(done, 200); };
	child.stdout.on("data", busy);
	child.stderr.on("data", busy);
	setTimeout(done, 2000);
});
`;

/** How the supervisor is started: `spawnSync(file, args, options)`. Exposed so
 * tests can run the exact same supervisor from a separate parent process. */
export function supervisorSpawn(cmd: string, timeoutMs: number) {
	const limit = Math.min(Math.max(1, Math.floor(timeoutMs)), MAX_TIMER_MS);
	return {
		limit,
		file: process.execPath,
		args: ["-e", SUPERVISOR, cmd, String(limit)],
		options: {
			encoding: "utf-8" as const,
			maxBuffer: MAX_BUFFER,
			// fd 3: the supervisor's report. fd 4: held open by this process only,
			// so the supervisor sees EOF on it if this process dies.
			stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"] as Array<"ignore" | "pipe">,
			// Backstop only: the supervisor normally exits well before this. SIGTERM,
			// not SIGKILL, so the supervisor still tears the group down.
			timeout: limit + 30_000,
			killSignal: "SIGTERM" as const,
		},
	};
}

export interface TreeRunResult {
	stdout: string;
	ok: boolean;
	timedOut: boolean;
}

/** Like `run()` from exec.ts, but a timeout kills every process the command
 * started, and is recorded as `status: "timeout"`. A `timeoutMs` above
 * {@link MAX_TIMER_MS} is clamped to it. */
export function runWithTreeKill(cmd: string, cwd: string, timeoutMs: number, context: ToolRunContext = {}): TreeRunResult {
	const started = Date.now();
	const { limit, file, args, options } = supervisorSpawn(cmd, timeoutMs);
	const res = spawnSync(file, args, { ...options, cwd });
	const stdout = typeof res.stdout === "string" ? res.stdout : "";
	const stderr = typeof res.stderr === "string" ? res.stderr : "";
	const marker = typeof res.output?.[3] === "string" ? res.output[3] : "";
	const exited = new RegExp(`${EXIT_MARKER}(\\d+)`).exec(marker);
	const errorCode = (res.error as NodeJS.ErrnoException | undefined)?.code;
	// The supervisor's own report wins; the backstop's ETIMEDOUT counts only
	// when the supervisor never said how the command ended.
	const timedOut = marker.includes(TIMEOUT_MARKER) || (!exited && errorCode === "ETIMEDOUT");
	const status = exited ? Number(exited[1]) : res.status;
	const failedToRun = Boolean(res.error) && !(exited && errorCode === "ETIMEDOUT");
	const ok = !timedOut && !failedToRun && status === 0;
	const combined = `${stdout}${stdout && stderr ? "\n" : ""}${stderr}`.trim() || (res.error ? String(res.error) : "");
	const output = ok ? stdout : combined;

	recordToolRun(
		cmd,
		cwd,
		{
			status: ok ? "success" : timedOut ? "timeout" : "failed",
			exitCode: ok ? 0 : timedOut ? null : (status ?? null),
			ok,
			durationMs: Date.now() - started,
			output,
			...(timedOut ? { timedOut: true, timeoutMs: limit } : {}),
		},
		context,
	);
	return { stdout: output, ok, timedOut };
}
