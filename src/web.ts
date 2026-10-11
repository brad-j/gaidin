// Web view of the root conversation: the live transcript, a message box, a stop button, open reminders
// and the agent's settings. It listens on loopback only; `tailscale serve` puts HTTPS in front and adds
// Tailscale-User-Login, and only GAIDIN_WEB_USER is let in.
//
// The page is web/index.html and web/app.ts, with its types stripped as it's served. Its icon is assets/logo.svg,
// and the header shows assets/logo-transparent.svg. The PNG icons, for phone home screens and ntfy.icon, are
// renders of the same two files. web/sw.js is the service worker that shows notifications (push.ts).
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { resolve } from "node:path";
import { type AgentEvent, type Conversation, type Harness, type ModelRef, type SnapshotEvent, type ToolRegistration, type Tx, watchEvents } from "@earendil-works/pi-durable";
import type { ApprovalService, Decision } from "./approvals.ts";
import type { BudgetGuard } from "./budget.ts";
import { context } from "./host.ts";
import type { createHistory } from "./history.ts";
import { describeSchedule, Jobs, pauseJob, removeJob, resumeJob } from "./jobs.ts";
import { addNote, forgetNote, Memory } from "./memory.ts";
import { array, integer, literal, number, object, optional, ParseError, type Parser, parseJson, string } from "./parse.ts";
import type { Push } from "./push.ts";
import { type Reminder, Reminders, removeReminder } from "./reminders.ts";
import { stamp } from "./time.ts";

const WEB_DIR = resolve(import.meta.dirname, "../web");

/**
 * On every response. Another site can't frame the page, which would carry the owner's tailnet identity, and trick a
 * click onto Allow; and the page runs only its own script, so text that got past the Markdown renderer couldn't run.
 */
const SECURITY_HEADERS = {
	"Content-Security-Policy":
		"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; " +
		"object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
	"X-Frame-Options": "DENY",
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "no-referrer",
};
const THINKING = ["off", "low", "medium", "high"] as const;

/** What an open page's event stream carries: the transcript's events, and word that the approvals changed. */
type StreamEvent = AgentEvent | SnapshotEvent | { type: "approvals_changed" };

const byId = object({ id: integer });
const settingsChange = object({
	model: optional(string),
	thinkingLevel: optional(literal(...THINKING)),
	instructions: optional(string),
	disabledTools: optional(array(string)),
});

export type Settings = {
	model: string;
	models: string[];
	thinkingLevel: string;
	instructions: string;
	tools: { name: string; enabled: boolean }[];
};

export function createWebServer(options: {
	harness: Harness;
	root: Conversation;
	user: string;
	/** Tools the page can switch off, as of now. The reminder and homelab tools stay on. */
	switchable: () => readonly ToolRegistration[];
	approvals: ApprovalService;
	/** Model ids the page offers, from the settings' model.choices. */
	models?: readonly string[];
	budget?: BudgetGuard;
	/** Sets a fired reminder again, for the snooze buttons on its push. */
	snooze?: (tx: Tx, id: number, minutes: number) => Promise<Reminder | undefined>;
	/** What gaidin did, for /timeline. */
	timeline?: ReturnType<typeof createHistory>["timeline"];
	/** Notifications to the devices that sign up here. */
	push?: Push;
}) {
	const { harness, root, user, switchable, approvals } = options;
	const choices = options.models ?? [];
	// Each open page's event stream, told when a request for approval opens or closes.
	const streams = new Set<(event: StreamEvent) => void>();
	approvals.onChange(() => {
		for (const send of streams) send({ type: "approvals_changed" });
	});
	const page = readFileSync(resolve(WEB_DIR, "index.html"));
	const script = stripTypeScriptTypes(readFileSync(resolve(WEB_DIR, "app.ts"), "utf8"));
	const asset = (name: string, type: string) => ({ body: readFileSync(resolve(import.meta.dirname, "..", name)), type });
	const files = new Map([
		["/favicon.svg", asset("assets/logo.svg", "image/svg+xml")],
		["/logo.svg", asset("assets/logo-transparent.svg", "image/svg+xml")],
		["/apple-touch-icon.png", asset("assets/icon-180.png", "image/png")],
		["/icon-192.png", asset("assets/icon-192.png", "image/png")],
		["/icon-512.png", asset("assets/icon-512.png", "image/png")],
		["/icon-maskable-512.png", asset("assets/icon-maskable-512.png", "image/png")],
		["/manifest.webmanifest", asset("web/manifest.webmanifest", "application/manifest+json")],
		["/sw.js", asset("web/sw.js", "text/javascript; charset=utf-8")],
	]);

	async function settings(): Promise<Settings> {
		const agent = await root.agent(context);
		const model = agent.model ?? { provider: "", modelId: "" };
		const offered = new Set(agent.tools.map((t) => t.name));
		return {
			model: model.modelId,
			models: [...new Set([...choices, model.modelId])],
			thinkingLevel: agent.thinkingLevel,
			instructions: agent.instructions ?? "",
			tools: switchable().map((t) => ({ name: t.name, enabled: offered.has(t.name) })),
		};
	}

	async function configure(change: ReturnType<typeof settingsChange>) {
		const current = await settings();
		const modelId = change.model ?? current.model;
		if (!current.models.includes(modelId)) throw new HttpError(400, `Unknown model ${modelId}`);
		const thinkingLevel = change.thinkingLevel ?? THINKING.find((level) => level === current.thinkingLevel) ?? "off";
		const disabled = new Set(change.disabledTools ?? []);
		const remove = switchable().filter((t) => disabled.has(t.name));
		const instructions = change.instructions?.trim() ?? current.instructions;
		const provider = (await root.agent(context)).model?.provider ?? "anthropic";
		const model: ModelRef = { provider, modelId };
		await root.configure({
			model,
			thinkingLevel,
			instructions: instructions === "" ? null : instructions,
			tools: remove.length === 0 ? null : { remove },
		}, context);
	}

	async function events(response: ServerResponse) {
		response.writeHead(200, {
			...SECURITY_HEADERS,
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-store",
			"X-Accel-Buffering": "no",
		});
		const send = (event: StreamEvent) => response.write(`data: ${JSON.stringify(event)}\n\n`);
		streams.add(send);
		const stream = await watchEvents(harness, root.id, context);
		send(stream.snapshot);
		stream.start(async (batch) => {
			for (const event of batch) send(event);
		});
		const ping = setInterval(() => response.write(": ping\n\n"), 25_000);
		response.once("close", () => {
			streams.delete(send);
			clearInterval(ping);
			void stream.stop();
		});
	}

	async function route(request: IncomingMessage, response: ServerResponse) {
		const url = new URL(request.url ?? "/", "http://gaidin");
		const get = request.method === "GET";
		if (get && url.pathname === "/") return reply(response, 200, page, "text/html; charset=utf-8");
		if (get && url.pathname === "/app.js") return reply(response, 200, script, "text/javascript; charset=utf-8");
		const file = get ? files.get(url.pathname) : undefined;
		if (file !== undefined) return reply(response, 200, file.body, file.type);
		if (get && url.pathname === "/events") return events(response);
		if (get && url.pathname === "/api/settings") return json(response, await settings());
		if (get && url.pathname === "/api/reminders") {
			const items = (await harness.snapshot(Reminders, context))?.items ?? [];
			return json(response, [...items].sort((a, b) => a.at - b.at));
		}
		if (get && url.pathname === "/api/jobs") {
			const items = (await harness.snapshot(Jobs, context))?.items ?? [];
			return json(response, items.map((job) => ({ ...job, when: describeSchedule(job.schedule) })).sort((a, b) => (a.nextAt ?? 0) - (b.nextAt ?? 0)));
		}
		if (get && url.pathname === "/api/timeline") {
			const entry = Number(url.searchParams.get("entry"));
			const ref = url.searchParams.get("ref");
			return json(response, (await options.timeline?.(ref === null || !Number.isInteger(entry) ? undefined : { entry, ref })) ?? { items: [] });
		}
		if (get && url.pathname === "/api/memory") return json(response, (await harness.snapshot(Memory, context))?.notes ?? []);
		if (get && url.pathname === "/api/budget") return json(response, options.budget === undefined ? null : await options.budget.refresh());
		if (get && url.pathname === "/api/usage") return json(response, await harness.usage(context));
		if (get && url.pathname === "/api/approvals") return json(response, await approvals.pending());
		if (get && url.pathname === "/api/push") {
			const push = options.push;
			return json(response, push === undefined ? null : { publicKey: push.publicKey, devices: (await push.devices()).map(({ endpoint, label, addedAt }) => ({ endpoint, label, addedAt })) });
		}
		if (request.method !== "POST") throw new HttpError(404, "Not found");

		const text = await readBody(request);
		/** The request's JSON body as `parser` has it; a body that isn't, or none, is a 400. */
		const body = <T>(parser: Parser<T>) => parseJson(text === "" ? "{}" : text, parser, "the request");
		switch (url.pathname) {
			case "/api/message": {
				const message = body(object({ content: string, requestId: optional(string) }));
				const content = message.content.trim();
				if (content === "") throw new HttpError(400, "Empty message");
				if ((await approvals.intercept(root.id, content, "web")) === "answered") return json(response, { ok: true, answered: true });
				const requestId = `web:${message.requestId ?? randomUUID()}`;
				await root.submit({ type: "input", content: stamp(content), requestId }, context);
				return json(response, { ok: true });
			}
			case "/api/abort":
				await root.abort(context);
				return json(response, { ok: true });
			case "/api/reminders/snooze": {
				// A reminder push's button, pressed on the owner's phone.
				const { id, minutes } = body(object({ id: integer, minutes: integer }));
				if (minutes < 1 || minutes > 1440) throw new HttpError(400, "minutes must be 1 to 1440");
				const snoozed = await root.commit((tx) => options.snooze?.(tx, id, minutes), context);
				if (snoozed === undefined) throw new HttpError(404, "No such reminder");
				return json(response, { ok: true, at: snoozed.at });
			}
			case "/api/reminders/cancel": {
				const { id } = body(byId);
				const removed = await root.commit((tx) => removeReminder(tx, id), context);
				return json(response, { ok: removed !== undefined });
			}
			case "/api/memory/add": {
				try {
					const { text: note } = body(object({ text: string }));
					const added = await root.commit((tx) => addNote(tx, note, "owner"), context);
					return json(response, added);
				} catch (error) {
					if (error instanceof ParseError) throw error;
					throw new HttpError(400, error instanceof Error ? error.message : String(error));
				}
			}
			case "/api/memory/forget": {
				const { id } = body(byId);
				const removed = await root.commit((tx) => forgetNote(tx, id), context);
				return json(response, { ok: removed !== undefined });
			}
			case "/api/budget/allow": {
				if (options.budget === undefined) throw new HttpError(404, "No budget");
				const { dailyLimit } = options.budget.status();
				// One more day's worth, or $5 when there's no daily limit.
				const amount = body(object({ amount: optional(number) })).amount ?? (dailyLimit > 0 ? dailyLimit : 5);
				if (amount <= 0 || amount > 1000) throw new HttpError(400, "amount must be between 0 and 1000 dollars");
				return json(response, await options.budget.allowMore(amount));
			}
			case "/api/jobs/cancel": {
				const { id } = body(byId);
				const removed = await root.commit((tx) => removeJob(tx, id), context);
				return json(response, { ok: removed !== undefined });
			}
			case "/api/jobs/pause": {
				const { id } = body(byId);
				const paused = await root.commit((tx) => pauseJob(tx, id, "paused by the owner"), context);
				return json(response, { ok: paused !== undefined });
			}
			case "/api/jobs/resume": {
				const { id } = body(byId);
				const resumed = await root.commit((tx) => resumeJob(tx, id), context);
				return json(response, { ok: resumed !== undefined });
			}
			case "/api/approvals/answer": {
				const { id, answer } = body(object({ id: string, answer: string }));
				const answered = await approvals.answer(id, answer, "web");
				return json(response, { ok: answered !== undefined });
			}
			case "/api/approvals/decide": {
				const { id, decision } = body(object({ id: string, decision: literal<Decision>("once", "always", "deny") }));
				const decided = await approvals.decide(id, decision, "web");
				return json(response, { ok: decided !== undefined });
			}
			case "/api/push/subscribe": {
				if (options.push === undefined) throw new HttpError(404, "Notifications need web.url in the settings");
				const device = body(object({ endpoint: string, keys: object({ p256dh: string, auth: string }), label: optional(string) }));
				try {
					await options.push.add({ endpoint: device.endpoint, p256dh: device.keys.p256dh, auth: device.keys.auth, label: device.label ?? "a device" });
				} catch (error) {
					throw new HttpError(400, error instanceof Error ? error.message : String(error));
				}
				return json(response, { ok: true });
			}
			case "/api/push/unsubscribe":
				return json(response, { ok: (await options.push?.remove(body(object({ endpoint: string })).endpoint)) === true });
			case "/api/push/test": {
				if (options.push === undefined) throw new HttpError(404, "Notifications need web.url in the settings");
				const sent = await options.push.send({ title: "gaidin", body: "Notifications work on this device.", tag: "test" });
				return json(response, { sent });
			}
			case "/api/settings":
				await configure(body(settingsChange));
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
			const status = error instanceof HttpError ? error.status : error instanceof ParseError ? 400 : 500;
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

async function readBody(request: IncomingMessage): Promise<string> {
	let text = "";
	for await (const chunk of request) {
		text += chunk;
		if (text.length > 100_000) throw new HttpError(413, "Too large");
	}
	return text;
}

function reply(response: ServerResponse, status: number, body: string | Buffer, type: string) {
	response.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": type, "Cache-Control": "no-store" });
	response.end(body);
}

function json<T>(response: ServerResponse, value: T) {
	reply(response, 200, JSON.stringify(value), "application/json");
}
