// MCP servers for tests, on loopback: one speaking 2026-07-28, stateless, and one speaking 2025-06-18, with initialize
// and a session. Each records the requests it got, checks the token when it has one, and answers tools/call with
// what the test's `call` gives.
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
}) {
	const seen: Seen[] = [];
	let session = "s1";
	let sessions = 0;
	const server = createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk as Buffer);
		const raw = Buffer.concat(chunks).toString();
		const body = raw === "" ? {} : JSON.parse(raw);
		seen.push({ method: req.method === "POST" ? body.method : req.method!, headers: req.headers, body });
		const reply = (status: number, value: unknown, headers: Record<string, string> = {}) => {
			res.writeHead(status, { "Content-Type": "application/json", ...headers });
			res.end(JSON.stringify(value));
		};
		const error = (status: number, code: number, message: string, data?: unknown) => reply(status, { jsonrpc: "2.0", id: body.id ?? null, error: { code, message, data } });
		if (options.token !== undefined && req.headers.authorization !== `Bearer ${options.token}`) {
			res.writeHead(401, { "WWW-Authenticate": 'Bearer resource_metadata="http://example.test/.well-known/oauth-protected-resource"' });
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
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise((resolve) => server.close(resolve)));
	return {
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
		seen,
		/** An earlier server forgetting its session, as after a restart. */
		forget: () => {
			session = "gone";
		},
	};
}
