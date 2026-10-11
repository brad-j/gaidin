// An index of the transcript, in <data>/history.sqlite, for searching past conversations and for the timeline.
// Pi Durable keeps every entry, including the ones compaction summarized away, but can't search their text or
// list them across conversations.
//
// - messages: the owner's messages and gaidin's answers, with a full-text index, for search_history.
// - activity: what gaidin did and who allowed it, for the web view's timeline: tool calls and whether they
//   worked, approval outcomes (approvals.ts writes them into the transcript), job reports and reminders.
//
// Both cover the main conversation, Slack threads and job runs, not gaidin's internal conversations, such as
// the self-extension reviewer's. The index follows commits as they happen and catches up at start, so the file
// can be deleted and it's rebuilt. Reads wait for indexing that's under way, so they see everything committed
// before them.
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT as background } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { AssistantEntry, type ConversationId, defineExtension, defineTool, type EntryId, type EntryRecord, type Harness, ToolResultEntry, type Tx, UserEntry } from "@earendil-works/pi-durable";
import { ApprovalSettled } from "./approvals.ts";
import { JobReported } from "./jobs.ts";
import { ReminderFired } from "./reminders.ts";
import { formatTime } from "./time.ts";

type Place = "main" | "thread" | "job";
type Row = { id: number; conversation: number; place: Place; role: string; at: number; text: string };

const PLACES = { main: "main conversation", thread: "Slack thread", job: "job run" } satisfies Record<Place, string>;

/** Tools left off the timeline: the sandbox's, ask_owner (its approval entry has the question and answer), and ones that only read gaidin's own state. */
const QUIET = new Set(["read", "write", "edit", "bash", "ask_owner", "list_reminders", "list_jobs", "search_history", "read_history"]);

/** One thing on the timeline. `at` is 0 when the entry doesn't say when. */
export type Activity = {
	entry: number;
	at: number;
	place: Place;
	kind: "tool" | "approval" | "job" | "reminder";
	/** The tool, or the job's title. */
	name: string;
	/** The call's arguments as JSON, the approval's summary, or the reminder's text. */
	detail: string;
	/** "ok", what went wrong, or how an approval ended; empty while a call runs. */
	outcome: string;
};

const WHERE = new Map([["slack", " in Slack"], ["web", " in the web view"]]);

/** What an entry adds to the timeline. `update` is a tool call's outcome, by its call id. */
type Contribution = { rows: (Omit<Activity, "place"> & { ref: string })[]; update?: [string, string] };

function activityOf(entry: EntryRecord): Contribution {
	const id = entry.id as number;
	if (AssistantEntry.is(entry)) {
		const message = entry.model?.[0];
		if (message?.role !== "assistant") return { rows: [] };
		const calls = message.content.flatMap((c) => (c.type === "toolCall" && !QUIET.has(c.name) ? [c] : []));
		return { rows: calls.map((c) => ({ ref: c.id, entry: id, at: message.timestamp, kind: "tool", name: c.name, detail: JSON.stringify(c.arguments), outcome: "" })) };
	}
	if (ToolResultEntry.is(entry)) {
		const message = entry.model?.[0];
		if (message?.role !== "toolResult") return { rows: [] };
		if (!message.isError) return { rows: [], update: [message.toolCallId, "ok"] };
		// The approval above it says why a call was blocked.
		const text = message.content.map((c) => (c.type === "text" ? c.text : "")).join("").replace(/<\/?harness>|\[error\]/g, "").trim();
		return { rows: [], update: [message.toolCallId, text.startsWith("Tool call blocked") ? "blocked" : (text.split("\n")[0] ?? "").slice(0, 300) || "error"] };
	}
	if (ApprovalSettled.is(entry)) {
		const d = entry.data;
		const where = WHERE.get(d.by ?? "") ?? "";
		const outcome = d.kind === "question" ? (d.status === "answered" ? `answered${where}: ${d.answer}` : d.status)
			: d.status === "approved" ? `${d.decision === "always" ? "always allowed" : "allowed once"}${where}`
			: d.status === "denied" ? `denied${where}`
			: d.status;
		return { rows: [{ ref: `approval:${d.id}`, entry: id, at: d.decidedAt ?? 0, kind: "approval", name: d.tool, detail: d.summary, outcome }] };
	}
	if (JobReported.is(entry)) {
		const d = entry.data;
		return { rows: [{ ref: `job:${id}`, entry: id, at: d.at ?? 0, kind: "job", name: d.title, detail: "", outcome: d.delivered ? "reported" : `not delivered: ${d.error}` }] };
	}
	if (ReminderFired.is(entry)) {
		const d = entry.data;
		return { rows: [{ ref: `reminder:${id}`, entry: id, at: d.at, kind: "reminder", name: "reminder", detail: d.text, outcome: d.delivered ? "pushed" : `push failed: ${d.error}` }] };
	}
	return { rows: [] };
}

/** The text of an owner's message or an answer, without the time the owner's messages start with. */
function messageOf(entry: EntryRecord): Omit<Row, "conversation" | "place"> | undefined {
	if (!UserEntry.is(entry) && !AssistantEntry.is(entry)) return undefined;
	const message = entry.model?.[0];
	if (message?.role !== "user" && message?.role !== "assistant") return undefined;
	const parts = typeof message.content === "string" ? [message.content] : message.content.flatMap((c) => (c.type === "text" ? [c.text] : []));
	const text = parts.join("").replace(/^\[[^\]]*\] /, "").trim();
	return text === "" ? undefined : { id: entry.id as number, role: message.role, at: message.timestamp, text };
}

/** Where a conversation is, or nothing for one that isn't indexed. */
async function placeOf(tx: Tx, id: ConversationId): Promise<Place | undefined> {
	const conversation = await tx.conversation(id);
	if (conversation === undefined) return undefined;
	if (conversation.owner === undefined) return conversation.parent === undefined ? "main" : "thread";
	return (await tx.task(conversation.owner.taskId))?.kind === "gaidin.job" ? "job" : undefined;
}

export function createHistory(file: string, owner: string) {
	const db = new DatabaseSync(file);
	// An index made before the timeline existed is filled again from the start, so it gets the older activity.
	const fresh = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'activity'").get() === undefined;
	db.exec(`
		CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, conversation INTEGER NOT NULL, place TEXT NOT NULL, role TEXT NOT NULL, at INTEGER NOT NULL, text TEXT NOT NULL);
		CREATE INDEX IF NOT EXISTS messages_by_conversation ON messages (conversation, id);
		CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(text, content='messages', content_rowid='id', tokenize='porter unicode61');
		CREATE TRIGGER IF NOT EXISTS messages_indexed AFTER INSERT ON messages BEGIN INSERT INTO search (rowid, text) VALUES (new.id, new.text); END;
		CREATE TABLE IF NOT EXISTS activity (ref TEXT PRIMARY KEY, entry INTEGER NOT NULL, conversation INTEGER NOT NULL, place TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, detail TEXT NOT NULL, outcome TEXT NOT NULL);
		CREATE INDEX IF NOT EXISTS activity_by_entry ON activity (entry, ref);
	`);
	const insert = db.prepare("INSERT OR IGNORE INTO messages (id, conversation, place, role, at, text) VALUES (?, ?, ?, ?, ?, ?)");
	const insertActivity = db.prepare("INSERT OR IGNORE INTO activity (ref, entry, conversation, place, at, kind, name, detail, outcome) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
	const finish = db.prepare("UPDATE activity SET outcome = ? WHERE ref = ?");
	const places = new Map<number, Place | undefined>();
	// Indexing in order, one batch at a time; searches wait on it.
	let work = Promise.resolve();
	let closed = false;
	const queue = (job: () => Promise<void>) => {
		// Indexing that's cut off by shutdown is finished by the next start's catch-up.
		work = work.then(job).catch((error) => {
			if (!closed) console.error("[history]", error);
		});
	};

	async function add(harness: Harness, entries: readonly EntryRecord[]) {
		const unknown = [...new Set(entries.map((e) => e.conversationId))].filter((id) => !places.has(id as number));
		if (unknown.length > 0) {
			await harness.commit(async (tx) => {
				for (const id of unknown) places.set(id as number, await placeOf(tx, id));
			}, background);
		}
		for (const entry of entries) {
			const place = places.get(entry.conversationId as number);
			if (place === undefined) continue;
			const conversation = entry.conversationId as number;
			const message = messageOf(entry);
			if (message !== undefined) insert.run(message.id, conversation, place, message.role, message.at, message.text);
			const { rows, update } = activityOf(entry);
			for (const r of rows) insertActivity.run(r.ref, r.entry, conversation, place, r.at, r.kind, r.name, r.detail, r.outcome);
			if (update !== undefined) finish.run(update[1], update[0]);
		}
	}

	/** Indexes what was committed after the newest indexed message. A fork's scan includes its parent's entries, which are skipped. */
	async function catchUp(harness: Harness) {
		const after = fresh ? 0 : Number((db.prepare("SELECT max(id) AS id FROM messages").get() as { id: number | null }).id ?? 0);
		let conversations: Parameters<Tx["scanConversations"]>[2];
		do {
			const page = await harness.commit((tx) => tx.scanConversations({}, 100, conversations), background);
			for (const conversation of page.items) {
				let entries: Parameters<Tx["scanEntries"]>[2];
				do {
					const query = { conversationId: conversation.id, minEntryId: (after + 1) as EntryId, order: "ascending" as const };
					const found = await harness.commit((tx) => tx.scanEntries(query, 200, entries), background);
					await add(harness, found.items.filter((e) => e.conversationId === conversation.id));
					entries = found.next;
				} while (entries !== undefined);
			}
			conversations = page.next;
		} while (conversations !== undefined);
	}

	const line = (row: Row, text: string) => `#${row.id} · ${formatTime(row.at)} · ${PLACES[row.place]} · ${row.role === "user" ? owner : "gaidin"}: ${text}`;

	const search = defineTool({
		name: "search_history",
		description:
			`Search past conversations, the main one, Slack threads and job runs, for words in ${owner}'s messages and your answers. ` +
			"Newest first, up to 10, each with its number; read_history shows the messages around one. Tool output isn't searched.",
		parameters: Type.Object({ query: Type.String({ description: "Words that must all appear; word endings don't matter" }) }),
		replay: "safe",
		execute: async (args) => {
			await work;
			const words = args.query.match(/[\p{L}\p{N}]+/gu) ?? [];
			if (words.length === 0) return { content: [{ type: "text", text: "Give some words to search for." }], isError: true };
			const rows = db
				.prepare("SELECT m.*, snippet(search, 0, '«', '»', '…', 24) AS snippet FROM search JOIN messages m ON m.id = search.rowid WHERE search MATCH ? ORDER BY m.id DESC LIMIT 10")
				.all(words.map((w) => `"${w}"`).join(" ")) as (Row & { snippet: string })[];
			const text = rows.length === 0 ? `Nothing in past conversations matches "${args.query}".` : rows.map((row) => line(row, row.snippet)).join("\n");
			return { content: [{ type: "text", text }] };
		},
	});

	const read = defineTool({
		name: "read_history",
		description: "The messages around one that search_history found, in their conversation and in order.",
		parameters: Type.Object({ id: Type.Number({ description: "The number search_history gave" }) }),
		replay: "safe",
		execute: async (args) => {
			await work;
			const before = db.prepare("SELECT * FROM messages WHERE conversation = (SELECT conversation FROM messages WHERE id = ?1) AND id <= ?1 ORDER BY id DESC LIMIT 5").all(args.id) as Row[];
			if (before.length === 0) return { content: [{ type: "text", text: `There's no message #${args.id}.` }], isError: true };
			const after = db.prepare("SELECT * FROM messages WHERE conversation = ? AND id > ? ORDER BY id LIMIT 4").all(before[0]!.conversation, args.id) as Row[];
			const clip = (text: string) => (text.length > 2000 ? `${text.slice(0, 2000)}…` : text);
			return { content: [{ type: "text", text: [...before.reverse(), ...after].map((row) => line(row, clip(row.text))).join("\n\n") }] };
		},
	});

	return {
		tools: [search, read],
		extension: defineExtension({ name: "history", tools: [search, read] }),
		/** Up to 50 things gaidin did, newest first, from after `cursor` on, and the cursor for the next 50. */
		async timeline(cursor?: { entry: number; ref: string }): Promise<{ items: Activity[]; next?: { entry: number; ref: string } }> {
			await work;
			const rows = (cursor === undefined
				? db.prepare("SELECT * FROM activity ORDER BY entry DESC, ref DESC LIMIT 50").all()
				: db.prepare("SELECT * FROM activity WHERE entry < ?1 OR (entry = ?1 AND ref < ?2) ORDER BY entry DESC, ref DESC LIMIT 50").all(cursor.entry, cursor.ref)) as (Activity & { ref: string })[];
			const items = rows.map(({ entry, at, place, kind, name, detail, outcome }) => ({ entry, at, place, kind, name, detail, outcome }));
			const end = rows.at(-1);
			return rows.length < 50 || end === undefined ? { items } : { items, next: { entry: end.entry, ref: end.ref } };
		},
		/** Follows the Harness's commits from now on and indexes what's missing. */
		attach(harness: Harness) {
			harness.subscribeCommits(({ changes }) => {
				const entries = changes.flatMap((c) => (c.type === "entry" ? [c.value] : []));
				if (entries.length > 0) queue(() => add(harness, entries));
			});
			harness.subscribeClose(() => {
				closed = true;
				queue(async () => db.close());
			});
			queue(() => catchUp(harness));
		},
	};
}
