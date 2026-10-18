// Threads: conversations of their own that the owner starts from Slack or the app. A new thread has its agent's
// home settings (model, thinking, tools, standing instructions) as they are then, and none of the home's history.
//
// Some conversations can't take the owner's message themselves: a job run, which its job owns, and a conversation
// another agent started, whose sender may still be waiting on it. Continuing one forks it at its last answer into a
// thread, as a Slack reply to a job's report does.
import { BACKGROUND_CONTEXT as background } from "@earendil-works/chord/context";
import { AssistantEntry, type Conversation, type ConversationId, defineDoc, type EntryId, type Harness, type Tx } from "@earendil-works/pi-durable";
import { AgentChain, agentIdOf, AgentOf, copyHomeSettings, type RosterService } from "./agents.ts";
import { conversationId as toConversationId } from "./ids.ts";

/** Where a thread began: Slack, the app, or a speaker in the house (voice.ts). */
export type Origin = "slack" | "app" | "voice";

/** What a speaker heard starts with this. Anyone in the room can speak, so the approvals hook treats it as outside text. */
export const VOICE_MESSAGE = "[spoken]";

/** How the approvals hook names what a speaker heard among the outside text in a conversation. */
export const SPEECH = "speech at a speaker";

/** What a speaker heard, as its agent reads it: the marker, then the speaker's name, then the words. */
export const spoken = (speaker: string, text: string) => `${VOICE_MESSAGE} (${speaker} speaker) ${text}`;

/** The words of a message `spoken` made, without the marker and the speaker; any other message as it is. */
export const unspoken = (text: string) => text.replace(/^\[spoken\] \([a-z][a-z0-9-]* speaker\) /, "");

/** Where a thread began. A thread without one began in Slack, the only place threads began before the app. */
export const ThreadOrigin = defineDoc<{ origin: Origin }>({
	kind: "gaidin.thread-origin",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ origin: "slack" }),
});

/** Threads the app started, by the request that started them, so a request sent again finds its thread. */
const Started = defineDoc<{ byRequest: Record<string, { conversationId: number; at: number }> }>({
	kind: "gaidin.threads-started",
	version: 1,
	scope: "session",
	initial: () => ({ byRequest: {} }),
});

/** Runs in the commit that makes a thread, as for Slack's bookkeeping. */
type Init = (tx: Tx, id: ConversationId) => Promise<void>;

export async function originOf(harness: Harness, id: number): Promise<Origin> {
	return (await harness.snapshot(ThreadOrigin, toConversationId(id), background))?.origin ?? "slack";
}

export function createThreads(harness: Harness, roster: RosterService) {
	/** Records the thread `key` started, and forgets ones over a week old, long past any request sent again. */
	async function remember(tx: Tx, key: string | undefined, id: ConversationId) {
		if (key === undefined) return;
		const doc = await tx.doc(Started);
		for (const [k, v] of Object.entries(doc.byRequest)) if (v.at < Date.now() - 7 * 86_400_000) delete doc.byRequest[k];
		doc.byRequest[key] = { conversationId: id, at: Date.now() };
	}

	/** The thread `key` started before, if it did. */
	async function startedBy(key: string | undefined): Promise<Conversation | undefined> {
		if (key === undefined) return undefined;
		const known = (await harness.snapshot(Started, background))?.byRequest[key];
		return known === undefined ? undefined : harness.conversation(toConversationId(known.conversationId), background);
	}

	/**
	 * A new thread with `agent`, the default agent unless given. `key` names the request that starts it, so the same
	 * request sent again gets the same thread. Throws when there's no such agent, or it's archived.
	 */
	async function start(options: { agent?: string; origin: Origin; key?: string; init?: Init }): Promise<Conversation> {
		const again = await startedBy(options.key);
		if (again !== undefined) return again;
		const home = await roster.home(options.agent);
		const agent = await agentIdOf(harness, home.id, background);
		return harness.createConversation({
			ownership: { kind: "ownerless" },
			init: async (tx, id) => {
				await copyHomeSettings(tx, home.id, id);
				(await tx.doc(AgentOf, id)).agent = agent;
				(await tx.doc(ThreadOrigin, id)).origin = options.origin;
				await remember(tx, options.key, id);
				await options.init?.(tx, id);
			},
		}, background);
	}

	/** A thread forked from `parent` at `at`, with the parent's agent and settings at that point. */
	async function fork(parent: Conversation, at: EntryId, options: { origin: Origin; key?: string; init?: Init }): Promise<Conversation> {
		const again = await startedBy(options.key);
		if (again !== undefined) return again;
		return parent.fork(at, {
			ownership: { kind: "ownerless" },
			init: async (tx, id) => {
				(await tx.doc(ThreadOrigin, id)).origin = options.origin;
				await remember(tx, options.key, id);
				await options.init?.(tx, id);
			},
		}, background);
	}

	/**
	 * The conversation a message from the owner to `id` goes to: `id` itself, or for a job run or a conversation another
	 * agent started, a thread forked at its last answer. Throws when there's no such conversation, it's one the owner
	 * can't write to, its agent is archived, or it has no answer yet to fork at.
	 */
	async function target(id: number, options: { origin: Origin; key?: string }): Promise<Conversation> {
		const conversation = await harness.conversation(toConversationId(id), background);
		if (conversation === undefined) throw new Error(`There's no conversation ${id}.`);
		const agent = await agentIdOf(harness, conversation.id, background);
		const archived = (await roster.list()).find((a) => a.id === agent && a.archived !== undefined);
		if (archived !== undefined) throw new Error(`${archived.name} is archived.`);
		const found = await harness.commit(async (tx) => {
			const record = await tx.conversation(conversation.id);
			const task = record?.owner === undefined ? undefined : await tx.task(record.owner.taskId);
			return { owned: record?.owner !== undefined, job: task?.kind === "gaidin.job" };
		}, background);
		const started = (await harness.snapshot(AgentChain, conversation.id, background))?.from !== undefined;
		if (found.owned && !found.job) throw new Error(`Conversation ${id} is one of gaidin's own and can't take messages.`);
		if (!found.owned && !started) return conversation;
		const at = await lastAnswer(conversation.id);
		if (at === undefined) throw new Error(`Conversation ${id} has no answer yet to continue from.`);
		return fork(conversation, at, options);
	}

	/** The newest finished answer in a conversation's history, one that calls no tools. */
	async function lastAnswer(id: ConversationId): Promise<EntryId | undefined> {
		return harness.commit(async (tx) => {
			let cursor: Parameters<Tx["scanEntries"]>[2];
			do {
				const page = await tx.scanEntries({ conversationId: id, order: "descending" }, 100, cursor);
				for (const entry of page.items) {
					if (!AssistantEntry.is(entry)) continue;
					const message = entry.model?.[0];
					if (message?.role === "assistant" && !message.content.some((c) => c.type === "toolCall")) return entry.id;
				}
				cursor = page.next;
			} while (cursor !== undefined);
			return undefined;
		}, background);
	}

	return { start, fork, target };
}

export type Threads = ReturnType<typeof createThreads>;
