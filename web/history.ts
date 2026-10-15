// The history page: Slack threads and job runs, the most recently active first, each opening to its transcript,
// read-only, drawn as the console draws the main conversation. #/history lists them; #/history/<id> opens one.
// A thread forked from an answer in the main conversation shows that answer above its own messages; a thread started in Slack has none.
import type { Gets } from "../src/web.ts";
import { load } from "./api.ts";
import { ago, el, when } from "./dom.ts";
import { createLog } from "./log.ts";
import { empty, PageState, sectionHead } from "./page.ts";
import { applyEvent, newTranscript } from "./transcript.ts";

type Listing = Gets["/api/conversations"];
type Summary = Listing["items"][number];

const PLACES = { thread: "Slack thread", job: "job run", agent: "from another agent" } as const;

let root: HTMLElement | undefined;
let items: Summary[] = [];
let next: number | undefined;
let loaded = false;
const page = new PageState(() => drawList());
/** Each opened conversation gets its own log, so its folds stay open while it's shown. */
let log = createLog();
let shownId: number | undefined;

/** The conversation an address like #/history/42 opens, if any. */
export function historyRoute(hash: string): number | undefined {
	const id = Number(/^#\/history\/(\d+)/.exec(hash)?.[1]);
	return Number.isInteger(id) && id > 0 ? id : undefined;
}

export async function renderHistory(into: HTMLElement, id: number | undefined) {
	root = into;
	page.problem = undefined;
	if (id !== undefined) return renderConversation(into, id);
	shownId = undefined;
	drawList();
	await page.attempt(async () => {
		const listing = await load("/api/conversations");
		[items, next, loaded] = [[...listing.items], listing.next, true];
	});
	drawList();
}

async function older() {
	if (next === undefined) return;
	const more = await load("/api/conversations", `?before=${next}`);
	items = [...items, ...more.items];
	next = more.next;
	drawList();
}

function drawList() {
	if (root === undefined || shownId !== undefined) return;
	const section = el("section");
	section.append(
		sectionHead("History", loaded ? String(items.length) + (next === undefined ? "" : "+") : undefined),
		el("p", "page-note", "Slack threads and job runs, the most recently active first. The main conversation is the console."),
	);
	if (!loaded) section.append(empty("Loading…"));
	else if (items.length === 0) section.append(empty("No Slack threads or job runs yet."));
	else {
		const list = el("ol", "convo-list");
		for (const item of items) {
			const link = el("a", "convo-row");
			link.href = `#/history/${item.id}`;
			const head = el("div", "head");
			head.append(el("span", "title", item.title || "(no message)"), el("span", `tag ${item.place}`, PLACES[item.place]));
			const meta = el("div", "meta");
			const last = el("span", undefined, ago(item.lastAt));
			last.title = when.format(item.lastAt);
			meta.append(last, el("span", undefined, `${item.messages} message${item.messages === 1 ? "" : "s"}`));
			link.append(head, meta);
			if (item.preview !== "") link.append(el("p", "preview", item.preview));
			const row = el("li");
			row.append(link);
			list.append(row);
		}
		section.append(list);
		if (next !== undefined) section.append(page.action("older", older));
	}
	root.replaceChildren(...page.problems(), section);
}

async function renderConversation(into: HTMLElement, id: number) {
	const fresh = shownId !== id;
	shownId = id;
	into.replaceChildren(empty("Loading…"));
	let found: Gets["/api/conversation"];
	try {
		found = await load("/api/conversation", `?id=${id}`);
	} catch (error) {
		if (shownId !== id) return;
		const back = el("a", undefined, "back to the history");
		back.href = "#/history";
		const problem = el("p", "page-problem", error instanceof Error ? error.message.replace(/^\/api\/[\w/]+: /, "") : String(error));
		into.replaceChildren(problem, back);
		return;
	}
	if (shownId !== id) return;
	const { conversation, snapshot } = found;
	if (fresh) log = createLog(conversation.place === "job" ? { prompts: "job" } : {});
	const transcript = newTranscript();
	applyEvent(transcript, snapshot);

	const crumbs = el("nav", "crumbs");
	crumbs.setAttribute("aria-label", "Breadcrumb");
	const back = el("a", undefined, "history");
	back.href = "#/history";
	crumbs.append(back, el("span", "sep", "/"), el("span", undefined, PLACES[conversation.place]));
	const head = el("div", "skill-head");
	head.append(el("h2", "convo-title", conversation.title || "(no message)"), el("span", `tag ${conversation.place}`, PLACES[conversation.place]));
	const header = el("header", "skill-header");
	header.append(crumbs, head);

	const body = el("div", "log readonly");
	// A thread's fork carries the main conversation up to the answer it replies to; that answer is shown, the rest isn't.
	const forkedAt = conversation.forkedAt;
	if (forkedAt !== undefined) {
		const parent = log.render(transcript, [], (entry) => entry.id === forkedAt);
		if (parent.length > 0) {
			const quote = el("div", "replying");
			quote.append(el("div", "label", "in reply to this answer in the console"), ...parent);
			body.append(quote);
		}
	}
	const rows = log.render(transcript, [], (entry) => entry.conversationId === id);
	body.append(...(rows.length === 0 ? [empty("Nothing in it yet.")] : rows));
	if (transcript.running) body.append(el("p", "page-note", "It's still running; reload to see what it's done since."));
	into.replaceChildren(header, body);
	into.parentElement?.scrollTo({ top: 0 });
}
