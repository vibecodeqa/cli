import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
});
