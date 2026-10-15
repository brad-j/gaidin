// The activity page: spend today and this month against the limits, spend by model, and the timeline of what
// gaidin did and who allowed it, newest first, 50 at a time.
import type { Gets } from "../src/web.ts";
import { load, post } from "./api.ts";
import { argsSummary, clock, day, el, money, toolArguments, when } from "./dom.ts";
import { empty, PageState, sectionHead } from "./page.ts";

type Budget = Gets["/api/budget"];
type Usage = Gets["/api/usage"];
type Timeline = Gets["/api/timeline"];
type Item = Timeline["items"][number];
type Cursor = NonNullable<Timeline["next"]>;

let root: HTMLElement | undefined;
let budget: Budget | undefined;
let usage: Usage | undefined;
let items: Item[] = [];
let next: Cursor | undefined;
let loaded = false;
const page = new PageState(() => draw());

export type ActivityHooks = {
	/** Tells the rest of the page the budget changed, after allowing more. */
	budgetChanged: (budget: NonNullable<Budget>) => void;
};
let hooks: ActivityHooks | undefined;

/** Loads spend and the newest page of the timeline, and draws the page into `into`. */
export async function renderActivity(into: HTMLElement, given: ActivityHooks) {
	root = into;
	hooks = given;
	draw();
	await page.attempt(async () => {
		const [b, u, t] = await Promise.all([load("/api/budget"), load("/api/usage"), load("/api/timeline")]);
		[budget, usage, items, next, loaded] = [b, u, [...t.items], t.next, true];
	});
	draw();
}

async function older() {
	if (next === undefined) return;
	const more = await load("/api/timeline", `?entry=${next.entry}&ref=${encodeURIComponent(next.ref)}`);
	items = [...items, ...more.items];
	next = more.next;
	draw();
}

function draw() {
	if (root === undefined) return;
	if (!loaded) {
		root.replaceChildren(...page.problems(), empty("Loading…"));
		return;
	}
	root.replaceChildren(...page.problems(), spend(), timeline());
}

/** Spent against a limit, as a line and a bar; no limit, just the line. */
function meter(label: string, spent: number, limit: number): HTMLElement {
	const row = el("div", "meter");
	const share = limit > 0 ? spent / limit : 0;
	const tone = share >= 1 ? " over" : share >= 0.8 ? " near" : "";
	const figures = el("div", "figures");
	figures.append(el("span", "label", label), el("span", `amount${tone}`, money(spent)), el("span", "limit", limit > 0 ? `of ${money(limit)}` : "no limit"));
	row.append(figures);
	if (limit > 0) {
		const bar = el("div", `bar${tone}`);
		const fill = el("span");
		fill.style.width = `${Math.min(100, share * 100)}%`;
		bar.append(fill);
		bar.setAttribute("role", "meter");
		bar.setAttribute("aria-label", `${label}: ${money(spent)} of ${money(limit)}`);
		bar.setAttribute("aria-valuenow", String(spent));
		bar.setAttribute("aria-valuemax", String(limit));
		row.append(bar);
	}
	return row;
}

function spend(): HTMLElement {
	const section = el("section");
	section.append(sectionHead("Spend", undefined));
	if (budget === null || budget === undefined) section.append(empty("No spend guard: the settings file sets no limits."));
	else {
		const status = budget;
		if (status.stopped) {
			const stopped = el("div", "stopped");
			stopped.append(
				el("p", undefined, status.reason ?? "gaidin is stopped at the spend limit."),
				page.action("allow more today", async () => {
					budget = await post("/api/budget/allow", {});
					hooks?.budgetChanged(budget);
					draw();
				}, "primary"),
			);
			section.append(stopped);
		}
		const meters = el("div", "meters");
		meters.append(meter("today", status.today, status.dailyLimit), meter("this month", status.month, status.monthlyLimit));
		section.append(meters);
	}
	// What the models and tools cost, in every conversation since gaidin started.
	const rows = Object.entries({ ...usage?.models, ...usage?.tools })
		.map(([key, u]) => ({ name: key.replace(/^[^/]+\//, ""), cost: u.cost.total, tokens: u.input + u.output + u.cacheRead + u.cacheWrite }))
		.filter((r) => r.cost > 0)
		.sort((a, b) => b.cost - a.cost);
	if (rows.length > 0) {
		const table = el("table", "by-model");
		const head = table.createTHead().insertRow();
		for (const title of ["all time, by model", "tokens", "cost"]) head.append(el("th", undefined, title));
		const body = table.createTBody();
		for (const row of rows) {
			const line = body.insertRow();
			line.append(el("td", undefined, row.name), el("td", "num", compact(row.tokens)), el("td", "num", money(row.cost)));
		}
		section.append(table);
	}
	return section;
}

const compactNumber = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const compact = (n: number) => compactNumber.format(n);

const GOOD = /^(ok|allowed once|always allowed|answered|reported|pushed)\b/;
const BAD = /^(denied|blocked|expired|not delivered|push failed)\b/;
const PLACES = { thread: "Slack thread", job: "job run", agent: "from another agent" } as const;

function timeline(): HTMLElement {
	const section = el("section");
	section.append(
		sectionHead("Timeline", undefined),
		el("p", "page-note", "What gaidin did outside its sandbox and who allowed it, newest first, in every conversation."),
	);
	if (items.length === 0) {
		section.append(empty("Nothing yet."));
		return section;
	}
	const list = el("ol", "timeline-list");
	let lastDay = "";
	for (const item of items) {
		// A line for each day, so the times can be short.
		const itemDay = item.at > 0 ? day(item.at) : "";
		if (itemDay !== lastDay) {
			lastDay = itemDay;
			list.append(el("li", "day", itemDay === "" ? "earlier" : itemDay === "today" || itemDay === "tomorrow" ? itemDay : when.format(item.at).replace(/,? \d{2}:\d{2}$/, "")));
		}
		list.append(timelineRow(item));
	}
	section.append(list);
	if (next !== undefined) section.append(page.action("older", older));
	return section;
}

function timelineRow(item: Item): HTMLElement {
	// "is-": the dock's approval requests already use the class "approval".
	const row = el("li", `event is-${item.kind}`);
	const time = el("span", "time", item.at > 0 ? clock.format(item.at) : "");
	if (item.at > 0) time.title = when.format(item.at);
	const what = item.kind === "tool" ? item.name : item.kind === "approval" ? `allow ${item.name}?` : item.kind;
	const detail = item.kind === "tool" ? argsSummary(item.name, toolArguments(item.detail)) : item.kind === "job" ? item.name : item.detail;
	const outcome = item.outcome || "running";
	const tone = GOOD.test(outcome) ? "good" : BAD.test(outcome) || (item.kind === "tool" && outcome !== "running") ? "bad" : "";
	const body = el("div", "body");
	const head = el("div", "what");
	head.append(el("span", "name", what));
	if (item.place !== "main") head.append(el("span", "tag", PLACES[item.place]));
	body.append(head, el("div", "detail", detail));
	row.append(time, body, el("span", `outcome ${tone}`, outcome));
	return row;
}
