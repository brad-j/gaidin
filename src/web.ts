// Web view of the root conversation: the live transcript, a message box, a stop button, open reminders
// and the agent's settings. It listens on loopback only; `tailscale serve` puts HTTPS in front and adds
// Tailscale-User-Login, and only GAIDIN_WEB_USER is let in.
//
// The page is web/index.html, web/app.ts and the modules it imports, with their types stripped as they're served. Its icon is assets/logo.svg,
// and the header shows assets/logo-transparent.svg. The PNG icons, for phone home screens and ntfy.icon, are
// renders of the same two files. web/sw.js is the service worker that shows notifications (push.ts).
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { resolve } from "node:path";
import { type AgentEvent, type Conversation, type Harness, type ModelRef, type SnapshotEvent, type ToolRegistration, type Tx, type UsageState, watchEvents } from "@earendil-works/pi-durable";
import type { ApprovalRequest, ApprovalService, Decision } from "./approvals.ts";
import type { BudgetGuard, BudgetStatus } from "./budget.ts";
import { context } from "./host.ts";
import type { createHistory } from "./history.ts";
import { describeSchedule, type Job, Jobs, pauseJob, removeJob, resumeJob } from "./jobs.ts";
import { addNote, forgetNote, MAX_NOTE, MAX_TOTAL, Memory, type Note, updateNote } from "./memory.ts";
import { array, integer, literal, number, object, optional, ParseError, type Parser, parseJson, string } from "./parse.ts";
import type { Device, Push } from "./push.ts";
import { type Reminder, Reminders, removeReminder } from "./reminders.ts";
import { type createSkills, readSkillFile, type Skill } from "./skills.ts";
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
export type StreamEvent = AgentEvent | SnapshotEvent | { type: "approvals_changed" };

// What each POST route takes.
const nothing = object({});
const byId = object({ id: integer });
const messageBody = object({ content: string, requestId: optional(string) });
const snoozeBody = object({ id: integer, minutes: integer });
const noteBody = object({ text: string });
const noteChange = object({ id: integer, text: string });
const skillSave = object({ name: string, file: string, text: string });
const skillRemove = object({ name: string, file: optional(string) });
const allowBody = object({ amount: optional(number) });
const answerBody = object({ id: string, answer: string });
const decideBody = object({ id: string, decision: literal<Decision>("once", "always", "deny") });
const subscribeBody = object({ endpoint: string, keys: object({ p256dh: string, auth: string }), label: optional(string) });
const endpointBody = object({ endpoint: string });
const settingsChange = object({
	model: optional(string),
	thinkingLevel: optional(literal(...THINKING)),
	instructions: optional(string),
	disabledTools: optional(array(string)),
});
type BodyOf<P> = P extends Parser<infer T> ? T : never;

export type Settings = {
	model: string;
	models: string[];
	thinkingLevel: string;
	instructions: string;
	tools: { name: string; enabled: boolean }[];
};
/** A scheduled job as the page lists it, with its schedule in words. */
export type ListedJob = Job & { when: string };
export type PushInfo = { publicKey: string; devices: Pick<Device, "endpoint" | "label" | "addedAt">[] };
export type Timeline = Awaited<ReturnType<ReturnType<typeof createHistory>["timeline"]>>;
/** A skill as the page lists it, without where it is on the server. */
export type ListedSkill = Omit<Skill, "dir">;
const listed = ({ name, description, source, files }: Skill): ListedSkill => ({ name, description, source, files });

// The protocol between the page (web/app.ts) and this server: what each route answers, and what each POST takes.
// The route tables below are checked against these, and the page's requests are typed by them.

/** What each GET route answers. */
export type Gets = {
	"/api/settings": Settings;
	"/api/reminders": Reminder[];
	"/api/jobs": ListedJob[];
	/** `?entry=&ref=` continues from the cursor the last page gave. */
	"/api/timeline": Timeline;
	"/api/memory": { notes: Note[]; maxNote: number; maxTotal: number };
	"/api/budget": BudgetStatus | null;
	"/api/usage": UsageState;
	"/api/approvals": ApprovalRequest[];
	"/api/push": PushInfo | null;
	"/api/skills": { skills: ListedSkill[]; problems: string[] };
	/** `?name=&file=`: one of a skill's files; SKILL.md when no file is given. */
	"/api/skills/file": { name: string; file: string; text: string };
};

type Ok = { ok: boolean };
/** What each POST route takes, as its parser reads it, and what it answers. */
export type Posts = {
	"/api/message": { body: BodyOf<typeof messageBody>; answer: { ok: true; answered?: true } };
	"/api/abort": { body: BodyOf<typeof nothing>; answer: Ok };
	"/api/reminders/snooze": { body: BodyOf<typeof snoozeBody>; answer: { ok: true; at: number } };
	"/api/reminders/cancel": { body: BodyOf<typeof byId>; answer: Ok };
	"/api/memory/add": { body: BodyOf<typeof noteBody>; answer: Note };
	"/api/memory/update": { body: BodyOf<typeof noteChange>; answer: Note };
	"/api/skills/save": { body: BodyOf<typeof skillSave>; answer: ListedSkill };
	"/api/skills/remove": { body: BodyOf<typeof skillRemove>; answer: Ok };
	"/api/memory/forget": { body: BodyOf<typeof byId>; answer: Ok };
	"/api/budget/allow": { body: BodyOf<typeof allowBody>; answer: BudgetStatus };
	"/api/jobs/cancel": { body: BodyOf<typeof byId>; answer: Ok };
	"/api/jobs/pause": { body: BodyOf<typeof byId>; answer: Ok };
	"/api/jobs/resume": { body: BodyOf<typeof byId>; answer: Ok };
	"/api/approvals/answer": { body: BodyOf<typeof answerBody>; answer: Ok };
	"/api/approvals/decide": { body: BodyOf<typeof decideBody>; answer: Ok };
	"/api/push/subscribe": { body: BodyOf<typeof subscribeBody>; answer: Ok };
	"/api/push/unsubscribe": { body: BodyOf<typeof endpointBody>; answer: Ok };
	"/api/push/test": { body: BodyOf<typeof nothing>; answer: { sent: number } };
	"/api/settings": { body: BodyOf<typeof settingsChange>; answer: Settings };
};

/** A POST route: how its body is read, and what it does with it. */
type PostRoute<R extends { body: unknown; answer: unknown }> = { body: Parser<R["body"]>; handle: (body: R["body"]) => Promise<R["answer"]> };
/** The server's GET routes, each answering as Gets says. */
type GetRoutes = { [P in keyof Gets]: (url: URL) => Promise<Gets[P]> };
/** The server's POST routes, each taking and answering as Posts says. */
type PostRoutes = { [P in keyof Posts]: PostRoute<Posts[P]> };

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
	/** Stops the root conversation's run and tells the model it was withdrawn (host.ts). Default: just stop it. */
	stop?: () => Promise<boolean>;
	/** The skills gaidin can open, which the owner changes here. */
	skills?: ReturnType<typeof createSkills>;
}) {
	const { harness, root, user, switchable, approvals } = options;
	const choices = options.models ?? [];
	// Each open page's event stream, told when a request for approval opens or closes.
	const streams = new Set<(event: StreamEvent) => void>();
	approvals.onChange(() => {
		for (const send of streams) send({ type: "approvals_changed" });
	});
	const page = readFileSync(resolve(WEB_DIR, "index.html"));
	const script = (name: string) => stripTypeScriptTypes(readFileSync(resolve(WEB_DIR, name), "utf8"));
	// app.ts imports the other modules by their .ts names, which the browser asks for beside /app.js.
	const modules = ["activity.ts", "api.ts", "dom.ts", "markdown.ts", "memory.ts", "page.ts", "schedule.ts", "settings.ts", "skills.ts", "transcript.ts"];
	const scripts = new Map([["/app.js", script("app.ts")], ...modules.map((name) => [`/${name}`, script(name)] as const)]);
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

	/** The owner's change to a skill, which doesn't ask: they're the one who'd be asked. */
	async function changeSkill(change: Parameters<ReturnType<typeof createSkills>["apply"]>[0]) {
		if (options.skills === undefined) throw new HttpError(404, "No skills");
		try {
			return await options.skills.apply(change, "owner");
		} catch (error) {
			throw new HttpError(400, error instanceof Error ? error.message : String(error));
		}
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

	const gets: GetRoutes = {
		"/api/settings": settings,
		"/api/reminders": async () => [...((await harness.snapshot(Reminders, context))?.items ?? [])].sort((a, b) => a.at - b.at),
		"/api/jobs": async () => {
			const items = (await harness.snapshot(Jobs, context))?.items ?? [];
			return items.map((job) => ({ ...job, when: describeSchedule(job.schedule) })).sort((a, b) => (a.nextAt ?? 0) - (b.nextAt ?? 0));
		},
		"/api/timeline": async (url) => {
			const entry = Number(url.searchParams.get("entry"));
			const ref = url.searchParams.get("ref");
			return (await options.timeline?.(ref === null || !Number.isInteger(entry) ? undefined : { entry, ref })) ?? { items: [] };
		},
		"/api/memory": async () => ({ notes: [...((await harness.snapshot(Memory, context))?.notes ?? [])], maxNote: MAX_NOTE, maxTotal: MAX_TOTAL }),
		"/api/budget": async () => (options.budget === undefined ? null : await options.budget.refresh()),
		"/api/usage": () => harness.usage(context),
		"/api/approvals": () => approvals.pending(),
		"/api/push": async () => {
			const push = options.push;
			return push === undefined ? null : { publicKey: push.publicKey, devices: (await push.devices()).map(({ endpoint, label, addedAt }) => ({ endpoint, label, addedAt })) };
		},
		"/api/skills": async () => ({
			skills: (options.skills?.list() ?? []).map(listed),
			problems: [...(options.skills?.problems() ?? [])],
		}),
		"/api/skills/file": async (url) => {
			const name = url.searchParams.get("name") ?? "";
			const file = url.searchParams.get("file") ?? "SKILL.md";
			const skill = options.skills?.find(name);
			if (skill === undefined || !skill.files.includes(file)) throw new HttpError(404, `No skill file ${name}/${file}`);
			return { name, file, text: readSkillFile(skill, file) };
		},
	};

	const posts: PostRoutes = {
		"/api/message": {
			body: messageBody,
			handle: async (message) => {
				const content = message.content.trim();
				if (content === "") throw new HttpError(400, "Empty message");
				if ((await approvals.intercept(root.id, content, "web")) === "answered") return { ok: true, answered: true };
				const requestId = `web:${message.requestId ?? randomUUID()}`;
				await root.submit({ type: "input", content: stamp(content), requestId }, context);
				return { ok: true };
			},
		},
		"/api/abort": {
			body: nothing,
			handle: async () => {
				if (options.stop === undefined) await root.abort(context);
				else await options.stop();
				return { ok: true };
			},
		},
		"/api/reminders/snooze": {
			body: snoozeBody,
			// A reminder push's button, pressed on the owner's phone.
			handle: async ({ id, minutes }) => {
				if (minutes < 1 || minutes > 1440) throw new HttpError(400, "minutes must be 1 to 1440");
				const snoozed = await root.commit((tx) => options.snooze?.(tx, id, minutes), context);
				if (snoozed === undefined) throw new HttpError(404, "No such reminder");
				return { ok: true, at: snoozed.at };
			},
		},
		"/api/reminders/cancel": { body: byId, handle: async ({ id }) => ({ ok: (await root.commit((tx) => removeReminder(tx, id), context)) !== undefined }) },
		"/api/memory/add": {
			body: noteBody,
			handle: async ({ text }) => {
				try {
					return await root.commit((tx) => addNote(tx, text, "owner"), context);
				} catch (error) {
					throw new HttpError(400, error instanceof Error ? error.message : String(error));
				}
			},
		},
		"/api/memory/update": {
			body: noteChange,
			handle: async ({ id, text }) => {
				let note: Note | undefined;
				try {
					note = await root.commit((tx) => updateNote(tx, id, text, "owner"), context);
				} catch (error) {
					throw new HttpError(400, error instanceof Error ? error.message : String(error));
				}
				if (note === undefined) throw new HttpError(404, `No note ${id}`);
				return note;
			},
		},
		"/api/skills/save": {
			body: skillSave,
			handle: async (change) => {
				const skill = await changeSkill(change);
				if (skill === undefined) throw new HttpError(500, `${change.name} wasn't there after saving it`);
				return listed(skill);
			},
		},
		"/api/skills/remove": {
			body: skillRemove,
			handle: async ({ name, file }) => {
				await changeSkill({ name, file: file ?? "SKILL.md" });
				return { ok: true };
			},
		},
		"/api/memory/forget": { body: byId, handle: async ({ id }) => ({ ok: (await root.commit((tx) => forgetNote(tx, id), context)) !== undefined }) },
		"/api/budget/allow": {
			body: allowBody,
			handle: async ({ amount: asked }) => {
				if (options.budget === undefined) throw new HttpError(404, "No budget");
				const { dailyLimit } = options.budget.status();
				// One more day's worth, or $5 when there's no daily limit.
				const amount = asked ?? (dailyLimit > 0 ? dailyLimit : 5);
				if (amount <= 0 || amount > 1000) throw new HttpError(400, "amount must be between 0 and 1000 dollars");
				return options.budget.allowMore(amount);
			},
		},
		"/api/jobs/cancel": { body: byId, handle: async ({ id }) => ({ ok: (await root.commit((tx) => removeJob(tx, id), context)) !== undefined }) },
		"/api/jobs/pause": { body: byId, handle: async ({ id }) => ({ ok: (await root.commit((tx) => pauseJob(tx, id, "paused by the owner"), context)) !== undefined }) },
		"/api/jobs/resume": { body: byId, handle: async ({ id }) => ({ ok: (await root.commit((tx) => resumeJob(tx, id), context)) !== undefined }) },
		"/api/approvals/answer": { body: answerBody, handle: async ({ id, answer }) => ({ ok: (await approvals.answer(id, answer, "web")) !== undefined }) },
		"/api/approvals/decide": { body: decideBody, handle: async ({ id, decision }) => ({ ok: (await approvals.decide(id, decision, "web")) !== undefined }) },
		"/api/push/subscribe": {
			body: subscribeBody,
			handle: async (device) => {
				if (options.push === undefined) throw new HttpError(404, "Notifications need web.url in the settings");
				try {
					await options.push.add({ endpoint: device.endpoint, p256dh: device.keys.p256dh, auth: device.keys.auth, label: device.label ?? "a device" });
				} catch (error) {
					throw new HttpError(400, error instanceof Error ? error.message : String(error));
				}
				return { ok: true };
			},
		},
		"/api/push/unsubscribe": { body: endpointBody, handle: async ({ endpoint }) => ({ ok: (await options.push?.remove(endpoint)) === true }) },
		"/api/push/test": {
			body: nothing,
			handle: async () => {
				if (options.push === undefined) throw new HttpError(404, "Notifications need web.url in the settings");
				return { sent: await options.push.send({ title: "gaidin", body: "Notifications work on this device.", tag: "test" }) };
			},
		},
		"/api/settings": {
			body: settingsChange,
			handle: async (change) => {
				await configure(change);
				return settings();
			},
		},
	};

	/** Runs the POST route at `path` on the request's JSON body; a body that isn't what the route takes, or none, is a 400. */
	async function handlePost<P extends keyof Posts>(path: P, text: string): Promise<Posts[P]["answer"]> {
		const route: PostRoute<Posts[P]> = posts[path];
		return route.handle(parseJson(text === "" ? "{}" : text, route.body, "the request"));
	}

	async function route(request: IncomingMessage, response: ServerResponse) {
		const url = new URL(request.url ?? "/", "http://gaidin");
		const path = url.pathname;
		if (request.method === "GET") {
			if (path === "/") return reply(response, 200, page, "text/html; charset=utf-8");
			const code = scripts.get(path);
			if (code !== undefined) return reply(response, 200, code, "text/javascript; charset=utf-8");
			const file = files.get(path);
			if (file !== undefined) return reply(response, 200, file.body, file.type);
			if (path === "/events") return events(response);
			if (isGet(path)) return json(response, await gets[path](url));
		}
		if (request.method !== "POST" || !isPost(path)) throw new HttpError(404, "Not found");
		return json(response, await handlePost(path, await readBody(request)));
	}

	const isGet = (path: string): path is keyof Gets => Object.hasOwn(gets, path);
	const isPost = (path: string): path is keyof Posts => Object.hasOwn(posts, path);

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
