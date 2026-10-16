// The app's server: moiraine's build, from the directory web.app names, and the API it works through: each agent's
// conversations, live, its reminders, jobs, notes, skills and settings, the roster, and threads the owner starts and
// continues (threads.ts). A request names its agent with `?agent=` or `agent` in its body, and a conversation with
// `conversation`; without them, it's the default agent's home conversation, the root. It listens on loopback only;
// `tailscale serve` puts HTTPS in front and adds Tailscale-User-Login, and only GAIDIN_WEB_USER is let in.
//
// Every path that isn't the API or /events is the app's: one of its files (its icons, manifest and service worker
// among them, at the paths the web view had them), or its shell.
import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { type AgentEvent, type Conversation, type ConversationId, type Harness, type ModelRef, type SnapshotEvent, type ToolRegistration, type Tx, type UsageState, watchEvents } from "@earendil-works/pi-durable";
import { type AgentEntry, agentIdOf, DEFAULT_AGENT, type RosterService } from "./agents.ts";
import { BrowserState } from "./browser/index.ts";
import type { LiveEvent, TakeOver } from "./browser/takeover.ts";
import { CALLBACK_PATH, CLIENT_PATH, type Connector, type ConnectorService, offered, review, tokensOf, type ToolSetting } from "./connectors/index.ts";
import { FLOOR, newRule, type Rule, type RuleService } from "./rules.ts";
import type { ApprovalRequest, ApprovalService, Decision } from "./approvals.ts";
import type { BudgetGuard, BudgetStatus } from "./budget.ts";
import { context } from "./host.ts";
import type { ConversationSummary, createHistory } from "./history.ts";
import { type Attached, type Avatars, MAX_FILE, type Uploaded, type Uploads, withFiles } from "./files.ts";
import { conversationId } from "./ids.ts";
import { describeSchedule, type Job, jobOf, Jobs, pauseJob, removeJob, resumeJob } from "./jobs.ts";
import { addNote, forgetNote, MAX_NOTE, MAX_TOTAL, MAX_WORK, type Note, notesOn, SHARED, type Shelf, updateNote } from "./memory.ts";
import { array, boolean, integer, literal, number, object, optional, ParseError, type Parser, parseJson, string } from "./parse.ts";
import type { Device, Push } from "./push.ts";
import { type Reminder, reminderOf, Reminders, removeReminder } from "./reminders.ts";
import { type createSkills, readSkillFile, type Skill } from "./skills.ts";
import type { Threads } from "./threads.ts";
import { stamp } from "./time.ts";


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

/** Where the app was served beside the web view, before it took its place: its old addresses go to the new ones. */
const OLD_APP_PATH = "/app";
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
export const PROTOCOL = 11;

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
	profiles: optional(array(string)),
	connectors: optional(array(string)),
	/** By profile, the hosts it acts on without asking: each profile's whole list, the profiles not named left as they are. */
	actHosts: optional(array(object({ profile: string, hosts: array(string) }))),
	hosts: optional(array(string)),
	extensions: optional(array(string)),
	/** A file sent to /api/files, to be its picture, or "" to take its picture away. */
	avatar: optional(string),
});
const agentArchive = object({ id: string, archived: boolean });
const profileBody = object({ profile: string });
const connectorName = object({ name: string });
const ruleId = object({ id: string });
const connectorAdd = object({ name: string, url: string, token: optional(string) });
const connectorConnect = object({ name: string, clientId: optional(string) });
/** A token to use from now on, or none to take it away. */
const connectorToken = object({ name: string, token: optional(string) });
const connectorTool = object({ name: string, tool: string, setting: literal<ToolSetting>("allow", "ask", "off") });
const liveInput = object({
	type: literal("click", "down", "up", "move", "wheel", "key", "text"),
	x: optional(number),
	y: optional(number),
	button: optional(literal("left", "right", "middle")),
	dx: optional(number),
	dy: optional(number),
	key: optional(string),
	text: optional(string),
});
const inputBody = object({ profile: string, events: array(liveInput) });
/** `url` to open, or `back`. */
const goBody = object({ profile: string, url: optional(string), back: optional(boolean) });
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
/**
 * What an agent is up to: whether a run of its is going, in any of its conversations, and its newest message, the owner's
 * or its own (`role`), with where it is. `place` "main" is its home conversation.
 */
export type AgentActivity = { agent: string; running: boolean; last?: { at: number; text: string; role: "user" | "assistant"; conversation: number; place: "main" | ConversationSummary["place"] } };
/** A skill as the page lists it, without where it is on the server. */
export type ListedSkill = Omit<Skill, "dir">;
const listed = ({ name, description, source, files }: Skill): ListedSkill => ({ name, description, source, files });

// The protocol between the app (moiraine) and this server: what each route answers, and what each POST takes.
// The route tables below are checked against these, and the app's requests are typed by them.

/** What each GET route answers. */
export type Gets = {
	"/api/version": { protocol: number };
	/** Every agent, archived ones included, the default agent first. */
	"/api/agents": AgentEntry[];
	/** Every agent's activity, for the sidebar. */
	"/api/agents/activity": AgentActivity[];
	/** The workspaces an agent can be given, by name. */
	"/api/workspaces": { names: string[] };
	/** The browser profiles an agent can be given, by name. */
	"/api/profiles": { names: string[] };
	/** Each browser profile: the page it was last on and the agent there, and whether the owner has it taken over. */
	"/api/browser": BrowserProfile[];
	/** Each connector, its tools and how they're set; never a token. */
	"/api/connectors": ListedConnector[];
	/** The owner's rules in force, the grants beside them that also let calls through, and the tools no allow rule reaches. */
	"/api/rules": { rules: Rule[]; grants: RuleGrant[]; floor: string[] };
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
export type { LiveEvent };
/**
 * A connector as the app lists it: what's stored, with each tool's review (new or changed since the owner set it) and
 * about how many tokens its offered tools add to each request.
 */
export type ListedConnector = Omit<Connector, "tools"> & { tokens: number; tools: (Connector["tools"][number] & { review?: "new" | "changed" })[] };
const listedConnector = (connector: Connector): ListedConnector => ({
	...connector,
	tokens: tokensOf(connector),
	tools: connector.tools.map((tool) => {
		const waiting = review(tool);
		return waiting === undefined ? tool : { ...tool, review: waiting };
	}),
});

/**
 * Something besides a rule that lets calls through without asking, where it's changed: a host an agent fetches from
 * (settings), a site it acts on in a browser profile (settings), a connector tool set to allow (connectors), or a
 * workspace allowed for an hour in one conversation.
 */
export type RuleGrant = { kind: "host" | "act-host" | "connector-tool" | "workspace-hour"; agent?: string; what: string; until?: number; conversation?: number };

/** A browser profile as the app lists it. */
export type BrowserProfile = { name: string; url?: string; agent?: string; at?: number; held: boolean };
/**
 * GET with `?profile=`: an event stream of LiveEvents, the profile's current tab as JPEG frames, taking it over for the
 * owner while anyone watches. Every agent's browser call on it waits until the owner is done.
 */
export const LIVE_PATH = "/api/browser/live";
/**
 * POST /api/files takes a file's bytes, up to 20 MB, as the body, its name URI-encoded in X-Gaidin-File and its type
 * in Content-Type, and answers with this. A message names its files by their ids. The header makes a browser ask
 * first, as a JSON body does, and the Origin is checked as for every POST.
 */
export const FILE_HEADER = "X-Gaidin-File";
/**
 * GET with `?id=` an agent's id: its picture (AgentEntry.avatar), cached for good, since a new one has a new name; add
 * `&v=` the name, so the address changes with it. 404 when it has none.
 */
export const AVATAR_PATH = "/api/agents/avatar";
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
	/** The owner's input to a profile they've taken over, in order. 409 when they haven't. */
	"/api/browser/input": { body: BodyOf<typeof inputBody>; answer: Ok };
	/** The owner's navigation in a profile they've taken over. */
	"/api/browser/go": { body: BodyOf<typeof goBody>; answer: Ok };
	/** The owner is done with a profile: the agents' calls on it go ahead, and any hand-over of it is done. */
	"/api/browser/release": { body: BodyOf<typeof profileBody>; answer: Ok };
	/** A new connector, connected and its tools read; kept even when connecting fails. */
	"/api/connectors/add": { body: BodyOf<typeof connectorAdd>; answer: ListedConnector };
	/** Starts signing a connector in: the address to send the browser to. It comes back to the Connectors page. */
	"/api/connectors/connect": { body: BodyOf<typeof connectorConnect>; answer: { url: string } };
	"/api/connectors/refresh": { body: BodyOf<typeof connectorName>; answer: ListedConnector };
	"/api/connectors/token": { body: BodyOf<typeof connectorToken>; answer: ListedConnector };
	/** Sets a tool to allow, ask or off, and accepts its definition as it is now. */
	"/api/connectors/tool": { body: BodyOf<typeof connectorTool>; answer: ListedConnector };
	/** Removes a connector, its tokens and every agent's grant of it. */
	"/api/connectors/remove": { body: BodyOf<typeof connectorName>; answer: Ok };
	/** A new rule, checked as it's made. */
	"/api/rules/add": { body: BodyOf<typeof newRule>; answer: Rule };
	"/api/rules/remove": { body: BodyOf<typeof ruleId>; answer: Ok };
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
	/** The browser profiles' names, which an agent's entry gives it. Default: none. */
	profiles?: () => readonly string[];
	/** Taking a profile over; without it the browser routes are 404s. */
	takeOver?: TakeOver;
	/** The connectors, whose sign-ins come back to CALLBACK_PATH. */
	connectors?: ConnectorService;
	/** The owner's rules. */
	rules?: RuleService;
	threads: Threads;
	user: string;
	/** The directory of moiraine's build, the app, served at /. */
	app?: string;
	/**
	 * Posts a message sent from the app in its conversation's Slack thread, if it has one, and then its answer (slack/).
	 * Resolves once that's recorded. `submission` is the message's.
	 */
	mirror?: (sent: { conversationId: number; submission: number; text: string; files?: readonly string[] }) => Promise<boolean>;
	/** Files the app sends ahead of the messages that name them. Without it, /api/files refuses them. */
	uploads?: Uploads;
	/** The agents' pictures. Without it, an agent can't be given one. */
	avatars?: Avatars;
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
	/** Threads, job runs and each agent's newest message, for the sidebar. */
	history?: Pick<ReturnType<typeof createHistory>, "conversations" | "conversation" | "latest">;
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

	/** An agent's new picture's name, from the file sent to /api/files as `upload`; "" takes it away. */
	async function picture(agent: string, upload: string): Promise<string> {
		if (upload === "") return "";
		if (options.avatars === undefined || options.uploads === undefined) throw new HttpError(400, "This server doesn't keep pictures.");
		const { avatars, uploads } = options;
		return refused(async () => avatars.keep(agent, await uploads.attached(upload).load()));
	}

	/** An agent's picture. */
	async function avatar(url: URL, response: ServerResponse) {
		const entry = (await agents.list()).find((a) => a.id === url.searchParams.get("id"));
		const found = entry?.avatar === undefined ? undefined : options.avatars?.read(entry.avatar);
		if (found === undefined) throw new HttpError(404, "No picture");
		response.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": found.type, "Cache-Control": "private, max-age=31536000, immutable" });
		response.end(found.data);
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

	/** The take-over, for a profile the settings name. */
	function takeOverOf(profile: string | null) {
		const takeOver = options.takeOver;
		if (takeOver === undefined) throw new HttpError(404, "There's no browser: the settings name no profiles.");
		if (profile === null || !(options.profiles?.() ?? []).includes(profile)) throw new HttpError(404, `There's no browser profile ${profile ?? ""}.`);
		return { takeOver, profile };
	}

	/** A failure of the owner's input or navigation: 409 when the profile isn't taken over, else the page's error. */
	async function asOwner(work: () => Promise<void>): Promise<Ok> {
		try {
			await work();
		} catch (error) {
			const message = error instanceof Error ? error.message.split("\n")[0]! : String(error);
			throw new HttpError(/isn't taken over/.test(message) ? 409 : 400, message);
		}
		return { ok: true };
	}

	/**
	 * A profile's live view, which takes it over while it's open. Opening it changes something, as a POST does, so a
	 * request another site made in the owner's browser is refused, by the header browsers mark it with.
	 */
	async function live(url: URL, request: IncomingMessage, response: ServerResponse) {
		const site = request.headers["sec-fetch-site"];
		if (site !== undefined && site !== "same-origin") throw new HttpError(403, "Cross-site request");
		const { takeOver, profile } = takeOverOf(url.searchParams.get("profile"));
		response.writeHead(200, {
			...SECURITY_HEADERS,
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-store",
			"X-Accel-Buffering": "no",
		});
		let open = true;
		const viewer = (event: LiveEvent) => {
			if (!open) return true;
			const flowing = response.write(`data: ${JSON.stringify(event)}\n\n`);
			if (event.type === "released") response.end();
			return flowing;
		};
		const ping = setInterval(() => response.write(": ping\n\n"), 25_000);
		let stop: (() => void) | undefined;
		response.once("close", () => {
			open = false;
			clearInterval(ping);
			stop?.();
		});
		try {
			stop = await takeOver.watch(profile, viewer);
			if (!open) stop();
		} catch (error) {
			viewer({ type: "released", reason: `couldn't open it: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}` });
		}
	}

	/**
	 * Where the owner's browser comes back to from signing a connector in. The state it carries is the one gaidin made, so
	 * another site can't finish a sign-in it didn't start. It goes on to the app's Connectors page, or says what failed.
	 */
	async function signedIn(url: URL, response: ServerResponse) {
		if (options.connectors === undefined) throw new HttpError(404, "There are no connectors.");
		try {
			const connector = await options.connectors.callback(url.searchParams);
			// Back to the app's page, which says how it went.
			response.writeHead(303, { ...SECURITY_HEADERS, Location: `/connectors?signed_in=${encodeURIComponent(connector.name)}`, "Cache-Control": "no-store" });
			response.end();
		} catch (error) {
			reply(response, 400, `Signing in didn't finish: ${error instanceof Error ? error.message : String(error)}`, "text/plain; charset=utf-8");
		}
	}

	/** Runs `work` with the connectors; what it refuses, such as a bad URL or an unknown connector, is a 400. */
	async function owned<T>(work: (connectors: ConnectorService) => Promise<T>): Promise<T> {
		if (options.connectors === undefined) throw new HttpError(404, "There are no connectors.");
		try {
			return await work(options.connectors);
		} catch (error) {
			throw error instanceof HttpError ? error : new HttpError(400, error instanceof Error ? error.message : String(error));
		}
	}
	const asConnector = (work: (connectors: ConnectorService) => Promise<Connector>) => owned(async (c) => listedConnector(await work(c)));

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
		"/api/profiles": async () => ({ names: [...(options.profiles?.() ?? [])] }),
		"/api/connectors": async () => (options.connectors?.list() ?? []).map(listedConnector),
		"/api/rules": async () => {
			const { fetchHosts, grants = [] } = await approvals.state();
			const now = Date.now();
			const listed: RuleGrant[] = [];
			for (const agent of await agents.list()) {
				for (const host of agent.id === DEFAULT_AGENT ? fetchHosts : agent.hosts) listed.push({ kind: "host", agent: agent.id, what: host });
				for (const [profile, hosts] of Object.entries(agent.actHosts ?? {})) for (const host of hosts) listed.push({ kind: "act-host", agent: agent.id, what: `${host} in ${profile}` });
			}
			for (const connector of options.connectors?.list() ?? []) {
				for (const tool of connector.tools) if (offered(tool) && tool.setting === "allow") listed.push({ kind: "connector-tool", what: `${connector.name}: ${tool.name}` });
			}
			for (const grant of grants) {
				if (grant.until <= now) continue;
				const agent = await agentIdOf(harness, grant.conversationId, context);
				listed.push({ kind: "workspace-hour", agent, what: grant.workspace, until: grant.until, conversation: grant.conversationId });
			}
			return { rules: (await options.rules?.list()) ?? [], grants: listed, floor: FLOOR };
		},
		"/api/browser": async () => {
			const state = (await harness.snapshot(BrowserState, context))?.profiles ?? {};
			return (options.profiles?.() ?? []).map((name): BrowserProfile => ({ name, ...state[name], held: options.takeOver?.held(name) === true }));
		},
		"/api/agents/activity": async () => {
			// Each conversation with a message waiting or being answered, as its agent's.
			const busy = new Set<string>();
			const owners = new Map<ConversationId, string>();
			for (const { conversationId: id } of (await harness.inspect(context)).submissions) {
				if (!owners.has(id)) owners.set(id, await agentIdOf(harness, id, context));
				busy.add(owners.get(id)!);
			}
			const latest = new Map(((await options.history?.latest()) ?? []).map((row) => [row.agent, row]));
			return (await agents.list()).map(({ id }): AgentActivity => {
				const row = latest.get(id);
				const activity: AgentActivity = { agent: id, running: busy.has(id) };
				if (row !== undefined) activity.last = { at: row.at, text: row.text, role: row.role, conversation: row.conversation, place: row.place };
				return activity;
			});
		},
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
			handle: ({ id, name, job, hosts, avatar, actHosts, ...change }) =>
				refused(async () => {
					if (!(await agents.list()).some((a) => a.id === id)) {
						if (name === undefined) throw new HttpError(400, "A new agent needs a name.");
						await agents.add({ id, name, job: job ?? "" });
					}
					const entryChange: Parameters<typeof agents.update>[1] = { name, job, ...change };
					if (actHosts !== undefined) {
						const current = (await agents.list()).find((a) => a.id === id)?.actHosts ?? {};
						entryChange.actHosts = { ...current, ...Object.fromEntries(actHosts.map((a) => [a.profile, a.hosts])) };
					}
					if (avatar !== undefined) entryChange.avatar = await picture(id, avatar);
					// The default agent's hosts are kept with the approvals, where its fetches are checked against them.
					if (id === DEFAULT_AGENT && hosts !== undefined) await approvals.setFetchHosts(hosts);
					else entryChange.hosts = hosts;
					const entry = await agents.update(id, entryChange);
					if (avatar !== undefined) options.avatars?.prune(id, entry.avatar);
					return shown(entry);
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
		"/api/browser/input": {
			body: inputBody,
			handle: async ({ profile, events }) => {
				const found = takeOverOf(profile);
				return asOwner(() => found.takeOver.input(found.profile, events));
			},
		},
		"/api/browser/go": {
			body: goBody,
			handle: async ({ profile, url, back }) => {
				const found = takeOverOf(profile);
				if (url !== undefined && !/^https?:\/\//i.test(url)) throw new HttpError(400, "Open an http or https address.");
				if (url === undefined && back !== true) throw new HttpError(400, "Give a url, or back.");
				return asOwner(() => found.takeOver.go(found.profile, url === undefined ? { back: true } : { url }));
			},
		},
		"/api/browser/release": {
			body: profileBody,
			handle: async ({ profile }) => {
				const found = takeOverOf(profile);
				await found.takeOver.release(found.profile, "you're done");
				for (const request of await approvals.pending()) {
					if (request.kind === "handover" && request.profile === found.profile) await approvals.decide(request.id, "once", "web");
				}
				return { ok: true };
			},
		},
		"/api/rules/add": {
			body: newRule,
			handle: async (rule) => {
				if (options.rules === undefined) throw new HttpError(404, "There are no rules here.");
				try {
					return await options.rules.add(rule);
				} catch (error) {
					throw new HttpError(400, error instanceof Error ? error.message : String(error));
				}
			},
		},
		"/api/rules/remove": {
			body: ruleId,
			handle: async ({ id }) => {
				if (options.rules === undefined) throw new HttpError(404, "There are no rules here.");
				try {
					await options.rules.remove(id);
				} catch (error) {
					throw new HttpError(400, error instanceof Error ? error.message : String(error));
				}
				return { ok: true };
			},
		},
		"/api/connectors/add": { body: connectorAdd, handle: (body) => asConnector(async (c) => c.add(body)) },
		"/api/connectors/connect": { body: connectorConnect, handle: ({ name, clientId }) => owned(async (c) => ({ url: await c.connect(name, clientId) })) },
		"/api/connectors/refresh": { body: connectorName, handle: ({ name }) => asConnector((c) => c.refresh(name)) },
		"/api/connectors/token": { body: connectorToken, handle: ({ name, token }) => asConnector((c) => c.setToken(name, token)) },
		"/api/connectors/tool": {
			body: connectorTool,
			handle: ({ name, tool, setting }) =>
				asConnector(async (c) => {
					await c.setTool(name, tool, setting);
					return c.list().find((found) => found.name === name)!;
				}),
		},
		"/api/connectors/remove": { body: connectorName, handle: ({ name }) => owned(async (c) => (await c.remove(name), { ok: true })) },
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
			if (path === "/events") return events(url, response);
			if (path === LIVE_PATH) return live(url, request, response);
			if (path === CALLBACK_PATH) return signedIn(url, response);
			if (path === CLIENT_PATH) {
				const document = options.connectors?.clientDocument();
				if (document === undefined) throw new HttpError(404, "Signing connectors in needs web.url in the settings.");
				return json(response, document);
			}
			if (path === AVATAR_PATH) return avatar(url, response);
			if (isGet(path)) return json(response, await gets[path](url));
			if (path === OLD_APP_PATH || path.startsWith(`${OLD_APP_PATH}/`)) return redirect(response, `${path.slice(OLD_APP_PATH.length) || "/"}${url.search}`);
			if (!path.startsWith("/api/")) {
				if (options.app === undefined) throw new HttpError(404, "There's no app here: set web.app in gaidin's settings to the directory of moiraine's build.");
				return serveApp(options.app, path, response);
			}
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

/** Sends the browser to `to` for good, keeping the method. */
function redirect(response: ServerResponse, to: string) {
	response.writeHead(308, { ...SECURITY_HEADERS, Location: to, "Cache-Control": "no-store" });
	response.end();
}

function reply(response: ServerResponse, status: number, body: string | Buffer, type: string) {
	response.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": type, "Cache-Control": "no-store" });
	response.end(body);
}

function json<T>(response: ServerResponse, value: T) {
	reply(response, 200, JSON.stringify(value), "application/json");
}
