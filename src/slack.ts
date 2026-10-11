// Slack surface. One channel is the root conversation, the same one the CLI talks to. A thread on any
// message in it is a fork of the root at that message's answer; later replies in the thread continue the
// fork. Socket Mode, so the host needs no inbound port.
//
// Files sent with a message are downloaded when it goes to the model. Images go to the model with the text;
// other files, such as PDFs, are saved in the sandbox's uploads/ directory and the message says where.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import { type ConversationId, type Conversation, defineDoc, type EntryId, type Harness, type UserInput } from "@earendil-works/pi-durable";
import type { ApprovalService } from "./approvals.ts";
import { assistantText, context } from "./host.ts";
import { stamp } from "./time.ts";

/** The fields of a file in a Slack message this uses. */
export type SlackFile = { name?: string; mimetype?: string; size?: number; url_private?: string; thumb_1024?: string };

type Pending = { conversationId: number; content: string; threadTs?: string; files?: SlackFile[] };

/** Downloads a Slack file's private URL with the bot token. */
export type SlackDownload = (url: string) => Promise<Buffer>;

// The model takes images up to 5 MB; a bigger one goes as Slack's 1024-pixel thumbnail.
const MAX_IMAGE = 3_750_000;
const MAX_FILE = 20_000_000;

/** The image type from the bytes themselves, which a thumbnail's URL doesn't say, or nothing for another kind of file. */
function imageType(data: Buffer): string | undefined {
	if (data.subarray(0, 4).toString("hex") === "89504e47") return "image/png";
	if (data.subarray(0, 3).toString("hex") === "ffd8ff") return "image/jpeg";
	if (data.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
	if (data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
	return undefined;
}

/** Slack bookkeeping, keyed by message ts. Durable, so a restart still posts answers it owes. */
export const SlackState = defineDoc<{
	/** The owner's top-level messages and gaidin's answers to them → the answer entry a thread on them forks at. */
	answers: Record<string, number>;
	/** For answers outside the root conversation, such as a scheduled job's report: the conversation they're in. */
	answerConversations?: Record<string, number>;
	/** Thread parent ts → the fork for that thread. */
	threads: Record<string, number>;
	/** Accepted messages whose answer isn't posted yet. */
	pending: Record<string, Pending>;
	/** Messages taken as the answer to a question, so a redelivery isn't taken again. */
	consumed?: Record<string, number>;
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
	files?: SlackFile[];
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
	/** Says why a run went unanswered, when there's more to say than its reason, such as the spend limit. */
	explain?: (reason: string | undefined) => string | undefined;
	/** Pending questions and approvals: a message can answer a question, and a new message skips an approval. */
	approvals?: ApprovalService;
	/** How files in messages are fetched, and the sandbox directory other files are saved in. Without them, files are left out. */
	files?: { download: SlackDownload; sandbox: string };
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
		if (event.type !== "message" || (event.subtype !== undefined && event.subtype !== "file_share") || event.bot_id !== undefined) return Promise.resolve();
		const files = options.files === undefined ? [] : (event.files ?? []).filter((f) => f.url_private !== undefined);
		if (event.channel !== channel || event.user !== user || (!event.text && files.length === 0)) return Promise.resolve();
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
				const from = state.answerConversations?.[threadTs];
				const parent = from === undefined ? root : await harness.conversation(from as ConversationId, context);
				if (parent === undefined) throw new Error(`conversation ${from} is gone`);
				const fork = await parent.fork(at as EntryId, {
					ownership: { kind: "ownerless" },
					init: async (tx, id) => {
						(await tx.doc(SlackState)).threads[threadTs] = id;
					},
				}, context);
				conversationId = fork.id;
			}
		}
		// A question waiting in this conversation takes the message as its answer; a waiting approval is skipped.
		if (approvals !== undefined && (await approvals.intercept(conversationId, text, "slack")) === "answered") {
			await consume();
			return false;
		}
		// The time is fixed here, so a resubmission after a restart sends the same text.
		const pending: Pending = { conversationId, content: stamp(text), ...(threadTs === undefined ? {} : { threadTs }), ...(files.length === 0 ? {} : { files }) };
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
			const content = pending.files === undefined ? pending.content : await withFiles(pending.content, pending.files, ts);
			const submission = await conversation.submit({ type: "input", content, requestId: `slack:${ts}` }, context);
			const settled = await submission.wait(context);
			let answer: EntryId | undefined;
			let text: string;
			if (settled.status === "done" && settled.type === "input") {
				answer = settled.answer;
				text = assistantText(await conversation.commit((tx) => tx.entry(settled.answer), context)) ?? "(no text in the answer)";
			} else {
				text = options.explain?.(settled.reason) ?? `! ${settled.status}${settled.reason ? `: ${settled.reason}` : ""}`;
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

	/** The message with its images, and a note of where its other files are saved or why one couldn't be fetched. */
	async function withFiles(text: string, files: SlackFile[], ts: string): Promise<UserInput> {
		const { download, sandbox } = options.files!;
		const images: ImageContent[] = [];
		const notes: string[] = [];
		for (const file of files) {
			const name = file.name ?? "file";
			try {
				const image = file.mimetype?.startsWith("image/") === true;
				const url = image && (file.size ?? 0) > MAX_IMAGE ? (file.thumb_1024 ?? file.url_private!) : file.url_private!;
				if (!image && (file.size ?? 0) > MAX_FILE) throw new Error(`it's over ${MAX_FILE / 1_000_000} MB`);
				const data = await download(url);
				const mimeType = imageType(data);
				if (image && mimeType !== undefined && data.length <= MAX_IMAGE) {
					images.push({ type: "image", data: data.toString("base64"), mimeType });
					continue;
				}
				// The same name each time, so delivering again after a restart overwrites it.
				const path = `uploads/${ts}-${name.replace(/[^\w.-]+/g, "_")}`;
				mkdirSync(join(sandbox, "uploads"), { recursive: true });
				writeFileSync(join(sandbox, path), data);
				notes.push(`${name} is saved as ${path} (${file.mimetype ?? "unknown type"}, ${Math.ceil(data.length / 1000)} KB)`);
			} catch (error) {
				notes.push(`${name} couldn't be fetched: ${error instanceof Error ? error.message : error}`);
			}
		}
		const note = notes.length === 0 ? "" : `\n\n[Files from Slack: ${notes.join("; ")}. Read them with the file tools; for a PDF, run pdftotext FILE - in bash.]`;
		return images.length === 0 ? `${text}${note}` : [{ type: "text", text: `${text}${note}` }, ...images];
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
export function slackDownload(botToken: string): SlackDownload {
	return async (url) => {
		const response = await fetch(url, { headers: { Authorization: `Bearer ${botToken}` }, signal: AbortSignal.timeout(30_000) });
		if (!response.ok) throw new Error(`Slack answered ${response.status}`);
		// Without the files:read scope, Slack answers with its sign-in page.
		if (response.headers.get("content-type")?.startsWith("text/html")) throw new Error("Slack sent a web page; the app needs the files:read scope");
		return Buffer.from(await response.arrayBuffer());
	};
}

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
	/** The message the button is on. */
	message?: { ts: string; text?: string; blocks?: { type: string }[] };
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
