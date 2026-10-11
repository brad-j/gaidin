// Approval hook: some tool calls wait for the owner to allow them, from Slack or the web view.
//
// A beforeTool hook asks the policy whether a call needs approval. If it does, the hook takes a request
// id from a memo on the tool task, so after a restart the rerun of the same call finds the same
// request, and waits for the decision. Requests and decisions live in a session document; hooks can't
// write documents, so the host's ApprovalService does the writing and tells the surfaces.
//
// Now: fetch_url to a host the owner hasn't allowed for good. Tools that change things outside the
// sandbox will ask every time.
//
// Before asking, the hook checks whether the call can succeed at all (`Refusal`), so the owner is never asked
// to allow something that would fail. An answer can come days later, so after an approval it checks again:
// an approval allows a call, but never one that has become impossible since.
import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as background } from "@earendil-works/chord/context";
import { type Message, type ToolCall, Type } from "@earendil-works/pi-ai";
import { type ConversationId, defineDoc, defineEntry, defineExtension, defineTool, type DocumentReader, type Harness, type HookApi, hook, type ToolExecutionApi, ToolTask, type Tx } from "@earendil-works/pi-durable";
import { describeSchedule, GATE_FINDINGS, parseSchedule, scheduleArgs } from "./jobs.ts";
import { array, number, object, optional, parse, ParseError, string } from "./parse.ts";
import { tidy } from "./memory.ts";
import { conversationId, taskId } from "./ids.ts";

export type Decision = "once" | "always" | "deny";
/** "superseded": the owner sent a new message in the conversation instead of answering. */
export type ApprovalStatus = "pending" | "approved" | "denied" | "answered" | "expired" | "cancelled" | "superseded";

export type ApprovalRequest = {
	id: string;
	conversationId: number;
	/** The tool call's task. A request whose task has ended isn't waited on any more. */
	taskId: number;
	tool: string;
	/** One line for the owner: what the call does, or for a question, the question. */
	summary: string;
	/** More than a line can hold, such as the diff of a self-written extension. */
	detail?: string;
	/** A question from ask_owner rather than a request to allow a call. */
	kind?: "question";
	/** Answers offered as buttons. */
	choices?: string[];
	/** The owner's answer to a question. */
	answer?: string;
	/** The wider grant the second button gives, when one is offered. `label` is the button, `done` the outcome. */
	always?: { kind: "fetch-host" | "workspace-hour"; value: string; label: string; done: string };
	createdAt: number;
	expiresAt: number;
	status: ApprovalStatus;
	decidedAt?: number;
	/** Where it was decided: "slack" or "web". */
	by?: string;
	decision?: Decision;
	/** The Slack message that asks, once it's posted. */
	slackTs?: string;
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

/** What a call needs approval for, or nothing. `detail` holds what the summary can't, so the owner sees all of what they allow. */
type Ask = Pick<ApprovalRequest, "summary" | "always" | "detail"> | undefined;
/**
 * What a call needs approval for, or nothing. `untrusted` lists the tools whose outside text the run has
 * read since the owner's last message; it reads the transcript, so call it only when it matters.
 */
export type Policy = (call: ToolCall, state: ApprovalState, conversationId: number, untrusted: () => Promise<string[]>) => Ask | Promise<Ask>;

/** Why a call can't succeed, read from the current state, or nothing. Checked before asking and again after an approval. */
export type Refusal = (call: ToolCall, read: DocumentReader, context: Context) => string | undefined | Promise<string | undefined>;

/** Tools whose results are text from outside: web pages, other programs' logs, files and output on a workspace. */
export const UNTRUSTED_TOOLS = new Set(["fetch_url", "web_search", "container_logs", "workspace_read", "workspace_run"]);

const WORKSPACE_GRANT_MS = 60 * 60_000;
const clip = (text: string, max = 1500) => (text.length > max ? `${text.slice(0, max)}… (${text.length} characters)` : text);
/** The summary, with `full` as the detail when the summary had to cut it. */
const whole = (summary: string, shown: string, full: string): NonNullable<Ask> => (shown === full ? { summary } : { summary, detail: full });

/** A workspace_edit's changes, each old text and its replacement, as the owner is asked about them. */
function editsDetail(edits: readonly { oldText: string; newText: string }[]): string {
	const lines = (text: string, mark: string) => text.split("\n").map((line) => `${mark} ${line}`);
	return edits.map((e, i) => [`Change ${i + 1}:`, ...lines(e.oldText, "-"), ...lines(e.newText, "+")].join("\n")).join("\n\n");
}

// The calls' arguments as the policy reads them; one it can't read still asks (defaultPolicy).
const noteArgs = object({ text: optional(string), id: optional(number) });
const workspaceArgs = object({
	workspace: string,
	command: optional(string),
	cwd: optional(string),
	path: optional(string),
	content: optional(string),
	edits: optional(array(object({ oldText: string, newText: string }))),
});

export const defaultPolicy: Policy = async (call, state, conversationId, untrusted) => {
	try {
		return await askFor(call, state, conversationId, untrusted);
	} catch (error) {
		if (!(error instanceof ParseError)) throw error;
		// Better asked about than let through: the tool reports what's wrong with them.
		return { summary: `${call.name} with arguments that don't read right (${error.message})`, detail: JSON.stringify(call.arguments, null, 2) };
	}
};

async function askFor(call: ToolCall, state: ApprovalState, conversationId: number, untrusted: () => Promise<string[]>): Promise<Ask> {
	// Notes reach every future run, so writing one right after reading outside text asks first.
	if (call.name === "remember" || call.name === "update_memory") {
		const read = await untrusted();
		if (read.length === 0) return undefined;
		const a = parse(call.arguments, noteArgs, `${call.name}'s arguments`);
		// As it will be stored: a note that won't fit is refused before this (memory.ts), so it isn't cut.
		const text = tidy(a.text ?? "");
		return { summary: `${call.name === "remember" ? "remember" : `change note ${a.id} to`} "${text}", after reading outside text (${read.join(", ")})` };
	}
	// Every workspace tool asks, unless the owner allowed that workspace for an hour in this conversation.
	if (call.name.startsWith("workspace_")) {
		const a = parse(call.arguments, workspaceArgs, `${call.name}'s arguments`);
		const { workspace } = a;
		const now = Date.now();
		if ((state.grants ?? []).some((g) => g.workspace === workspace && g.conversationId === conversationId && g.until > now)) return undefined;
		const command = a.command ?? "";
		const ask = call.name === "workspace_run" ? whole(`run on ${workspace}${a.cwd ? ` in ${a.cwd}` : ""}: ${clip(command)}`, clip(command), command)
			: call.name === "workspace_write" ? { summary: `write ${a.path} on ${workspace} (${(a.content ?? "").length} characters)`, detail: a.content ?? "" }
			: call.name === "workspace_edit" ? { summary: `edit ${a.path} on ${workspace} (${a.edits?.length ?? 0} changes)`, detail: editsDetail(a.edits ?? []) }
			: { summary: `read ${a.path} on ${workspace}` };
		return { ...ask, always: { kind: "workspace-hour", value: workspace, label: `Allow ${workspace} for an hour here`, done: `Allowed ${workspace} for an hour` } };
	}
	// A job acts later, without the owner there, so every new one asks. A bad schedule is refused before this (jobs.ts).
	if (call.name === "schedule_job") {
		const a = parse(call.arguments, scheduleArgs, "schedule_job's arguments");
		const { gate } = a;
		let when: string;
		try {
			when = describeSchedule(parseSchedule(a, gate !== undefined));
		} catch {
			return undefined; // the tool reports the bad schedule itself
		}
		const gated = gate === undefined ? "" : `, gated by ${gate.name}${gate.args === undefined ? "" : ` ${JSON.stringify(gate.args)}`}`;
		const instruction = a.instruction ?? "";
		return whole(`schedule "${a.title}", ${when}${a.mode === "watch" ? " (a watch)" : ""}${gated}: ${clip(instruction)}`, clip(instruction), instruction);
	}
	if (call.name === "fetch_url") {
		const { url } = parse(call.arguments, object({ url: string }), "fetch_url's arguments");
		let host: string;
		try {
			host = new URL(url).hostname;
		} catch {
			return undefined; // the tool reports the bad URL itself
		}
		if (state.fetchHosts.includes(host)) return undefined;
		return { summary: `fetch ${url}`, always: { kind: "fetch-host", value: host, label: `Always allow ${host}`, done: `Always allowed ${host}` } };
	}
	return undefined;
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
	async open(id: string, at: { conversationId: number; taskId: number }, tool: string, ask: Pick<ApprovalRequest, "summary" | "detail" | "always" | "kind" | "choices">): Promise<ApprovalRequest> {
		const now = Date.now();
		const { request, created } = await this.#commit((doc) => {
			for (const [key, old] of Object.entries(doc.requests)) {
				if (old.status !== "pending" && (old.decidedAt ?? old.createdAt) < now - KEEP_DECIDED_MS) delete doc.requests[key];
			}
			const existing = doc.requests[id];
			if (existing !== undefined) return { request: plain(existing), created: false };
			const fresh: ApprovalRequest = { id, ...at, tool, ...ask, createdAt: now, expiresAt: now + this.#timeoutMs, status: "pending" };
			doc.requests[id] = fresh;
			return { request: plain(fresh), created: true };
		});
		if (created) this.#emit(request);
		return request;
	}

	/** The owner's answer. Returns the request, or nothing if it wasn't pending. */
	async decide(id: string, decision: Decision, by: string): Promise<ApprovalRequest | undefined> {
		const decided = await this.#commit(async (doc, tx) => {
			const request = doc.requests[id];
			if (request === undefined || request.status !== "pending" || request.kind === "question") return undefined;
			if (request.expiresAt <= Date.now()) {
				request.status = "expired";
				request.decidedAt = Date.now();
				return this.#record(tx, request);
			}
			request.status = decision === "deny" ? "denied" : "approved";
			request.decidedAt = Date.now();
			request.by = by;
			request.decision = decision;
			if (decision === "always" && request.always?.kind === "fetch-host" && !doc.fetchHosts.includes(request.always.value)) {
				doc.fetchHosts.push(request.always.value);
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

	/** The pending question asked in the Slack message `ts`, if any. */
	async questionAt(ts: string): Promise<ApprovalRequest | undefined> {
		return (await this.pending()).find((r) => r.kind === "question" && r.slackTs === ts);
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

	/** Remembers where a surface asked, so it can show the outcome there. */
	async note(id: string, fields: Pick<ApprovalRequest, "slackTs">): Promise<void> {
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
 * The untrusted tools whose results are in the conversation since its last user message, and the job's gate when that
 * message holds what a gate found. The hook's api is the tool task's runtime, which can read the conversation's context.
 */
export async function untrustedSince(api: HookApi, context: Context): Promise<string[]> {
	if (!("context" in api) || !(api.context instanceof Function)) return [];
	// SAFETY: in Pi Durable 1.1.0 the hook's api is the tool task's runtime, whose context(id) gives the conversation's
	// model context; HookApi's type doesn't declare it, so it's checked for above.
	const read = api.context as (id: ConversationId, context: Context) => Promise<{ messages: readonly Message[] }>;
	const { messages } = await read.call(api, api.conversationId, context);
	const found = new Set<string>();
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i]!;
		if (message.role === "user") {
			// A job run a gate woke starts with what the gate found.
			if (JSON.stringify(message.content).includes(GATE_FINDINGS)) found.add("the job's gate");
			break;
		}
		if (message.role === "toolResult" && UNTRUSTED_TOOLS.has(message.toolName)) found.add(message.toolName);
	}
	return [...found];
}

/** The hook. `service` is read lazily, because the Harness that the service needs is opened after the registry. */
export function approvalExtension(service: () => ApprovalService, owner: string, options: { policy?: Policy; refusals?: readonly Refusal[] } = {}) {
	const policy = options.policy ?? defaultPolicy;
	const refused = async (call: ToolCall, api: DocumentReader, context: Context) => {
		for (const refusal of options.refusals ?? []) {
			const why = await refusal(call, api, context);
			if (why !== undefined) return why;
		}
		return undefined;
	};
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
			return { content: [{ type: "text", text }], isError: done.status !== "answered" };
		},
	});
	return defineExtension({
		name: "approvals",
		tools: [askOwner],
		hooks: [
			hook(ToolTask, {
				beforeTool: async (call, api, context: Context) => {
					const approvals = service();
					const impossible = await refused(call, api, context);
					if (impossible !== undefined) return { block: impossible };
					const ask = await policy(call, await approvals.state(), api.conversationId, () => untrustedSince(api, context));
					if (ask === undefined) return undefined;
					// The same id for every run of this call's phase, so a restart doesn't ask twice.
					const id = await api.memo<string>("gaidin.approval", randomUUID(), context);
					const request = await approvals.open(id, { conversationId: api.conversationId, taskId: api.taskId }, call.name, ask);
					const done = await approvals.wait(request, signalOf(api, context));
					if (done.status === "approved") {
						const since = await refused(call, api, context);
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

