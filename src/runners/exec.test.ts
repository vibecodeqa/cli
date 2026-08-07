import { describe, expect, it } from "vitest";
import { filterToolRuns, run, startToolRecording, type ToolRun, takeToolRuns } from "./exec.js";

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
		expect(runs[0]).toMatchObject({
			tool: "echo",
			command: "echo hello",
			cwd: "/tmp",
			status: "success",
			exitCode: 0,
			ok: true,
			notFound: false,
		});
		expect(runs[0].output).toBe("hello");
		expect(runs[0].durationMs).toBeGreaterThanOrEqual(0);
	});

	it("records analyzer and project context for page-specific logs", () => {
		startToolRecording({ analyzerId: "lint" });
		run("echo hello", "/tmp", 60_000, { projectId: "packages-web", projectPath: "packages/web" });
		const [r] = takeToolRuns();
		expect(r).toMatchObject({ analyzerId: "lint", analyzer: "lint", projectId: "packages-web", projectPath: "packages/web" });
	});

	it("supports the legacy analyzer context name while recording analyzerId", () => {
		startToolRecording({ analyzer: "testing" });
		run("echo hello", "/tmp");
		const [r] = takeToolRuns();
		expect(r).toMatchObject({ analyzerId: "testing", analyzer: "testing" });
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
		expect(missing.status).toBe("failed");
		expect(missing.exitCode).not.toBe(0);
		expect(missing.notFound).toBe(true);
		expect(failed.ok).toBe(false);
		expect(failed.status).toBe("failed");
		expect(failed.exitCode).toBe(3);
		expect(failed.notFound).toBe(false);
	});

	it("records combined stdout and stderr when a tool fails", () => {
		startToolRecording();
		run("sh -c 'echo stdout; echo stderr >&2; exit 2'", "/tmp");
		const [r] = takeToolRuns();
		expect(r.output).toContain("stdout");
		expect(r.output).toContain("stderr");
		expect(r.exitCode).toBe(2);
	});

	it("names the package rather than npx for delegated tools", () => {
		startToolRecording();
		run("npx --yes knip --reporter json", "/tmp", 1);
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

	it("filters tool runs by analyzer and project for page-specific logs", () => {
		const runs: ToolRun[] = [
			{
				tool: "eslint",
				command: "npx eslint .",
				cwd: "/repo/packages/web",
				analyzerId: "lint",
				analyzer: "lint",
				projectId: "web",
				projectPath: "packages/web",
				status: "success",
				exitCode: 0,
				ok: true,
				durationMs: 1,
				output: "web lint",
				notFound: false,
			},
			{
				tool: "vitest",
				command: "npx vitest run",
				cwd: "/repo/packages/web",
				analyzerId: "testing",
				analyzer: "testing",
				projectId: "web",
				projectPath: "packages/web",
				status: "success",
				exitCode: 0,
				ok: true,
				durationMs: 1,
				output: "web tests",
				notFound: false,
			},
			{
				tool: "eslint",
				command: "npx eslint .",
				cwd: "/repo/packages/api",
				analyzerId: "lint",
				analyzer: "lint",
				projectId: "api",
				projectPath: "packages/api",
				status: "success",
				exitCode: 0,
				ok: true,
				durationMs: 1,
				output: "api lint",
				notFound: false,
			},
		];

		expect(filterToolRuns(runs, { analyzerId: "lint" }).map((r) => r.output)).toEqual(["web lint", "api lint"]);
		expect(filterToolRuns(runs, { analyzerId: "lint", projectId: "web" }).map((r) => r.output)).toEqual(["web lint"]);
		expect(filterToolRuns(runs, { analyzerId: "testing", projectPath: "packages/web" }).map((r) => r.output)).toEqual(["web tests"]);
		expect(filterToolRuns(runs)).toHaveLength(3);
	});
});
