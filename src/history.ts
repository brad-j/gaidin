// Search past conversations. Pi Durable keeps every entry, including the ones compaction summarized away,
// but can't search their text, so this keeps a full-text index of the owner's messages and gaidin's answers
// in <data>/history.sqlite. It covers the main conversation, Slack threads and job runs, not tool output or
// gaidin's internal conversations, such as the self-extension reviewer's.
//
// The index follows commits as they happen and catches up at start, so the file can be deleted and it's
// rebuilt. Searching waits for indexing that's under way, so a search sees everything committed before it.
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT as background } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { AssistantEntry, type ConversationId, defineExtension, defineTool, type EntryId, type EntryRecord, type Harness, type Tx, UserEntry } from "@earendil-works/pi-durable";
import { formatTime } from "./time.ts";

type Place = "main" | "thread" | "job";
type Row = { id: number; conversation: number; place: Place; role: string; at: number; text: string };

const PLACES: Record<Place, string> = { main: "main conversation", thread: "Slack thread", job: "job run" };

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
	db.exec(`
		CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, conversation INTEGER NOT NULL, place TEXT NOT NULL, role TEXT NOT NULL, at INTEGER NOT NULL, text TEXT NOT NULL);
		CREATE INDEX IF NOT EXISTS messages_by_conversation ON messages (conversation, id);
		CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(text, content='messages', content_rowid='id', tokenize='porter unicode61');
		CREATE TRIGGER IF NOT EXISTS messages_indexed AFTER INSERT ON messages BEGIN INSERT INTO search (rowid, text) VALUES (new.id, new.text); END;
	`);
	const insert = db.prepare("INSERT OR IGNORE INTO messages (id, conversation, place, role, at, text) VALUES (?, ?, ?, ?, ?, ?)");
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
			const message = place === undefined ? undefined : messageOf(entry);
			if (message !== undefined) insert.run(message.id, entry.conversationId as number, place!, message.role, message.at, message.text);
		}
	}

	/** Indexes what was committed after the newest indexed message. A fork's scan includes its parent's entries, which are skipped. */
	async function catchUp(harness: Harness) {
		const after = Number((db.prepare("SELECT max(id) AS id FROM messages").get() as { id: number | null }).id ?? 0);
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
