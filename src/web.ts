// Web view of the root conversation: the live transcript, a message box, a stop button, open reminders
// and the agent's settings. It listens on loopback only; `tailscale serve` puts HTTPS in front and adds
// Tailscale-User-Login, and only GAIDIN_WEB_USER is let in.
//
// The page is web/index.html and web/app.ts, with its types stripped as it's served.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { resolve } from "node:path";
import { type Conversation, type Harness, type ModelRef, type ToolRegistration, watchEvents } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { context } from "./host.ts";
import { Reminders, removeReminder } from "./reminders.ts";
import { stamp } from "./time.ts";

const WEB_DIR = resolve(import.meta.dirname, "../web");
const THINKING = ["off", "low", "medium", "high"] as const;
const ANTHROPIC_MODELS = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"];
/** Tools the page can switch off. The reminder tools stay on. */
const SWITCHABLE: readonly ToolRegistration[] = CodingTools.tools ?? [];

export type Settings = {
	model: string;
	models: string[];
	thinkingLevel: string;
	instructions: string;
	tools: { name: string; enabled: boolean }[];
};

export function createWebServer(options: { harness: Harness; root: Conversation; user: string }) {
	const { harness, root, user } = options;
	const page = readFileSync(resolve(WEB_DIR, "index.html"));
	const script = stripTypeScriptTypes(readFileSync(resolve(WEB_DIR, "app.ts"), "utf8"));

	async function settings(): Promise<Settings> {
		const agent = await root.agent(context);
		const model = agent.model ?? { provider: "", modelId: "" };
		const offered = new Set(agent.tools.map((t) => t.name));
		return {
			model: model.modelId,
			models: model.provider === "anthropic" ? [...new Set([...ANTHROPIC_MODELS, model.modelId])] : [model.modelId],
			thinkingLevel: agent.thinkingLevel,
			instructions: agent.instructions ?? "",
			tools: SWITCHABLE.map((t) => ({ name: t.name, enabled: offered.has(t.name) })),
		};
	}

	async function configure(body: Record<string, unknown>) {
		const current = await settings();
		const modelId = String(body.model ?? current.model);
		if (!current.models.includes(modelId)) throw new HttpError(400, `Unknown model ${modelId}`);
		const thinkingLevel = String(body.thinkingLevel ?? current.thinkingLevel);
		if (!(THINKING as readonly string[]).includes(thinkingLevel)) throw new HttpError(400, `Unknown thinking level ${thinkingLevel}`);
		const disabled = new Set(Array.isArray(body.disabledTools) ? body.disabledTools.map(String) : []);
		const remove = SWITCHABLE.filter((t) => disabled.has(t.name));
		const instructions = typeof body.instructions === "string" ? body.instructions.trim() : current.instructions;
		const provider = (await root.agent(context)).model?.provider ?? "anthropic";
		const model: ModelRef = { provider, modelId };
		await root.configure({
			model,
			thinkingLevel: thinkingLevel as (typeof THINKING)[number],
			instructions: instructions === "" ? null : instructions,
			tools: remove.length === 0 ? null : { remove },
		}, context);
	}

	async function events(response: ServerResponse) {
		response.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-store",
			"X-Accel-Buffering": "no",
		});
		const send = (event: unknown) => response.write(`data: ${JSON.stringify(event)}\n\n`);
		const stream = await watchEvents(harness, root.id, context);
		send(stream.snapshot);
		stream.start(async (batch) => {
			for (const event of batch) send(event);
		});
		const ping = setInterval(() => response.write(": ping\n\n"), 25_000);
		response.once("close", () => {
			clearInterval(ping);
			void stream.stop();
		});
	}

	async function route(request: IncomingMessage, response: ServerResponse) {
		const url = new URL(request.url ?? "/", "http://gaidin");
		const get = request.method === "GET";
		if (get && url.pathname === "/") return reply(response, 200, page, "text/html; charset=utf-8");
		if (get && url.pathname === "/app.js") return reply(response, 200, script, "text/javascript; charset=utf-8");
		if (get && url.pathname === "/events") return events(response);
		if (get && url.pathname === "/api/settings") return json(response, await settings());
		if (get && url.pathname === "/api/reminders") {
			const items = (await harness.snapshot(Reminders, context))?.items ?? [];
			return json(response, [...items].sort((a, b) => a.at - b.at));
		}
		if (get && url.pathname === "/api/usage") return json(response, await harness.usage(context));
		if (request.method !== "POST") throw new HttpError(404, "Not found");

		const body = await readJson(request);
		switch (url.pathname) {
			case "/api/message": {
				const content = typeof body.content === "string" ? body.content.trim() : "";
				if (content === "") throw new HttpError(400, "Empty message");
				const requestId = typeof body.requestId === "string" ? `web:${body.requestId}` : `web:${randomUUID()}`;
				await root.submit({ type: "input", content: stamp(content), requestId }, context);
				return json(response, { ok: true });
			}
			case "/api/abort":
				await root.abort(context);
				return json(response, { ok: true });
			case "/api/reminders/cancel": {
				const removed = await root.commit((tx) => removeReminder(tx, Number(body.id)), context);
				return json(response, { ok: removed !== undefined });
			}
			case "/api/settings":
				await configure(body);
				return json(response, await settings());
			default:
				throw new HttpError(404, "Not found");
		}
	}

	return createServer((request, response) => {
		// tailscale serve sets this for a person's device; tagged devices and anything else get no header.
		if (request.headers["tailscale-user-login"] !== user) return reply(response, 403, "Forbidden", "text/plain");
		if (request.method === "POST" && !sameOrigin(request)) return reply(response, 403, "Cross-site request", "text/plain");
		route(request, response).catch((error) => {
			const status = error instanceof HttpError ? error.status : 500;
			if (status === 500) console.error("[web]", error);
			if (!response.headersSent) reply(response, status, error instanceof Error ? error.message : String(error), "text/plain");
			else response.end();
		});
	});
}

class HttpError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

/**
 * Another site open in Brad's browser could post here with his tailnet identity. A JSON body forces a
 * CORS preflight, which gets no CORS headers back, and the Origin has to be this host.
 */
function sameOrigin(request: IncomingMessage): boolean {
	if (!request.headers["content-type"]?.startsWith("application/json")) return false;
	const origin = request.headers.origin;
	return origin === undefined || origin === `https://${request.headers.host}` || origin === `http://${request.headers.host}`;
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
	let text = "";
	for await (const chunk of request) {
		text += chunk;
		if (text.length > 100_000) throw new HttpError(413, "Too large");
	}
	if (text === "") return {};
	try {
		const value = JSON.parse(text) as unknown;
		if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
	} catch {}
	throw new HttpError(400, "Expected a JSON object");
}

function reply(response: ServerResponse, status: number, body: string | Buffer, type: string) {
	response.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
	response.end(body);
}

function json(response: ServerResponse, value: unknown) {
	reply(response, 200, JSON.stringify(value), "application/json");
}
