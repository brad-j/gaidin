// MCP servers for tests, on loopback: one speaking 2026-07-28, stateless, and one speaking 2025-06-18, with initialize
// and a session. Each records the requests it got, checks the token when it has one, and answers tools/call with
// what the test's `call` gives.
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { TestContext } from "node:test";

export type FakeTool = { name: string; description?: string; inputSchema: Record<string, unknown>; annotations?: Record<string, boolean> };
export type Seen = { method: string; headers: IncomingMessage["headers"]; body: any };

export async function fakeMcp(t: TestContext, options: {
	era: "modern" | "legacy";
	tools: () => FakeTool[];
	call?: (name: string, args: any, headers: IncomingMessage["headers"]) => any;
	token?: string;
	/** Answer tools/call on an event stream, with a progress notification first. */
	stream?: boolean;
	/** Tools per page of tools/list. */
	page?: number;
	/**
	 * An authorization server on the same host, as Home Assistant has: resource metadata at the root, and client id
	 * documents (IndieAuth: the redirect on the client id's host) or, with `register`, Dynamic Client Registration.
	 * Access tokens it issues are what the MCP endpoint takes.
	 */
	oauth?: { register?: boolean; challenge?: boolean };
}) {
	const seen: Seen[] = [];
	let session = "s1";
	let sessions = 0;
	const codes = new Map<string, { clientId: string; redirect: string; challenge: string }>();
	const live = new Set<string>();
	const refreshes = new Set<string>();
	const registered = new Set<string>();
	let issued = 0;
	const auth = { tokenRequests: [] as Record<string, string>[], authorizeRequests: [] as URLSearchParams[] };
	const server = createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk as Buffer);
		const raw = Buffer.concat(chunks).toString();
		const url = new URL(req.url ?? "/", base());
		if (options.oauth !== undefined && url.pathname !== "/mcp") {
			const send = (status: number, value: unknown) => {
				res.writeHead(status, { "Content-Type": "application/json" });
				res.end(JSON.stringify(value));
			};
			if (url.pathname === "/.well-known/oauth-protected-resource") return send(200, { resource: base(), authorization_servers: [base()] });
			if (url.pathname === "/.well-known/oauth-authorization-server") {
				return send(200, {
					issuer: base(),
					authorization_endpoint: `${base()}/auth/authorize`,
					token_endpoint: `${base()}/auth/token`,
					...(options.oauth.register === true ? { registration_endpoint: `${base()}/register` } : { client_id_metadata_document_supported: true }),
					code_challenge_methods_supported: ["S256"],
				});
			}
			if (url.pathname === "/register") {
				const id = `registered-${registered.size + 1}`;
				registered.add(id);
				return send(201, { client_id: id });
			}
			if (url.pathname === "/auth/authorize") {
				// The owner signs in here; it sends the browser back with a code.
				auth.authorizeRequests.push(url.searchParams);
				const clientId = url.searchParams.get("client_id") ?? "";
				const redirect = url.searchParams.get("redirect_uri") ?? "";
				const sameHost = URL.parse(clientId)?.origin === URL.parse(redirect)?.origin;
				if (!(options.oauth.register === true ? registered.has(clientId) : sameHost) || url.searchParams.get("code_challenge_method") !== "S256") return send(400, { error: "invalid_request" });
				const code = `code-${codes.size + 1}`;
				codes.set(code, { clientId, redirect, challenge: url.searchParams.get("code_challenge") ?? "" });
				res.writeHead(302, { Location: `${redirect}?code=${code}&state=${encodeURIComponent(url.searchParams.get("state") ?? "")}&iss=${encodeURIComponent(base())}` });
				return res.end();
			}
			if (url.pathname === "/auth/token") {
				const form = Object.fromEntries(new URLSearchParams(raw));
				auth.tokenRequests.push(form);
				const issue = () => {
					const token = `access-${++issued}`;
					live.add(token);
					const refresh = `refresh-${issued}`;
					refreshes.add(refresh);
					return send(200, { access_token: token, token_type: "Bearer", expires_in: 1800, refresh_token: refresh });
				};
				if (form.grant_type === "refresh_token") return refreshes.has(form.refresh_token ?? "") ? issue() : send(400, { error: "invalid_grant" });
				const code = codes.get(form.code ?? "");
				codes.delete(form.code ?? "");
				const verified = code !== undefined && createHash("sha256").update(form.code_verifier ?? "").digest("base64url") === code.challenge;
				if (!verified || code.clientId !== form.client_id || code.redirect !== form.redirect_uri) return send(400, { error: "invalid_grant" });
				return issue();
			}
			return send(404, {});
		}
		const body = raw === "" ? {} : JSON.parse(raw);
		seen.push({ method: req.method === "POST" ? body.method : req.method!, headers: req.headers, body });
		const reply = (status: number, value: unknown, headers: Record<string, string> = {}) => {
			res.writeHead(status, { "Content-Type": "application/json", ...headers });
			res.end(JSON.stringify(value));
		};
		const error = (status: number, code: number, message: string, data?: unknown) => reply(status, { jsonrpc: "2.0", id: body.id ?? null, error: { code, message, data } });
		const bearer = req.headers.authorization?.replace(/^Bearer /, "");
		const refused = options.oauth !== undefined ? bearer === undefined || !live.has(bearer) : options.token !== undefined && bearer !== options.token;
		if (refused) {
			const challenge = options.oauth !== undefined && options.oauth.challenge !== true ? {} : { "WWW-Authenticate": `Bearer resource_metadata="${base()}/.well-known/oauth-protected-resource"` };
			res.writeHead(401, challenge);
			return res.end();
		}
		if (req.method === "DELETE") {
			res.writeHead(200);
			return res.end();
		}
		const result = (value: unknown, headers: Record<string, string> = {}) => reply(200, { jsonrpc: "2.0", id: body.id, result: options.era === "modern" ? { resultType: "complete", ...(value as object) } : value }, headers);
		if (options.era === "legacy") {
			if (body.method === "initialize") {
				session = `s${++sessions}`;
				return result({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "old-server", version: "1" } }, { "Mcp-Session-Id": session });
			}
			if (req.headers["mcp-session-id"] === undefined) return error(400, -32000, "Bad Request: No valid session ID provided");
			if (req.headers["mcp-session-id"] !== session) return error(404, -32001, "Session not found");
			if (body.method === "notifications/initialized") {
				res.writeHead(202);
				return res.end();
			}
		} else {
			const version = body.params?._meta?.["io.modelcontextprotocol/protocolVersion"];
			if (req.headers["mcp-protocol-version"] !== "2026-07-28" || version !== "2026-07-28") return error(400, -32020, "Header mismatch");
			if (req.headers["mcp-method"] !== body.method) return error(400, -32020, "Header mismatch");
			if (body.method === "server/discover") return result({ supportedVersions: ["2026-07-28"], capabilities: { tools: {} }, _meta: { "io.modelcontextprotocol/serverInfo": { name: "new-server", version: "1" } } });
		}
		if (body.method === "tools/list") {
			const all = options.tools();
			const size = options.page ?? 100;
			const from = Number(body.params?.cursor ?? 0);
			const next = from + size < all.length ? String(from + size) : undefined;
			const page = new Map<string, unknown>([["tools", all.slice(from, from + size)], ["ttlMs", 0], ["cacheScope", "private"]]);
			if (next !== undefined) page.set("nextCursor", next);
			return result(Object.fromEntries(page));
		}
		if (body.method === "tools/call") {
			if (options.era === "modern" && req.headers["mcp-name"] === undefined) return error(400, -32020, "Header mismatch");
			const answer = options.call?.(body.params.name, body.params.arguments, req.headers) ?? { content: [{ type: "text", text: "done" }] };
			if (options.stream !== true) return result(answer);
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } })}\n\n`);
			res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: options.era === "modern" ? { resultType: "complete", ...answer } : answer })}\n\n`);
			return;
		}
		return error(404, -32601, "Method not found");
	});
	const base = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise((resolve) => server.close(resolve)));
	return {
		auth,
		/** Every access token stops working, as when they expire; refresh tokens still do. */
		expire: () => live.clear(),
		/** Refresh tokens stop working too, as when the owner revokes gaidin's access. */
		revoke: () => {
			live.clear();
			refreshes.clear();
		},
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
		seen,
		/** An earlier server forgetting its session, as after a restart. */
		forget: () => {
			session = "gone";
		},
	};
}
