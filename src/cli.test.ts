import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CLI = join(import.meta.dirname!, "..", "dist", "cli.js");
const TMP = join(import.meta.dirname!, "__test_cli__");

function run(args: string): string {
	try {
		return execSync(`node ${CLI} ${args}`, { encoding: "utf-8", timeout: 30_000, cwd: TMP });
	} catch (e: any) {
		return e.stdout || e.stderr || String(e);
	}
}

beforeEach(() => {
	rmSync(TMP, { recursive: true, force: true });
	mkdirSync(join(TMP, "src"), { recursive: true });
	writeFileSync(join(TMP, "package.json"), JSON.stringify({ name: "test-project" }));
	writeFileSync(join(TMP, "src", "index.ts"), "export const x = 1;\n");
});

afterEach(() => {
	rmSync(TMP, { recursive: true, force: true });
});

describe("CLI flags", () => {
	it("--version prints version", () => {
		const out = run("--version");
		expect(out.trim()).toMatch(/^\d+\.\d+\.\d+$/);
	});

	it("-v prints version", () => {
		const out = run("-v");
		expect(out.trim()).toMatch(/^\d+\.\d+\.\d+$/);
	});

	it("--help shows usage", () => {
		const out = run("--help");
		expect(out).toContain("Usage:");
		expect(out).toContain("--skip-tests");
		expect(out).toContain("init");
		expect(out).toContain("fix");
	});

	it("--json produces valid JSON", () => {
		const out = run("--skip-tests --json .");
		const report = JSON.parse(out);
		expect(report.version).toBeDefined();
		expect(report.score).toBeGreaterThanOrEqual(0);
		expect(report.score).toBeLessThanOrEqual(100);
		expect(report.checks).toBeInstanceOf(Array);
		expect(report.checks.length).toBe(24);
	}, 30_000);

	it("nonexistent path exits with error", () => {
		const out = execSync(`node ${CLI} --skip-tests /nonexistent 2>&1 || true`, { encoding: "utf-8" });
		expect(out).toContain("does not exist");
	});

	it("--fail-under exits with code 1 when score is below threshold", () => {
		// An empty project with no LICENSE, .gitignore, etc. scores low
		try {
			execSync(`node ${CLI} --skip-tests --json --fail-under 99 .`, { encoding: "utf-8", timeout: 30_000, cwd: TMP });
			// Should not reach here — expect exit code 1
			expect.unreachable("should have thrown");
		} catch (e: any) {
			expect(e.status).toBe(1);
		}
	}, 30_000);

	it("--fail-under does not exit when score is above threshold", () => {
		const out = run("--skip-tests --json --fail-under 0 .");
		const report = JSON.parse(out);
		expect(report.score).toBeGreaterThanOrEqual(0);
	}, 30_000);

	it("--ci sets fail-under threshold", () => {
		// With --ci, score must be >= 60. Our test project scores ~71, so it passes.
		const out = run("--skip-tests --json --ci .");
		const report = JSON.parse(out);
		expect(report.score).toBeGreaterThanOrEqual(60);
	}, 30_000);

	it("--top limits issue output", () => {
		const out = run("--skip-tests --top 3 .");
		// --top mode should show "Top 3 issues" or similar
		expect(out).toContain("Top");
	}, 30_000);

	it("--diff filters issues to changed files", () => {
		// Initialize a git repo for diff to work (configure identity for CI)
		execSync("git init && git config user.email 'test@test.com' && git config user.name 'Test' && git add -A && git commit -m init", {
			cwd: TMP,
			stdio: "pipe",
		});
		writeFileSync(join(TMP, "src", "new.ts"), 'eval("bad");');
		const out = run("--skip-tests --json --diff HEAD .");
		const report = JSON.parse(out);
		// Issues should only reference changed files (src/new.ts)
		for (const c of report.checks) {
			for (const i of c.issues) {
				if (i.file) expect(i.file).toContain("new.ts");
			}
		}
	}, 30_000);
});

describe("explain command", () => {
	it("lists all checks when no argument given", () => {
		const out = run("explain");
		expect(out).toContain("Available checks:");
		expect(out).toContain("structure");
		expect(out).toContain("confusion");
		expect(out).toContain("testing");
	});

	it("shows check details when name given", () => {
		const out = run("explain testing");
		expect(out).toContain("Testing");
		expect(out).toContain("What:");
		expect(out).toContain("Risk:");
		expect(out).toContain("Fix:");
	});

	it("shows error for unknown check", () => {
		const out = run("explain nonexistent");
		expect(out).toContain("Unknown check");
	});
});

describe("output modes", () => {
	it("--markdown produces clean markdown", () => {
		const out = run("--skip-tests --markdown .");
		expect(out).toContain("# ");
		expect(out).toContain("VibeCode QA");
		expect(out).toContain("| Check | Score | Grade |");
		// Should NOT contain ANSI escape codes
		expect(out).not.toContain("\x1b[");
	}, 30_000);

	it("--annotations emits GitHub Actions format", () => {
		const out = run("--skip-tests --annotations .");
		// Should contain ::warning or ::error annotations
		expect(out).toMatch(/::(warning|error)/);
	}, 30_000);
});

describe("config file", () => {
	it("disables checks via .vcqa.json", () => {
		writeFileSync(join(TMP, ".vcqa.json"), JSON.stringify({ checks: { confusion: { enabled: false }, context: { enabled: false } } }));
		const out = run("--skip-tests --json .");
		const report = JSON.parse(out);
		const confusion = report.checks.find((c: any) => c.name === "confusion");
		expect(confusion.details.skipped).toBe(true);
		expect(confusion.details.reason).toBe("disabled in config");
	}, 30_000);

	it("uses failUnder from config", () => {
		writeFileSync(join(TMP, ".vcqa.json"), JSON.stringify({ failUnder: 99 }));
		try {
			execSync(`node ${CLI} --skip-tests --json .`, { encoding: "utf-8", timeout: 30_000, cwd: TMP });
			expect.unreachable("should have thrown");
		} catch (e: any) {
			expect(e.status).toBe(1);
		}
	}, 30_000);
});

describe("init command", () => {
	it("creates workflow file", () => {
		const out = run("init .");
		expect(out).toContain("vibecodeqa.yml");
		expect(existsSync(join(TMP, ".github", "workflows", "vibecodeqa.yml"))).toBe(true);
		const workflow = readFileSync(join(TMP, ".github", "workflows", "vibecodeqa.yml"), "utf-8");
		expect(workflow).toContain("pull_request");
		expect(workflow).toContain("--fail-under");
	});

	it("does not overwrite existing workflow", () => {
		mkdirSync(join(TMP, ".github", "workflows"), { recursive: true });
		writeFileSync(join(TMP, ".github", "workflows", "vibecodeqa.yml"), "custom");
		run("init .");
		expect(readFileSync(join(TMP, ".github", "workflows", "vibecodeqa.yml"), "utf-8")).toBe("custom");
	});

	it("adds .vibe-check to .gitignore", () => {
		writeFileSync(join(TMP, ".gitignore"), "node_modules\n");
		run("init .");
		const gi = readFileSync(join(TMP, ".gitignore"), "utf-8");
		expect(gi).toContain(".vibe-check/");
	});

	it("skips .gitignore if no .gitignore exists", () => {
		run("init .");
		expect(existsSync(join(TMP, ".gitignore"))).toBe(false);
	});

	it("creates biome.json when biome is a dep", () => {
		writeFileSync(join(TMP, "package.json"), JSON.stringify({ devDependencies: { "@biomejs/biome": "2" } }));
		mkdirSync(join(TMP, "node_modules", "@biomejs", "biome"), { recursive: true });
		run("init .");
		expect(existsSync(join(TMP, "biome.json"))).toBe(true);
	});

	it("generates .vcqa.json with all check names listed", () => {
		run("init .");
		expect(existsSync(join(TMP, ".vcqa.json"))).toBe(true);
		const config = JSON.parse(readFileSync(join(TMP, ".vcqa.json"), "utf-8"));
		// Should list all 20 scorable checks
		expect(Object.keys(config.checks)).toContain("structure");
		expect(Object.keys(config.checks)).toContain("testing");
		expect(Object.keys(config.checks)).toContain("security");
		expect(Object.keys(config.checks)).toContain("confusion");
		expect(Object.keys(config.checks)).toContain("context");
		expect(Object.keys(config.checks).length).toBe(22);
		// Should have help fields
		expect(config._comment).toContain("vibecodeqa.online");
		expect(config._checks_help).toContain("enabled");
		expect(config._ignore_help).toContain("vendor");
		expect(config.failUnder).toBe(60);
	});

	it("does not overwrite existing .vcqa.json", () => {
		writeFileSync(join(TMP, ".vcqa.json"), '{"failUnder":99}');
		run("init .");
		const config = JSON.parse(readFileSync(join(TMP, ".vcqa.json"), "utf-8"));
		expect(config.failUnder).toBe(99);
	});

	it("generated .vcqa.json is valid for the config loader", () => {
		run("init .");
		const out = run("--skip-tests --json .");
		const report = JSON.parse(out);
		// Config should load without error and not disable any checks
		expect(report.checks.length).toBe(24);
		const disabled = report.checks.filter((c: any) => c.details.reason === "disabled in config");
		expect(disabled).toHaveLength(0);
	}, 30_000);

	it("validates path", () => {
		const out = execSync(`node ${CLI} init /nonexistent 2>&1 || true`, { encoding: "utf-8" });
		expect(out).toContain("does not exist");
	});
});

describe("config disabling checks", () => {
	it("disabled checks are excluded from scoring", () => {
		writeFileSync(
			join(TMP, ".vcqa.json"),
			JSON.stringify({ checks: { confusion: { enabled: false }, context: { enabled: false } } }),
		);
		const out = run("--skip-tests --json .");
		const report = JSON.parse(out);
		const confusion = report.checks.find((c: any) => c.name === "confusion");
		const context = report.checks.find((c: any) => c.name === "context");
		expect(confusion.details.skipped).toBe(true);
		expect(context.details.skipped).toBe(true);
		// Score should be computed without these checks
		expect(report.score).toBeGreaterThan(0);
	}, 30_000);

	it("per-check ignore filters issues from matching files", () => {
		writeFileSync(join(TMP, "src", "gen.ts"), 'eval("bad");\n');
		writeFileSync(
			join(TMP, ".vcqa.json"),
			JSON.stringify({ checks: { security: { ignore: ["src/gen.ts"] } } }),
		);
		const out = run("--skip-tests --json .");
		const report = JSON.parse(out);
		const sec = report.checks.find((c: any) => c.name === "security");
		// The eval issue in src/gen.ts should be filtered out
		const genIssues = sec.issues.filter((i: any) => i.file === "src/gen.ts");
		expect(genIssues).toHaveLength(0);
	}, 30_000);

	it("global ignore skips files from scanning", () => {
		mkdirSync(join(TMP, "src", "vendor"), { recursive: true });
		writeFileSync(join(TMP, "src", "vendor", "lib.ts"), 'eval("bad"); console.log("debug");\n');
		writeFileSync(join(TMP, ".vcqa.json"), JSON.stringify({ ignore: ["src/vendor/**"] }));
		const out = run("--skip-tests --json .");
		const report = JSON.parse(out);
		// No issues should reference src/vendor/
		for (const c of report.checks) {
			for (const i of c.issues) {
				if (i.file) expect(i.file).not.toContain("vendor/lib.ts");
			}
		}
	}, 30_000);
});

describe("fix command", () => {
	it("shows fix suggestions for empty catch", () => {
		writeFileSync(join(TMP, "src", "bad.ts"), "export function f() { try { x() } catch {} }\n");
		const out = run("fix .");
		expect(out).toContain("Fix:");
	}, 30_000);

	it("shows score after fix", () => {
		const out = run("fix .");
		expect(out).toContain("Score after fix:");
	}, 30_000);

	it("validates path", () => {
		const out = execSync(`node ${CLI} fix /nonexistent 2>&1 || true`, { encoding: "utf-8" });
		expect(out).toContain("does not exist");
	});
});

describe("report output", () => {
	it("--json produces report with all checks and workspace info", () => {
		const out = run("--skip-tests --json .");
		const report = JSON.parse(out);
		expect(report.checks.length).toBe(24);
		expect(report.meta.workspace).toBeDefined();
		expect(typeof report.meta.workspace.isMonorepo).toBe("boolean");
		// Also verify report file was written
		expect(existsSync(join(TMP, ".vibe-check", "report.json"))).toBe(true);
	}, 30_000);

	it("--badge and --sarif generate output files", () => {
		run("--skip-tests --badge --sarif .");
		expect(existsSync(join(TMP, ".vibe-check", "badge.svg"))).toBe(true);
		expect(existsSync(join(TMP, ".vibe-check", "report.sarif"))).toBe(true);
	}, 30_000);

	it("--sarif produces valid SARIF 2.1.0", () => {
		run("--skip-tests --sarif .");
		const sarif = JSON.parse(readFileSync(join(TMP, ".vibe-check", "report.sarif"), "utf-8"));
		expect(sarif.$schema).toContain("sarif");
		expect(sarif.version).toBe("2.1.0");
		expect(sarif.runs).toBeInstanceOf(Array);
		expect(sarif.runs.length).toBe(1);
		expect(sarif.runs[0].tool.driver.name).toBe("VibeCode QA");
		expect(sarif.runs[0].results).toBeInstanceOf(Array);
		// Verify rules are defined
		expect(sarif.runs[0].tool.driver.rules).toBeInstanceOf(Array);
		expect(sarif.runs[0].tool.driver.rules.length).toBeGreaterThan(0);
	}, 30_000);

	it("generates multi-page HTML report", () => {
		run("--skip-tests .");
		const reportDir = join(TMP, ".vibe-check", "report");
		expect(existsSync(join(reportDir, "index.html"))).toBe(true);
		const html = readFileSync(join(reportDir, "index.html"), "utf-8");
		expect(html).toContain("<!DOCTYPE html>");
		expect(html).toContain("VibeCode QA");
	}, 30_000);
});
