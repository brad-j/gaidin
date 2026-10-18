// Approval hook: some tool calls wait for the owner to allow them, from Slack or the app.
//
// Each tool's rules are its guard (guards.ts), which the module that owns the tool declares. A beforeTool
// hook finds the call's guard and asks it whether the call needs approval. If it does, the hook takes a
// request id from a memo on the tool task, so after a restart the rerun of the same call finds the same
// request, and waits for the decision. Requests and decisions live in a session document; hooks can't
// write documents, so the host's ApprovalService does the writing and tells the surfaces.
//
// Before asking, the hook checks whether the call can succeed at all (the guard's `refuse`), so the owner is
// never asked to allow something that would fail. An answer can come days later, so after an approval it
// checks again: an approval allows a call, but never one that has become impossible since.
import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as background } from "@earendil-works/chord/context";
import { type Message, type ToolCall, Type } from "@earendil-works/pi-ai";
import { type ConversationId, defineDoc, defineEntry, defineExtension, defineTool, type DocumentReader, type Harness, type HookApi, hook, type ToolExecutionApi, ToolTask, type Tx } from "@earendil-works/pi-durable";
import { AGENT_MESSAGE, agentAt, AgentOf, Agents, DEFAULT_AGENT, entryOf, hostsOf, rosterOf } from "./agents.ts";
import type { Ask, Guard, Situation, Where } from "./guards.ts";
import { GATE_FINDINGS } from "./jobs.ts";
import { VOICE_MESSAGE } from "./threads.ts";
import { attempt, isObject, json, type Json, ParseError, scalar, string } from "./parse.ts";
import { confinedBy, folderOf, INSIDE_TOOLS, type Rule, rulesFor, rulesIn, WITHIN, type Within } from "./rules.ts";
import { clip, whole } from "./guards.ts";
import { searchedUrls } from "./search.ts";
import { conversationId, taskId } from "./ids.ts";

export type Decision = "once" | "always" | "deny";
/** "superseded": the owner sent a new message in the conversation instead of answering. */
export type ApprovalStatus = "pending" | "approved" | "denied" | "answered" | "expired" | "cancelled" | "superseded";

export type ApprovalRequest = {
	id: string;
	conversationId: number;
	/** The agent whose conversation asks. Absent: the default agent. */
	agent?: string;
	/** The tool call's task. A request whose task has ended isn't waited on any more. */
	taskId: number;
	tool: string;
	/** One line for the owner: what the call does, or for a question, the question. */
	summary: string;
	/** More than a line can hold, such as the diff of a self-written extension. */
	detail?: string;
	/** A question from ask_owner, or a request to take over a browser profile from browser_hand_over, rather than a request to allow a call. */
	kind?: "question" | "handover";
	/** For a hand-over, the profile to take over. */
	profile?: string;
	/** Answers offered as buttons. */
	choices?: string[];
	/** The owner's answer to a question. */
	answer?: string;
	/**
	 * The call's arguments that are short text, numbers or true and false, for the app to make a rule from the request.
	 * Longer ones, such as a file's content, are left out.
	 */
	ruleArgs?: Record<string, string>;
	/** The wider grant the second button gives, when one is offered. `label` is the button, `done` the outcome. */
	always?: { kind: "fetch-host" | "workspace-hour" | "act-host"; value: string; label: string; done: string };
	createdAt: number;
	expiresAt: number;
	status: ApprovalStatus;
	decidedAt?: number;
	/** Where it was decided: "slack" or "web". */
	by?: string;
	decision?: Decision;
	/** The Slack message that asks, once it's posted. */
	slackTs?: string;
	/** Its channel, when that isn't the default agent's. */
	slackChannel?: string;
};

/** A workspace allowed in one conversation until a time. */
export type Grant = { workspace: string; conversationId: number; until: number };

export const Approvals = defineDoc<{ requests: Record<string, ApprovalRequest>; fetchHosts: string[]; grants?: Grant[] }>({
	kind: "gaidin.approvals",
	version: 1,
	scope: "session",
	initial: () => ({ requests: {}, fetchHosts: [] }),
});

/**
 * How a request ended, written into its conversation for the timeline (history.ts). The model doesn't see it, and
 * it outlives the request, which is dropped from the document a week after it's decided.
 */
export const ApprovalSettled = defineEntry<Pick<ApprovalRequest, "id" | "tool" | "summary" | "status" | "kind" | "decision" | "by" | "answer" | "decidedAt">>("gaidin.approval");

type ApprovalState = { requests: Record<string, ApprovalRequest>; fetchHosts: string[]; grants?: Grant[] };

const WORKSPACE_GRANT_MS = 60 * 60_000;

/** What `call` asks under its guard, or nothing. Arguments the guard can't read ask too, showing all of them. */
export async function askFor(guard: Guard, call: ToolCall, situation: Situation): Promise<Ask | undefined> {
	try {
		return await guard.ask(call.arguments, situation);
	} catch (error) {
		if (!(error instanceof ParseError)) throw error;
		// Better asked about than let through: the tool reports what's wrong with them.
		return { summary: `${call.name} with arguments that don't read right (${error.message})`, detail: JSON.stringify(call.arguments, null, 2) };
	}
}

/** Why `call` can't succeed under its guard, or nothing. Arguments it can't read aren't refused here; they ask (askFor). */
async function refusalOf(guard: Guard, call: ToolCall, read: DocumentReader, context: Context, where: Where): Promise<string | undefined> {
	try {
		return await guard.refuse(call.arguments, read, context, where);
	} catch (error) {
		if (error instanceof ParseError) return undefined;
		throw error;
	}
}

/** A copy that outlives the commit: a draft's nested objects stop working once it's committed. */
function plain(request: ApprovalRequest): ApprovalRequest {
	// SAFETY: a request is plain JSON data, so a JSON round trip gives back the same request.
	return JSON.parse(JSON.stringify(request)) as ApprovalRequest;
}

/** Requests decided this long ago are dropped from the document. */
const KEEP_DECIDED_MS = 7 * 24 * 3_600_000;

export class ApprovalService {
	readonly #harness: Harness;
	readonly #timeoutMs: number;
	readonly #waiters = new Map<string, Set<(request: ApprovalRequest) => void>>();
	readonly #listeners = new Set<(request: ApprovalRequest) => void | Promise<void>>();

	constructor(harness: Harness, options: { timeoutMs?: number } = {}) {
		this.#harness = harness;
		this.#timeoutMs = options.timeoutMs ?? 7 * 24 * 3_600_000;
	}

	async state(): Promise<ApprovalState> {
		return (await this.#harness.snapshot(Approvals, background)) ?? { requests: {}, fetchHosts: [] };
	}

	/** The hosts `agent` fetches from without asking. */
	async hostsFor(agent: string): Promise<readonly string[]> {
		return hostsOf(entryOf(await rosterOf(this.#harness, background), agent), (await this.state()).fetchHosts);
	}

	/** Sets the hosts the default agent fetches from without asking. The other agents' are in their roster entries. */
	async setFetchHosts(hosts: readonly string[]): Promise<void> {
		await this.#commit((doc) => {
			doc.fetchHosts = [...new Set(hosts)];
		});
	}

	/** Requests still waiting for the owner. Ones whose call was stopped, or whose time ran out while the server was down, are closed. */
	async pending(): Promise<ApprovalRequest[]> {
		const waiting: ApprovalRequest[] = [];
		for (const request of Object.values((await this.state()).requests)) {
			if (request.status !== "pending") continue;
			if (await this.#reap(request)) continue;
			waiting.push(request);
		}
		return waiting.sort((a, b) => a.createdAt - b.createdAt);
	}

	/** Closes a pending request nothing will wait for again. True if it did. */
	async #reap(request: ApprovalRequest): Promise<boolean> {
		if (request.expiresAt <= Date.now()) {
			await this.close(request.id, "expired");
			return true;
		}
		const task = await this.#harness.getTask(taskId(request.taskId), background);
		if (task === undefined || task.state.status === "completing" || task.state.status === "terminal") {
			await this.close(request.id, "cancelled");
			return true;
		}
		return false;
	}

	/** Called with every new or changed request. Surfaces use it to ask and to show the outcome. */
	onChange(listener: (request: ApprovalRequest) => void | Promise<void>): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async #commit<T>(change: (doc: ApprovalState, tx: Tx) => T | Promise<T>): Promise<T> {
		const root = await this.#harness.root(background);
		return root.commit(async (tx) => change(await tx.doc(Approvals), tx), background);
	}

	/** Records how `request` ended in its conversation, and returns a copy that outlives the commit. */
	async #record(tx: Tx, request: ApprovalRequest): Promise<ApprovalRequest> {
		const done = plain(request);
		const { id, tool, summary, status, kind, decision, by, answer, decidedAt } = done;
		const data = JSON.parse(JSON.stringify({ id, tool, summary, status, kind, decision, by, answer, decidedAt }));
		await tx.appendEntry(ApprovalSettled, conversationId(request.conversationId), { data });
		return done;
	}

	#emit(request: ApprovalRequest) {
		for (const listener of this.#listeners) {
			Promise.resolve(listener(request)).catch((error) => console.error("[approvals]", error));
		}
	}

	/** Records a request under `id` unless it exists, and returns it as stored. */
	async open(id: string, at: { conversationId: number; taskId: number }, tool: string, ask: Pick<ApprovalRequest, "summary" | "detail" | "always" | "kind" | "choices" | "profile" | "ruleArgs">): Promise<ApprovalRequest> {
		const now = Date.now();
		const agent = (await this.#harness.snapshot(AgentOf, conversationId(at.conversationId), background))?.agent ?? DEFAULT_AGENT;
		const { request, created } = await this.#commit((doc) => {
			for (const [key, old] of Object.entries(doc.requests)) {
				if (old.status !== "pending" && (old.decidedAt ?? old.createdAt) < now - KEEP_DECIDED_MS) delete doc.requests[key];
			}
			const existing = doc.requests[id];
			if (existing !== undefined) return { request: plain(existing), created: false };
			const fresh: ApprovalRequest = { id, ...at, tool, ...ask, createdAt: now, expiresAt: now + this.#timeoutMs, status: "pending" };
			if (agent !== DEFAULT_AGENT) fresh.agent = agent;
			doc.requests[id] = fresh;
			return { request: plain(fresh), created: true };
		});
		if (created) this.#emit(request);
		return request;
	}

	/** The owner's answer: for a hand-over, "once" is done and "deny" is couldn't. Returns the request, or nothing if it wasn't pending. */
	async decide(id: string, decision: Decision, by: string): Promise<ApprovalRequest | undefined> {
		const decided = await this.#commit(async (doc, tx) => {
			const request = doc.requests[id];
			if (request === undefined || request.status !== "pending" || request.kind === "question") return undefined;
			if (request.kind === "handover" && decision === "always") return undefined;
			if (request.expiresAt <= Date.now()) {
				request.status = "expired";
				request.decidedAt = Date.now();
				return this.#record(tx, request);
			}
			request.status = decision === "deny" ? "denied" : "approved";
			request.decidedAt = Date.now();
			request.by = by;
			request.decision = decision;
			// A host is allowed for the agent that asked, the default agent's in this document and the others' in the roster.
			if (decision === "always" && request.always?.kind === "fetch-host") {
				const host = request.always.value;
				const other = request.agent === undefined ? undefined : (await tx.doc(Agents)).agents.find((a) => a.id === request.agent);
				const hosts = other === undefined ? doc.fetchHosts : other.hosts;
				if (!hosts.includes(host)) hosts.push(host);
			}
			// Acting without asking is allowed for the agent that asked, on that host in that profile only: value is <profile>/<host>.
			if (decision === "always" && request.always?.kind === "act-host") {
				const [profile = "", host = ""] = request.always.value.split("/");
				const agent = (await tx.doc(Agents)).agents.find((a) => a.id === (request.agent ?? DEFAULT_AGENT));
				const hosts = agent?.actHosts?.[profile] ?? [];
				if (agent !== undefined && !hosts.includes(host)) {
					// SAFETY: actHosts is plain JSON data, so a JSON round trip gives back the same lists.
					const acts = JSON.parse(JSON.stringify(agent.actHosts ?? {})) as Record<string, string[]>;
					acts[profile] = [...hosts, host];
					agent.actHosts = acts;
				}
			}
			if (decision === "always" && request.always?.kind === "workspace-hour") {
				const now = Date.now();
				doc.grants = [
					...(doc.grants ?? []).filter((g) => g.until > now),
					{ workspace: request.always.value, conversationId: request.conversationId, until: now + WORKSPACE_GRANT_MS },
				];
			}
			return this.#record(tx, request);
		});
		if (decided !== undefined) this.#settled(decided);
		return decided;
	}

	/** The owner's answer to a question. Returns the request, or nothing if it wasn't a pending question. */
	async answer(id: string, text: string, by: string): Promise<ApprovalRequest | undefined> {
		const answer = text.trim();
		if (answer === "") return undefined;
		const answered = await this.#commit(async (doc, tx): Promise<ApprovalRequest | undefined> => {
			const request = doc.requests[id];
			if (request === undefined || request.status !== "pending" || request.kind !== "question") return undefined;
			request.status = "answered";
			request.answer = answer;
			request.decidedAt = Date.now();
			request.by = by;
			return this.#record(tx, request);
		});
		if (answered !== undefined) this.#settled(answered);
		return answered;
	}

	/**
	 * The owner's new message in a conversation. If a question is waiting there, the message is its answer
	 * ("answered"). Otherwise pending approvals there are closed as superseded, so the run stops waiting
	 * and the message can run ("continue").
	 */
	async intercept(conversationId: number, text: string, by: string): Promise<"answered" | "continue"> {
		const waiting = (await this.pending()).filter((r) => r.conversationId === conversationId);
		const question = waiting.find((r) => r.kind === "question");
		if (question !== undefined && (await this.answer(question.id, text, by)) !== undefined) return "answered";
		for (const request of waiting) await this.close(request.id, "superseded");
		return "continue";
	}

	/** Closes what's waiting in a conversation, questions included, as a new message that isn't an answer does. */
	async supersede(conversationId: number): Promise<void> {
		for (const request of await this.pending()) if (request.conversationId === conversationId) await this.close(request.id, "superseded");
	}

	/** The pending question asked in the Slack message `ts` in `channel`, the default agent's when it's not given, if any. */
	async questionAt(ts: string, channel?: string): Promise<ApprovalRequest | undefined> {
		return (await this.pending()).find((r) => r.kind === "question" && r.slackTs === ts && r.slackChannel === channel);
	}

	/** Ends a pending request without an answer: the run was stopped, the time ran out, or the owner moved on. */
	async close(id: string, status: "expired" | "cancelled" | "superseded"): Promise<void> {
		const closed = await this.#commit(async (doc, tx): Promise<ApprovalRequest | undefined> => {
			const request = doc.requests[id];
			if (request === undefined || request.status !== "pending") return undefined;
			request.status = status;
			request.decidedAt = Date.now();
			return this.#record(tx, request);
		});
		if (closed !== undefined) this.#settled(closed);
	}

	/** Records a call an allow rule let through without asking, in its conversation, for the timeline. */
	async ruled(at: { conversationId: number; taskId: number }, tool: string, summary: string, rule: Rule): Promise<void> {
		await this.#commit(async (_doc, tx) => {
			const data = { id: `rule:${at.taskId}`, tool, summary, status: "approved" as const, decision: "once" as const, by: `rule ${rule.id}`, decidedAt: Date.now() };
			await tx.appendEntry(ApprovalSettled, conversationId(at.conversationId), { data });
		});
	}

	/** Remembers where a surface asked, so it can show the outcome there. */
	async note(id: string, fields: Pick<ApprovalRequest, "slackTs" | "slackChannel">): Promise<void> {
		await this.#commit((doc) => {
			const request = doc.requests[id];
			if (request !== undefined) Object.assign(request, fields);
		});
	}

	/** Background bookkeeping; it fails harmlessly once the Harness is closed. */
	#quietly(work: Promise<unknown>) {
		work.catch(() => {});
	}

	#settled(request: ApprovalRequest) {
		for (const resolve of this.#waiters.get(request.id) ?? []) resolve(request);
		this.#waiters.delete(request.id);
		this.#emit(request);
	}

	/** Resolves with the request once it's no longer pending. */
	async wait(request: ApprovalRequest, signal: AbortSignal | undefined): Promise<ApprovalRequest> {
		if (request.status !== "pending") return request;
		const settled = new Promise<ApprovalRequest>((resolve, reject) => {
			let set = this.#waiters.get(request.id);
			if (set === undefined) this.#waiters.set(request.id, (set = new Set()));
			const waiter = (done: ApprovalRequest) => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				resolve(done);
			};
			set.add(waiter);
			const timer = setTimeout(() => this.#quietly(this.close(request.id, "expired")), Math.max(0, request.expiresAt - Date.now()));
			timer.unref();
			// Stop and a shutdown both abort. Only a stopped call's task ends, so the request is closed only
			// then; after a restart the call runs again and waits on the same request.
			const onAbort = () => {
				clearTimeout(timer);
				set!.delete(waiter);
				setTimeout(() => this.#quietly(this.#reap(request)), 500).unref();
				reject(signal!.reason ?? new Error("aborted"));
			};
			if (signal?.aborted) onAbort();
			else signal?.addEventListener("abort", onAbort, { once: true });
		});
		// A decision committed between reading the request and registering the waiter.
		const latest = (await this.state()).requests[request.id];
		if (latest !== undefined && latest.status !== "pending") this.#settled(latest);
		return settled;
	}
}

/**
 * Fires when the call is stopped and when the Harness closes. Pi Durable 1.1.0's tool runtime carries the second as
 * `signal`, which its types don't declare; without it, only the first is used.
 */
export function signalOf(api: ToolExecutionApi | HookApi, context: Context): AbortSignal {
	const closed = "signal" in api && api.signal instanceof AbortSignal ? api.signal : undefined;
	return AbortSignal.any([context.abortSignal, closed].filter((s) => s !== undefined));
}

/**
 * The tools whose results are in the conversation's context and are text from outside (`isOutside`), and the job's gate
 * when a message there holds what a gate found. Text the model has read stays able to steer it for as long as it's in the
 * context, whoever spoke since; compaction is what takes it out. The hook's api is the tool task's runtime, which can
 * read that context. The context already holds a placeholder result for the call being decided, `callId`, which is skipped.
 * For the inside rule `rule`, the reads it let through, confined to its folder, are the owner's own files and are skipped too.
 */
export async function outsideTextIn(api: HookApi, context: Context, isOutside: (tool: string) => boolean, callId?: string, rule?: string): Promise<string[]> {
	const messages = await contextOf(api, context);
	// Without the context there's no telling what was read, so it counts as outside text.
	if (messages === undefined) return ["a conversation it couldn't check"];
	const found = new Set<string>();
	for (const message of messages) {
		// A job run a gate woke starts with what the gate found, and a conversation another agent started with its message.
		if (message.role === "user" && JSON.stringify(message.content).includes(GATE_FINDINGS)) found.add("the job's gate");
		if (message.role === "user" && JSON.stringify(message.content).includes(AGENT_MESSAGE)) found.add("a message from another agent");
		// Anyone in the room can talk to a speaker, so what it heard is outside text too (voice.ts).
		if (message.role === "user" && JSON.stringify(message.content).includes(VOICE_MESSAGE)) found.add("speech at a speaker");
		if (message.role !== "toolResult" || message.toolCallId === callId || !isOutside(message.toolName)) continue;
		if (rule === undefined || confinedBy(message) !== rule) found.add(message.toolName);
	}
	return [...found];
}

/** The URLs web_search returned in the conversation's context, from its results' details, or none when the context can't be read. */
export async function searchedIn(api: HookApi, context: Context): Promise<string[]> {
	const messages = await contextOf(api, context);
	return (messages ?? []).flatMap((m) => (m.role === "toolResult" && m.toolName === "web_search" ? searchedUrls(m.details) : []));
}

/** The conversation's model context, or undefined when the hook's api can't read it. */
async function contextOf(api: HookApi, context: Context): Promise<readonly Message[] | undefined> {
	if (!("context" in api) || !(api.context instanceof Function)) return undefined;
	// SAFETY: in Pi Durable 1.1.0 the hook's api is the tool task's runtime, whose context(id) gives the conversation's
	// model context; HookApi's type doesn't declare it, so it's checked for above.
	const read = api.context as (id: ConversationId, context: Context) => Promise<{ messages: readonly Message[] }>;
	return (await read.call(api, api.conversationId, context)).messages;
}

/** The arguments of `args` a rule can match on: its top-level text, numbers and booleans, up to 200 characters. */
export function shortArgs(args: Json): Record<string, string> {
	if (!isObject(args)) return {};
	return Object.fromEntries(Object.entries(args).flatMap(([key, value]) => {
		const text = attempt(value, scalar);
		return text !== undefined && text.length <= 200 ? [[key, text]] : [];
	}));
}

/**
 * The hook. `service` is read lazily, because the Harness that the service needs is opened after the registry. `guards`
 * is read on every call, because self-written tools come and go. `firstRoot` gives a workspace's first root as its helper
 * names it, which inside rules compare paths against (rules.ts).
 */
export function approvalExtension(service: () => ApprovalService, owner: string, guards: () => readonly Guard[], firstRoot: (workspace: string) => Promise<string | undefined> = async () => undefined) {
	const askOwner = defineTool({
		name: "ask_owner",
		description:
			`Ask ${owner} a question and wait for the answer, for a decision only they can make. The run pauses until ` +
			`${owner} answers, for up to days, and continues where it stopped. Give \`choices\` (up to 5) when the answer is one ` +
			`of a few options; ${owner} can still answer in their own words. Ask one question at a time.`,
		parameters: Type.Object({
			question: Type.String(),
			choices: Type.Optional(Type.Array(Type.String(), { maxItems: 5 })),
		}),
		// The request id comes from the tool call's task, so a rerun after a restart waits on the same question.
		replay: "safe",
		execute: async (args, api, context) => {
			const approvals = service();
			const choices = (args.choices ?? []).map((c) => c.trim()).filter((c) => c !== "").map((c) => c.slice(0, 75));
			const ask: Parameters<ApprovalService["open"]>[3] = { summary: args.question.trim(), kind: "question" };
			if (choices.length > 0) ask.choices = choices;
			const request = await approvals.open(`question:${api.taskId}`, { conversationId: api.conversationId, taskId: api.taskId }, "ask_owner", ask);
			const done = await approvals.wait(request, signalOf(api, context));
			const text = done.status === "answered" ? `${owner} answered: ${done.answer}`
				: done.status === "expired" ? `${owner} didn't answer in time.`
				: "No answer: the run was stopped.";
			return { output: [{ type: "text", text }], isError: done.status !== "answered" };
		},
	});
	return defineExtension({
		name: "approvals",
		tools: [askOwner],
		hooks: [
			hook(ToolTask, {
				beforeTool: async (call, api, context: Context) => {
					const all = guards();
					const guard = all.find((g) => g.tool === call.name);
					// The owner's rules reach every tool, guarded or not (rules.ts).
					const rules = await rulesIn(api, context);
					if (guard === undefined && !rules.some((r) => r.effect === "ask")) return undefined;
					const approvals = service();
					const { agent, roster } = await agentAt(api, api.conversationId, context);
					const args = attempt(call.arguments, json) ?? {};
					// A workspace's root is asked for only when an inside rule could decide the call.
					const workspace = INSIDE_TOOLS.includes(call.name) && isObject(args) ? attempt(args.workspace, string) : undefined;
					const root = workspace !== undefined && rules.some((r) => folderOf(r) !== undefined) ? await firstRoot(workspace) : undefined;
					const ruled = rulesFor(rules, agent.id, call.name, args, Date.now(), root);
					if (guard === undefined && ruled.ask === undefined) return undefined;
					const where: Where = { conversationId: api.conversationId, agent, roster };
					const impossible = guard === undefined ? undefined : await refusalOf(guard, call, api, context, where);
					if (impossible !== undefined) return { block: impossible };
					const { fetchHosts, grants = [] } = await approvals.state();
					const outside = (rule?: string) => outsideTextIn(api, context, (tool) => all.some((g) => g.tool === tool && g.outside), call.id, rule);
					let ask = guard === undefined ? undefined : await askFor(guard, call, {
						fetchHosts: hostsOf(agent, fetchHosts),
						grants,
						conversationId: api.conversationId,
						callId: call.id,
						agent,
						outside,
						searched: () => searchedIn(api, context),
						snapshot: (doc) => api.snapshot(doc, context),
					});
					if (ruled.ask !== undefined) {
						// An ask rule asks whatever else would let the call through, showing all of it when no guard says what it does.
						const rule = ruled.ask;
						const full = JSON.stringify(args, null, 2);
						const base = ask ?? whole(`use ${call.name} with ${clip(JSON.stringify(args), 300)}`, clip(JSON.stringify(args), 300), full);
						ask = { ...base, summary: `${base.summary} (rule ${rule.id}${rule.note === undefined ? "" : `, ${rule.note},`} asks)` };
					} else if (ask !== undefined && ruled.allow.length > 0) {
						// An allow rule lets through what the guard would ask about, while no outside text is read unless it holds even after.
						let rule: Rule | undefined;
						for (const r of ruled.allow) {
							if (r.afterOutside === true || (await outside(r.id)).length === 0) {
								rule = r;
								break;
							}
						}
						if (rule !== undefined) {
							// The tool sends an inside rule's folder to the workspace's helper, which checks the real path against it.
							const folder = folderOf(rule);
							if (folder !== undefined) await api.memo<Within>(WITHIN, { rule: rule.id, folder }, context);
							await approvals.ruled({ conversationId: api.conversationId, taskId: api.taskId }, call.name, ask.summary, rule);
							return undefined;
						}
					}
					if (ask === undefined) return undefined;
					// The same id for every run of this call's phase, so a restart doesn't ask twice.
					const id = await api.memo<string>("gaidin.approval", randomUUID(), context);
					const request = await approvals.open(id, { conversationId: api.conversationId, taskId: api.taskId }, call.name, { ...ask, ruleArgs: shortArgs(args) });
					const done = await approvals.wait(request, signalOf(api, context));
					if (done.status === "approved") {
						// The roster as it is now: an agent's grants can change while it waits.
						const since = guard === undefined ? undefined : await refusalOf(guard, call, api, context, { conversationId: api.conversationId, ...(await agentAt(api, api.conversationId, context)) });
						return since === undefined ? undefined : { block: `${owner} allowed it, but it can't happen now: ${since}` };
					}
					const why = done.status === "denied" ? `${owner} said no`
						: done.status === "expired" ? `${owner} didn't answer in time`
						: done.status === "superseded" ? `${owner} sent a new message instead of answering`
						: "the run was stopped";
					return { block: `Needs ${owner}'s approval to ${ask.summary}, and ${why}.` };
				},
			}),
		],
	});
}

