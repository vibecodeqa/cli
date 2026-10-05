/** Fingerprint v2 (#97): per-runner subjects, content anchors, and the v1/v2 boundary. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scan } from "./core.js";
import { computeDelta } from "./delta.js";
import { setGlobalSrcRoots } from "./fs-utils.js";
import {
	FINGERPRINT_VERSION,
	type FingerprintedIssue,
	fingerprintIssue,
	type SourceLineReader,
	withIssueFingerprints,
} from "./issue-fingerprint.js";
import { runArchitecture } from "./runners/architecture.js";
import { runComplexity } from "./runners/complexity.js";
import { runContext } from "./runners/context.js";
import { runDuplication } from "./runners/duplication.js";
import { runPerformance } from "./runners/performance.js";
import { runStandards } from "./runners/standards.js";
import { computeTrend } from "./trend.js";
import type { CheckResult, Issue, StackInfo, VibeReport } from "./types.js";

const dirs: string[] = [];
afterEach(() => {
	setGlobalSrcRoots(undefined);
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "vcqa-fp2-"));
	dirs.push(dir);
	writeFileSync(join(dir, "package.json"), "{}");
	write(dir, files);
	return dir;
}

function write(dir: string, files: Record<string, string>): void {
	for (const [name, content] of Object.entries(files)) {
		const full = join(dir, name);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, content);
	}
}

const TS_STACK: StackInfo = {
	language: "typescript",
	framework: "none",
	bundler: "none",
	testRunner: "none",
	linter: "none",
	packageManager: "npm",
};

/** The one issue of `rule`, fingerprinted as core.ts does. */
function fingerprinted(result: CheckResult, rule: string): FingerprintedIssue {
	const all = withIssueFingerprints(result.name, result.issues);
	const hits = all.filter((i) => i.rule === rule);
	expect(hits).toHaveLength(1);
	return hits[0];
}

/** Run a check twice around an edit that only moves the measurement. */
async function measuredRuleKeepsIdentity(
	rule: string,
	before: Record<string, string>,
	after: Record<string, string>,
	run: (dir: string) => CheckResult | Promise<CheckResult>,
): Promise<void> {
	const dir = project(before);
	const a = fingerprinted(await run(dir), rule);
	write(dir, after);
	const b = fingerprinted(await run(dir), rule);
	expect(b.message).not.toBe(a.message); // the number really moved…
	expect(fingerprintIssue("x", b)).not.toBe(fingerprintIssue("x", a)); // …which re-identified it in v1
	expect(b.fingerprint).toBe(a.fingerprint); // …and does not in v2
}

const lines = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i)).join("\n");

describe("v2 subjects: a changed measurement keeps the fingerprint", () => {
	it("standards large-file", async () => {
		await measuredRuleKeepsIdentity(
			"large-file",
			{ "src/big.ts": lines(350, (i) => `export const v${i} = ${i};`) },
			{ "src/big.ts": lines(380, (i) => `export const v${i} = ${i};`) },
			(dir) => runStandards(dir, TS_STACK),
		);
	});

	it("context high-token-count", async () => {
		const pad = (i: number) => `export const val${i} = ${i}; // some padding text here to increase token count`;
		await measuredRuleKeepsIdentity("high-token-count", { "src/big.ts": lines(500, pad) }, { "src/big.ts": lines(560, pad) }, (dir) =>
			runContext(dir),
		);
	});

	it("architecture high-fan-out", async () => {
		const mods = Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`src/mod${i}.ts`, `export const m${i} = ${i};\n`]));
		const hub = (n: number) =>
			`${lines(n, (i) => `import { m${i} } from "./mod${i}";`)}\nexport const all = [${Array.from({ length: n }, (_, i) => `m${i}`).join(", ")}];\n`;
		await measuredRuleKeepsIdentity("high-fan-out", { ...mods, "src/hub.ts": hub(11) }, { "src/hub.ts": hub(13) }, (dir) =>
			runArchitecture(dir),
		);
	});

	it("performance barrel-import", async () => {
		const barrel = (n: number) => lines(n, (i) => `export * from "./mod${i}";`);
		const mods = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`src/lib/mod${i}.ts`, `export const m${i} = ${i};\n`]));
		await measuredRuleKeepsIdentity("barrel-import", { ...mods, "src/lib/index.ts": barrel(3) }, { "src/lib/index.ts": barrel(5) }, (dir) =>
			runPerformance(dir),
		);
	});

	it("complexity long-function (keyed by function name)", async () => {
		const fn = (n: number) => `export function AdminLayout() {\n${lines(n, (i) => `  const x${i} = ${i};`)}\n  return 0;\n}\n`;
		await measuredRuleKeepsIdentity("long-function", { "src/admin.ts": fn(65) }, { "src/admin.ts": fn(80) }, (dir) => runComplexity(dir));
	});

	it("complexity: two long functions in one file stay distinct", async () => {
		const fn = (name: string) => `export function ${name}() {\n${lines(70, (i) => `  const x${i} = ${i};`)}\n  return 0;\n}\n`;
		const dir = project({ "src/two.ts": `${fn("First")}\n${fn("Second")}` });
		const issues = withIssueFingerprints("complexity", runComplexity(dir).issues).filter((i) => i.rule === "long-function");
		expect(issues).toHaveLength(2);
		expect(issues[0].fingerprint).not.toBe(issues[1].fingerprint);
	});
});

describe("v2 duplication identity", () => {
	const block = [
		"function processUser(user: User) {",
		"  const name = user.firstName + ' ' + user.lastName;",
		"  const email = user.email.toLowerCase().trim();",
		"  const age = calculateAge(user.birthDate);",
		"  const isActive = user.status === 'active';",
		"  const role = user.permissions.includes('admin') ? 'admin' : 'user';",
		"  return { name, email, age, isActive, role };",
		"}",
	].join("\n");

	it("inserting lines above both clones keeps the fingerprint", async () => {
		const dir = project({ "src/a.ts": `${block}\n`, "src/b.ts": `${block}\n` });
		const before = fingerprinted(await runDuplication(dir), "duplicate-code");
		// Padding that cannot extend the clone: the token just before the block
		// differs (";" vs "}"), so the maximal clone stays the block itself.
		const padA = lines(5, (i) => `export const alpha${i} = "${"a".repeat(i + 1)}";`);
		const padB = lines(9, (i) => `if (Math.random() > ${i}) { console.log("b${i}"); }`);
		write(dir, { "src/a.ts": `${padA}\n${block}\n`, "src/b.ts": `${padB}\n${block}\n` });
		const after = fingerprinted(await runDuplication(dir), "duplicate-code");
		expect(after.file).not.toBe(before.file); // the :line moved
		expect(after.fingerprint).toBe(before.fingerprint);
	});
});

describe("v2 content anchors for repeated findings", () => {
	const readerFor =
		(files: Record<string, string>): SourceLineReader =>
		(file, line) =>
			files[file]?.split("\n")[line - 1];

	/** One finding per `as any` line, all with the same message — as type-safety emits them. */
	function anyFindings(src: string): Issue[] {
		return src
			.split("\n")
			.flatMap((text, i) =>
				text.includes("as any")
					? [{ severity: "warning" as const, rule: "as-any", message: "Avoid `as any`", file: "src/a.ts", line: i + 1 }]
					: [],
			);
	}

	function fps(src: string): string[] {
		return withIssueFingerprints("type-safety", anyFindings(src), readerFor({ "src/a.ts": src })).map((i) => i.fingerprint!);
	}

	const one = "const a = x as any;";
	const two = "const b = y as any;";
	const three = "const c = z as any;";

	it("two identical findings on different lines get distinct fingerprints", () => {
		const [a, b] = fps(`${one}\n${two}`);
		expect(a).not.toBe(b);
		// In v1 they collided.
		const [v1a, v1b] = anyFindings(`${one}\n${two}`).map((i) => fingerprintIssue("type-safety", i));
		expect(v1a).toBe(v1b);
	});

	it("inserting a third identical finding above them leaves the first two unchanged", () => {
		const [a, b] = fps(`${one}\n${two}`);
		const after = fps(`${three}\n\n${one}\n${two}`);
		expect(after).toHaveLength(3);
		expect(after.slice(1)).toEqual([a, b]);
		expect(new Set(after).size).toBe(3);
	});

	it("identical source lines are told apart by an ordinal, and the first keeps its fingerprint", () => {
		const [solo] = fps(one);
		const [a, b] = fps(`${one}\n${one}`);
		expect(a).not.toBe(b);
		expect(a).toBe(solo);
	});

	it("issues without a line get an ordinal by emission order", () => {
		const iss = { severity: "warning" as const, rule: "r", message: "same" };
		const out = withIssueFingerprints("c", [iss, iss, iss]).map((i) => i.fingerprint);
		expect(new Set(out).size).toBe(3);
		expect(out[0]).toBe(fingerprintIssue("c", iss)); // a lone, unanchored finding keeps its v1 key
	});

	it("fixing one of two identical findings reports exactly that one fixed", () => {
		const src = `${one}\n${two}`;
		const fixedSrc = `const a = x as unknown;\n${two}`;
		const before = v2Report([check("type-safety", withIssueFingerprints("type-safety", anyFindings(src), readerFor({ "src/a.ts": src })))]);
		const after = v2Report([
			check("type-safety", withIssueFingerprints("type-safety", anyFindings(fixedSrc), readerFor({ "src/a.ts": fixedSrc }))),
		]);

		const delta = computeDelta(before, after);
		expect(delta.fixed).toHaveLength(1);
		expect(delta.introduced).toHaveLength(0);
		expect(delta.fixed[0]).toMatchObject({ line: 1 });

		const trend = trendBetween(before, after);
		expect(trend.fixedIssues).toBe(1);
		expect(trend.newIssues).toBe(0);
		expect(trend.fixed?.[0]).toMatchObject({ line: 1 });
	});
});

describe("dependencies counts", () => {
	it("a vulnerability count change still reports a change", () => {
		const a = withIssueFingerprints("dependencies", [{ severity: "error", message: "95 high vulnerabilities" }]);
		const b = withIssueFingerprints("dependencies", [{ severity: "error", message: "96 high vulnerabilities" }]);
		expect(a[0].fingerprint).not.toBe(b[0].fingerprint);

		const delta = computeDelta(v2Report([check("dependencies", a)]), v2Report([check("dependencies", b)]));
		expect(delta.introduced).toHaveLength(1);
		expect(delta.fixed).toHaveLength(1);
	});
});

describe("v1/v2 boundary", () => {
	const src = "const a = x as any;\nconst a = x as any;\nconst b = y as any;";
	const raw: { check: string; issues: Issue[] }[] = [
		{
			check: "type-safety",
			issues: [1, 2, 3].map((line) => ({
				severity: "warning" as const,
				rule: "as-any",
				message: "Avoid `as any`",
				file: "src/a.ts",
				line,
			})),
		},
		{
			check: "standards",
			issues: [{ severity: "warning", rule: "large-file", message: "350 lines — consider splitting", file: "src/a.ts" }],
		},
		{ check: "dependencies", issues: [{ severity: "error", message: "95 high vulnerabilities" }] },
	];
	const reader: SourceLineReader = (file, line) => (file === "src/a.ts" ? src.split("\n")[line - 1] : undefined);

	function v1(): VibeReport {
		const r = report(
			raw.map((c) =>
				check(
					c.check,
					c.issues.map((i) => ({ ...i, fingerprint: fingerprintIssue(c.check, i) })),
				),
			),
		);
		expect(r.meta.fingerprintVersion).toBeUndefined();
		return r;
	}
	function v2(): VibeReport {
		const withSubject = raw.map((c) => ({
			...c,
			issues: c.issues.map((i) => (i.rule === "large-file" ? { ...i, subject: i.file } : i)),
		}));
		return v2Report(withSubject.map((c) => check(c.check, withIssueFingerprints(c.check, c.issues, reader))));
	}

	it("the stored fingerprints really differ across versions", () => {
		const a = v1().checks.flatMap((c) => c.issues.map((i) => (i as FingerprintedIssue).fingerprint));
		const b = v2().checks.flatMap((c) => c.issues.map((i) => (i as FingerprintedIssue).fingerprint));
		expect(b.filter((fp) => !a.includes(fp)).length).toBeGreaterThan(0);
	});

	it("delta between a v1 and a v2 report of unchanged code reports 0 new / 0 fixed, both directions", () => {
		for (const [before, after] of [
			[v1(), v2()],
			[v2(), v1()],
		]) {
			const delta = computeDelta(before, after);
			expect(delta.fixed).toHaveLength(0);
			expect(delta.introduced).toHaveLength(0);
		}
	});

	it("trend between a v1 and a v2 report of unchanged code reports 0 new / 0 fixed", () => {
		const trend = trendBetween(v1(), v2());
		expect(trend.newIssues).toBe(0);
		expect(trend.fixedIssues).toBe(0);
	});
});

describe("scan writes v2", () => {
	it("sets meta.fingerprintVersion and anchors repeated findings to their source lines", async () => {
		const dir = project({ "src/a.ts": "export const a = x as any;\nexport const b = y as any;\n" });
		const result = await scan(dir, { checks: ["type-safety"], skipTests: true });
		expect(result.meta.fingerprintVersion).toBe(FINGERPRINT_VERSION);
		const issues = result.checks.find((c) => c.name === "type-safety")!.issues as FingerprintedIssue[];
		const anys = issues.filter((i) => i.file === "src/a.ts");
		expect(anys.length).toBeGreaterThanOrEqual(2);
		expect(new Set(anys.map((i) => i.fingerprint)).size).toBe(anys.length);
	});
});

function check(name: string, issues: Issue[]): CheckResult {
	return { name, score: 80, grade: "B", details: { status: "passed" }, issues, duration: 1 };
}

function report(checks: CheckResult[]): VibeReport {
	return {
		version: "0.56.0",
		timestamp: "2026-10-05T00:00:00Z",
		score: 80,
		grade: "B",
		checks,
		meta: { cwd: "/tmp", node: "v22", duration: 1, stack: TS_STACK, repoUrl: null, branch: "main" },
	};
}

function v2Report(checks: CheckResult[]): VibeReport {
	const r = report(checks);
	r.meta.fingerprintVersion = FINGERPRINT_VERSION;
	return r;
}

function trendBetween(prev: VibeReport, curr: VibeReport) {
	const dir = mkdtempSync(join(tmpdir(), "vcqa-fp2-trend-"));
	dirs.push(dir);
	writeFileSync(join(dir, "report.json"), JSON.stringify(prev));
	const trend = computeTrend(curr, dir);
	expect(trend).not.toBeNull();
	return trend!;
}
