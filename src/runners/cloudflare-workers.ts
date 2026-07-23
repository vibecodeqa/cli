/** Cloudflare Workers check — audits wrangler config and worker code together.
 *  Gated centrally via appliesTo { component: ["cloudflare-workers"] }. Advisory
 *  (weight 0) while the rules bed in. */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CheckResult, Issue, WorkspaceInfo } from "../types.js";
import { gradeFromScore } from "../types.js";

const SECRETISH_KEY = /(KEY|TOKEN|SECRET|PASS|PWD|CREDENTIAL|_AUTH$|^AUTH_TOKEN)/i;
/** A committed value only counts as a secret if it has credential-like shape. */
function secretishValue(v: string): boolean {
	if (v.length < 12) return false;
	if (/^(https?:\/\/|true$|false$|\d+$)/.test(v)) return false;
	return /[0-9]/.test(v) && /[a-zA-Z]/.test(v) && !/\s/.test(v);
}
const MAX_AGE_DAYS = 365;

interface WranglerConfig {
	path: string;
	dir: string;
	raw: string;
}

function findConfigs(cwd: string, workspace?: WorkspaceInfo): WranglerConfig[] {
	const dirs = [cwd, ...(workspace?.packages.map((p) => join(cwd, p.path)) ?? [])];
	const configs: WranglerConfig[] = [];
	for (const dir of dirs) {
		for (const name of ["wrangler.toml", "wrangler.json", "wrangler.jsonc"]) {
			const f = join(dir, name);
			if (existsSync(f)) {
				try {
					configs.push({ path: f, dir, raw: readFileSync(f, "utf-8") });
				} catch {
					/* unreadable */
				}
				break;
			}
		}
	}
	return configs;
}

/** Worker source files under the config's dir (src/, functions/, plus the main entry). */
function workerSources(dir: string, mainRel: string | null): { path: string; content: string }[] {
	const out: { path: string; content: string }[] = [];
	const seen = new Set<string>();
	const pushFile = (p: string) => {
		if (seen.has(p) || !existsSync(p)) return;
		seen.add(p);
		try {
			out.push({ path: p, content: readFileSync(p, "utf-8") });
		} catch {
			/* binary/unreadable */
		}
	};
	const walk = (d: string, depth: number) => {
		if (depth > 4 || !existsSync(d)) return;
		let entries: string[];
		try {
			entries = readdirSync(d);
		} catch {
			return;
		}
		for (const e of entries) {
			if (e === "node_modules" || e.startsWith(".")) continue;
			const full = join(d, e);
			try {
				if (statSync(full).isDirectory()) walk(full, depth + 1);
				else if (/\.(ts|js|mjs|tsx|jsx)$/.test(e)) pushFile(full);
			} catch {
				/* race */
			}
		}
	};
	if (mainRel) pushFile(join(dir, mainRel));
	for (const sub of ["src", "functions", "worker"]) walk(join(dir, sub), 0);
	if (mainRel) walk(dirname(join(dir, mainRel)), 3);
	return out;
}

export function runCloudflareWorkers(cwd: string, workspace?: WorkspaceInfo): CheckResult {
	const start = Date.now();
	const issues: Issue[] = [];
	const configs = findConfigs(cwd, workspace);

	if (configs.length === 0) {
		return {
			name: "cloudflare-workers",
			score: 100,
			grade: "A",
			details: { skipped: true, reason: "no wrangler config found" },
			issues: [],
			duration: Date.now() - start,
		};
	}

	const bindingsDeclared: string[] = [];
	const bindingsUsed: string[] = [];
	/** Names declared out-of-band: Env interface/type members in code (the developer's
	 *  own contract — covers `wrangler secret put` secrets) and .dev.vars keys. */
	const envTypeMembers = new Set<string>();
	let compatibilityDate: string | null = null;

	for (const cfg of configs) {
		const rel = cfg.path.slice(cwd.length + 1) || cfg.path;
		const lines = cfg.raw.split("\n");

		// ── compatibility_date ──
		const compat = cfg.raw.match(/compatibility_date\s*=\s*"(\d{4}-\d{2}-\d{2})"/);
		if (!compat) {
			issues.push({
				severity: "warning",
				message: "No compatibility_date in wrangler config — runtime behavior floats",
				file: rel,
				rule: "no-compat-date",
			});
		} else {
			compatibilityDate = compat[1];
			const age = (Date.now() - new Date(compat[1]).getTime()) / 86_400_000;
			if (age > MAX_AGE_DAYS) {
				issues.push({
					severity: "warning",
					message: `compatibility_date ${compat[1]} is over a year old — update it deliberately to pick up runtime fixes`,
					file: rel,
					rule: "stale-compat-date",
				});
			}
		}

		// ── main entry exists ──
		const main = cfg.raw.match(/^\s*main\s*=\s*"([^"]+)"/m)?.[1] ?? null;
		if (main && !existsSync(join(cfg.dir, main))) {
			issues.push({ severity: "error", message: `main = "${main}" does not exist`, file: rel, rule: "missing-main" });
		}

		// ── secrets committed in [vars] ──
		let inVars = false;
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i].trim();
			if (/^\[vars\]/.test(line)) {
				inVars = true;
				continue;
			}
			if (/^\[/.test(line)) inVars = false;
			if (!inVars) continue;
			const kv = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"([^"]*)"/);
			if (!kv) continue;
			bindingsDeclared.push(kv[1]);
			const [, key, value] = kv;
			if (SECRETISH_KEY.test(key) && secretishValue(value)) {
				issues.push({
					severity: "error",
					message: `[vars] ${key} looks like a secret committed to config — use \`wrangler secret put ${key}\``,
					file: rel,
					line: i + 1,
					rule: "secret-in-vars",
				});
			}
		}

		// ── declared bindings (D1/KV/R2/DO/services/queues all use binding = "X") ──
		for (const m of cfg.raw.matchAll(/^\s*binding\s*=\s*"([A-Za-z_][A-Za-z0-9_]*)"/gm)) {
			bindingsDeclared.push(m[1]);
		}

		// ── code-side analysis ──
		const sources = workerSources(cfg.dir, main);
		const code = sources.map((s) => s.content).join("\n");

		// Env interface/type members — secrets set via `wrangler secret put` appear
		// here but never in wrangler config; that is correct, not an error.
		for (const m of code.matchAll(/(?:interface\s+\w*Env\w*(?:\s+extends[^{]+)?|type\s+\w*Env\w*\s*=[^{;]*?)\s*\{([^}]*)\}/g)) {
			for (const mem of m[1].matchAll(/\b([A-Z][A-Z0-9_]{1,40})\s*\??:/g)) envTypeMembers.add(mem[1]);
		}
		const devVars = join(cfg.dir, ".dev.vars");
		if (existsSync(devVars)) {
			try {
				for (const m of readFileSync(devVars, "utf-8").matchAll(/^([A-Z][A-Z0-9_]*)\s*=/gm)) envTypeMembers.add(m[1]);
			} catch {
				/* unreadable */
			}
		}

		for (const m of code.matchAll(/\benv\.([A-Z][A-Z0-9_]{1,40})\b/g)) {
			if (!bindingsUsed.includes(m[1])) bindingsUsed.push(m[1]);
		}
		for (const m of code.matchAll(/\benv\[["']([A-Z][A-Z0-9_]{1,40})["']\]/g)) {
			if (!bindingsUsed.includes(m[1])) bindingsUsed.push(m[1]);
		}

		// crons without a scheduled() handler
		if (/^\s*crons\s*=\s*\[/m.test(cfg.raw) && !/\bscheduled\s*[:(]/.test(code)) {
			issues.push({
				severity: "error",
				message: "Cron trigger declared but no scheduled() handler in worker code — crons fail silently",
				file: rel,
				rule: "cron-no-handler",
			});
		}

		// node: imports without nodejs_compat
		const hasNodeCompat = /nodejs_compat/.test(cfg.raw) || /node_compat\s*=\s*true/.test(cfg.raw);
		if (!hasNodeCompat) {
			const nodeImport = sources.find((s) => /from\s+["']node:|require\(["']node:/.test(s.content));
			if (nodeImport) {
				issues.push({
					severity: "error",
					message: "node: builtin imported but nodejs_compat flag is not set — fails at deploy or runtime",
					file: nodeImport.path.slice(cwd.length + 1),
					rule: "node-import-no-compat",
				});
			}
		}
	}

	// ── declared vs used (across all configs of the project) ──
	const declared = [...new Set(bindingsDeclared)];
	const used = [...new Set(bindingsUsed)];
	for (const b of declared) {
		if (!used.includes(b)) {
			issues.push({
				severity: "warning",
				message: `Binding ${b} is declared but never referenced as env.${b} — dead config or missed wiring`,
				rule: "unused-binding",
			});
		}
	}
	for (const b of used) {
		if (declared.includes(b)) continue;
		if (envTypeMembers.has(b)) {
			// In the code's Env contract but not in config — the normal shape of a
			// `wrangler secret put` secret. Surface as info so the list is auditable.
			issues.push({
				severity: "info",
				message: `env.${b} is in the Env type but not in wrangler config — expected for secrets (verify with \`wrangler secret list\`)`,
				rule: "secret-binding",
			});
		} else {
			issues.push({
				severity: "error",
				message: `Code references env.${b} but nothing declares it (not in wrangler config or the Env type) — likely a typo, crashes at runtime`,
				rule: "undeclared-binding",
			});
		}
	}

	const errors = issues.filter((i) => i.severity === "error").length;
	const warnings = issues.filter((i) => i.severity === "warning").length;
	const score = Math.max(0, Math.min(100, 100 - errors * 15 - warnings * 5));

	return {
		name: "cloudflare-workers",
		score,
		grade: gradeFromScore(score),
		details: {
			configs: configs.map((c) => c.path.slice(cwd.length + 1) || c.path),
			compatibilityDate,
			bindingsDeclared: declared,
			bindingsUsed: used,
			tool: "built-in",
		},
		issues,
		duration: Date.now() - start,
	};
}
