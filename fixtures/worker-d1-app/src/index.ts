export interface Env {
	DB: D1Database;
	CACHE: KVNamespace;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/users") {
			const cached = await env.CACHE.get("users");
			if (cached) return Response.json(JSON.parse(cached));
			const { results } = await env.DB.prepare("SELECT id, email FROM users WHERE active = ?")
				.bind(1)
				.all();
			await env.CACHE.put("users", JSON.stringify(results), { expirationTtl: 60 });
			return Response.json(results);
		}
		return new Response("not found", { status: 404 });
	},
};
