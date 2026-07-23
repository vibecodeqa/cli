export interface Env {
	DB: D1Database;
	CACHE: KVNamespace;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/users") {
			const { results } = await env.DB.prepare("SELECT id, email FROM users WHERE active = ?")
				.bind(1)
				.all();
			return Response.json(results);
		}
		return new Response("not found", { status: 404 });
	},
};
