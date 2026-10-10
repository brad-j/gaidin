// Slack surface. One channel is the root conversation, the same one the CLI talks to. A thread on any
// message in it is a fork of the root at that message's answer; later replies in the thread continue the
// fork. Socket Mode, so the host needs no inbound port.
import { type ConversationId, type Conversation, defineDoc, type EntryId, type Harness } from "@earendil-works/pi-durable";
import { assistantText, context } from "./host.ts";
import { stamp } from "./time.ts";

type Pending = { conversationId: number; content: string; threadTs?: string };

/** Slack bookkeeping, keyed by message ts. Durable, so a restart still posts answers it owes. */
export const SlackState = defineDoc<{
	/** Brad's top-level messages and gaidin's answers to them → the answer entry a thread on them forks at. */
	answers: Record<string, number>;
	/** Thread parent ts → the fork for that thread. */
	threads: Record<string, number>;
	/** Accepted messages whose answer isn't posted yet. */
	pending: Record<string, Pending>;
}>({
	kind: "gaidin.slack",
	version: 1,
	scope: "session",
	initial: () => ({ answers: {}, threads: {}, pending: {} }),
});

/** The fields of a Slack `message` event this uses. */
export type SlackMessage = {
	type: string;
	channel?: string;
	user?: string;
	text?: string;
	ts: string;
	thread_ts?: string;
	subtype?: string;
	bot_id?: string;
};

/** Posts markdown and returns the ts of each message it made. */
export type SlackPost = (channel: string, markdown: string, threadTs?: string) => Promise<string[]>;

const POST_ATTEMPTS = 5;

export function createSlackSurface(options: {
	harness: Harness;
	root: Conversation;
	post: SlackPost;
	channel: string;
	user: string;
	retryDelayMs?: number;
}) {
	const { harness, root, post, channel, user, retryDelayMs = 1000 } = options;
	const delivering = new Set<string>();
	// Accepting is serialized, so two quick replies in a new thread make one fork.
	let accepting: Promise<unknown> = Promise.resolve();

	const read = async () => (await harness.snapshot(SlackState, context)) ?? { answers: {}, threads: {}, pending: {} };

	/**
	 * Durably records the message, or does nothing if it isn't for gaidin. Resolves once it's safe to ack the
	 * event; the answer is posted in the background.
	 */
	function receive(event: SlackMessage): Promise<void> {
		if (event.type !== "message" || event.subtype !== undefined || event.bot_id !== undefined) return Promise.resolve();
		if (event.channel !== channel || event.user !== user || !event.text) return Promise.resolve();
		const result = accepting.then(() => accept(event.ts, event.text!, event.thread_ts === event.ts ? undefined : event.thread_ts));
		accepting = result.catch(() => {});
		return result.then((ok) => {
			if (ok) void deliver(event.ts);
		});
	}

	async function accept(ts: string, text: string, threadTs: string | undefined): Promise<boolean> {
		const state = await read();
		// A redelivered event: already answered, or already on its way.
		if (ts in state.answers) return false;
		if (ts in state.pending) return true;
		let conversationId: number = root.id;
		if (threadTs !== undefined) {
			const existing = state.threads[threadTs];
			const at = state.answers[threadTs];
			if (existing !== undefined) {
				conversationId = existing;
			} else if (at === undefined) {
				await postWithRetry(threadTs, "I can only pick up threads on messages I've answered in this channel.");
				return false;
			} else {
				const fork = await root.fork(at as EntryId, {
					ownership: { kind: "ownerless" },
					init: async (tx, id) => {
						(await tx.doc(SlackState)).threads[threadTs] = id;
					},
				}, context);
				conversationId = fork.id;
			}
		}
		// The time is fixed here, so a resubmission after a restart sends the same text.
		const pending: Pending = { conversationId, content: stamp(text), ...(threadTs === undefined ? {} : { threadTs }) };
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
				: await harness.conversation(pending.conversationId as ConversationId, context);
			if (conversation === undefined) throw new Error(`conversation ${pending.conversationId} is gone`);
			// The request id makes this idempotent: after a restart it finds the run already admitted.
			const submission = await conversation.submit({ type: "input", content: pending.content, requestId: `slack:${ts}` }, context);
			const settled = await submission.wait(context);
			let answer: EntryId | undefined;
			let text: string;
			if (settled.status === "done" && settled.type === "input") {
				answer = settled.answer;
				text = assistantText(await conversation.commit((tx) => tx.entry(settled.answer), context)) ?? "(no text in the answer)";
			} else {
				text = `! ${settled.status}${settled.reason ? `: ${settled.reason}` : ""}`;
			}
			// At least once: a crash between posting and the commit below posts it again.
			const posted = await postWithRetry(pending.threadTs, text);
			await root.commit(async (tx) => {
				const state = await tx.doc(SlackState);
				delete state.pending[ts];
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

	/** Answers messages accepted before the last stop. */
	async function recover(): Promise<void> {
		await Promise.all(Object.keys((await read()).pending).map((ts) => deliver(ts)));
	}

	return { receive, recover };
}

/** Calls a Slack Web API method with the bot token; throws unless Slack answers ok. */
export type SlackApi = (method: string, body: Record<string, unknown>) => Promise<{ ts?: string; [field: string]: unknown }>;

export function slackApi(botToken: string): SlackApi {
	return async (method, body) => {
		const response = await fetch(`https://slack.com/api/${method}`, {
			method: "POST",
			headers: { Authorization: `Bearer ${botToken}`, "Content-Type": "application/json; charset=utf-8" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(15_000),
		});
		const answer = (await response.json()) as { ok: boolean; error?: string; ts?: string };
		if (!answer.ok) throw new Error(`${method}: ${answer.error ?? response.status}`);
		return answer;
	};
}

/** chat.postMessage with Slack rendering the markdown. Longer answers go out in several messages. */
export function slackPoster(api: SlackApi): SlackPost {
	return async (channel, markdown, threadTs) => {
		const posted: string[] = [];
		for (const chunk of chunks(markdown, 12_000)) {
			const { ts } = await api("chat.postMessage", { channel, markdown_text: chunk, ...(threadTs === undefined ? {} : { thread_ts: threadTs }) });
			if (ts === undefined) throw new Error("chat.postMessage: no ts");
			posted.push(ts);
		}
		return posted;
	};
}

function chunks(text: string, size: number): string[] {
	const out: string[] = [];
	let rest = text;
	while (rest.length > size) {
		const cut = rest.lastIndexOf("\n", size);
		const at = cut > size / 2 ? cut : size;
		out.push(rest.slice(0, at));
		rest = rest.slice(at).replace(/^\n/, "");
	}
	out.push(rest);
	return out;
}

/** The fields of a Slack block_actions payload (a button press) this uses. */
export type SlackAction = {
	type: string;
	user?: { id: string };
	channel?: { id: string };
	actions?: { action_id: string; value?: string }[];
};

/**
 * Keeps a Socket Mode connection open and hands each message event to `event` and each button press to
 * `action`, acking once they resolve. A new connection opens before the old one closes: on Slack's
 * disconnect notices, and hourly in case a connection dies without either side noticing.
 */
export function socketMode(appToken: string, handlers: { event: (event: SlackMessage) => Promise<void>; action?: (action: SlackAction) => Promise<void> }) {
	let stopped = false;
	let failures = 0;
	const sockets = new Set<WebSocket>();

	async function open(): Promise<void> {
		if (stopped) return;
		let url: string;
		try {
			const response = await fetch("https://slack.com/api/apps.connections.open", {
				method: "POST",
				headers: { Authorization: `Bearer ${appToken}`, "Content-Type": "application/x-www-form-urlencoded" },
				signal: AbortSignal.timeout(15_000),
			});
			const body = (await response.json()) as { ok: boolean; url?: string; error?: string };
			if (!body.ok || body.url === undefined) throw new Error(`apps.connections.open: ${body.error ?? response.status}`);
			url = body.url;
		} catch (error) {
			retry(error);
			return;
		}
		const socket = new WebSocket(url);
		sockets.add(socket);
		let replaced = false;
		// Opens the next connection, then closes this one once Slack has had time to switch over.
		const replace = () => {
			if (replaced) return;
			replaced = true;
			void open();
			setTimeout(() => socket.close(), 10_000).unref();
		};
		const refresh = setTimeout(replace, 60 * 60_000);
		refresh.unref();
		socket.addEventListener("message", (message) => {
			const data = JSON.parse(String(message.data)) as {
				type: string;
				envelope_id?: string;
				reason?: string;
				payload?: { event?: SlackMessage } & SlackAction;
			};
			if (data.type === "hello") {
				failures = 0;
				return;
			}
			if (data.type === "disconnect") {
				replace();
				return;
			}
			if (data.envelope_id === undefined) return;
			const ack = () => {
				if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ envelope_id: data.envelope_id }));
			};
			if (data.type === "interactive" && data.payload?.type === "block_actions" && handlers.action !== undefined) {
				// Slack doesn't resend a button press, and wants its ack within 3 seconds either way.
				handlers.action(data.payload).catch((error) => console.error("[slack] action failed:", error)).finally(ack);
				return;
			}
			const event = data.type === "events_api" ? data.payload?.event : undefined;
			if (event === undefined) return ack();
			// Not acked on failure, so Slack sends it again.
			handlers.event(event).then(ack, (error) => console.error("[slack] event failed:", error));
		});
		socket.addEventListener("close", () => {
			clearTimeout(refresh);
			sockets.delete(socket);
			if (!replaced) retry(new Error("connection closed"));
		});
		socket.addEventListener("error", () => {});
	}

	function retry(error: unknown) {
		if (stopped) return;
		failures += 1;
		const delay = Math.min(1000 * 2 ** failures, 60_000);
		console.error(`[slack] ${error instanceof Error ? error.message : error}; reconnecting in ${delay / 1000}s`);
		setTimeout(() => void open(), delay).unref();
	}

	void open();
	return {
		stop() {
			stopped = true;
			for (const socket of sockets) socket.close();
		},
	};
}
