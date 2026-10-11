// The page's requests to src/web.ts, typed by its route tables.
import type { Gets, Posts } from "../src/web.ts";

/** A POST to one of the server's routes, with the body it takes. */
export async function post<P extends keyof Posts>(path: P, body: Posts[P]["body"]): Promise<Posts[P]["answer"]> {
	const response = await fetch(path, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!response.ok) throw new Error(`${path}: ${await response.text()}`);
	// SAFETY: web.ts's route table is checked against Posts, so the route answers with Posts[P]["answer"].
	return response.json() as Promise<Posts[P]["answer"]>;
}

/** A GET of one of the server's routes, with `query` after it. */
export async function load<P extends keyof Gets>(path: P, query = ""): Promise<Gets[P]> {
	const response = await fetch(path + query);
	if (!response.ok) throw new Error(`${path}: ${await response.text()}`);
	// SAFETY: web.ts's route table is checked against Gets, so the route answers with Gets[P].
	return response.json() as Promise<Gets[P]>;
}
