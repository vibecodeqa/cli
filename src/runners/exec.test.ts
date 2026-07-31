import { describe, expect, it } from "vitest";
import { run, startToolRecording, takeToolRuns } from "./exec.js";

/** Provenance is the mechanism that makes a report auditable — without it a
 *  clean score cannot be distinguished from a tool that never ran, or one that
 *  ran in the wrong directory (which produced a real false positive). These
 *  tests pin the fields that answer those questions. */
describe("tool run provenance", () => {
	it("records the command, cwd, success and duration of a run", () => {
		startToolRecording();
		run("echo hello", "/tmp");
		const runs = takeToolRuns();
		expect(runs).toHaveLength(1);
		expect(runs[0]).toMatchObject({ tool: "echo", command: "echo hello", cwd: "/tmp", ok: true, notFound: false });
		expect(runs[0].output).toBe("hello");
		expect(runs[0].durationMs).toBeGreaterThanOrEqual(0);
	});

	it("records the directory the command ran in — the field that caught a real false positive", () => {
		startToolRecording();
		run("pwd", "/tmp");
		const [r] = takeToolRuns();
		// Both the recorded cwd and the command's own output must agree.
		expect(r.cwd).toBe("/tmp");
		expect(r.output).toMatch(/tmp$/);
	});

	it("distinguishes a missing binary from a tool that ran and failed", () => {
		startToolRecording();
		run("definitely-not-a-real-binary-xyz", "/tmp");
		run("sh -c 'exit 3'", "/tmp");
		const [missing, failed] = takeToolRuns();
		expect(missing.ok).toBe(false);
		expect(missing.notFound).toBe(true);
		expect(failed.ok).toBe(false);
		expect(failed.notFound).toBe(false);
	});

	it("names the package rather than npx for delegated tools", () => {
		startToolRecording();
		run("npx --yes knip --reporter json", "/tmp");
		expect(takeToolRuns()[0].tool).toBe("knip");
	});

	it("records nothing when not recording, so runs cannot leak between checks", () => {
		run("echo stray", "/tmp");
		startToolRecording();
		run("echo mine", "/tmp");
		const runs = takeToolRuns();
		expect(runs).toHaveLength(1);
		expect(runs[0].command).toBe("echo mine");
	});

	it("empties the buffer when taken, so the next check starts clean", () => {
		startToolRecording();
		run("echo one", "/tmp");
		expect(takeToolRuns()).toHaveLength(1);
		startToolRecording();
		expect(takeToolRuns()).toEqual([]);
	});

	it("caps captured output so one noisy tool cannot bloat the report", () => {
		startToolRecording();
		run('sh -c \'head -c 40000 /dev/zero | tr "\\\\0" "x"\'', "/tmp");
		const [r] = takeToolRuns();
		expect(r.output.length).toBeLessThanOrEqual(8000);
	});
});
