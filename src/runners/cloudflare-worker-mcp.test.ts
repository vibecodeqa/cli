import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scan } from "../core.js";
import { detectComponents } from "../detect.js";
import { runCloudflareWorkerMcp } from "./cloudflare-worker-mcp.js";

function makeProject(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "vcqa-cfw-mcp-"));
	for (const [name, content] of Object.entries(files)) {
		const full = join(dir, name);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, content);
	}
	return dir;
}

const WRANGLER = `name = "mcp-worker"
main = "src/index.ts"
compatibility_date = "2026-06-01"
`;

describe("runCloudflareWorkerMcp", () => {
	it("scores a Worker MCP server using Cloudflare helpers and smoke evidence cleanly", () => {
		const dir = makeProject({
			"package.json": JSON.stringify({
				dependencies: { "@modelcontextprotocol/server": "^2.0.0", agents: "^0.20.0", zod: "^4.0.0" },
				devDependencies: { vitest: "^4.0.0" },
			}),
			"wrangler.toml": WRANGLER,
			"src/index.ts": `
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

const repoSchema = z.object({ repo: z.string().min(3) });

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (url.pathname === "/.well-known/oauth-protected-resource") {
      return Response.json({ resource: url.origin + "/mcp", authorization_servers: [env.AUTH_ISSUER] });
    }
    const auth = request.headers.get("Authorization");
    const token = auth?.replace(/^Bearer\\s+/, "");
    if (!token || token !== env.MCP_BEARER_TOKEN) {
      return new Response("unauthorized", {
        status: 401,
        headers: { "WWW-Authenticate": 'Bearer resource_metadata="/.well-known/oauth-protected-resource"' },
      });
    }
    return createMcpHandler((server) => {
      server.tool("vcqa_score", { repo: repoSchema.shape.repo }, async (args) => {
        repoSchema.parse(args);
        return { content: [{ type: "text", text: "ok" }] };
      });
    })(request, env);
  },
};
`,
			"test/mcp-smoke.test.ts": `
import { describe, expect, it } from "vitest";
describe("mcp smoke", () => {
  it("covers protocol and auth", async () => {
    expect("initialize").toBeTruthy();
    expect("tools/list").toBeTruthy();
    expect("tools/call").toBeTruthy();
    expect("WWW-Authenticate 401 Authorization").toContain("401");
  });
});
`,
		});

		const result = runCloudflareWorkerMcp(dir);
		expect(result.issues).toEqual([]);
		expect(result.score).toBe(100);
		expect(result.details).toMatchObject({
			detectedMcpRoutes: ["/.well-known/oauth-protected-resource", "/mcp"],
			sdkHelper: { kind: "cloudflare-helper", value: "createMcpHandler" },
			authModeEvidence: { hasBearer: true, validatesToken: true, hasProtectedResourceMetadata: true },
			toolCountEvidence: { toolsDetected: 1 },
		});
		rmSync(dir, { recursive: true });
	});

	it("flags hand-rolled Worker JSON-RPC with weak bearer checks and no smoke evidence", () => {
		const dir = makeProject({
			"package.json": JSON.stringify({ dependencies: { "@modelcontextprotocol/server": "^2.0.0" } }),
			"wrangler.toml": WRANGLER,
			"src/mcp.ts": `
interface JsonRpcRequest { jsonrpc: "2.0"; id?: string | number; method: string; params?: Record<string, unknown>; }
const MCP_TOOLS = [{ name: "vcqa_score", inputSchema: { type: "object", properties: { repo: { type: "string" } }, required: ["repo"] } }];
function jsonRpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
export async function handleMcp(request: Request, env: Env): Promise<Response> {
  const auth = request.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return Response.json(jsonRpcError(null, -32000, "unauthorized"), { status: 401 });
  const body = await request.json() as JsonRpcRequest;
  if (body.method === "initialize") {
    return Response.json({ jsonrpc: "2.0", id: body.id ?? null, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} } } });
  }
  if (body.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: body.id ?? null, result: { tools: MCP_TOOLS } });
  if (body.method === "tools/call") {
    const params = body.params as { name: string; arguments?: Record<string, unknown> };
    return Response.json({ jsonrpc: "2.0", id: body.id ?? null, result: await callTool(params.name, params.arguments || {}, env) });
  }
  return Response.json(jsonRpcError(body.id ?? null, -32601, "method not found"));
}
async function callTool(name: string, args: Record<string, unknown>, env: Env) {
  return { content: [{ type: "text", text: String(args.repo ?? env.REPORTS) }] };
}
export default { fetch: handleMcp };
`,
		});

		const result = runCloudflareWorkerMcp(dir);
		const rules = result.issues.map((issue) => issue.rule);
		expect(rules).toEqual(expect.arrayContaining(["R-PROTO-1", "R-PROTO-5", "R-AUTH-1", "R-AUTH-2", "R-VAL-1", "R-DEPLOY-3"]));
		expect(result.details).toMatchObject({
			sdkHelper: { kind: "none" },
			authModeEvidence: { hasBearer: true, validatesToken: false, hasProtectedResourceMetadata: false },
			source: "legacy-walk",
		});
		rmSync(dir, { recursive: true });
	});

	it("is centrally gated off unless both Worker and MCP components are detected", async () => {
		const workerOnly = makeProject({
			"package.json": JSON.stringify({ dependencies: {} }),
			"wrangler.toml": WRANGLER,
			"src/index.ts": `export default { fetch() { return new Response("ok"); } };`,
		});
		expect(detectComponents(workerOnly)).toEqual(["cloudflare-workers"]);
		let report = await scan(workerOnly, { skipTests: true, checks: ["cloudflare-worker-mcp"] });
		expect(report.checks[0]?.details.skipped).toBe(true);
		expect(report.checks[0]?.details.reason).toContain("cloudflare-workers + mcp-server");
		rmSync(workerOnly, { recursive: true });

		const stdioMcp = makeProject({
			"package.json": JSON.stringify({ dependencies: { "@modelcontextprotocol/sdk": "^1.30.0" } }),
			"src/index.ts": `import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";`,
		});
		expect(detectComponents(stdioMcp)).toEqual(["mcp-server"]);
		report = await scan(stdioMcp, { skipTests: true, checks: ["cloudflare-worker-mcp"] });
		expect(report.checks[0]?.details.skipped).toBe(true);
		expect(report.checks[0]?.details.reason).toContain("cloudflare-workers + mcp-server");
		rmSync(stdioMcp, { recursive: true });
	});

	it("uses FileInventory through scan and omits generated Worker MCP outputs", async () => {
		const dir = makeProject({
			"package.json": JSON.stringify({ dependencies: { "@modelcontextprotocol/server": "^2.0.0" } }),
			"wrangler.toml": WRANGLER.replace('main = "src/index.ts"', 'main = "dist/index.js"'),
			"src/index.ts": `
import { createMcpHandler } from "agents/mcp/server";
export default { fetch(request: Request, env: Env) {
  const token = request.headers.get("Authorization")?.replace(/^Bearer\\s+/, "");
  if (!token || token !== env.MCP_BEARER_TOKEN) return new Response("unauthorized", { status: 401, headers: { "WWW-Authenticate": 'Bearer resource_metadata="/.well-known/oauth-protected-resource"' } });
  return createMcpHandler(() => {})(request, env);
} };
`,
			"dist/index.js": `
export default { async fetch(request) {
  const body = await request.json();
  if (body.method === "tools/call") return Response.json({ jsonrpc: "2.0", result: body.params.arguments || {} });
} };
`,
			"test/mcp-smoke.test.ts": `expect("initialize tools/list tools/call WWW-Authenticate 401 Authorization").toBeTruthy();`,
		});

		const report = await scan(dir, { skipTests: true, checks: ["cloudflare-worker-mcp"] });
		const result = report.checks[0]!;

		expect(result.details).toMatchObject({ source: "file-inventory", sdkHelper: { kind: "cloudflare-helper" } });
		expect(result.issues.some((issue) => issue.file?.startsWith("dist/"))).toBe(false);
		rmSync(dir, { recursive: true });
	});
});
