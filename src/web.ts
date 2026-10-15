// The web view and the app's API: each agent's conversations, live, with a message box and a stop button, its
// reminders, jobs, notes and settings, the roster, and threads the owner starts and continues (threads.ts). A request
// names its agent with `?agent=` or `agent` in its body, and a conversation with `conversation`; without them, it's the
// default agent's home conversation, the root. It listens on loopback only; `tailscale serve` puts HTTPS in front and
// adds Tailscale-User-Login, and only GAIDIN_WEB_USER is let in.
//
// The page is web/index.html, web/app.ts and the modules it imports, with their types stripped as they're served. Its icon is assets/logo.svg,
// and the header shows assets/logo-transparent.svg. The PNG icons, for phone home screens and ntfy.icon, are
// renders of the same two files. web/sw.js is the service worker that shows notifications (push.ts).
//
// With `web.app`, moiraine's build is served at /app/ beside it: its files, and its shell for every other path there.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { extname, resolve, sep } from "node:path";
import { type AgentEvent, type Conversation, type Harness, type ModelRef, type SnapshotEvent, type ToolRegistration, type Tx, type UsageState, watchEvents } from "@earendil-works/pi-durable";
import { type AgentEntry, agentIdOf, DEFAULT_AGENT, type RosterService } from "./agents.ts";
import type { ApprovalRequest, ApprovalService, Decision } from "./approvals.ts";
import type { BudgetGuard, BudgetStatus } from "./budget.ts";
import { context } from "./host.ts";
import type { ConversationSummary, createHistory } from "./history.ts";
import { type Attached, MAX_FILE, type Uploaded, type Uploads, withFiles } from "./files.ts";
import { conversationId } from "./ids.ts";
import { describeSchedule, type Job, jobOf, Jobs, pauseJob, removeJob, resumeJob } from "./jobs.ts";
import { addNote, forgetNote, MAX_NOTE, MAX_TOTAL, MAX_WORK, type Note, notesOn, SHARED, type Shelf, updateNote } from "./memory.ts";
import { array, boolean, integer, literal, number, object, optional, ParseError, type Parser, parseJson, string } from "./parse.ts";
import type { Device, Push } from "./push.ts";
import { type Reminder, reminderOf, Reminders, removeReminder } from "./reminders.ts";
import { type createSkills, readSkillFile, type Skill } from "./skills.ts";
import type { Threads } from "./threads.ts";
import { stamp } from "./time.ts";

const WEB_DIR = resolve(import.meta.dirname, "../web");

/**
 * On every response. Another site can't frame the page, which would carry the owner's tailnet identity, and trick a
 * click onto Allow; and the page runs only its own script, so text that got past the Markdown renderer couldn't run.
 */
const SECURITY_HEADERS = {
	"Content-Security-Policy": policy(),
	"X-Frame-Options": "DENY",
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "no-referrer",
};

/** The Content-Security-Policy, with `scripts` the sources allowed besides the page's own files. */
function policy(scripts: readonly string[] = []): string {
	return (
		`default-src 'self'; script-src ${["'self'", ...scripts].join(" ")}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; ` +
		"object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
	);
}

/** Where moiraine's build is served. Its own paths start here too: it's built with this base. */
const APP_PATH = "/app";
/** The page moiraine's build gives for every path that isn't one of its files. */
const APP_SHELL = "_shell.html";
const APP_TYPES = new Map([
	[".js", "text/javascript; charset=utf-8"],
	[".css", "text/css; charset=utf-8"],
	[".html", "text/html; charset=utf-8"],
	[".json", "application/json"],
	[".webmanifest", "application/manifest+json"],
	[".svg", "image/svg+xml"],
	[".png", "image/png"],
	[".ico", "image/x-icon"],
	[".woff2", "font/woff2"],
	[".txt", "text/plain; charset=utf-8"],
]);
const THINKING = ["off", "low", "medium", "high"] as const;

/** The protocol's version, which /api/version reports. Raise it when an answer or a body changes shape, so an app built against another version can say so. */
export const PROTOCOL = 3;

/** What an open page's event stream carries: the transcript's events, and word that the approvals changed. */
export type StreamEvent = AgentEvent | SnapshotEvent | { type: "approvals_changed" };

// What each POST route takes. `agent` is an agent's id, and `conversation` a conversation's; without them, the default
// agent and its home conversation.
const nothing = object({});
const byId = object({ id: integer });
/** `files`: what /api/files answered for each file sent with the message. */
const messageBody = object({ content: string, requestId: optional(string), agent: optional(string), conversation: optional(integer), files: optional(array(string)) });
const abortBody = object({ agent: optional(string), conversation: optional(integer) });
const threadBody = object({ content: string, requestId: optional(string), agent: optional(string), files: optional(array(string)) });
const snoozeBody = object({ id: integer, minutes: integer });
/** `work`: the agent's work notes; otherwise the shared notes. */
const noteBody = object({ text: string, agent: optional(string), work: optional(boolean) });
const noteChange = object({ id: integer, text: string, agent: optional(string), work: optional(boolean) });
const noteForget = object({ id: integer, agent: optional(string), work: optional(boolean) });
/** Makes the agent when there's none with this id, which needs a name. */
const agentSave = object({
	id: string,
	name: optional(string),
	job: optional(string),
	channel: optional(string),
	canMessage: optional(array(string)),
	workspaces: optional(array(string)),
	hosts: optional(array(string)),
	extensions: optional(array(string)),
});
const agentArchive = object({ id: string, archived: boolean });
const skillSave = object({ name: string, file: string, text: string });
const skillRemove = object({ name: string, file: optional(string) });
const allowBody = object({ amount: optional(number) });
const answerBody = object({ id: string, answer: string });
const decideBody = object({ id: string, decision: literal<Decision>("once", "always", "deny") });
const subscribeBody = object({ endpoint: string, keys: object({ p256dh: string, auth: string }), label: optional(string) });
const endpointBody = object({ endpoint: string });
const settingsChange = object({
	agent: optional(string),
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
	"/api/version": { protocol: number };
	/** Every agent, archived ones included, the default agent first. */
	"/api/agents": AgentEntry[];
	/** The workspaces an agent can be given, by name. */
	"/api/workspaces": { names: string[] };
	/** `?agent=` for each of these: that agent's, the default agent's without it. */
	"/api/settings": Settings;
	"/api/reminders": Reminder[];
	"/api/jobs": ListedJob[];
	/** Every agent's. `?entry=&ref=` continues from the cursor the last page gave. */
	"/api/timeline": Timeline;
	/** `notes`: the shared notes; `work`: the agent's work notes. */
	"/api/memory": { notes: Note[]; work: Note[]; maxNote: number; maxTotal: number; maxWork: number };
	"/api/budget": BudgetStatus | null;
	"/api/usage": UsageState;
	"/api/approvals": ApprovalRequest[];
	"/api/push": PushInfo | null;
	"/api/skills": { skills: ListedSkill[]; problems: string[] };
	/** `?agent=`: the agent's threads, job runs and conversations other agents started. `?before=` continues from the cursor the last page gave. */
	"/api/conversations": { items: ConversationSummary[]; next?: number };
	/** `?id=`: a thread, job run or conversation another agent started, and its transcript as the event stream starts it. */
	"/api/conversation": { conversation: Omit<ConversationSummary, "startedAt" | "lastAt" | "messages">; snapshot: SnapshotEvent };
	/** `?name=&file=`: one of a skill's files; SKILL.md when no file is given. */
	"/api/skills/file": { name: string; file: string; text: string };
};

type Ok = { ok: boolean };

export type { Uploaded };
/**
 * POST /api/files takes a file's bytes, up to 20 MB, as the body, its name URI-encoded in X-Gaidin-File and its type
 * in Content-Type, and answers with this. A message names its files by their ids. The header makes a browser ask
 * first, as a JSON body does, and the Origin is checked as for every POST.
 */
export const FILE_HEADER = "X-Gaidin-File";
/** What each POST route takes, as its parser reads it, and what it answers. */
export type Posts = {
	/**
	 * To the conversation, or the agent's home. A job run or a conversation another agent started is forked at its last
	 * answer, and the message goes to the fork: `conversation` is where it went.
	 */
	"/api/message": { body: BodyOf<typeof messageBody>; answer: { ok: true; answered?: true; conversation: number } };
	"/api/abort": { body: BodyOf<typeof abortBody>; answer: Ok };
	/** A new thread with the agent, answering its first message. */
	"/api/threads/start": { body: BodyOf<typeof threadBody>; answer: { conversation: number } };
	"/api/agents/save": { body: BodyOf<typeof agentSave>; answer: AgentEntry };
	/** Archives an agent, or restores it with `archived: false`. */
	"/api/agents/archive": { body: BodyOf<typeof agentArchive>; answer: AgentEntry };
	"/api/reminders/snooze": { body: BodyOf<typeof snoozeBody>; answer: { ok: true; at: number } };
	"/api/reminders/cancel": { body: BodyOf<typeof byId>; answer: Ok };
	"/api/memory/add": { body: BodyOf<typeof noteBody>; answer: Note };
	"/api/memory/update": { body: BodyOf<typeof noteChange>; answer: Note };
	"/api/skills/save": { body: BodyOf<typeof skillSave>; answer: ListedSkill };
	"/api/skills/remove": { body: BodyOf<typeof skillRemove>; answer: Ok };
	"/api/memory/forget": { body: BodyOf<typeof noteForget>; answer: Ok };
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
	/** The roster, whose home conversations the requests without a conversation go to. */
	agents: RosterService;
	/** The workspaces' names, which an agent's entry gives it. Default: none. */
	workspaces?: () => readonly string[];
	threads: Threads;
	user: string;
	/** The directory of moiraine's build, served at /app/. */
	app?: string;
	/**
	 * Posts a message sent from the app in its conversation's Slack thread, if it has one, and then its answer (slack/).
	 * Resolves once that's recorded. `submission` is the message's.
	 */
	mirror?: (sent: { conversationId: number; submission: number; text: string; files?: readonly string[] }) => Promise<boolean>;
	/** Files the app sends ahead of the messages that name them. Without it, /api/files refuses them. */
	uploads?: Uploads;
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
	/** Slack threads and job runs, for the history page. */
	history?: Pick<ReturnType<typeof createHistory>, "conversations" | "conversation">;
	/** Notifications to the devices that sign up here. */
	push?: Push;
	/** Stops a conversation's run and tells the model it was withdrawn (host.ts). Default: just stop it. */
	stop?: (conversation: Conversation) => Promise<boolean>;
	/** The skills gaidin can open, which the owner changes here. */
	skills?: ReturnType<typeof createSkills>;
}) {
	const { harness, root, agents, threads, user, switchable, approvals } = options;
	const choices = options.models ?? [];
	// Each open page's event stream, told when a request for approval opens or closes.
	const streams = new Set<(event: StreamEvent) => void>();
	approvals.onChange(() => {
		for (const send of streams) send({ type: "approvals_changed" });
	});
	const page = readFileSync(resolve(WEB_DIR, "index.html"));
	const script = (name: string) => stripTypeScriptTypes(readFileSync(resolve(WEB_DIR, name), "utf8"));
	// app.ts imports the other modules by their .ts names, which the browser asks for beside /app.js.
	const modules = ["activity.ts", "api.ts", "dom.ts", "history.ts", "log.ts", "markdown.ts", "memory.ts", "page.ts", "schedule.ts", "settings.ts", "skills.ts", "transcript.ts"];
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

	/** The agent a GET names, or the default agent. */
	const agentIn = (url: URL) => url.searchParams.get("agent") ?? DEFAULT_AGENT;

	/**
	 * An entry as the app shows it: the default agent's hosts are the approvals document's, which its roster entry
	 * doesn't hold.
	 */
	async function shown(entry: AgentEntry): Promise<AgentEntry> {
		return entry.id === DEFAULT_AGENT ? { ...entry, hosts: [...(await approvals.hostsFor(DEFAULT_AGENT))] } : entry;
	}

	/** An agent's home conversation, the default agent's unless one is named. */
	const home = (agent?: string) => refused(() => agents.home(agent), 404);

	/** A conversation by id; `agent`, when given, has to be the one it belongs to. */
	async function conversationAt(id: number, agent?: string): Promise<Conversation> {
		const conversation = await harness.conversation(conversationId(id), context);
		if (conversation === undefined) throw new HttpError(404, `There's no conversation ${id}.`);
		if (agent !== undefined && (await agentIdOf(harness, conversation.id, context)) !== agent) throw new HttpError(400, `Conversation ${id} isn't ${agent}'s.`);
		return conversation;
	}

	/**
	 * What a message from the app goes to the model as: its text, stamped with the time, and the files it names, saved
	 * in the sandbox of the agent whose conversation it is.
	 */
	async function input(text: string, files: readonly string[] | undefined, conversation: Conversation) {
		if (files === undefined || files.length === 0) return stamp(text);
		if (options.uploads === undefined) throw new HttpError(400, "This server doesn't take files.");
		const uploads = options.uploads;
		const attached: Attached[] = await refused(async () => files.map((id) => uploads.attached(id)));
		const sandbox = await agents.sandbox(await agentIdOf(harness, conversation.id, context));
		return withFiles(stamp(text), attached, sandbox, "the app");
	}

	/** The shelf a note change means: the agent's work notes, or the shared notes. The agent has to exist. */
	async function shelfOf(body: { agent?: string; work?: boolean }): Promise<Shelf> {
		if (body.work !== true) return SHARED;
		const agent = body.agent ?? DEFAULT_AGENT;
		if (!(await agents.list()).some((a) => a.id === agent)) throw new HttpError(404, `There's no agent ${agent}.`);
		return { shared: false, agent };
	}

	async function settings(agentId?: string): Promise<Settings> {
		const agent = await (await home(agentId)).agent(context);
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
		const conversation = await home(change.agent);
		const current = await settings(change.agent);
		const modelId = change.model ?? current.model;
		if (!current.models.includes(modelId)) throw new HttpError(400, `Unknown model ${modelId}`);
		const thinkingLevel = change.thinkingLevel ?? THINKING.find((level) => level === current.thinkingLevel) ?? "off";
		const disabled = new Set(change.disabledTools ?? []);
		const remove = switchable().filter((t) => disabled.has(t.name));
		const instructions = change.instructions?.trim() ?? current.instructions;
		const provider = (await conversation.agent(context)).model?.provider ?? "anthropic";
		const model: ModelRef = { provider, modelId };
		await conversation.configure({
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

	/** A conversation's events: `?conversation=`, or the home of `?agent=`. */
	async function events(url: URL, response: ServerResponse) {
		const id = url.searchParams.get("conversation");
		const conversation = id === null ? await home(agentIn(url)) : await conversationAt(Number(id));
		response.writeHead(200, {
			...SECURITY_HEADERS,
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-store",
			"X-Accel-Buffering": "no",
		});
		const send = (event: StreamEvent) => response.write(`data: ${JSON.stringify(event)}\n\n`);
		streams.add(send);
		const stream = await watchEvents(harness, conversation.id, context);
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
		"/api/version": async () => ({ protocol: PROTOCOL }),
		"/api/agents": async () => Promise.all((await agents.list()).map(shown)),
		"/api/workspaces": async () => ({ names: [...(options.workspaces?.() ?? [])] }),
		"/api/settings": (url) => settings(agentIn(url)),
		"/api/reminders": async (url) => {
			const items = (await harness.snapshot(Reminders, context))?.items ?? [];
			return items.filter((r) => reminderOf(r, agentIn(url))).sort((a, b) => a.at - b.at);
		},
		"/api/jobs": async (url) => {
			const items = ((await harness.snapshot(Jobs, context))?.items ?? []).filter((j) => jobOf(j, agentIn(url)));
			return items.map((job) => ({ ...job, when: describeSchedule(job.schedule) })).sort((a, b) => (a.nextAt ?? 0) - (b.nextAt ?? 0));
		},
		"/api/timeline": async (url) => {
			const entry = Number(url.searchParams.get("entry"));
			const ref = url.searchParams.get("ref");
			return (await options.timeline?.(ref === null || !Number.isInteger(entry) ? undefined : { entry, ref })) ?? { items: [] };
		},
		"/api/memory": async (url) => ({
			notes: [...(await notesOn(harness, SHARED, context))],
			work: [...(await notesOn(harness, { shared: false, agent: agentIn(url) }, context))],
			maxNote: MAX_NOTE,
			maxTotal: MAX_TOTAL,
			maxWork: MAX_WORK,
		}),
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
		"/api/conversations": async (url) => {
			const before = Number(url.searchParams.get("before"));
			return (await options.history?.conversations(Number.isInteger(before) && before > 0 ? before : undefined, agentIn(url))) ?? { items: [] };
		},
		"/api/conversation": async (url) => {
			const id = Number(url.searchParams.get("id"));
			// Not a home conversation: the event stream gives those.
			const conversation = Number.isInteger(id) ? await options.history?.conversation(id) : undefined;
			if (conversation === undefined) throw new HttpError(404, `No thread, job run or conversation from another agent ${url.searchParams.get("id")}`);
			const stream = await watchEvents(harness, conversationId(id), context);
			// Never started, so there's nothing to stop but the stream's own watch.
			await stream.stop();
			return { conversation, snapshot: stream.snapshot };
		},
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
				const files = message.files ?? [];
				if (content === "" && files.length === 0) throw new HttpError(400, "Empty message");
				const requestId = `web:${message.requestId ?? randomUUID()}`;
				const named = message.conversation === undefined ? undefined : await conversationAt(message.conversation, message.agent);
				const conversation = named === undefined ? await home(message.agent) : await refused(() => threads.target(named.id, { origin: "app", key: requestId }));
				// A message with files isn't an answer to a question; it goes to the model, which closes the question.
				if (files.length === 0 && (await approvals.intercept(conversation.id, content, "web")) === "answered") return { ok: true, answered: true, conversation: conversation.id };
				if (files.length > 0) await approvals.supersede(conversation.id);
				const submission = await conversation.submit({ type: "input", content: await input(content, files, conversation), requestId }, context);
				// The message is in; a Slack thread that doesn't hear of it is told at the next start, or not at all.
				await options
					.mirror?.({ conversationId: conversation.id, submission: submission.id, text: content, files: files.length === 0 ? undefined : files.map((id) => options.uploads?.attached(id).name ?? "a file") })
					.catch((error) => console.error("[web] couldn't record the message for Slack:", error));
				return { ok: true, conversation: conversation.id };
			},
		},
		"/api/abort": {
			body: abortBody,
			handle: async ({ agent, conversation: id }) => {
				const conversation = id === undefined ? await home(agent) : await conversationAt(id, agent);
				if (options.stop === undefined) await conversation.abort(context);
				else await options.stop(conversation);
				return { ok: true };
			},
		},
		"/api/threads/start": {
			body: threadBody,
			handle: async (message) => {
				const content = message.content.trim();
				if (content === "" && (message.files ?? []).length === 0) throw new HttpError(400, "Empty message");
				const requestId = `web:${message.requestId ?? randomUUID()}`;
				const conversation = await refused(() => threads.start({ agent: message.agent, origin: "app", key: requestId }), 404);
				await conversation.submit({ type: "input", content: await input(content, message.files, conversation), requestId }, context);
				return { conversation: conversation.id };
			},
		},
		"/api/agents/save": {
			body: agentSave,
			handle: ({ id, name, job, hosts, ...change }) =>
				refused(async () => {
					if (!(await agents.list()).some((a) => a.id === id)) {
						if (name === undefined) throw new HttpError(400, "A new agent needs a name.");
						await agents.add({ id, name, job: job ?? "" });
					}
					const entryChange: Parameters<typeof agents.update>[1] = { name, job, ...change };
					// The default agent's hosts are kept with the approvals, where its fetches are checked against them.
					if (id === DEFAULT_AGENT && hosts !== undefined) await approvals.setFetchHosts(hosts);
					else entryChange.hosts = hosts;
					return shown(await agents.update(id, entryChange));
				}),
		},
		"/api/agents/archive": { body: agentArchive, handle: ({ id, archived }) => refused(async () => shown(await agents.archive(id, archived))) },
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
			handle: async (body) => {
				const shelf = await shelfOf(body);
				return refused(() => root.commit((tx) => addNote(tx, body.text, "owner", shelf), context));
			},
		},
		"/api/memory/update": {
			body: noteChange,
			handle: async (body) => {
				const shelf = await shelfOf(body);
				const note = await refused(() => root.commit((tx) => updateNote(tx, body.id, body.text, "owner", shelf), context));
				if (note === undefined) throw new HttpError(404, `No note ${body.id}`);
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
		"/api/memory/forget": {
			body: noteForget,
			handle: async (body) => {
				const shelf = await shelfOf(body);
				return { ok: (await root.commit((tx) => forgetNote(tx, body.id, shelf), context)) !== undefined };
			},
		},
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
				return settings(change.agent);
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
			if (options.app !== undefined && (path === APP_PATH || path.startsWith(`${APP_PATH}/`))) return serveApp(options.app, path.slice(APP_PATH.length), response);
			const code = scripts.get(path);
			if (code !== undefined) return reply(response, 200, code, "text/javascript; charset=utf-8");
			const file = files.get(path);
			if (file !== undefined) return reply(response, 200, file.body, file.type);
			if (path === "/events") return events(url, response);
			if (isGet(path)) return json(response, await gets[path](url));
		}
		if (request.method === "POST" && path === "/api/files") return json(response, await upload(request));
		if (request.method !== "POST" || !isPost(path)) throw new HttpError(404, "Not found");
		return json(response, await handlePost(path, await readBody(request)));
	}

	/** A file the app sends ahead of its message, kept until the message names it. */
	async function upload(request: IncomingMessage): Promise<Uploaded> {
		if (options.uploads === undefined) throw new HttpError(404, "This server doesn't take files.");
		const header = request.headers[FILE_HEADER.toLowerCase()];
		let name: string;
		try {
			name = decodeURIComponent(String(header)).trim().replace(/[/\\]/g, "_");
		} catch {
			throw new HttpError(400, `${FILE_HEADER} isn't a URI-encoded name`);
		}
		const data = await readBytes(request, MAX_FILE);
		if (data.length === 0) throw new HttpError(400, "The file is empty.");
		const type = request.headers["content-type"]?.split(";")[0]?.trim();
		return options.uploads.save(name === "" ? "file" : name, type === "" || type === "application/octet-stream" ? undefined : type, data);
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

/**
 * One of the app's files, or its shell for any other path, so the router's URLs survive a reload. Built files have
 * hashed names and are cached for good; the shell isn't cached. The shell's inline scripts change with each build, so
 * each is read as it's asked for and its scripts' hashes go in its policy, and a new build needs no restart.
 */
async function serveApp(dir: string, path: string, response: ServerResponse) {
	const root = resolve(dir);
	let decoded: string;
	try {
		decoded = decodeURIComponent(path);
	} catch {
		throw new HttpError(400, "Malformed path");
	}
	const file = resolve(root, `.${decoded}`);
	const inside = file.startsWith(root + sep) && !file.slice(root.length + 1).split(sep).some((part) => part.startsWith("."));
	if (inside && extname(file) !== ".html" && (await stat(file).catch(() => undefined))?.isFile()) {
		const cached = file.startsWith(resolve(root, "assets") + sep);
		response.writeHead(200, {
			...SECURITY_HEADERS,
			"Content-Type": APP_TYPES.get(extname(file)) ?? "application/octet-stream",
			"Cache-Control": cached ? "public, max-age=31536000, immutable" : "no-store",
		});
		return response.end(await readFile(file));
	}
	const shell = await readFile(resolve(root, APP_SHELL), "utf8").catch(() => undefined);
	if (shell === undefined) throw new HttpError(404, `The app isn't built: there's no ${APP_SHELL} in web.app's directory`);
	response.writeHead(200, {
		...SECURITY_HEADERS,
		"Content-Security-Policy": policy(inlineScripts(shell).map((code) => `'sha256-${createHash("sha256").update(code).digest("base64")}'`)),
		"Content-Type": "text/html; charset=utf-8",
		"Cache-Control": "no-store",
	});
	response.end(shell);
}

/** The text of each inline script in a page, as the browser hashes it. */
function inlineScripts(html: string): string[] {
	return [...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((match) => match[1]!);
}

/** Runs `work`, turning what it throws into an answer with `status` and its message: the request asked for what can't be. */
async function refused<T>(work: () => Promise<T>, status = 400): Promise<T> {
	try {
		return await work();
	} catch (error) {
		if (error instanceof HttpError) throw error;
		throw new HttpError(status, error instanceof Error ? error.message : String(error));
	}
}

class HttpError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

/**
 * Another site open in Brad's browser could post here with his tailnet identity. A JSON body, or a file with its
 * X-Gaidin-File header, forces a CORS preflight, which gets no CORS headers back, and the Origin has to be this host.
 */
function sameOrigin(request: IncomingMessage): boolean {
	const file = request.url?.split("?")[0] === "/api/files" && request.headers[FILE_HEADER.toLowerCase()] !== undefined;
	if (!file && !request.headers["content-type"]?.startsWith("application/json")) return false;
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

/** A body of bytes, up to `max`; a longer one is a 413. */
async function readBytes(request: IncomingMessage, max: number): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		size += chunk.length;
		if (size > max) {
			request.resume();
			throw new HttpError(413, `The file is over ${max / 1_000_000} MB.`);
		}
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}

function reply(response: ServerResponse, status: number, body: string | Buffer, type: string) {
	response.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": type, "Cache-Control": "no-store" });
	response.end(body);
}

function json<T>(response: ServerResponse, value: T) {
	reply(response, 200, JSON.stringify(value), "application/json");
}
