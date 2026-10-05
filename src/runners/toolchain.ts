/** Toolchain availability probes for delegated tools.
 *
 * A command that never ran must not be read as "the tool ran and found
 * nothing". Runners shell out as `<tool> … 2>/dev/null || true`, which forces
 * exit 0 and throws stderr away, so a missing SDK reaches the parser as empty
 * output — and empty output parses as zero findings, which scores as a perfect
 * pass. That is how a Flutter repo scanned without the Dart SDK reported
 * `lint A/100` and `types A/100` (#92).
 *
 * Unmasking the real exit codes is the general fix and belongs to #26. Until
 * then a runner that is about to delegate to the Dart SDK asks here first, and
 * returns an *unavailable* result rather than a score if the SDK is absent.
 * Runners that delegate to a tool resolved from the project's own dependencies
 * (tsc, a project ESLint config, knip) ask `probeDependencies` the same way (#100).
 *
 * `unavailable` is deliberately not `not-applicable`: the stack was detected,
 * the tool was not. Both are excluded from the composite score (#52 — a missing
 * SDK is not a code defect), but only one of them is something the user can fix
 * by installing something.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseYamlList } from "../detect.js";
import type { CheckResult } from "../types.js";
import { run } from "./exec.js";

/** What the user is told when the Dart SDK is not installed. */
export const DART_SDK_MISSING_REASON = "Dart SDK not installed — install Dart/Flutter to analyze this repo";

let dartProbe: { path: string; available: boolean } | null = null;

/** True when a Dart SDK is on PATH.
 *
 * Probed with a bare `dart --version` — no `|| true`, so a missing binary is a
 * real non-zero exit and is recorded as such in the tool log. The result is
 * cached against PATH, so a scan pays for one probe while a PATH change (a
 * test, a long-lived monitor process) still re-probes instead of answering
 * from a stale cache. */
export function hasDartSdk(cwd: string): boolean {
	const path = process.env.PATH ?? "";
	if (dartProbe && dartProbe.path === path) return dartProbe.available;
	const available = run("dart --version", cwd, 10_000).ok;
	dartProbe = { path, available };
	return available;
}

// ── Project dependencies (#100) ──
//
// `npx tsc`, `npx eslint` and `npx knip` all run *against the project's own
// dependencies*: its compiler and `@types`, its ESLint config's plugins, the
// packages knip's plugins key off. On a checkout nobody has installed, npx
// either fetches some unrelated package or the tool runs half-blind — and the
// output, masked by `|| true`, scores as if the check had happened.

/** What a dependency probe found for one project directory. */
export interface DependencyProbe {
	/** True when the project's declared dependencies resolve from this directory. */
	installed: boolean;
	/** The package manager inferred from the nearest lockfile (npm when none). */
	packageManager: "npm" | "pnpm" | "yarn" | "bun";
	/** The package.json the probe read, or null when there is none. */
	manifest: string | null;
	/** How many dependencies the manifest declares (dependencies + devDependencies). */
	declared: number;
	/** True when a Yarn Plug'n'Play map is on the path (no node_modules to inspect). */
	pnp: boolean;
}

const depProbes = new Map<string, { fingerprint: string; probe: DependencyProbe }>();

/** Every ancestor of `dir` (inclusive), nearest first, up to the filesystem root. */
function ancestors(dir: string): string[] {
	const out: string[] = [];
	let current = resolve(dir);
	for (;;) {
		out.push(current);
		const parent = dirname(current);
		if (parent === current) return out;
		current = parent;
	}
}

/** Is `dir` the same directory as `root`, or inside it? */
function isWithin(dir: string, root: string): boolean {
	const rel = relative(root, dir);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Match a workspace glob (`packages/*`, `apps/**`, `tools/cli`) against a
 *  POSIX relative path. Only the shapes package managers document. */
function workspaceGlobMatches(glob: string, rel: string): boolean {
	const pattern = glob.replace(/^\.\//, "").replace(/\/+$/, "").split("/").filter(Boolean);
	if (pattern.length === 0) return false;
	const segment = (p: string) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`);
	const match = (p: string[], r: string[]): boolean => {
		if (p.length === 0) return r.length === 0;
		if (p[0] === "**") return match(p.slice(1), r) || (r.length > 0 && match(p, r.slice(1)));
		return r.length > 0 && segment(p[0]!).test(r[0]!) && match(p.slice(1), r.slice(1));
	};
	return match(pattern, rel.split("/").filter(Boolean));
}

/** The workspace globs `dir` declares (pnpm-workspace.yaml or package.json
 *  `workspaces`), or null when `dir` is not a workspace root. */
function workspaceGlobs(dir: string): string[] | null {
	const pnpmManifest = join(dir, "pnpm-workspace.yaml");
	if (existsSync(pnpmManifest)) {
		try {
			return parseYamlList(readFileSync(pnpmManifest, "utf-8"), "packages");
		} catch {
			return [];
		}
	}
	const manifest = join(dir, "package.json");
	if (!existsSync(manifest)) return null;
	try {
		const ws = JSON.parse(readFileSync(manifest, "utf-8"))?.workspaces;
		if (Array.isArray(ws)) return ws;
		if (ws && Array.isArray(ws.packages)) return ws.packages;
	} catch {
		/* unreadable manifest — not a workspace root */
	}
	return null;
}

/** The directory whose installs count for a scan of `scanRoot`.
 *
 * That is the scan root itself — an install somewhere above the project being
 * scanned is not *its* install (#100: a nested project under an installed parent
 * resolved the parent's `typescript`, and `tsc` ran half-blind). The one
 * exception is a scan root that is a member of an enclosing workspace: npm, yarn
 * and bun hoist its dependencies to the workspace root, so the boundary widens
 * to that root. Membership is read from the nearest workspace manifest above the
 * scan root and must match one of its package globs (negations honoured). */
export function installBoundary(scanRoot: string): string {
	const root = resolve(scanRoot);
	for (const dir of ancestors(root).slice(1)) {
		const globs = workspaceGlobs(dir);
		if (globs === null) continue;
		const rel = relative(dir, root).split(sep).join("/");
		const included = globs.some((g) => !g.startsWith("!") && workspaceGlobMatches(g, rel));
		const excluded = globs.some((g) => g.startsWith("!") && workspaceGlobMatches(g.slice(1), rel));
		return included && !excluded ? dir : root;
	}
	return root;
}

/** The directories Node would search for `dir`'s dependencies, nearest first,
 *  stopping at the install boundary of `scanRoot`. A `dir` outside that
 *  boundary is searched on its own. */
function searchPath(dir: string, scanRoot: string): string[] {
	const boundary = installBoundary(scanRoot);
	const all = ancestors(dir);
	if (!isWithin(all[0]!, boundary)) return [all[0]!];
	return all.filter((d) => isWithin(d, boundary));
}

/** Which ancestors hold an install (node_modules or a Yarn PnP map). This is
 *  what an `install` changes, so it keys the cache: a long-lived process that
 *  sees the user install re-probes instead of answering from a stale result. */
function installFingerprint(dirs: string[]): string {
	return dirs
		.map(
			(d) =>
				(existsSync(join(d, "node_modules")) ? "n" : "") + (existsSync(join(d, ".pnp.cjs")) || existsSync(join(d, ".pnp.js")) ? "p" : ""),
		)
		.join("|");
}

function inferPackageManager(dirs: string[]): DependencyProbe["packageManager"] {
	// Same precedence as detect.ts, nearest directory first.
	for (const d of dirs) {
		if (existsSync(join(d, "pnpm-lock.yaml"))) return "pnpm";
		if (existsSync(join(d, "bun.lockb")) || existsSync(join(d, "bun.lock"))) return "bun";
		if (existsSync(join(d, "yarn.lock"))) return "yarn";
		if (existsSync(join(d, "package-lock.json"))) return "npm";
	}
	return "npm";
}

/** Probe whether the dependencies of the project at `dir` are installed.
 *
 * `scanRoot` is the directory being scanned. The lookup never leaves its
 * install boundary (see `installBoundary`): what is installed above the
 * project being scanned says nothing about the project's own install.
 *
 * Reads the nearest package.json at or above `dir` — the package that declares
 * the dependencies — and asks whether any of its `dependencies` /
 * `devDependencies` resolves the way Node would resolve it: a
 * `node_modules/<name>` in that directory or an ancestor within the boundary, so
 * workspace-root hoisting (npm, yarn, bun) and pnpm's per-package symlinks both
 * count. A Yarn Plug'n'Play map (`.pnp.cjs`) on the path counts as installed too.
 *
 * "Any", not "all": optional and platform-specific packages are legitimately
 * absent from a good install, while a checkout nobody installed resolves none.
 * A manifest that declares nothing has nothing to install, so it passes.
 *
 * Cached per directory and boundary against the install fingerprint of the
 * searched directories. */
export function probeDependencies(dir: string, scanRoot: string): DependencyProbe {
	const dirs = searchPath(dir, scanRoot);
	const key = dirs.join("\u0000");
	const fingerprint = installFingerprint(dirs);
	const cached = depProbes.get(key);
	if (cached && cached.fingerprint === fingerprint) return cached.probe;

	const packageManager = inferPackageManager(dirs);
	const manifestDir = dirs.find((d) => existsSync(join(d, "package.json")));
	let declaredNames: string[] = [];
	if (manifestDir) {
		try {
			const pkg = JSON.parse(readFileSync(join(manifestDir, "package.json"), "utf-8"));
			declaredNames = [...Object.keys(pkg?.dependencies ?? {}), ...Object.keys(pkg?.devDependencies ?? {})];
		} catch {
			/* unreadable manifest — treat as declaring nothing */
		}
	}
	const pnp = fingerprint.includes("p");
	const installed = declaredNames.length === 0 || pnp || declaredNames.some((name) => resolvesFrom(dirs, name));

	const probe: DependencyProbe = {
		installed,
		packageManager,
		manifest: manifestDir ? join(manifestDir, "package.json") : null,
		declared: declaredNames.length,
		pnp,
	};
	depProbes.set(key, { fingerprint, probe });
	return probe;
}

/** Does `node_modules/<name>` exist in any of `dirs` — Node's lookup path? */
function resolvesFrom(dirs: string[], name: string): boolean {
	return dirs.some((d) => existsSync(join(d, "node_modules", name)));
}

/** What the user is told when a project's dependencies are not installed. */
export function dependenciesMissingReason(packageManager: DependencyProbe["packageManager"]): string {
	return `dependencies not installed — run \`${packageManager} install\``;
}

/** Why a tool cannot run against the project at `dir`, or null when it can.
 *
 * `scanRoot` bounds the lookup exactly as in `probeDependencies`.
 *
 * Fails when the project's dependencies are not installed at all, and — when
 * `toolPackage` is given — when that package does not resolve from `dir`. The
 * second case matters for `npx <bin>`: with nothing local to resolve, npx
 * fetches a package from the registry instead (for `tsc`, an unrelated package
 * of that name), so the run measures nothing about the project. That happens
 * at a monorepo root whose packages, not the root, declare the tool. */
export function dependencyGap(dir: string, scanRoot: string, toolPackage?: string): string | null {
	const deps = probeDependencies(dir, scanRoot);
	if (!deps.installed) return dependenciesMissingReason(deps.packageManager);
	if (toolPackage && !deps.pnp && !resolvesFrom(searchPath(dir, scanRoot), toolPackage)) {
		return `${dependenciesMissingReason(deps.packageManager)} (${toolPackage} does not resolve from this project)`;
	}
	return null;
}

/** Forget every probed result. Tests use this; nothing in a scan should need it. */
export function resetToolchainProbes(): void {
	dartProbe = null;
	depProbes.clear();
}

/** A check result meaning "this check applies here, but its tool is missing".
 *
 * `skipped: true` is what `score.ts` reads to drop the check from the weighted
 * composite; `unavailable: true` is what `core.ts` reads to report it as
 * *unavailable* rather than *not applicable*. The 0/F is normalized away by
 * `normalizeCheckResult` — an excluded check renders as a skip, not a fail. */
export function unavailableResult(name: string, reason: string, details: Record<string, unknown>, start: number): CheckResult {
	return {
		name,
		score: 0,
		grade: "F",
		details: { ...details, skipped: true, unavailable: true, reason },
		issues: [],
		duration: Date.now() - start,
	};
}
