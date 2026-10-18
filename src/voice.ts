// Voice: the route a voice front end uses to talk to an agent in text. A bridge hears a speaker in the house, turns the
// speech into text and posts it here, and the answer comes back as an event stream it speaks as each part arrives.
// gaidin never handles audio.
//
// A bridge proves itself with a bearer token from the settings (`voice.tokens`), not the Tailscale login. A token
// reaches only the agents it lists, and nothing else on the web server: web.ts sends only VOICE_PATH here, before its
// login check, and every other route still wants the login. Each speaker has a rolling thread with its agent, which
// carries on while turns keep coming and starts afresh after QUIET_MS of silence, so a follow-up works and yesterday's
// talk doesn't pile up. Anyone in the room can talk to a speaker, a guest or a television included, so each turn is
// marked as spoken (`spoken` in threads.ts) and the approvals hook treats it as outside text. A run that stops to ask the owner
// ends the turn with a "waiting" event: the request reaches the owner's phone, never the speaker.
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { type Conversation, defineDoc, type EntryId, type EntryRecord, type Harness, watchEvents } from "@earendil-works/pi-durable";
import type { ApprovalService } from "./approvals.ts";
import { assistantText, context } from "./host.ts";
import { conversationId } from "./ids.ts";
import { object, optional, ParseError, parseJson, string } from "./parse.ts";
import { spoken, type Threads } from "./threads.ts";
import { stamp } from "./time.ts";

export const VOICE_PATH = "/api/voice/turn";

/** How long a speaker's thread carries on without a turn before the next one starts a new thread. */
export const QUIET_MS = 5 * 60_000;

/** How long a turn's key keeps finding its thread, so a turn sent again lands once. */
const KEY_MS = 86_400_000;

/** A bridge's token, and the agents it may talk to; the first is the one a turn naming none goes to. */
export type VoiceToken = { name: string; token: string; agents: string[] };

/** What the bridge hears back, one event-stream event each. */
export type VoiceEvent =
	/** Something to say: each of the run's messages as it ends, the answer last. */
	| { type: "say"; text: string }
	/** The run is waiting for the owner, who's been asked on their phone. */
	| { type: "waiting"; summary: string }
	/** The turn is over; `status` is the run's. */
	| { type: "done"; status: string; conversation: number };

/** Each speaker's thread, and each recent turn's, by its key. */
export const VoiceState = defineDoc<{
	speakers: Record<string, { agent: string; conversation: number; at: number }>;
	turns: Record<string, { conversation: number; at: number }>;
}>({
	kind: "gaidin.voice",
	version: 1,
	scope: "session",
	initial: () => ({ speakers: {}, turns: {} }),
});

/** `speaker` is the bridge's name for it, like kitchen; `key` names the turn, so a turn sent again lands once. */
const turnBody = object({ speaker: string, text: string, key: string, agent: optional(string) });
const SPEAKER = /^[a-z][a-z0-9-]{0,30}$/;

const digest = (token: string) => createHash("sha256").update(token).digest();

export function createVoice(options: {
	harness: Harness;
	threads: Threads;
	approvals: ApprovalService;
	tokens: readonly VoiceToken[];
	/** Why a run that didn't finish stopped, in words for the owner, when there's more to say than its status. */
	explain?: (reason: string | undefined) => string | undefined;
}) {
	const { harness, threads, approvals } = options;
	const known = options.tokens.map((t) => ({ ...t, digest: digest(t.token) }));

	/** The token the request carries, if it's one of the settings'. */
	function bridgeOf(request: IncomingMessage) {
		const header = request.headers.authorization ?? "";
		if (!header.startsWith("Bearer ")) return undefined;
		const offered = digest(header.slice("Bearer ".length).trim());
		return known.find((t) => timingSafeEqual(t.digest, offered));
	}

	/** The conversation a turn goes to: its key's, the speaker's while it's recent, or a new thread. */
	async function conversationFor(agent: string, speaker: string, key: string): Promise<Conversation> {
		const state = await harness.snapshot(VoiceState, context);
		const now = Date.now();
		const before = state?.turns[key];
		const recent = state?.speakers[speaker];
		const id = before?.conversation ?? (recent !== undefined && recent.agent === agent && now - recent.at < QUIET_MS ? recent.conversation : undefined);
		const found = id === undefined ? undefined : await harness.conversation(conversationId(id), context);
		const conversation = found ?? (await threads.start({ agent, origin: "voice", key: `voice:${key}` }));
		await harness.commit(async (tx) => {
			const doc = await tx.doc(VoiceState);
			doc.speakers[speaker] = { agent, conversation: conversation.id, at: now };
			for (const [k, turn] of Object.entries(doc.turns)) if (now - turn.at > KEY_MS) delete doc.turns[k];
			doc.turns[key] = { conversation: conversation.id, at: now };
		}, context);
		return conversation;
	}

	/** Answers a turn: checks the token and the body, then streams what the agent says until its run settles or waits. */
	async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		if (request.method !== "POST") return plain(response, 405, "POST a turn here.");
		const bridge = bridgeOf(request);
		if (bridge === undefined) return plain(response, 401, "This route takes a voice bridge's token.");
		let turn;
		try {
			turn = parseJson(await readBody(request), turnBody, "the turn");
		} catch (error) {
			return plain(response, error instanceof ParseError ? 400 : 413, error instanceof Error ? error.message : String(error));
		}
		const agent = turn.agent ?? bridge.agents[0];
		if (agent === undefined || !bridge.agents.includes(agent)) return plain(response, 403, `The ${bridge.name} token doesn't reach ${turn.agent ?? "any agent"}.`);
		if (!SPEAKER.test(turn.speaker)) return plain(response, 400, "A speaker's name is lowercase letters, digits and -, starting with a letter.");
		const text = turn.text.trim();
		if (text === "") return plain(response, 400, "The turn has no text.");

		let conversation: Conversation;
		try {
			conversation = await conversationFor(agent, turn.speaker, turn.key);
		} catch (error) {
			return plain(response, 404, error instanceof Error ? error.message : String(error));
		}

		response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
		const send = (event: VoiceEvent) => {
			if (!response.writableEnded) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
		};
		const said = new Set<EntryId>();
		const say = (entry: EntryRecord | undefined) => {
			const spoken = assistantText(entry)?.trim();
			if (entry === undefined || spoken === undefined || spoken === "" || said.has(entry.id)) return;
			said.add(entry.id);
			send({ type: "say", text: spoken });
		};

		let finish!: (event: VoiceEvent) => void;
		const finished = new Promise<VoiceEvent>((resolve) => (finish = resolve));
		const stream = await watchEvents(harness, conversation.id, context);
		stream.start(async (batch) => {
			for (const event of batch) if (event.type === "message_end") say(event.entry);
		});
		const unwatch = approvals.onChange((r) => {
			if (r.status === "pending" && r.conversationId === conversation.id) {
				send({ type: "waiting", summary: r.summary });
				finish({ type: "done", status: "waiting", conversation: conversation.id });
			}
		});
		response.once("close", () => finish({ type: "done", status: "gone", conversation: conversation.id }));
		const content = stamp(spoken(turn.speaker, text));
		void (async () => {
			try {
				const submission = await conversation.submit({ type: "input", content, requestId: `voice:${turn.key}` }, context);
				const settled = await submission.wait(context);
				if (settled.status === "done" && settled.type === "input") say(await conversation.commit((tx) => tx.entry(settled.answer), context));
				else send({ type: "say", text: options.explain?.(settled.reason) ?? "Sorry, I couldn't finish that." });
				finish({ type: "done", status: settled.status, conversation: conversation.id });
			} catch (error) {
				console.error("[voice] a turn failed:", error);
				send({ type: "say", text: "Sorry, something went wrong." });
				finish({ type: "done", status: "error", conversation: conversation.id });
			}
		})();
		const last = await finished;
		unwatch();
		await stream.stop();
		send(last);
		response.end();
	}

	return { handle };
}

export type Voice = ReturnType<typeof createVoice>;

async function readBody(request: IncomingMessage): Promise<string> {
	let text = "";
	for await (const chunk of request) {
		text += chunk;
		if (text.length > 20_000) throw new Error("The turn is too long.");
	}
	return text;
}

function plain(response: ServerResponse, status: number, text: string) {
	response.writeHead(status, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
	response.end(text);
}
