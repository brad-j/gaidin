// Approval hook: some tool calls wait for the owner to allow them, from Slack or the web view.
//
// A beforeTool hook asks the policy whether a call needs approval. If it does, the hook takes a request
// id from a memo on the tool task, so after a restart the rerun of the same call finds the same
// request, and waits for the decision. Requests and decisions live in a session document; hooks can't
// write documents, so the host's ApprovalService does the writing and tells the surfaces.
//
// Now: fetch_url to a host the owner hasn't allowed for good. Tools that change things outside the
// sandbox will ask every time.
import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as background } from "@earendil-works/chord/context";
import type { ToolCall } from "@earendil-works/pi-ai";
import { defineDoc, defineExtension, type Harness, hook, type TaskId, ToolTask } from "@earendil-works/pi-durable";

export type Decision = "once" | "always" | "deny";
export type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "cancelled";

export type ApprovalRequest = {
	id: string;
	conversationId: number;
	/** The tool call's task. A request whose task has ended isn't waited on any more. */
	taskId: number;
	tool: string;
	/** One line for the owner: what the call does. */
	summary: string;
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

type ApprovalState = { requests: Record<string, ApprovalRequest>; fetchHosts: string[]; grants?: Grant[] };

/** What a call needs approval for, or nothing. */
export type Policy = (call: ToolCall, state: ApprovalState, conversationId: number) => Pick<ApprovalRequest, "summary" | "always"> | undefined;

const WORKSPACE_GRANT_MS = 60 * 60_000;
const clip = (text: string, max = 1500) => (text.length > max ? `${text.slice(0, max)}… (${text.length} characters)` : text);

export const defaultPolicy: Policy = (call, state, conversationId) => {
	// Every workspace tool asks, unless the owner allowed that workspace for an hour in this conversation.
	if (call.name.startsWith("workspace_")) {
		const workspace = String(call.arguments.workspace);
		const now = Date.now();
		if ((state.grants ?? []).some((g) => g.workspace === workspace && g.conversationId === conversationId && g.until > now)) return undefined;
		const a = call.arguments;
		const summary = call.name === "workspace_run" ? `run on ${workspace}${a.cwd ? ` in ${String(a.cwd)}` : ""}: ${clip(String(a.command))}`
			: call.name === "workspace_write" ? `write ${String(a.path)} on ${workspace} (${String(a.content ?? "").length} characters)`
			: call.name === "workspace_edit" ? `edit ${String(a.path)} on ${workspace} (${Array.isArray(a.edits) ? a.edits.length : 0} changes)`
			: `read ${String(a.path)} on ${workspace}`;
		return { summary, always: { kind: "workspace-hour", value: workspace, label: `Allow ${workspace} for an hour here`, done: `Allowed ${workspace} for an hour` } };
	}
	if (call.name === "fetch_url") {
		let host: string;
		try {
			host = new URL(String(call.arguments.url)).hostname;
		} catch {
			return undefined; // the tool reports the bad URL itself
		}
		if (state.fetchHosts.includes(host)) return undefined;
		return { summary: `fetch ${String(call.arguments.url)}`, always: { kind: "fetch-host", value: host, label: `Always allow ${host}`, done: `Always allowed ${host}` } };
	}
	return undefined;
};

/** A copy that outlives the commit: a draft's nested objects stop working once it's committed. */
function plain(request: ApprovalRequest): ApprovalRequest {
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
		this.#timeoutMs = options.timeoutMs ?? 30 * 60_000;
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
		const task = await this.#harness.getTask(request.taskId as TaskId<unknown>, background);
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

	async #commit<T>(change: (doc: ApprovalState) => T): Promise<T> {
		const root = await this.#harness.root(background);
		return root.commit(async (tx) => change(await tx.doc(Approvals)), background);
	}

	#emit(request: ApprovalRequest) {
		for (const listener of this.#listeners) {
			Promise.resolve(listener(request)).catch((error) => console.error("[approvals]", error));
		}
	}

	/** Records a request under `id` unless it exists, and returns it as stored. */
	async open(id: string, at: { conversationId: number; taskId: number }, tool: string, ask: Pick<ApprovalRequest, "summary" | "always">): Promise<ApprovalRequest> {
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
		const decided = await this.#commit((doc) => {
			const request = doc.requests[id];
			if (request === undefined || request.status !== "pending") return undefined;
			if (request.expiresAt <= Date.now()) {
				request.status = "expired";
				request.decidedAt = Date.now();
				return plain(request);
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
			return plain(request);
		});
		if (decided !== undefined) this.#settled(decided);
		return decided;
	}

	/** Ends a pending request without an answer: the run was stopped, or the time ran out. */
	async close(id: string, status: "expired" | "cancelled"): Promise<void> {
		const closed = await this.#commit((doc): ApprovalRequest | undefined => {
			const request = doc.requests[id];
			if (request === undefined || request.status !== "pending") return undefined;
			request.status = status;
			request.decidedAt = Date.now();
			return plain(request);
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

/** The hook. `service` is read lazily, because the Harness that the service needs is opened after the registry. */
export function approvalExtension(service: () => ApprovalService, owner: string, policy: Policy = defaultPolicy) {
	return defineExtension({
		name: "approvals",
		hooks: [
			hook(ToolTask, {
				beforeTool: async (call, api, context: Context) => {
					const approvals = service();
					const ask = policy(call, await approvals.state(), api.conversationId as number);
					if (ask === undefined) return undefined;
					// The same id for every run of this call's phase, so a restart doesn't ask twice.
					const id = await api.memo<string>("gaidin.approval", randomUUID(), context);
					const request = await approvals.open(id, { conversationId: api.conversationId as number, taskId: api.taskId as number }, call.name, ask);
					// The hook's api is the tool task's runtime, whose signal also fires when the Harness closes.
					const signals = [context.abortSignal, (api as { signal?: AbortSignal }).signal].filter((s) => s !== undefined);
					const done = await approvals.wait(request, AbortSignal.any(signals));
					if (done.status === "approved") return undefined;
					const why = done.status === "denied" ? `${owner} said no` : done.status === "expired" ? `${owner} didn't answer in time` : "the run was stopped";
					return { block: `Needs ${owner}'s approval to ${ask.summary}, and ${why}.` };
				},
			}),
		],
	});
}

