// The owner's messages in Slack. Each top-level message in the channel starts a thread (threads.ts), with the
// root conversation's settings but none of its history, and is answered in its Slack thread; later replies there
// continue it. A thread on something gaidin posted on its own, such as a job's report, or on an answer from
// before threads were separate, forks that conversation at that answer. index.ts hands this only the owner's
// messages in that channel.
//
// A message the owner sends from the app to a conversation with a Slack thread is posted in that thread too, marked
// as from the app, and then its answer, so the thread reads whole in Slack.
//
// Files sent with a message are downloaded when it goes to the model, and go with it as files.ts has them: images to
// the model with the text, other files, such as PDFs, to the sandbox's uploads/ directory, with the message saying where.
import { type Conversation, defineDoc, type EntryId, type Harness, type Submission, type UserInput } from "@earendil-works/pi-durable";
import type { ApprovalService } from "../approvals.ts";
import { MAX_IMAGE, withFiles as attach } from "../files.ts";
import { assistantText, context } from "../host.ts";
import type { Threads } from "../threads.ts";
import { stamp } from "../time.ts";
import { conversationId as toConversationId, entryId, submissionId } from "../ids.ts";
import type { SlackDownload, SlackFile, SlackMessage, SlackPost } from "./api.ts";

type Pending = { conversationId: number; content: string; threadTs?: string; files?: SlackFile[] };
/** A message from the app, for the Slack thread of its conversation: posted (once `posted`), then its answer. */
type Mirrored = { conversationId: number; threadTs: string; text: string; posted?: boolean };

/** Slack bookkeeping, keyed by message ts. Durable, so a restart still posts answers it owes. */
export const SlackState = defineDoc<{
	/** Messages gaidin posted on its own, and top-level messages from before threads were separate and their answers → the answer entry a thread on them forks at. */
	answers: Record<string, number>;
	/** For answers outside the root conversation, such as a scheduled job's report: the conversation they're in. */
	answerConversations?: Record<string, number>;
	/** Thread parent ts → the conversation for that thread. */
	threads: Record<string, number>;
	/** Accepted messages whose answer isn't posted yet. */
	pending: Record<string, Pending>;
	/** Messages taken as the answer to a question, so a redelivery isn't taken again. */
	consumed?: Record<string, number>;
	/** Messages from the app whose post in Slack, or whose answer there, isn't done, by their submission's id. */
	mirrored?: Record<string, Mirrored>;
}>({
	kind: "gaidin.slack",
	version: 1,
	scope: "session",
	initial: () => ({ answers: {}, threads: {}, pending: {} }),
});

/**
 * Records messages gaidin posted on its own, such as a job's report, so a thread on them forks
 * `conversationId` at `answer`.
 */
export async function recordPosted(root: Conversation, posted: readonly string[], answer: EntryId, conversationId: number): Promise<void> {
	await root.commit(async (tx) => {
		const state = await tx.doc(SlackState);
		state.answerConversations ??= {};
		for (const ts of posted) {
			state.answers[ts] = answer;
			if (conversationId !== root.id) state.answerConversations[ts] = conversationId;
		}
	}, context);
}

const POST_ATTEMPTS = 5;

export function createSlackConversation(options: {
	harness: Harness;
	root: Conversation;
	threads: Threads;
	post: SlackPost;
	channel: string;
	retryDelayMs?: number;
	/** Says why a run went unanswered, when there's more to say than its reason, such as the spend limit. */
	explain?: (reason: string | undefined) => string | undefined;
	/** Pending questions and approvals: a message can answer a question, and a new message skips an approval. */
	approvals?: ApprovalService;
	/** How files in messages are fetched, and the sandbox directory other files are saved in. Without them, files are left out. */
	files?: { download: SlackDownload; sandbox: string };
}) {
	const { harness, root, threads, post, channel, retryDelayMs = 1000 } = options;
	const delivering = new Set<string>();
	const relaying = new Set<string>();
	// Accepting is serialized, so two quick replies in a new thread make one fork.
	let accepting: Promise<unknown> = Promise.resolve();

	const read = async () => (await harness.snapshot(SlackState, context)) ?? { answers: {}, threads: {}, pending: {} };

	/**
	 * Durably records the message, or does nothing if it isn't for gaidin. Resolves once it's safe to ack the
	 * event; the answer is posted in the background.
	 */
	function receive(event: SlackMessage): Promise<void> {
		if (event.type !== "message" || (event.subtype !== undefined && event.subtype !== "file_share") || event.bot_id !== undefined) return Promise.resolve();
		const files = options.files === undefined ? [] : (event.files ?? []).filter((f) => f.url_private !== undefined);
		if (!event.text && files.length === 0) return Promise.resolve();
		const result = accepting.then(() => accept(event.ts, event.text ?? "", event.thread_ts === event.ts ? undefined : event.thread_ts, files));
		accepting = result.catch(() => {});
		return result.then((ok) => {
			if (ok) void deliver(event.ts);
		});
	}

	async function accept(ts: string, text: string, threadTs: string | undefined, files: SlackFile[]): Promise<boolean> {
		const state = await read();
		// A redelivered event: already answered, or already on its way.
		if (ts in state.answers || state.consumed?.[ts] !== undefined) return false;
		if (ts in state.pending) return true;
		// A top-level message whose thread exists and owes nothing has been answered.
		if (threadTs === undefined && ts in state.threads) return false;
		const approvals = options.approvals;
		const consume = () => root.commit(async (tx) => {
			const doc = await tx.doc(SlackState);
			doc.consumed ??= {};
			doc.consumed[ts] = Date.now();
			// A week is long past any redelivery.
			for (const [key, at] of Object.entries(doc.consumed)) if (at < Date.now() - 7 * 86_400_000) delete doc.consumed[key];
		}, context);
		// A reply in the thread of a question gaidin asked answers it, whichever conversation asked.
		if (threadTs !== undefined && approvals !== undefined) {
			const question = await approvals.questionAt(threadTs);
			if (question !== undefined && (await approvals.answer(question.id, text, "slack")) !== undefined) {
				await consume();
				return false;
			}
		}
		// The time is fixed here, so a resubmission after a restart sends the same text.
		const content = stamp(text);
		if (threadTs === undefined) {
			// Nothing can be waiting in a new conversation, so the message is pending from the commit that creates it.
			await threads.start({
				origin: "slack",
				init: async (tx, id) => {
					const pending: Pending = { conversationId: id, content, threadTs: ts };
					if (files.length > 0) pending.files = files;
					const doc = await tx.doc(SlackState);
					doc.threads[ts] = id;
					doc.pending[ts] = pending;
				},
			});
			return true;
		}
		let conversationId: number;
		const existing = state.threads[threadTs];
		if (existing !== undefined) {
			conversationId = existing;
		} else {
			const at = state.answers[threadTs];
			if (at === undefined) {
				await postWithRetry(threadTs, "I can only pick up threads on messages I've answered in this channel.");
				return false;
			}
			const from = state.answerConversations?.[threadTs];
			const parent = from === undefined ? root : await harness.conversation(toConversationId(from), context);
			if (parent === undefined) throw new Error(`conversation ${from} is gone`);
			const fork = await threads.fork(parent, entryId(at), {
				origin: "slack",
				init: async (tx, id) => {
					(await tx.doc(SlackState)).threads[threadTs] = id;
				},
			});
			conversationId = fork.id;
		}
		// A question waiting in this conversation takes the message as its answer; a waiting approval is skipped.
		if (approvals !== undefined && (await approvals.intercept(conversationId, text, "slack")) === "answered") {
			await consume();
			return false;
		}
		const pending: Pending = { conversationId, content, threadTs };
		if (files.length > 0) pending.files = files;
		await root.commit(async (tx) => {
			(await tx.doc(SlackState)).pending[ts] = pending;
		}, context);
		return true;
	}

	async function deliver(ts: string): Promise<void> {
		if (delivering.has(ts)) return;
		delivering.add(ts);
		try {
			const pending = (await read()).pending[ts];
			if (pending === undefined) return;
			const conversation = pending.conversationId === root.id
				? root
				: await harness.conversation(toConversationId(pending.conversationId), context);
			if (conversation === undefined) throw new Error(`conversation ${pending.conversationId} is gone`);
			// The request id makes this idempotent: after a restart it finds the run already admitted.
			const content = pending.files === undefined ? pending.content : await withFiles(pending.content, pending.files, ts);
			const submission = await conversation.submit({ type: "input", content, requestId: `slack:${ts}` }, context);
			const { answer, text } = await answerTo(conversation, submission);
			// At least once: a crash between posting and the commit below posts it again.
			const posted = await postWithRetry(pending.threadTs, text);
			await root.commit(async (tx) => {
				const state = await tx.doc(SlackState);
				delete state.pending[ts];
				// Only a message accepted before threads were separate is answered in the channel.
				if (answer !== undefined && pending.threadTs === undefined) {
					for (const key of [ts, ...posted]) state.answers[key] = answer;
				}
			}, context);
		} catch (error) {
			// The message stays pending and is retried at the next start.
			console.error(`[slack] couldn't answer ${ts}:`, error instanceof Error ? error.message : error);
		} finally {
			delivering.delete(ts);
		}
	}

	/** What a message's run answered, as Slack shows it: the answer's text, or why there's none. */
	async function answerTo(conversation: Conversation, submission: Submission): Promise<{ answer?: EntryId; text: string }> {
		const settled = await submission.wait(context);
		if (settled.status === "done" && settled.type === "input") {
			const text = assistantText(await conversation.commit((tx) => tx.entry(settled.answer), context)) ?? "(no text in the answer)";
			return { answer: settled.answer, text };
		}
		return { text: options.explain?.(settled.reason) ?? `! ${settled.status}${settled.reason ? `: ${settled.reason}` : ""}` };
	}

	/**
	 * Posts a message the owner sent from the app in its conversation's Slack thread, if it has one, then its answer.
	 * It's recorded first, so a restart still posts both. Resolves once it's recorded, to whether there was a thread.
	 */
	async function mirror(sent: { conversationId: number; submission: number; text: string; files?: readonly string[] }): Promise<boolean> {
		const state = await read();
		const threadTs = Object.keys(state.threads).find((ts) => state.threads[ts] === sent.conversationId);
		if (threadTs === undefined) return false;
		const files = sent.files === undefined || sent.files.length === 0 ? "" : `\n_with ${sent.files.join(", ")}_`;
		const text = `*From the app:* ${sent.text}${files}`;
		await root.commit(async (tx) => {
			const doc = await tx.doc(SlackState);
			doc.mirrored ??= {};
			doc.mirrored[String(sent.submission)] ??= { conversationId: sent.conversationId, threadTs, text };
		}, context);
		void relay(String(sent.submission));
		return true;
	}

	async function relay(key: string): Promise<void> {
		if (relaying.has(key)) return;
		relaying.add(key);
		try {
			const mirrored = (await read()).mirrored?.[key];
			if (mirrored === undefined) return;
			// At least once, as for answers: a crash between posting and recording it posts it again.
			if (mirrored.posted !== true) {
				await postWithRetry(mirrored.threadTs, mirrored.text);
				await root.commit(async (tx) => {
					const entry = (await tx.doc(SlackState)).mirrored?.[key];
					if (entry !== undefined) entry.posted = true;
				}, context);
			}
			const conversation = await harness.conversation(toConversationId(mirrored.conversationId), context);
			const submission = await harness.submission(submissionId(Number(key)), context);
			const { text } = conversation === undefined || submission === undefined ? { text: "! The message from the app is gone, so there's no answer to post." } : await answerTo(conversation, submission);
			await postWithRetry(mirrored.threadTs, text);
			await root.commit(async (tx) => {
				delete (await tx.doc(SlackState)).mirrored?.[key];
			}, context);
		} catch (error) {
			// It stays recorded and is retried at the next start.
			console.error(`[slack] couldn't post the app's message ${key}:`, error instanceof Error ? error.message : error);
		} finally {
			relaying.delete(key);
		}
	}

	/** The message with its files. An image over the model's limit goes as Slack's 1024-pixel thumbnail. */
	async function withFiles(text: string, files: SlackFile[], ts: string): Promise<UserInput> {
		const { download, sandbox } = options.files!;
		return attach(
			text,
			files.map((file) => {
				const image = file.mimetype?.startsWith("image/") === true;
				const thumbnail = image && (file.size ?? 0) > MAX_IMAGE;
				// The same prefix each time, so delivering again after a restart overwrites the file.
				return { name: file.name ?? "file", type: file.mimetype, size: image ? undefined : file.size, prefix: ts, load: () => download(thumbnail ? (file.thumb_1024 ?? file.url_private!) : file.url_private!) };
			}),
			sandbox,
			"Slack",
		);
	}

	async function postWithRetry(threadTs: string | undefined, text: string): Promise<string[]> {
		for (let attempt = 1; ; attempt += 1) {
			try {
				return await post(channel, text, threadTs);
			} catch (error) {
				if (attempt >= POST_ATTEMPTS) throw error;
				await new Promise((r) => setTimeout(r, retryDelayMs * 2 ** (attempt - 1)));
			}
		}
	}

	/** Answers messages accepted before the last stop, and posts what's owed for the app's. */
	async function recover(): Promise<void> {
		const state = await read();
		await Promise.all([...Object.keys(state.pending).map((ts) => deliver(ts)), ...Object.keys(state.mirrored ?? {}).map((key) => relay(key))]);
	}

	return { receive, recover, mirror };
}

