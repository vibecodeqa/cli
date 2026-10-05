/** Run a command with a time limit that kills its whole process tree.
 *
 * `execSync`'s timeout signals only the `/bin/sh` it spawned. Everything that
 * shell started — `npx` → `vitest` → worker pools — is reparented and keeps
 * running after the scan has given up on it (vibecodeqa/cli#106).
 *
 * The runners are synchronous and `spawnSync` cannot start a detached child,
 * so the command runs under a tiny Node supervisor: it starts the command in
 * its own process group (`detached`), and on timeout signals the group —
 * SIGTERM, then SIGKILL after a grace period — and waits until no member of
 * the group is left before exiting. When this function returns, nothing the
 * command started is still alive. The supervisor reports the timeout on fd 3,
 * so it cannot be confused with anything the command prints or exits with.
 */

import { spawnSync } from "node:child_process";
import { recordToolRun, type ToolRunContext } from "./exec.js";

const MAX_BUFFER = 64 * 1024 * 1024;
const TIMEOUT_MARKER = "vcqa:timed-out";

// Runs as `node -e`. argv: [cmd, timeoutMs]. Plain JS — it is not compiled.
const SUPERVISOR = `
const { spawn, execFileSync } = require("node:child_process");
const { writeSync } = require("node:fs");
const [cmd, timeoutArg] = process.argv.slice(1);
const timeoutMs = Number(timeoutArg);
const win = process.platform === "win32";
const child = spawn(cmd, { shell: true, detached: !win, stdio: ["ignore", "inherit", "inherit"] });
let timedOut = false;
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
function finish(code) {
	if (timedOut) { try { writeSync(3, "${TIMEOUT_MARKER}"); } catch {} }
	process.exit(code);
}
const timer = setTimeout(() => {
	timedOut = true;
	signalTree("SIGTERM");
	const started = Date.now();
	let killed = false;
	const poll = setInterval(() => {
		if (!groupAlive()) { clearInterval(poll); finish(124); return; }
		const waited = Date.now() - started;
		if (!killed && waited >= 2000) { killed = true; signalTree("SIGKILL"); }
		if (waited >= 10000) { clearInterval(poll); finish(124); }
	}, 20);
}, timeoutMs);
child.on("error", (e) => { clearTimeout(timer); process.stderr.write(String(e && e.message)); process.exit(127); });
child.on("exit", (code, signal) => {
	if (timedOut) return;
	clearTimeout(timer);
	// Grandchildren that outlive the command (a stray watcher) go too.
	signalTree("SIGKILL");
	process.exit(code ?? (signal ? 128 : 1));
});
`;

export interface TreeRunResult {
	stdout: string;
	ok: boolean;
	timedOut: boolean;
}

/** Like `run()` from exec.ts, but a timeout kills every process the command
 * started, and is recorded as `status: "timeout"`. */
export function runWithTreeKill(cmd: string, cwd: string, timeoutMs: number, context: ToolRunContext = {}): TreeRunResult {
	const started = Date.now();
	const res = spawnSync(process.execPath, ["-e", SUPERVISOR, cmd, String(timeoutMs)], {
		cwd,
		encoding: "utf-8",
		maxBuffer: MAX_BUFFER,
		stdio: ["ignore", "pipe", "pipe", "pipe"],
		// Backstop only: the supervisor normally exits well before this.
		timeout: timeoutMs + 30_000,
		killSignal: "SIGKILL",
	});
	const stdout = typeof res.stdout === "string" ? res.stdout : "";
	const stderr = typeof res.stderr === "string" ? res.stderr : "";
	const marker = typeof res.output?.[3] === "string" ? res.output[3] : "";
	const timedOut = marker.includes(TIMEOUT_MARKER) || (res.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
	const ok = !timedOut && !res.error && res.status === 0;
	const combined = `${stdout}${stdout && stderr ? "\n" : ""}${stderr}`.trim() || (res.error ? String(res.error) : "");
	const output = ok ? stdout : combined;

	recordToolRun(
		cmd,
		cwd,
		{
			status: ok ? "success" : timedOut ? "timeout" : "failed",
			exitCode: ok ? 0 : timedOut ? null : (res.status ?? null),
			ok,
			durationMs: Date.now() - started,
			output,
			...(timedOut ? { timedOut: true, timeoutMs } : {}),
		},
		context,
	);
	return { stdout: output, ok, timedOut };
}
