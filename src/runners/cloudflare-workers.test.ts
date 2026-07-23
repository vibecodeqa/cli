import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCloudflareWorkers } from "./cloudflare-workers.js";

function makeWorker(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "vcqa-cfw-"));
	for (const [name, content] of Object.entries(files)) {
		const full = join(dir, name);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, content);
	}
	return dir;
}

const CLEAN_TOML = `name = "t"
main = "src/index.ts"
compatibility_date = "2026-06-01"

[[kv_namespaces]]
binding = "CACHE"
id = "x"
`;

describe("runCloudflareWorkers", () => {
	it("clean worker scores 100", () => {
		const dir = makeWorker({
			"wrangler.toml": CLEAN_TOML,
			"src/index.ts": `export default { async fetch(req: Request, env: Env) { return new Response(await env.CACHE.get("k")); } };`,
		});
		const r = runCloudflareWorkers(dir);
		expect(r.issues).toEqual([]);
		expect(r.score).toBe(100);
		expect(r.details.bindingsDeclared).toEqual(["CACHE"]);
		expect(r.details.bindingsUsed).toEqual(["CACHE"]);
		rmSync(dir, { recursive: true });
	});

	it("flags secrets committed in [vars]", () => {
		const dir = makeWorker({
			"wrangler.toml": `${CLEAN_TOML}\n[vars]\nAPI_TOKEN = "sk_live_abcdef123456"\nPUBLIC_URL = "https://example.com"\n`,
			"src/index.ts": `export default { fetch(r: Request, env: Env) { return new Response(env.API_TOKEN + env.PUBLIC_URL + env.CACHE); } };`,
		});
		const r = runCloudflareWorkers(dir);
		expect(r.issues.filter((i) => i.rule === "secret-in-vars")).toHaveLength(1);
		expect(r.issues.some((i) => i.message.includes("API_TOKEN"))).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("flags unused and undeclared bindings", () => {
		const dir = makeWorker({
			"wrangler.toml": CLEAN_TOML,
			"src/index.ts": `export default { fetch(r: Request, env: Env) { return Response.json(env.DB); } };`,
		});
		const r = runCloudflareWorkers(dir);
		expect(r.issues.some((i) => i.rule === "unused-binding" && i.message.includes("CACHE"))).toBe(true);
		expect(r.issues.some((i) => i.rule === "undeclared-binding" && i.message.includes("DB"))).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("flags cron trigger without scheduled handler", () => {
		const dir = makeWorker({
			"wrangler.toml": `${CLEAN_TOML}\n[triggers]\ncrons = ["0 * * * *"]\n`,
			"src/index.ts": `export default { fetch(r: Request, env: Env) { return new Response(String(env.CACHE)); } };`,
		});
		const r = runCloudflareWorkers(dir);
		expect(r.issues.some((i) => i.rule === "cron-no-handler")).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("accepts cron when scheduled() exists", () => {
		const dir = makeWorker({
			"wrangler.toml": `${CLEAN_TOML}\n[triggers]\ncrons = ["0 * * * *"]\n`,
			"src/index.ts": `export default { fetch(r: Request, env: Env) { return new Response(String(env.CACHE)); }, async scheduled(ev: unknown, env: Env) {} };`,
		});
		const r = runCloudflareWorkers(dir);
		expect(r.issues.some((i) => i.rule === "cron-no-handler")).toBe(false);
		rmSync(dir, { recursive: true });
	});

	it("flags stale and missing compatibility_date", () => {
		const stale = makeWorker({
			"wrangler.toml": CLEAN_TOML.replace("2026-06-01", "2024-01-01"),
			"src/index.ts": `export default { fetch(r: Request, env: Env) { return new Response(String(env.CACHE)); } };`,
		});
		expect(runCloudflareWorkers(stale).issues.some((i) => i.rule === "stale-compat-date")).toBe(true);
		rmSync(stale, { recursive: true });

		const missing = makeWorker({
			"wrangler.toml": CLEAN_TOML.replace(/compatibility_date.*\n/, ""),
			"src/index.ts": `export default { fetch(r: Request, env: Env) { return new Response(String(env.CACHE)); } };`,
		});
		expect(runCloudflareWorkers(missing).issues.some((i) => i.rule === "no-compat-date")).toBe(true);
		rmSync(missing, { recursive: true });
	});

	it("flags node: imports without nodejs_compat", () => {
		const dir = makeWorker({
			"wrangler.toml": CLEAN_TOML,
			"src/index.ts": `import { Buffer } from "node:buffer";\nexport default { fetch(r: Request, env: Env) { return new Response(String(env.CACHE)); } };`,
		});
		expect(runCloudflareWorkers(dir).issues.some((i) => i.rule === "node-import-no-compat")).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("accepts node: imports when nodejs_compat is set", () => {
		const dir = makeWorker({
			"wrangler.toml": `${CLEAN_TOML}compatibility_flags = ["nodejs_compat"]\n`,
			"src/index.ts": `import { Buffer } from "node:buffer";\nexport default { fetch(r: Request, env: Env) { return new Response(String(env.CACHE)); } };`,
		});
		expect(runCloudflareWorkers(dir).issues.some((i) => i.rule === "node-import-no-compat")).toBe(false);
		rmSync(dir, { recursive: true });
	});

	it("flags missing main entry", () => {
		const dir = makeWorker({
			"wrangler.toml": CLEAN_TOML,
		});
		expect(runCloudflareWorkers(dir).issues.some((i) => i.rule === "missing-main")).toBe(true);
		rmSync(dir, { recursive: true });
	});
});
