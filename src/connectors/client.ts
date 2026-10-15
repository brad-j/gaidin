// An MCP client for one remote server, over Streamable HTTP: JSON-RPC in a POST, answered with JSON or an event stream.
// It speaks both generations of the protocol. The current one, 2026-07-28, has no handshake: every request carries its
// protocol version and the client's identity in _meta. The earlier ones, 2025-03-26 to 2025-11-25, start with
// `initialize` and may give a session in Mcp-Session-Id. The first request is `server/discover`; a server that answers
// it with an error the current revision doesn't define speaks the earlier one, and the client shakes hands instead.
//
// Only what gaidin uses: tools/list and tools/call. A server that asks the client something mid-call (input_required,
// or a request on the stream from an earlier server) isn't answered. Everything a server sends is read with parse.ts.
import { array, attempt, boolean, isObject, json, type Json, jsonObject, number, object, optional, parse, scalar, string, text } from "../parse.ts";

export const MODERN = "2026-07-28";
/** The earlier revisions it speaks, newest first; `initialize` asks for the first. */
export const LEGACY = ["2025-11-25", "2025-06-18", "2025-03-26"];
/** The most an answer may be, as JSON or a stream. */
const MAX_ANSWER = 5_000_000;
const UNSUPPORTED_VERSION = -32022;
const METHOD_NOT_FOUND = -32601;

/** A tool as the server lists it, and the parameters it mirrors into headers (x-mcp-header). */
export type McpTool = {
	name: string;
	title?: string;
	description?: string;
	inputSchema: { readonly [key: string]: Json };
	annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
};

/** What a call gave back: its content blocks, structured content, and whether the tool says it failed. */
export type CallResult = { content: { readonly [key: string]: Json }[]; structuredContent?: Json; isError: boolean };

/** A JSON-RPC error the server answered with, and the HTTP status it came with. */
export class McpError extends Error {
	readonly code: number | undefined;
	readonly status: number;
	readonly data: Json | undefined;
	constructor(message: string, status: number, code?: number, data?: Json) {
		super(message);
		this.status = status;
		this.code = code;
		this.data = data;
	}
}

/** The server wants a token, or a better one: 401, or 403 with insufficient_scope. `challenge` is its WWW-Authenticate. */
export class AuthRequired extends Error {
	readonly challenge: string | undefined;
	constructor(message: string, challenge: string | undefined) {
		super(message);
		this.challenge = challenge;
	}
}

const rpcError = object({ code: number, message: string, data: optional(json) });
const rpcAnswer = object({ id: optional(json), result: optional(json), error: optional(rpcError), method: optional(string) });
const annotations = object({ readOnlyHint: optional(boolean), destructiveHint: optional(boolean), idempotentHint: optional(boolean), openWorldHint: optional(boolean) });
const toolParser = object({ name: string, title: optional(string), description: optional(string), inputSchema: jsonObject, annotations: optional(annotations) });
const toolsPage = object({ tools: array(json), nextCursor: optional(string) });
const callParser = object({ content: optional(array(jsonObject)), structuredContent: optional(json), isError: optional(boolean), resultType: optional(string) });

/** A header value as the spec has it sent: plain when it's visible ASCII without edge spaces, else base64 in a sentinel. */
export function headerValue(value: string): string {
	const plain = /^[\x21-\x7e]([\x20-\x7e\t]*[\x21-\x7e])?$/.test(value) && !(value.startsWith("=?base64?") && value.endsWith("?="));
	return plain ? value : `=?base64?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/** A tool's parameters to mirror into Mcp-Param-* headers, by their property paths, or why its x-mcp-header marks are invalid. */
export function headerParams(schema: Json): { params: { path: string[]; header: string }[] } | { problem: string } {
	const params: { path: string[]; header: string }[] = [];
	const problems: string[] = [];
	const walk = (node: Json, path: string[], reachable: boolean) => {
		if (Array.isArray(node)) {
			for (const item of node) walk(item, path, false);
			return;
		}
		if (!isObject(node)) return;
		if (node["x-mcp-header"] !== undefined) {
			const header = attempt(node["x-mcp-header"], string);
			const type = attempt(node.type, string);
			if (!reachable || path.length === 0) problems.push(`x-mcp-header on ${path.join(".") || "the schema's root"} isn't reached through properties alone`);
			else if (header === undefined || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header)) problems.push(`x-mcp-header on ${path.join(".")} isn't a header name`);
			else if (type !== "string" && type !== "integer" && type !== "boolean") problems.push(`x-mcp-header on ${path.join(".")} is on a ${type ?? "untyped"} parameter`);
			else if (params.some((p) => p.header.toLowerCase() === header.toLowerCase())) problems.push(`x-mcp-header ${header} is used twice`);
			else params.push({ path, header });
		}
		for (const [key, value] of Object.entries(node)) {
			if (key === "properties" && isObject(value)) for (const [name, child] of Object.entries(value)) walk(child, [...path, name], reachable);
			else if (key !== "x-mcp-header") walk(value, path, false);
		}
	};
	walk(schema, [], true);
	return problems.length > 0 ? { problem: problems.join("; ") } : { params };
}

/** The value at `path` in `args`, as a header carries it, or nothing when it's absent or null. */
function headerArgument(args: Json, path: readonly string[]): string | undefined {
	let value: Json | undefined = args;
	for (const key of path) value = isObject(value) ? value[key] : undefined;
	return value === undefined ? undefined : attempt(value, scalar);
}

export type ClientOptions = {
	url: string;
	/** The bearer token to send, read for each request so a refreshed one is used. */
	token?: () => Promise<string | undefined>;
	/** What gaidin calls itself to the server. */
	clientInfo?: { name: string; version: string };
	/** How long a request may take, unless the call gives a signal; default 60 s. */
	timeoutMs?: number;
	fetch?: typeof fetch;
};

export function mcpClient(options: ClientOptions) {
	const send = options.fetch ?? fetch;
	const clientInfo = options.clientInfo ?? { name: "gaidin", version: "1" };
	let era: { kind: "modern"; serverName?: string; instructions?: string } | { kind: "legacy"; version: string; session?: string; serverName?: string; instructions?: string } | undefined;
	let connecting: Promise<void> | undefined;
	let nextId = 1;

	/** Posts one JSON-RPC request, or a notification without `id`, and gives its result. */
	async function post(method: string, params: { readonly [key: string]: Json }, extra: { name?: string; headers?: Record<string, string>; notify?: boolean; signal?: AbortSignal } = {}): Promise<Json | undefined> {
		const id = nextId++;
		const modern = era === undefined || era.kind === "modern";
		const meta = { "io.modelcontextprotocol/protocolVersion": MODERN, "io.modelcontextprotocol/clientInfo": clientInfo, "io.modelcontextprotocol/clientCapabilities": {} };
		const body = new Map<string, Json>([["jsonrpc", "2.0"]]);
		if (extra.notify !== true) body.set("id", id);
		body.set("method", method);
		body.set("params", modern && method !== "initialize" ? { ...params, _meta: meta } : params);
		const headers = new Headers({ "Content-Type": "application/json", Accept: "application/json, text/event-stream", "Mcp-Method": method, ...extra.headers });
		if (extra.name !== undefined) headers.set("Mcp-Name", headerValue(extra.name));
		if (modern && method !== "initialize") headers.set("MCP-Protocol-Version", MODERN);
		if (era?.kind === "legacy") {
			headers.set("MCP-Protocol-Version", era.version);
			if (era.session !== undefined) headers.set("Mcp-Session-Id", era.session);
		}
		const token = await options.token?.();
		if (token !== undefined) headers.set("Authorization", `Bearer ${token}`);
		const signal = extra.signal ?? AbortSignal.timeout(options.timeoutMs ?? 60_000);
		const response = await send(options.url, { method: "POST", headers, body: JSON.stringify(Object.fromEntries(body)), signal, redirect: "error" });
		const challenge = response.headers.get("www-authenticate") ?? undefined;
		if (response.status === 401 || (response.status === 403 && /insufficient_scope/.test(challenge ?? ""))) {
			await response.body?.cancel();
			throw new AuthRequired(response.status === 401 ? `${new URL(options.url).host} wants signing in` : `${new URL(options.url).host} needs a wider grant`, challenge);
		}
		if (method === "initialize") {
			const session = response.headers.get("mcp-session-id");
			if (session !== null && era?.kind === "legacy") era.session = session;
		}
		if (extra.notify === true || response.status === 202) {
			await response.body?.cancel();
			if (!response.ok) throw new McpError(`${method}: HTTP ${response.status}`, response.status);
			return undefined;
		}
		const type = response.headers.get("content-type") ?? "";
		const answer = type.startsWith("text/event-stream") ? await fromStream(response, id) : await fromJson(response);
		if (answer === undefined) throw new McpError(`${method}: HTTP ${response.status} with no JSON-RPC answer`, response.status);
		if (answer.error !== undefined) throw new McpError(`${method}: ${answer.error.message}`, response.status, answer.error.code, answer.error.data);
		if (!response.ok) throw new McpError(`${method}: HTTP ${response.status}`, response.status);
		return answer.result;
	}

	async function fromJson(response: Response) {
		const body = await read(response);
		try {
			return parse(JSON.parse(body), rpcAnswer, "the server's answer");
		} catch {
			return undefined;
		}
	}

	/** The answer to request `id` on an event stream; notifications and requests to the client on the way are skipped. */
	async function fromStream(response: Response, id: number) {
		const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
		let buffer = "";
		let size = 0;
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) return undefined;
				size += value.length;
				if (size > MAX_ANSWER) throw new Error(`The server's answer is over ${MAX_ANSWER / 1_000_000} MB`);
				buffer += value.replace(/\r\n?/g, "\n");
				let end: number;
				while ((end = buffer.indexOf("\n\n")) >= 0) {
					const event = buffer.slice(0, end);
					buffer = buffer.slice(end + 2);
					const data = event.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
					if (data === "") continue;
					let message;
					try {
						message = parse(JSON.parse(data), rpcAnswer, "the server's event");
					} catch {
						continue;
					}
					if (message.method === undefined && message.id === id) return message;
				}
			}
		} finally {
			await reader.cancel().catch(() => {});
		}
	}

	async function read(response: Response): Promise<string> {
		const body = await response.text();
		if (body.length > MAX_ANSWER) throw new Error(`The server's answer is over ${MAX_ANSWER / 1_000_000} MB`);
		return body;
	}

	/** Which generation the server speaks, found once. */
	async function connect(): Promise<void> {
		if (era !== undefined) return;
		connecting ??= (async () => {
			try {
				const result = await post("server/discover", {});
				const found = parse(result ?? {}, object({ instructions: optional(string), _meta: optional(json) }), "server/discover");
				const info = attempt(found._meta ?? null, object({ "io.modelcontextprotocol/serverInfo": object({ name: string }) }));
				era = { kind: "modern", serverName: info?.["io.modelcontextprotocol/serverInfo"].name, instructions: found.instructions };
			} catch (cause) {
				if (!legacyServer(cause)) throw cause;
				await initialize();
			}
		})().finally(() => (connecting = undefined));
		await connecting;
	}

	/** Whether an error to server/discover says the server speaks an earlier revision. */
	function legacyServer(cause: unknown): boolean {
		if (!(cause instanceof McpError)) return false;
		const error = cause;
		if (error.code === UNSUPPORTED_VERSION) {
			const supported = attempt(error.data ?? null, object({ supported: array(string) }))?.supported ?? [];
			if (supported.includes(MODERN)) return false;
			return supported.some((v) => LEGACY.includes(v));
		}
		// Anything else the current revision doesn't define, such as Method not found or a 404 from an earlier server.
		return error.code === undefined || error.code === METHOD_NOT_FOUND || error.code < -32700 || error.status === 404 || error.status === 405 || error.status === 400;
	}

	async function initialize(): Promise<void> {
		era = { kind: "legacy", version: LEGACY[0]! };
		try {
			const result = await post("initialize", { protocolVersion: LEGACY[0]!, capabilities: {}, clientInfo });
			const found = parse(result ?? {}, object({ protocolVersion: string, instructions: optional(string), serverInfo: optional(object({ name: string })) }), "initialize");
			if (!LEGACY.includes(found.protocolVersion)) throw new Error(`The server speaks MCP ${found.protocolVersion}, which gaidin doesn't`);
			era.version = found.protocolVersion;
			era.serverName = found.serverInfo?.name;
			era.instructions = found.instructions;
			await post("notifications/initialized", {}, { notify: true });
		} catch (error) {
			era = undefined;
			throw error;
		}
	}

	/** Runs `request`, connecting first, and once again after an earlier server forgot its session (404) or a version change. */
	async function run<T>(request: () => Promise<T>): Promise<T> {
		await connect();
		try {
			return await request();
		} catch (error) {
			const lostSession = error instanceof McpError && era?.kind === "legacy" && era.session !== undefined && error.status === 404;
			const otherVersion = error instanceof McpError && error.code === UNSUPPORTED_VERSION;
			if (!lostSession && !otherVersion) throw error;
			era = undefined;
			await connect();
			return request();
		}
	}

	/** Every tool, page by page, leaving out ones whose x-mcp-header marks are invalid, as the spec requires. */
	async function listTools(): Promise<{ tools: McpTool[]; rejected: { name: string; problem: string }[] }> {
		const tools: McpTool[] = [];
		const rejected: { name: string; problem: string }[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < 50; page += 1) {
			const result = await run(() => post("tools/list", cursor === undefined ? {} : { cursor }));
			const found = parse(result ?? {}, toolsPage, "tools/list");
			for (const raw of found.tools) {
				let tool: McpTool;
				try {
					tool = withoutUndefined(parse(raw, toolParser, "a tool"));
				} catch (error) {
					rejected.push({ name: attempt(raw, object({ name: string }))?.name ?? "(no name)", problem: error instanceof Error ? error.message : String(error) });
					continue;
				}
				const headers = headerParams(tool.inputSchema);
				if ("problem" in headers) rejected.push({ name: tool.name, problem: headers.problem });
				else tools.push(tool);
			}
			cursor = found.nextCursor;
			if (cursor === undefined) break;
		}
		return { tools, rejected };
	}

	/** Calls `tool` with `args`, mirroring its marked parameters into headers. */
	async function callTool(tool: McpTool, args: { readonly [key: string]: Json }, signal?: AbortSignal): Promise<CallResult> {
		const headers = new Map<string, string>();
		const marked = headerParams(tool.inputSchema);
		if ("params" in marked) {
			for (const { path, header } of marked.params) {
				const value = headerArgument(args, path);
				if (value !== undefined) headers.set(`Mcp-Param-${header}`, headerValue(value));
			}
		}
		const result = await run(() => post("tools/call", { name: tool.name, arguments: args }, { name: tool.name, headers: Object.fromEntries(headers), signal }));
		const found = parse(result ?? {}, callParser, "tools/call");
		if (found.resultType === "input_required") {
			throw new Error(`The server asked for more input mid-call, which gaidin can't answer yet: ${text(result ?? null, "the request").slice(0, 500)}`);
		}
		const call: CallResult = { content: found.content ?? [], isError: found.isError === true };
		if (found.structuredContent !== undefined) call.structuredContent = found.structuredContent;
		return call;
	}

	/** Ends an earlier server's session, as it asks; nothing for the current revision. */
	async function close(): Promise<void> {
		if (era?.kind !== "legacy" || era.session === undefined) return;
		const headers = new Headers({ "Mcp-Session-Id": era.session, "MCP-Protocol-Version": era.version });
		const token = await options.token?.();
		if (token !== undefined) headers.set("Authorization", `Bearer ${token}`);
		era = undefined;
		await send(options.url, { method: "DELETE", headers, signal: AbortSignal.timeout(5_000) }).then((r) => r.body?.cancel(), () => {});
	}

	return {
		connect,
		listTools,
		callTool,
		close,
		/** The protocol in use, once connected, and what the server says it's called and how to use it. */
		get server() {
			return era === undefined ? undefined : { protocol: era.kind === "modern" ? MODERN : era.version, name: era.serverName, instructions: era.instructions };
		},
	};
}

export type McpClient = ReturnType<typeof mcpClient>;

/** `value` without its undefined fields, which a parsed object keeps and stored JSON can't. */
function withoutUndefined<T extends object>(value: T): T {
	// SAFETY: the same object, its undefined fields left out, which the type already allows to be absent.
	return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

