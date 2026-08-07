import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectWorkspace } from "../detect.js";
import { buildFileInventory } from "../file-inventory.js";
import { buildEffectiveScanPolicy } from "../scan-policy.js";
import { runSqliteD1 } from "./sqlite-d1.js";

function makeProject(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "vcqa-d1-"));
	writeFileSync(join(dir, "package.json"), "{}");
	for (const [name, content] of Object.entries(files)) {
		const full = join(dir, name);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, content);
	}
	return dir;
}

describe("runSqliteD1", () => {
	it("clean bound query scores 100", () => {
		const dir = makeProject({
			"src/db.ts": `export async function getUser(env: Env, id: string) {
  return env.DB.prepare("SELECT id, email FROM users WHERE id = ?").bind(id).first();
}`,
		});
		const r = runSqliteD1(dir);
		expect(r.issues).toEqual([]);
		expect(r.score).toBe(100);
		expect(r.details.queries).toBe(1);
		rmSync(dir, { recursive: true });
	});

	it("uses FileInventory for source scanning and skips ignored/generated SQL findings", () => {
		const dir = makeProject({
			"src/db.ts": `export async function getUser(env: Env, id: string) {
  return env.DB.prepare("SELECT id, email FROM users WHERE id = ?").bind(id).first();
}`,
			"dist/db.ts": `export const q = (env: Env, name: string) =>
  env.DB.prepare(\`SELECT id FROM users WHERE name = '\${name}'\`).all();`,
			".claude/worktrees/agent-a/src/db.ts": `export const q = (env: Env, name: string) =>
  env.DB.prepare(\`SELECT id FROM users WHERE name = '\${name}'\`).all();`,
		});
		const inventory = buildFileInventory(dir, detectWorkspace(dir), buildEffectiveScanPolicy(dir, {}));
		const result = runSqliteD1(dir, undefined, inventory);
		expect(result.details).toMatchObject({ source: "file-inventory", queries: 1 });
		expect(result.issues.some((i) => i.file?.includes(".claude/worktrees") || i.file?.startsWith("dist/"))).toBe(false);
		rmSync(dir, { recursive: true });
	});

	it("flags template-literal interpolation as injection", () => {
		const dir = makeProject({
			"src/db.ts": `export async function getUser(env: Env, id: string) {
  return env.DB.prepare(\`SELECT id FROM users WHERE id = '\${id}'\`).first();
}`,
		});
		const r = runSqliteD1(dir);
		expect(r.issues.some((i) => i.rule === "sql-interpolation" && i.severity === "error")).toBe(true);
		expect(r.details.interpolated).toBe(1);
		rmSync(dir, { recursive: true });
	});

	it("flags string concatenation as injection", () => {
		const dir = makeProject({
			"src/db.ts": `export async function find(env: Env, name: string) {
  return env.DB.prepare("SELECT id FROM users WHERE name = '" + name + "'").all();
}`,
		});
		expect(runSqliteD1(dir).issues.some((i) => i.rule === "sql-concatenation")).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("does not flag literal-only SQL string concatenation as injection", () => {
		const dir = makeProject({
			"src/db.ts": `export async function get(env: Env, instanceId: string, userId: string) {
  return env.DB.prepare(
    "SELECT i.config AS config, a.config AS agent_config FROM agent_instances i" +
      " LEFT JOIN agents a ON a.id = i.agent_id WHERE i.id = ?1 AND i.user_id = ?2",
  ).bind(instanceId, userId).first();
}`,
		});
		const r = runSqliteD1(dir);
		expect(r.issues.some((i) => i.rule === "sql-concatenation")).toBe(false);
		expect(r.issues.some((i) => i.rule === "sql-interpolation")).toBe(false);
		rmSync(dir, { recursive: true });
	});

	it("allows interpolation of SCREAMING_CASE constants (table-name pattern)", () => {
		const dir = makeProject({
			"src/db.ts": `const TABLE = "users";
export async function all(env: Env) {
  return env.DB.prepare(\`SELECT id FROM \${TABLE} WHERE active = ?\`).bind(1).all();
}`,
		});
		const r = runSqliteD1(dir);
		expect(r.issues.some((i) => i.rule === "sql-interpolation")).toBe(false);
		rmSync(dir, { recursive: true });
	});

	it("flags placeholders declared without bind()", () => {
		const dir = makeProject({
			"src/db.ts": `export async function get(env: Env) {
  const stmt = env.DB.prepare("SELECT id FROM users WHERE id = ?");
  return stmt;
}`,
		});
		expect(runSqliteD1(dir).issues.some((i) => i.rule === "missing-bind")).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("flags queries issued inside a loop (N+1)", () => {
		const dir = makeProject({
			"src/db.ts": `export async function load(env: Env, ids: string[]) {
  const out = [];
  for (const id of ids) {
    out.push(await env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(id).first());
  }
  return out;
}`,
		});
		const r = runSqliteD1(dir);
		expect(r.issues.some((i) => i.rule === "query-in-loop")).toBe(true);
		expect(r.details.queriesInLoops).toBe(1);
		rmSync(dir, { recursive: true });
	});

	it("flags SELECT * as info only", () => {
		const dir = makeProject({
			"src/db.ts": `export const all = (env: Env) => env.DB.prepare("SELECT * FROM users").all();`,
		});
		const r = runSqliteD1(dir);
		const star = r.issues.filter((i) => i.rule === "select-star");
		expect(star).toHaveLength(1);
		expect(star[0].severity).toBe("info");
		expect(r.score).toBe(100); // info does not move the score
		rmSync(dir, { recursive: true });
	});

	it("flags duplicate migration numbers", () => {
		const dir = makeProject({
			"migrations/0001_init.sql": "CREATE TABLE a (id INTEGER PRIMARY KEY);",
			"migrations/0001_dup.sql": "CREATE TABLE b (id INTEGER PRIMARY KEY);",
		});
		const r = runSqliteD1(dir);
		expect(r.issues.some((i) => i.rule === "migration-duplicate" && i.severity === "error")).toBe(true);
		expect(r.details.migrations).toBe(2);
		rmSync(dir, { recursive: true });
	});

	it("flags DROP TABLE without IF EXISTS", () => {
		const dir = makeProject({
			"migrations/0001_init.sql": "DROP TABLE users;\nCREATE TABLE users (id INTEGER PRIMARY KEY);",
		});
		expect(runSqliteD1(dir).issues.some((i) => i.rule === "migration-unsafe-drop")).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("ignores non-SQL strings containing the word select", () => {
		const dir = makeProject({
			"src/ui.ts": `export const label = "Select a user from the list";
export const help = () => "please select one";`,
		});
		const r = runSqliteD1(dir);
		expect(r.issues).toEqual([]);
		expect(r.details.queries).toBe(0);
		rmSync(dir, { recursive: true });
	});

	it("does not flag a closed string literal before a fragment (ESCAPE '\\\\' idiom)", () => {
		const dir = makeProject({
			"src/search.ts": `const scopeFor = (c: string) => " AND " + c + " = ?";
export const find = (env: Env, like: string) => env.DB
  .prepare(\`SELECT id FROM companies WHERE name LIKE ? ESCAPE '\\\\'\${scopeFor("owner_id")} LIMIT ?\`)
  .bind(like, 10).all();`,
		});
		const r = runSqliteD1(dir);
		expect(r.issues.some((i) => i.rule === "sql-interpolation")).toBe(false);
		rmSync(dir, { recursive: true });
	});

	it("does not flag a prepared statement bound later (statement-reuse / batch idiom)", () => {
		const dir = makeProject({
			"src/db.ts": `export async function replaceAll(env: Env, rows: string[]) {
  const insert = env.DB.prepare("INSERT INTO tags (value) VALUES (?)");
  await env.DB.batch(rows.map((r) => insert.bind(r)));
}`,
		});
		const r = runSqliteD1(dir);
		expect(r.issues.some((i) => i.rule === "missing-bind")).toBe(false);
		rmSync(dir, { recursive: true });
	});

	it("still flags a genuine value interpolation inside a string literal", () => {
		const dir = makeProject({
			"src/db.ts": `export const q = (env: Env, name: string) =>
  env.DB.prepare(\`SELECT id FROM users WHERE name = '\${name}'\`).all();`,
		});
		const r = runSqliteD1(dir);
		expect(r.issues.some((i) => i.rule === "sql-interpolation" && i.severity === "error")).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("classifies SQLite JSON path interpolation as identifier/path risk, not value injection", () => {
		const dir = makeProject({
			"src/db.ts": `const CONFIG_OR_EMPTY = "COALESCE(config, '{}')";
export async function setConfig(env: Env, key: string, value: unknown, id: string, userId: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error("bad key");
  return env.DB.prepare(\`
    UPDATE agent_instances
       SET config = json_set(\${CONFIG_OR_EMPTY}, '$.\${key}', json(?1))
     WHERE id = ?2 AND user_id = ?3
  \`).bind(JSON.stringify(value), id, userId).run();
}`,
		});
		const r = runSqliteD1(dir);
		expect(r.issues.some((i) => i.rule === "sql-interpolation")).toBe(false);
		expect(r.issues.some((i) => i.rule === "sql-dynamic-identifier" && i.severity === "warning")).toBe(true);
		rmSync(dir, { recursive: true });
	});

	it("detects multiline D1 chains with a trailing comma before .bind()", () => {
		const dir = makeProject({
			"src/db.ts": `export async function close(env: Env, sessionId: string, instanceId: string, userId: string, status: string) {
  const res = await env.DB.prepare(
    \`UPDATE coding_sessions
       SET status = ?4, ended_at = datetime('now'), updated_at = datetime('now'),
           driver_id = NULL, driver_at = NULL
     WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3 AND status IN ('active', 'suspended')\`,
  )
    .bind(sessionId, instanceId, userId, status)
    .run();
  return res;
}`,
		});
		const r = runSqliteD1(dir);
		expect(r.issues.some((i) => i.rule === "missing-bind")).toBe(false);
		rmSync(dir, { recursive: true });
	});

	it("does not let comments between prepare() and bind() break chain detection", () => {
		const dir = makeProject({
			"src/db.ts": `export async function get(env: Env, id: string) {
  return env.DB.prepare(
    // user's id placeholder is bound below
    "SELECT id FROM users WHERE id = ?",
  )
    // keep the D1 chain readable
    .bind(id)
    .first();
}`,
		});
		const r = runSqliteD1(dir);
		expect(r.issues.some((i) => i.rule === "missing-bind")).toBe(false);
		rmSync(dir, { recursive: true });
	});
});
