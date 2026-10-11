// Client for src/web.ts. Served with its types stripped, so it keeps to erasable TypeScript.
// It rebuilds the root conversation from the server's event stream: a snapshot, then one batch of
// events per commit (pi-durable's watchEvents).

type Text = { type: "text"; text: string };
type Block = Text | { type: "thinking"; thinking: string; redacted?: boolean } | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };
type Part = { type: string; text?: string };
type Message =
	| { role: "user"; content: string | Part[] }
	| { role: "assistant"; content: Block[]; stopReason?: string; errorMessage?: string }
	| { role: "toolResult"; toolCallId: string; toolName: string; content: Part[]; isError?: boolean };
type Entry = { id: number; kind: string; model?: Message[]; data?: Record<string, unknown> };
type Usage = { cost: { total: number } };
type UsageState = { models: Record<string, Usage>; tools: Record<string, Usage> };
type Slot = { callId: string; name: string; output: string };
type Reminder = { taskId: number; text: string; at: number };
type Job = { taskId: number; title: string; when: string; mode: string; nextAt?: number; lastAt?: number; lastResult?: string; paused?: { at: number; reason: string }; gate?: { name: string } };
type Approval = { id: string; summary: string; detail?: string; tool: string; expiresAt: number; kind?: string; choices?: string[]; always?: { kind: string; value: string; label: string } };
type Note = { id: number; text: string; by: string; updatedAt: number };
type Budget = { today: number; month: number; dailyLimit: number; monthlyLimit: number; stopped: boolean; reason?: string };
type Settings = { model: string; models: string[]; thinkingLevel: string; instructions: string; tools: { name: string; enabled: boolean }[] };
// The event stream's shapes are pi-durable's AgentEvent; only the fields used here are read.
type AgentEvent = { type: string; [field: string]: any };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const state = {
	entries: new Map<number, Entry>(),
	/** The assistant message being generated. */
	partial: undefined as { content: Block[] } | undefined,
	/** Running tool calls and their output so far, by tool call id. */
	slots: new Map<string, Slot>(),
	running: false,
	connected: false,
	retry: undefined as string | undefined,
	usage: undefined as UsageState | undefined,
	allSpend: undefined as number | undefined,
	budget: undefined as Budget | null | undefined,
};
/** Tool calls and thinking blocks the owner has opened, so a re-render keeps them open. */
const opened = new Set<string>();

// --- events -----------------------------------------------------------------------------------

function apply(event: AgentEvent) {
	switch (event.type) {
		case "snapshot":
			// A (re)connection may have missed changes.
			void loadApprovals();
			state.entries = new Map(event.entries.map((e: Entry) => [e.id, e]));
			state.partial = event.generation?.message ? structuredClone(event.generation.message) : undefined;
			state.slots = new Map(
				event.tools.filter((t: any) => t.status === "running").map((t: any) => [t.callId, { callId: t.callId, name: t.name, output: t.output ?? "" }]),
			);
			state.running = event.run !== undefined;
			state.usage = event.usage;
			break;
		case "run_start":
			state.running = true;
			break;
		case "run_end":
			state.running = false;
			state.partial = undefined;
			state.retry = undefined;
			void loadSpend();
			void loadReminders();
			void loadJobs();
			break;
		case "message_start":
			if (event.message.role === "assistant") state.partial = structuredClone(event.message);
			break;
		case "message_update":
			if (state.partial !== undefined) for (const change of event.changes) applyChange(state.partial, change);
			break;
		case "message_end":
			state.partial = undefined;
			add(event.entry);
			break;
		case "tool_execution_start":
			state.slots.set(event.toolCallId, { callId: event.toolCallId, name: event.toolName, output: "" });
			break;
		case "tool_execution_update": {
			const slot = state.slots.get(event.toolCallId);
			if (slot === undefined || event.output === undefined) break;
			if ("set" in event.output) slot.output = event.output.set;
			else slot.output = slot.output.slice(event.output.trimStart ?? 0) + (event.output.append ?? "");
			break;
		}
		case "tool_execution_end":
			state.slots.delete(event.toolCallId);
			if (event.entry) add(event.entry);
			break;
		case "entry_appended":
			add(event.entry);
			if (event.entry.kind === "gaidin.reminder-fired") void loadReminders();
			if (event.entry.kind === "gaidin.job-reported") void loadJobs();
			break;
		case "usage_changed":
			state.usage = event.usage;
			break;
		case "agent_changed":
			void loadSettings();
			break;
		case "auto_retry_start":
			state.retry = `retrying: ${event.errorMessage}`;
			break;
		case "auto_retry_end":
			state.retry = undefined;
			break;
		case "approvals_changed":
			void loadApprovals();
			break;
		case "task_failed":
			notice(`${event.kind} failed: ${event.message}`);
			break;
	}
}

function add(entry: Entry) {
	state.entries.set(entry.id, entry);
}

function applyChange(message: { content: Block[] }, change: any) {
	const i = change.contentIndex;
	switch (change.type) {
		case "text_start":
		case "thinking_start":
		case "toolcall_start":
		case "block":
			message.content[i] = structuredClone(change.block);
			break;
		case "text_delta":
			(message.content[i] as Text).text += change.delta;
			break;
		case "thinking_delta":
			(message.content[i] as { thinking: string }).thinking += change.delta;
			break;
		case "toolcall_delta": {
			// Appends to the string at `path` inside the call's arguments.
			let target: any = (message.content[i] as { arguments: unknown }).arguments;
			const path = change.path as (string | number)[];
			for (const key of path.slice(0, -1)) target = target[key] ??= {};
			const last = path.at(-1)!;
			target[last] = (target[last] ?? "") + change.delta;
			break;
		}
		case "message":
			message.content = structuredClone(change.message.content);
			break;
	}
}

function connect() {
	const source = new EventSource("/events");
	source.onopen = () => {
		state.connected = true;
		schedule();
	};
	source.onmessage = (message) => {
		apply(JSON.parse(message.data) as AgentEvent);
		schedule();
	};
	// EventSource reconnects by itself, and the server starts every connection with a snapshot.
	source.onerror = () => {
		state.connected = false;
		schedule();
	};
}

// --- rendering --------------------------------------------------------------------------------

let pending = false;
function schedule() {
	if (pending) return;
	pending = true;
	requestAnimationFrame(() => {
		pending = false;
		render();
	});
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

function textOf(content: string | Part[]): string {
	return typeof content === "string" ? content : content.map((p) => p.text ?? `[${p.type}]`).join("");
}

/** The owner's messages start with the local time in brackets; show it apart from the text. */
function splitStamp(text: string): { time?: string; text: string } {
	const match = /^\[([^\]]+)\] /.exec(text);
	return match ? { time: match[1], text: text.slice(match[0].length) } : { text };
}

/** "Sat 2026-10-10 19:31 GMT-4" (src/time.ts) as "19:31" today, or "Oct 10" another day. */
function shortStamp(stamp: string): string {
	const match = /^\w+ (\d{4})-(\d{2})-(\d{2}) (\d{2}:\d{2})/.exec(stamp);
	if (!match) return stamp;
	const [, year, month, day, time] = match;
	const now = new Date();
	if (Number(year) === now.getFullYear() && Number(month) === now.getMonth() + 1 && Number(day) === now.getDate()) return time;
	return new Date(Number(year), Number(month) - 1, Number(day)).toLocaleString(undefined, { month: "short", day: "numeric" });
}

const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const when = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** "in 25 min", "in 3 h 10 min", "in 4 days". */
function fromNow(at: number): string {
	const minutes = Math.round((at - Date.now()) / 60_000);
	if (minutes < 1) return "now";
	if (minutes < 60) return `in ${minutes} min`;
	if (minutes < 48 * 60) return `in ${Math.floor(minutes / 60)} h${minutes % 60 === 0 ? "" : ` ${minutes % 60} min`}`;
	return `in ${Math.round(minutes / 1440)} days`;
}

function argsSummary(name: string, args: Record<string, unknown>): string {
	if (name === "bash" && typeof args.command === "string") return args.command;
	if (typeof args.path === "string") return args.path;
	if (typeof args.url === "string") return args.url;
	if (name === "remind") return `${args.text ?? ""} ${args.at ?? (args.inMinutes === undefined ? "" : `in ${args.inMinutes} min`)}`;
	if (typeof args.title === "string") return args.title;
	if (typeof args.text === "string") return args.text;
	const json = JSON.stringify(args);
	return json === "{}" ? "" : json;
}

function money(dollars: number): string {
	return `$${dollars.toFixed(dollars < 1 ? 3 : 2)}`;
}

// --- markdown ---------------------------------------------------------------------------------
// Enough Markdown for model answers: fences, headings, lists, quotes, tables, rules, and inline code,
// emphasis and links. It builds DOM nodes, never HTML strings, so nothing in a message can inject markup.

const INLINE = /(`+)([\s\S]*?[^`])\1(?!`)|\*\*([^*][\s\S]*?)\*\*|__([^_][\s\S]*?)__|~~([\s\S]+?)~~|!?\[([^\]]+)\]\(<?((?:[^()\s<>]|\([^()\s]*\))+)>?\)|<?(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"\]])>?|\*([^*\s](?:[^*]*[^*\s])?)\*|(?<![\w])_([^_\s](?:[^_]*[^_\s])?)_(?![\w])/g;

function inline(text: string, parent: HTMLElement) {
	let last = 0;
	for (const m of text.matchAll(INLINE)) {
		const index = m.index ?? 0;
		if (index > last) parent.append(text.slice(last, index));
		last = index + m[0].length;
		if (m[1] !== undefined) parent.append(el("code", undefined, m[2].replace(/^ (.*) $/, "$1")));
		else if (m[3] !== undefined || m[4] !== undefined) inline(m[3] ?? m[4], parent.appendChild(el("strong")));
		else if (m[5] !== undefined) inline(m[5], parent.appendChild(el("s")));
		else if (m[6] !== undefined) parent.append(link(m[7], m[6]));
		else if (m[8] !== undefined) parent.append(link(m[8]));
		else inline(m[9] ?? m[10], parent.appendChild(el("em")));
	}
	if (last < text.length) parent.append(text.slice(last));
}

/** A link to an http(s) or mailto address; anything else is shown as its label. A label holding a URL stays plain, so links don't nest. */
function link(href: string, label?: string): Node {
	if (!/^(https?:|mailto:)/i.test(href)) return document.createTextNode(label ?? href);
	const a = el("a");
	a.href = href;
	a.target = "_blank";
	a.rel = "noopener noreferrer";
	if (label === undefined || /https?:\/\//.test(label)) a.textContent = label ?? href;
	else inline(label, a);
	return a;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+-]*)/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function markdown(source: string): HTMLElement {
	const root = el("div", "md");
	blocks(source.replace(/\r\n?/g, "\n").split("\n"), root);
	return root;
}

function cells(row: string): string[] {
	return row.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

function isTable(lines: string[], i: number): boolean {
	return lines[i].includes("|") && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]);
}

function startsBlock(lines: string[], i: number): boolean {
	const line = lines[i];
	return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || ITEM.test(line) || QUOTE.test(line) || isTable(lines, i);
}

function blocks(lines: string[], parent: HTMLElement) {
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (line.trim() === "") {
			i++;
			continue;
		}
		const fence = FENCE.exec(line);
		if (fence) {
			// An unclosed fence runs to the end, which is what a streaming answer looks like mid-block.
			const close = new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}\\s*$`);
			const body: string[] = [];
			for (i++; i < lines.length && !close.test(lines[i]); i++) body.push(lines[i]);
			i++;
			const pre = el("pre");
			const code = el("code", undefined, body.join("\n"));
			if (fence[2]) code.dataset.lang = fence[2];
			pre.append(code);
			parent.append(pre);
			continue;
		}
		const heading = HEADING.exec(line);
		if (heading) {
			const level = heading[1].length;
			const h = el(level <= 2 ? "h3" : level === 3 ? "h4" : "h5");
			inline(heading[2], h);
			parent.append(h);
			i++;
			continue;
		}
		if (RULE.test(line)) {
			parent.append(el("hr"));
			i++;
			continue;
		}
		if (QUOTE.test(line)) {
			const body: string[] = [];
			for (; i < lines.length && lines[i].trim() !== "" && QUOTE.test(lines[i]); i++) body.push(QUOTE.exec(lines[i])![1]);
			const quote = el("blockquote");
			blocks(body, quote);
			parent.append(quote);
			continue;
		}
		if (isTable(lines, i)) {
			const align = cells(lines[i + 1]).map((c) => (c.endsWith(":") ? (c.startsWith(":") ? "center" : "right") : ""));
			const table = el("table");
			const head = table.createTHead().insertRow();
			for (const [n, text] of cells(line).entries()) {
				const th = el("th");
				if (align[n]) th.style.textAlign = align[n];
				inline(text, th);
				head.append(th);
			}
			const body = table.createTBody();
			for (i += 2; i < lines.length && lines[i].includes("|") && lines[i].trim() !== ""; i++) {
				const row = body.insertRow();
				for (const [n, text] of cells(lines[i]).entries()) {
					const td = row.insertCell();
					if (align[n]) td.style.textAlign = align[n];
					inline(text, td);
				}
			}
			const wrap = el("div", "table");
			wrap.append(table);
			parent.append(wrap);
			continue;
		}
		const item = ITEM.exec(line);
		if (item) {
			i = list(lines, i, item[1].length, parent);
			continue;
		}
		// Line breaks inside a paragraph are kept: answers use them on purpose.
		const paragraph = el("p");
		for (let first = true; i < lines.length && lines[i].trim() !== "" && (first || !startsBlock(lines, i)); i++, first = false) {
			if (!first) paragraph.append(el("br"));
			inline(lines[i].trim(), paragraph);
		}
		parent.append(paragraph);
	}
}

/** A list at `indent`; lines indented further belong to the item above them. Returns the next line. */
function list(lines: string[], i: number, indent: number, parent: HTMLElement): number {
	const first = ITEM.exec(lines[i])!;
	const ordered = /\d/.test(first[2]);
	const node = el(ordered ? "ol" : "ul");
	if (ordered && parseInt(first[2]) !== 1) (node as HTMLOListElement).start = parseInt(first[2]);
	while (i < lines.length) {
		const item = ITEM.exec(lines[i]);
		if (!item || item[1].length !== indent || /\d/.test(item[2]) !== ordered) break;
		const body = [item[3]];
		let loose = false;
		for (i++; i < lines.length; i++) {
			const line = lines[i];
			const leading = line.length - line.trimStart().length;
			if (line.trim() === "") {
				// A blank line ends the item; the list goes on if the next text is another item or indented under this one.
				const next = lines.slice(i + 1).find((l) => l.trim() !== "");
				if (next === undefined || next.length - next.trimStart().length <= indent) break;
				body.push("");
				loose = true;
			} else if (leading > indent) body.push(line.slice(Math.min(leading, indent + 2)));
			else if (ITEM.test(line) || startsBlock(lines, i)) break;
			else body.push(line.trim());
		}
		const li = el("li");
		if (body.length === 1) inline(body[0], li);
		else {
			blocks(body, li);
			// A tight item's first paragraph sits inline, so the bullet lines up with its text.
			const lead = li.firstElementChild;
			if (!loose && lead?.tagName === "P") lead.replaceWith(...lead.childNodes);
		}
		node.append(li);
		if (lines[i]?.trim() === "") {
			let next = i;
			while (next < lines.length && lines[next].trim() === "") next++;
			const following = next < lines.length ? ITEM.exec(lines[next]) : null;
			if (following && following[1].length === indent) i = next;
		}
	}
	parent.append(node);
	return i;
}

/** Rendered answers by key, so a re-render while text streams in only re-parses the block that changed. */
let rendered = new Map<string, { text: string; node: HTMLElement }>();
let nextRendered = new Map<string, { text: string; node: HTMLElement }>();

function answer(key: string, text: string): HTMLElement {
	const cached = rendered.get(key);
	const node = cached !== undefined && cached.text === text ? cached.node : markdown(text);
	nextRendered.set(key, { text, node });
	return node;
}

// --- the log ----------------------------------------------------------------------------------
// Everything on screen is a row: the time on the first row of an exchange, a label saying what kind of
// line it is, and the body. Command output lives here too, between the entries it followed.

function row(kind: string, label: string, ...body: (Node | string)[]): HTMLElement {
	const node = el("div", `row ${kind}`);
	const b = el("div", "b");
	b.append(...body);
	node.append(el("span", "t"), el("span", "k", label), b);
	return node;
}

function fold(key: string, summary: HTMLElement[], sections: [string | undefined, string][]): HTMLDetailsElement {
	const details = el("details");
	details.open = opened.has(key);
	const head = el("summary");
	head.append(...summary);
	details.append(head);
	// The body is built on first open; most folds are never opened.
	const fill = () => {
		if (!details.open || details.childElementCount > 1) return;
		const body = el("div", "fold");
		for (const [label, text] of sections) {
			if (label) body.append(el("div", "label", label));
			body.append(el("pre", undefined, text));
		}
		details.append(body);
	};
	details.addEventListener("toggle", () => {
		if (details.open) opened.add(key);
		else opened.delete(key);
		fill();
	});
	fill();
	return details;
}

function lastLines(text: string, count: number): string {
	return text.replace(/\s+$/, "").split("\n").slice(-count).join("\n");
}

function renderBlocks(blocks: Block[], key: string, results: Map<string, Extract<Message, { role: "toolResult" }>>, out: HTMLElement[]) {
	blocks.forEach((block, index) => {
		if (block.type === "text" && block.text.trim() !== "") {
			const line = row("gaidin", "gaidin", answer(`${key}:${index}`, block.text));
			line.lastElementChild!.classList.add("prose");
			out.push(line);
		} else if (block.type === "thinking") {
			// A model with thinking off can still send an empty block.
			if (!block.redacted && block.thinking.trim() === "") return;
			const preview = block.redacted ? "redacted" : block.thinking.replace(/\s+/g, " ").trim();
			out.push(row("think", "think", fold(`${key}:${index}`, [el("span", "args", preview)], [[undefined, block.redacted ? "Redacted by the provider." : block.thinking]])));
		} else if (block.type === "toolCall") {
			const result = results.get(block.id);
			const slot = state.slots.get(block.id);
			const status = result ? (result.isError ? "error" : "done") : slot ? "running" : state.running ? "waiting" : "no result";
			const output = result ? textOf(result.content) : slot?.output ?? "";
			const args = block.arguments ?? {};
			const sections: [string | undefined, string][] = [["input", block.name === "bash" && typeof args.command === "string" ? args.command : JSON.stringify(args, null, 2)]];
			if (result || slot) sections.push(["output", output || "(no output)"]);
			const details = fold(block.id, [el("span", "name", block.name), el("span", "args", argsSummary(block.name, args)), el("span", "state", status)], sections);
			const line = row(`tool s-${status.replace(" ", "-")}`, "tool", details);
			// A running tool shows the end of its output without being opened.
			if (status === "running" && output.trim() !== "" && !details.open) line.lastElementChild!.append(el("pre", "tail", lastLines(output, 6)));
			out.push(line);
		}
	});
}

/** Command output and errors, kept on screen until the page reloads or /clear. */
const local: { after: number; row: HTMLElement }[] = [];
let stick = false;

function lastEntryId(): number {
	let last = 0;
	for (const id of state.entries.keys()) if (id > last) last = id;
	return last;
}

function say(kind: "sys" | "err" | "cmd", ...body: (Node | string)[]) {
	const line = row(kind, kind === "err" ? "error" : kind === "cmd" ? "you" : "sys", ...body);
	const previous = local.at(-1)?.row;
	if (kind === "err" && previous?.classList.contains("err") && previous.textContent === line.textContent) return;
	local.push({ after: lastEntryId(), row: line });
	stick = true;
	schedule();
}

let lastHeight = 0;

function render() {
	renderStatusline();
	const asks = approvals.filter((a) => a.kind === "question").length;
	const allows = approvals.length - asks;
	document.title = asks > 0 ? `(${asks}) question · gaidin` : allows > 0 ? `(${allows}) approval · gaidin` : state.running ? "working · gaidin" : "gaidin";

	const scroller = $("scroll");
	const atBottom = stick || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;

	const entries = [...state.entries.values()].sort((a, b) => a.id - b.id);
	const results = new Map<string, Extract<Message, { role: "toolResult" }>>();
	for (const entry of entries) for (const m of entry.model ?? []) if (m.role === "toolResult") results.set(m.toolCallId, m);

	const rows: HTMLElement[] = [];
	let shown = 0;
	const flush = (upTo: number) => {
		while (shown < local.length && local[shown].after <= upTo) rows.push(local[shown++].row);
	};
	for (const entry of entries) {
		const out: HTMLElement[] = [];
		let starts = false;
		let time: string | undefined;
		if (entry.kind === "gaidin.reminder-fired") {
			const data = entry.data ?? {};
			starts = true;
			const line = row("remind", "remind", String(data.text ?? ""));
			if (!data.delivered) line.lastElementChild!.append(el("span", "why", `push failed: ${data.error}`));
			if (typeof data.taskId === "number") line.lastElementChild!.append(snoozeButtons(data.taskId));
			out.push(line);
		}
		if (entry.kind === "gaidin.job-reported") {
			const data = entry.data ?? {};
			starts = true;
			const line = row("job", "job", String(data.title ?? ""));
			if (!data.delivered) line.lastElementChild!.append(el("span", "why", `not delivered: ${data.error}`));
			const report = row("gaidin", "gaidin", answer(`${entry.id}:report`, String(data.text ?? "")));
			report.lastElementChild!.classList.add("prose");
			out.push(line, report);
		}
		for (const message of entry.model ?? []) {
			if (message.role === "user") {
				const split = splitStamp(textOf(message.content));
				if (entry.kind === "pi.user") {
					starts = true;
					time = split.time;
					out.push(row("you", "you", split.text));
				} else out.push(row("sys", "note", `${entry.kind}: ${split.text}`));
			} else if (message.role === "assistant") {
				renderBlocks(message.content, String(entry.id), results, out);
				if (message.stopReason === "error") out.push(row("err", "error", message.errorMessage ?? "The model returned an error."));
				if (message.stopReason === "aborted") out.push(row("sys", "sys", "Stopped."));
			}
		}
		if (out.length > 0) {
			if (starts) {
				out[0].classList.add("start");
				if (time) {
					const stamp = out[0].firstElementChild as HTMLElement;
					stamp.textContent = shortStamp(time);
					stamp.title = time;
				}
			}
			rows.push(...out);
		}
		flush(entry.id);
	}
	if (state.partial !== undefined) renderBlocks(state.partial.content, "partial", results, rows);
	flush(Infinity);
	if (rows.length === 0) rows.push(row("sys", "gaidin", "No messages yet. Type below, or / for commands."));

	$("log").replaceChildren(...rows);
	rendered = nextRendered;
	nextRendered = new Map();

	if (atBottom) scroller.scrollTop = scroller.scrollHeight;
	else if (scroller.scrollHeight > lastHeight) $("jump").hidden = false;
	lastHeight = scroller.scrollHeight;
	stick = false;
}

// --- status line ------------------------------------------------------------------------------

let current: Settings | undefined;
let statusSignature = "";

function segment(label: string, title: string, action: () => void, className = ""): HTMLButtonElement {
	const button = el("button", `plain seg ${className}`, label);
	button.type = "button";
	button.title = title;
	button.addEventListener("click", action);
	return button;
}

function renderStatusline() {
	let label = "idle";
	let tone = "";
	if (!state.connected) [label, tone] = ["reconnecting", "problem"];
	else if (state.retry) [label, tone] = [state.retry, "problem"];
	else if (state.running) [label, tone] = ["working", "running"];
	const here = state.usage
		? [...Object.values(state.usage.models), ...Object.values(state.usage.tools)].reduce((sum, u) => sum + (u.cost?.total ?? 0), 0)
		: undefined;
	const budget = state.budget;
	// Today's spend against the daily limit when there's a budget; otherwise the totals.
	const total = budget
		? [budget.dailyLimit > 0 ? `${money(budget.today)} of ${money(budget.dailyLimit)} today` : `${money(budget.today)} today`, budget.monthlyLimit > 0 ? `${money(budget.month)} of ${money(budget.monthlyLimit)} month` : ""]
		: [state.allSpend === undefined ? "" : `${money(state.allSpend)} all`];
	const spend = [here === undefined ? "" : `${money(here)} conversation`, ...total].filter(Boolean).join(" · ");
	const near = budget !== null && budget !== undefined && !budget.stopped && budget.dailyLimit > 0 && budget.today >= budget.dailyLimit * 0.8;
	const signature = JSON.stringify([label, tone, spend, current, budget?.stopped, near]);
	// Rebuilt only when something in it changed, so a button under the pointer stays put while text streams.
	if (signature === statusSignature) return;
	statusSignature = signature;

	const segs: HTMLElement[] = [el("span", `status ${tone}`, label)];
	if (state.running) segs.push(segment("esc stop", "Stop the run (Esc or Ctrl+C)", () => void stop(), "danger"));
	if (current) {
		const settings = current;
		segs.push(segment(settings.model, "Switch the model (/model)", () => prefill("/model ")));
		segs.push(segment(`thinking ${settings.thinkingLevel}`, "Change the thinking level (/thinking)", () => prefill("/thinking ")));
		const off = settings.tools.filter((t) => !t.enabled).map((t) => t.name);
		segs.push(segment(off.length === 0 ? `tools ${settings.tools.length}/${settings.tools.length}` : `${off.join(" ")} off`, "Switch tools on and off (/tools)", () => void runCommand("/tools")));
		if (settings.instructions !== "") segs.push(segment("instructions", "Standing instructions (/instructions)", () => void runCommand("/instructions")));
	}
	if (budget?.stopped) segs.push(segment("stopped · allow more", budget.reason ?? "The spend limit is reached (/budget)", () => void allowMore(), "danger"));
	if (spend !== "") {
		const line = el("span", `spend${budget?.stopped ? " stopped" : near ? " near" : ""}`, spend);
		if (budget?.reason) line.title = budget.reason;
		segs.push(line);
	}
	segs.push(el("span", "spacer"), segment("/ commands", "Show the commands", () => prefill("/"), "hint"));
	$("statusline").replaceChildren(...segs);
}

// --- horizon ----------------------------------------------------------------------------------
// The next 24 hours as a line: reminders as dots, scheduled job runs as diamonds.

const HORIZON = 24 * 3_600_000;
let reminders: Reminder[] = [];
let jobs: Job[] = [];

type Upcoming = { ref: string; kind: "reminder" | "job"; text: string; at?: number; detail: string; paused?: boolean };

function upcoming(): Upcoming[] {
	return [
		...reminders.map((r): Upcoming => ({ ref: `r${r.taskId}`, kind: "reminder", text: r.text, at: r.at, detail: "reminder" })),
		...jobs.map((j): Upcoming => ({
			ref: `j${j.taskId}`,
			kind: "job",
			text: j.title,
			// A paused job's runs are skipped, so it has no next run to show.
			at: j.paused === undefined ? j.nextAt : undefined,
			detail: `${j.mode === "watch" ? "watch, " : ""}${j.when}${j.gate === undefined ? "" : `, gated by ${j.gate.name}`}${j.paused === undefined ? "" : `, paused: ${j.paused.reason}`}`,
			paused: j.paused !== undefined,
		})),
	].sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity));
}

function renderHorizon() {
	const now = Date.now();
	const items = upcoming();
	const track = $("track");
	const nodes: HTMLElement[] = [el("span", "now")];
	const tick = new Date(now);
	tick.setMinutes(0, 0, 0);
	do tick.setHours(tick.getHours() + 1);
	while (tick.getHours() % 3 !== 0);
	for (; tick.getTime() < now + HORIZON; tick.setHours(tick.getHours() + 3)) {
		const mark = el("span", `tick${tick.getHours() % 6 === 0 ? "" : " minor"}`, clock.format(tick));
		mark.style.left = `${((tick.getTime() - now) / HORIZON) * 100}%`;
		nodes.push(mark);
	}
	const soon = items.filter((i) => i.at !== undefined && i.at < now + HORIZON);
	for (const item of soon) {
		const marker = el("button", `marker ${item.kind}`);
		marker.type = "button";
		marker.style.left = `${Math.max(0, ((item.at! - now) / HORIZON) * 100)}%`;
		const label = `${item.text} · ${clock.format(item.at!)} · ${fromNow(item.at!)}`;
		marker.setAttribute("aria-label", label);
		marker.append(el("span", "tip", label));
		marker.addEventListener("click", () => void runCommand("/next"));
		nodes.push(marker);
	}
	if (items.length === 0) nodes.push(el("span", "empty", "nothing scheduled"));
	track.replaceChildren(...nodes);

	const later = items.length - soon.length;
	const laterButton = $("later") as HTMLButtonElement;
	laterButton.hidden = later === 0;
	laterButton.textContent = `+${later} later`;

	const next = items[0];
	const nextUp = $("next-up");
	const text = el("span");
	if (next?.at === undefined) text.textContent = items.length === 0 ? "nothing coming up" : `next: ${next.text}`;
	else {
		text.textContent = `next: ${next.text} · ${fromNow(next.at)}`;
		if (next.at - now < 3_600_000) text.className = "soon";
	}
	nextUp.replaceChildren(text);
}

// --- requests ---------------------------------------------------------------------------------

function notice(text: string) {
	if (text !== "") say("err", text);
}

async function post(path: string, body: unknown): Promise<any> {
	const response = await fetch(path, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!response.ok) throw new Error(`${path}: ${await response.text()}`);
	return response.json();
}

async function load<T>(path: string): Promise<T> {
	const response = await fetch(path);
	if (!response.ok) throw new Error(`${path}: ${await response.text()}`);
	return response.json() as Promise<T>;
}

async function loadSpend() {
	try {
		const usage = await load<UsageState>("/api/usage");
		state.allSpend = [...Object.values(usage.models), ...Object.values(usage.tools)].reduce((s, u) => s + (u.cost?.total ?? 0), 0);
		state.budget = await load<Budget | null>("/api/budget");
		schedule();
	} catch (error) {
		notice(String(error));
	}
}

/** Buttons that set a fired reminder again, as its push and its Slack message do. */
function snoozeButtons(id: number): HTMLElement {
	const buttons = el("span", "snooze");
	for (const [label, minutes] of [["snooze 10 min", 10], ["1 h", 60]] as const) {
		const button = el("button", "plain", label);
		button.type = "button";
		button.addEventListener("click", async () => {
			try {
				const { at } = (await post("/api/reminders/snooze", { id, minutes })) as { at: number };
				say("sys", `Snoozed until ${when.format(at)}.`);
				void loadReminders();
			} catch (error) {
				notice(String(error));
			}
		});
		buttons.append(button);
	}
	return buttons;
}

async function loadReminders() {
	try {
		reminders = await load<Reminder[]>("/api/reminders");
		renderHorizon();
	} catch (error) {
		notice(String(error));
	}
}

async function loadJobs() {
	try {
		jobs = await load<Job[]>("/api/jobs");
		renderHorizon();
	} catch (error) {
		notice(String(error));
	}
}

async function loadSettings() {
	try {
		current = await load<Settings>("/api/settings");
		schedule();
	} catch (error) {
		notice(String(error));
	}
}

/** Saves the settings with `change` applied; the server wants all of them every time. */
async function configure(change: { model?: string; thinkingLevel?: string; instructions?: string; disabledTools?: string[] }) {
	const settings = current ?? (await load<Settings>("/api/settings"));
	current = await post("/api/settings", {
		model: settings.model,
		thinkingLevel: settings.thinkingLevel,
		instructions: settings.instructions,
		disabledTools: settings.tools.filter((t) => !t.enabled).map((t) => t.name),
		...change,
	});
	schedule();
}

// --- approvals --------------------------------------------------------------------------------
// A request for approval docks above the prompt, like sudo asking first. ⌥Y, ⌥A and ⌥N answer the oldest.

let approvals: Approval[] = [];
const alt = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌥" : "Alt+";

async function loadApprovals() {
	try {
		approvals = await load<Approval[]>("/api/approvals");
		renderApprovals();
		schedule();
	} catch (error) {
		notice(String(error));
	}
}

/** The oldest request to allow a call; questions are answered, not allowed. */
function firstApproval(): Approval | undefined {
	return approvals.find((a) => a.kind !== "question");
}

/** A question from ask_owner: a button per choice, or type the answer at the prompt. */
function questionRow(request: Approval): HTMLElement {
	const ask = el("div", "ask");
	ask.append(el("span", "what", request.summary));
	const buttons = el("div", "buttons");
	for (const choice of request.choices ?? []) {
		const button = el("button", "", choice);
		button.type = "button";
		button.addEventListener("click", () => void answerQuestion(request, choice));
		buttons.append(button);
	}
	buttons.append(el("span", "expires", `type your answer below · waits until ${when.format(request.expiresAt)}`));
	const b = el("div", "b");
	b.append(ask, buttons);
	const node = el("div", "row approval question");
	node.append(el("span", "t", clock.format(Date.now())), el("span", "k", "asks?"), b);
	return node;
}

async function answerQuestion(request: Approval, answer: string) {
	for (const b of $("approvals").querySelectorAll("button")) b.disabled = true;
	try {
		await post("/api/approvals/answer", { id: request.id, answer });
	} catch (error) {
		notice(String(error));
	}
	await loadApprovals();
}

function renderApprovals() {
	const first = firstApproval();
	$("approvals").replaceChildren(
		...approvals.map((request) => {
			if (request.kind === "question") return questionRow(request);
			const ask = el("div", "ask");
			ask.append(el("span", "tool", request.tool), " ", el("span", "what", request.summary));
			if (request.detail !== undefined) {
				const detail = el("details", "detail");
				detail.append(el("summary", undefined, "all of it"), el("pre", undefined, request.detail));
				ask.append(detail);
			}
			const buttons = el("div", "buttons");
			const choices: [Decision, string, string, string][] = [["once", "Allow once", "primary", "Y"]];
			if (request.always !== undefined) choices.push(["always", request.always.label, "", "A"]);
			choices.push(["deny", "Deny", "danger", "N"]);
			for (const [decision, label, className, letter] of choices) {
				const button = el("button", className, label);
				button.type = "button";
				if (request === first) button.append(el("kbd", undefined, `${alt}${letter}`));
				button.addEventListener("click", () => void decide(decision, request));
				buttons.append(button);
			}
			buttons.append(el("span", "expires", `waits until ${clock.format(request.expiresAt)}`));
			const b = el("div", "b");
			b.append(ask, buttons);
			const node = el("div", "row approval");
			node.append(el("span", "t", clock.format(Date.now())), el("span", "k", "allow?"), b);
			return node;
		}),
	);
}

type Decision = "once" | "always" | "deny";

async function decide(decision: Decision, request = firstApproval()) {
	if (request === undefined) return say("sys", "Nothing is waiting for approval.");
	if (decision === "always" && request.always === undefined) return say("err", `${request.tool} has no "always" choice.`);
	for (const b of $("approvals").querySelectorAll("button")) b.disabled = true;
	try {
		await post("/api/approvals/decide", { id: request.id, decision });
	} catch (error) {
		notice(String(error));
	}
	await loadApprovals();
}

// --- commands ---------------------------------------------------------------------------------

type Choice = { value: string; hint?: string };
type Command = { name: string; args?: string; help: string; run: (arg: string) => unknown; complete?: () => Choice[] };

const LEVELS = ["off", "low", "medium", "high"];

async function stop(echo?: string) {
	if (echo) say("cmd", echo);
	if (!state.running) return say("sys", "Nothing is running.");
	try {
		await post("/api/abort", {});
	} catch (error) {
		notice(String(error));
	}
}

async function cancel(ref: string) {
	const match = /^([rj])(\d+)$/.exec(ref);
	if (!match) throw new Error(`Give a reference from /next, like r12 or j3, not "${ref}".`);
	const [, kind, id] = match;
	const path = kind === "r" ? "/api/reminders/cancel" : "/api/jobs/cancel";
	const { ok } = await post(path, { id: Number(id) });
	await (kind === "r" ? loadReminders() : loadJobs());
	say(ok ? "sys" : "err", ok ? `Cancelled ${kind === "r" ? "reminder" : "job"} ${id}.` : `No open ${kind === "r" ? "reminder" : "job"} ${id}.`);
}

async function pause(ref: string, paused: boolean) {
	const match = /^j(\d+)$/.exec(ref);
	if (!match) throw new Error(`Give a job's reference from /next, like j3, not "${ref}".`);
	const { ok } = await post(paused ? "/api/jobs/pause" : "/api/jobs/resume", { id: Number(match[1]) });
	await loadJobs();
	say(ok ? "sys" : "err", ok ? `${paused ? "Paused" : "Resumed"} job ${match[1]}.` : `No ${paused ? "running" : "paused"} job ${match[1]}.`);
}

function showUpcoming() {
	const items = upcoming();
	if (items.length === 0) return say("sys", "Nothing coming up. Ask gaidin for a reminder or a scheduled job.");
	const out = el("div", "out");
	for (const item of items) {
		const actions = el("span", "actions");
		const button = (label: string, run: () => Promise<void>) => {
			const b = el("button", "plain", label);
			b.type = "button";
			b.addEventListener("click", () => void run().catch((error) => notice(String(error))));
			actions.append(b);
		};
		if (item.kind === "job") button(item.paused ? "resume" : "pause", () => pause(item.ref, !item.paused));
		button("cancel", () => cancel(item.ref));
		out.append(
			el("span", "dim", item.ref),
			el("span", "when", item.at !== undefined ? `${when.format(item.at)} · ${fromNow(item.at)}` : item.paused ? "paused" : "no next run"),
			el("span", undefined, `${item.text}${item.kind === "job" ? ` (${item.detail})` : ""}`),
			actions,
		);
	}
	say("sys", out);
}

async function showTools() {
	const settings = current ?? (await load<Settings>("/api/settings"));
	const out = el("div", "out");
	for (const tool of settings.tools) {
		const button = el("button", "plain", tool.enabled ? "turn off" : "turn on");
		button.type = "button";
		button.addEventListener("click", () => void runCommand(`/tool ${tool.name} ${tool.enabled ? "off" : "on"}`));
		out.append(el("span", tool.enabled ? "on" : "off", tool.enabled ? "on" : "off"), el("span", undefined, tool.name), el("span"), button);
	}
	say("sys", out);
}

async function showMemory() {
	const notes = await load<Note[]>("/api/memory");
	if (notes.length === 0) return say("sys", "gaidin has no notes yet. /remember adds one, or tell gaidin something worth keeping.");
	const out = el("div", "out");
	for (const note of notes) {
		const button = el("button", "plain", "forget");
		button.type = "button";
		button.addEventListener("click", () => void runCommand(`/forget ${note.id}`));
		out.append(el("span", "dim", String(note.id)), el("span", "when", note.by === "owner" ? "you" : "gaidin"), el("span", undefined, note.text), button);
	}
	say("sys", out);
}

// --- notifications ------------------------------------------------------------------------------
// Web Push to this device (push.ts on the server, sw.js here): reminders, job reports, and what gaidin is waiting on.

type PushInfo = { publicKey: string; devices: { endpoint: string; label: string; addedAt: number }[] };

/** What kind of device this is, to tell the signed-up ones apart. */
function deviceLabel(): string {
	const ua = navigator.userAgent;
	return /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : "Linux";
}

async function turnOnHere(publicKey: string) {
	// Asked before anything else, while the tap still counts: iOS allows the request only in answer to one.
	if ((await Notification.requestPermission()) !== "granted") return say("err", "Notifications aren't allowed for gaidin here. Allow them in the device's settings, then try again.");
	const key = Uint8Array.from(atob(publicKey.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
	const subscription = await (await navigator.serviceWorker.ready).pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
	const { endpoint, keys } = subscription.toJSON();
	await post("/api/push/subscribe", { endpoint, keys, label: deviceLabel() });
	say("sys", "Notifications are on for this device.");
	await showNotifications();
}

async function removeDevice(endpoint: string) {
	const mine = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
	await post("/api/push/unsubscribe", { endpoint });
	if (mine?.endpoint === endpoint) await mine.unsubscribe();
	say("sys", mine?.endpoint === endpoint ? "Notifications are off for this device." : "That device won't get notifications any more.");
	await showNotifications();
}

async function showNotifications() {
	const info = await load<PushInfo | null>("/api/push");
	if (info === null) return say("sys", "Notifications need web.url in gaidin's settings.");
	if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
		return say("sys", /iPhone|iPad/.test(navigator.userAgent)
			? "On an iPhone or iPad, add gaidin to the Home Screen (Share, then Add to Home Screen) and open it from there to turn notifications on."
			: "This browser can't get notifications.");
	}
	const mine = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
	const button = (label: string, run: () => Promise<void>) => {
		const b = el("button", "plain", label);
		b.type = "button";
		b.addEventListener("click", () => void run().catch((error) => notice(String(error))));
		return b;
	};
	const out = el("div", "out");
	for (const device of info.devices) {
		const here = device.endpoint === mine?.endpoint;
		out.append(el("span", "dim", here ? "here" : ""), el("span", "when", `since ${when.format(device.addedAt)}`), el("span", undefined, device.label), button("remove", () => removeDevice(device.endpoint)));
	}
	const actions = el("div", "actions");
	if (!info.devices.some((d) => d.endpoint === mine?.endpoint)) actions.append(button("turn on here", () => turnOnHere(info.publicKey)));
	if (info.devices.length > 0) {
		actions.append(button("send a test", async () => {
			const { sent } = await post("/api/push/test", {});
			say("sys", `Sent to ${sent} device${sent === 1 ? "" : "s"}.`);
		}));
	}
	say("sys", info.devices.length === 0 ? "No device gets notifications yet." : out, actions);
}

type Activity = { entry: number; at: number; place: string; kind: string; name: string; detail: string; outcome: string };
type Cursor = { entry: number; ref: string };

const GOOD = /^(ok|allowed once|always allowed|answered|reported|pushed)\b/;
const BAD = /^(denied|blocked|expired|not delivered|push failed)\b/;

/** What gaidin did, 50 at a time, newest first, with who allowed it. */
async function showTimeline(cursor?: Cursor) {
	const page = await load<{ items: Activity[]; next?: Cursor }>(cursor === undefined ? "/api/timeline" : `/api/timeline?entry=${cursor.entry}&ref=${encodeURIComponent(cursor.ref)}`);
	if (page.items.length === 0) return say("sys", cursor === undefined ? "Nothing on the timeline yet." : "Nothing older.");
	const out = el("div", "out timeline");
	for (const item of page.items) {
		const label = item.kind === "tool" ? item.name : item.kind === "approval" ? `allow ${item.name}?` : item.kind === "job" ? "job" : "reminder";
		const what = item.kind === "tool" ? argsSummary(item.name, JSON.parse(item.detail) as Record<string, unknown>) : item.kind === "job" ? item.name : item.detail;
		const detail = el("span", undefined, what);
		if (item.place !== "main") detail.append(el("span", "dim", ` · ${item.place === "thread" ? "thread" : "job run"}`));
		const outcome = item.outcome || "running";
		out.append(
			el("span", "dim", item.at > 0 ? when.format(item.at) : ""),
			el("span", "when", label),
			detail,
			el("span", GOOD.test(outcome) ? "on" : BAD.test(outcome) || item.kind === "tool" && outcome !== "running" ? "off" : "dim", outcome),
		);
	}
	say("sys", out);
	if (page.next !== undefined) {
		const next = page.next;
		const button = el("button", "plain", "older");
		button.type = "button";
		button.addEventListener("click", () => {
			button.disabled = true;
			void showTimeline(next);
		}, { once: true });
		say("sys", button);
	}
}

async function allowMore() {
	try {
		state.budget = await post("/api/budget/allow", {});
		say("sys", `Allowed more today: the daily limit is now ${money(state.budget!.dailyLimit)}.`);
	} catch (error) {
		notice(String(error));
	}
}

function showBudget() {
	const budget = state.budget;
	if (!budget) return say("sys", "No spend information yet.");
	const daily = budget.dailyLimit > 0 ? `${money(budget.today)} of ${money(budget.dailyLimit)} today` : `${money(budget.today)} today, no daily limit`;
	const monthly = budget.monthlyLimit > 0 ? `${money(budget.month)} of ${money(budget.monthlyLimit)} this month` : `${money(budget.month)} this month, no monthly limit`;
	const body = el("div");
	body.append(`${daily} · ${monthly}`);
	if (budget.stopped) {
		const button = el("button", "danger", "allow more today");
		button.type = "button";
		button.addEventListener("click", () => void allowMore());
		body.append(el("div", "why", budget.reason ?? "Stopped at the limit."), button);
	}
	say(budget.stopped ? "err" : "sys", body);
}

function showHelp() {
	const help = el("div", "help");
	for (const c of commands) help.append(el("span", "c", `/${c.name}`), el("span", "a", c.args ?? ""), el("span", "h", c.help));
	const keys = el("div", "keys", `Enter sends · Shift+Enter new line · ↑ ↓ history · Tab completes · Esc or Ctrl+C stops a run · ${alt}Y ${alt}A ${alt}N answer an approval · start with // to send a message beginning with /`);
	const body = el("div");
	body.append(help, keys);
	say("sys", body);
}

const commands: Command[] = [
	{ name: "help", help: "Commands and keys", run: showHelp },
	{ name: "next", help: "Upcoming reminders and scheduled jobs", run: showUpcoming },
	{
		name: "cancel",
		args: "<ref>",
		help: "Cancel a reminder or job by its /next reference",
		complete: () => upcoming().map((i) => ({ value: i.ref, hint: `${i.text}${i.at === undefined ? "" : ` · ${fromNow(i.at)}`}` })),
		run: (arg) => cancel(arg),
	},
	{
		name: "pause",
		args: "<ref>",
		help: "Pause a job: its runs are skipped until you resume it",
		complete: () => upcoming().filter((i) => i.kind === "job" && !i.paused).map((i) => ({ value: i.ref, hint: i.text })),
		run: (arg) => pause(arg, true),
	},
	{
		name: "resume",
		args: "<ref>",
		help: "Resume a paused job from its next scheduled run",
		complete: () => upcoming().filter((i) => i.paused).map((i) => ({ value: i.ref, hint: i.text })),
		run: (arg) => pause(arg, false),
	},
	{ name: "stop", help: "Stop the current run (Esc, Ctrl+C)", run: () => stop() },
	{
		name: "model",
		args: "[id]",
		help: "Show or switch the model",
		complete: () => (current?.models ?? []).map((m) => ({ value: m, hint: m === current?.model ? "current" : undefined })),
		run: async (arg) => {
			if (arg === "") return say("sys", `Model ${current?.model ?? "unknown"}. Choices: ${current?.models.join(", ") ?? "none"}.`);
			await configure({ model: arg });
			say("sys", `Model set to ${arg}. Applies from the next request.`);
		},
	},
	{
		name: "thinking",
		args: "[level]",
		help: "Show or set the thinking level",
		complete: () => LEVELS.map((l) => ({ value: l, hint: l === current?.thinkingLevel ? "current" : undefined })),
		run: async (arg) => {
			if (arg === "") return say("sys", `Thinking ${current?.thinkingLevel ?? "unknown"}. Levels: ${LEVELS.join(", ")}.`);
			await configure({ thinkingLevel: arg });
			say("sys", `Thinking set to ${arg}. Applies from the next request.`);
		},
	},
	{ name: "tools", help: "The tools you can switch off", run: showTools },
	{ name: "memory", help: "gaidin's notes, which every conversation sees", run: showMemory },
	{ name: "timeline", help: "What gaidin did and who allowed it, newest first", run: () => showTimeline() },
	{ name: "notifications", help: "Turn notifications on or off for this device, and see the others", run: showNotifications },
	{
		name: "remember",
		args: "<text>",
		help: "Add a note to gaidin's memory",
		run: async (arg) => {
			if (arg === "") throw new Error("Give the note's text: /remember the NAS is in the hall closet");
			const note = await post("/api/memory/add", { text: arg });
			say("sys", `Noted [${note.id}]: ${note.text}`);
		},
	},
	{
		name: "forget",
		args: "<id>",
		help: "Delete a note by its /memory number",
		run: async (arg) => {
			const id = Number(arg);
			if (!Number.isInteger(id)) throw new Error("Give a note number from /memory, like /forget 3.");
			const { ok } = await post("/api/memory/forget", { id });
			say(ok ? "sys" : "err", ok ? `Forgot note ${id}.` : `No note ${id}.`);
		},
	},
	{ name: "budget", help: "Spend today and this month, against the limits", run: () => loadSpend().then(showBudget) },
	{
		name: "tool",
		args: "<name> [on|off]",
		help: "Switch a tool on or off",
		complete: () => (current?.tools ?? []).map((t) => ({ value: `${t.name} ${t.enabled ? "off" : "on"}`, hint: t.enabled ? "on now" : "off now" })),
		run: async (arg) => {
			const [name, setting] = arg.split(/\s+/);
			const settings = current ?? (await load<Settings>("/api/settings"));
			const tool = settings.tools.find((t) => t.name === name);
			if (!tool) throw new Error(`No switchable tool "${name}". /tools lists them.`);
			const on = setting === undefined ? !tool.enabled : setting === "on";
			const disabled = new Set(settings.tools.filter((t) => !t.enabled).map((t) => t.name));
			if (on) disabled.delete(name);
			else disabled.add(name);
			await configure({ disabledTools: [...disabled] });
			say("sys", `${name} ${on ? "on" : "off"}. Applies from the next request.`);
		},
	},
	{
		name: "instructions",
		args: "[text | clear]",
		help: "Show or replace the standing instructions",
		run: async (arg) => {
			if (arg === "") return say("sys", current?.instructions ? current.instructions : "No standing instructions.");
			await configure({ instructions: arg === "clear" ? "" : arg });
			say("sys", arg === "clear" ? "Standing instructions cleared." : "Standing instructions saved. They apply from the next request.");
		},
	},
	{ name: "allow", help: `Allow the waiting request once (${alt}Y)`, run: () => decide("once") },
	{ name: "always", help: `Allow it from now on, where offered (${alt}A)`, run: () => decide("always") },
	{ name: "deny", help: `Deny the waiting request (${alt}N)`, run: () => decide("deny") },
	{
		name: "clear",
		help: "Clear command output from the screen",
		run: () => {
			local.length = 0;
			schedule();
		},
	},
];

async function runCommand(line: string) {
	say("cmd", line);
	const [, name = "", arg = ""] = /^\/(\S*)\s*([\s\S]*)$/.exec(line) ?? [];
	const command = commands.find((c) => c.name === name);
	if (command === undefined) return say("err", `Unknown command /${name}. /help lists them.`);
	try {
		await command.run(arg.trim());
	} catch (error) {
		say("err", error instanceof Error ? error.message : String(error));
	}
}

// --- completion menu --------------------------------------------------------------------------

type Suggestion = { value: string; label: string; args?: string; hint?: string; run: boolean };
let menuItems: Suggestion[] = [];
let menuIndex = 0;
let dismissed: string | undefined;

function suggestions(text: string): Suggestion[] {
	if (!text.startsWith("/") || text.startsWith("//") || text.includes("\n")) return [];
	const body = text.slice(1);
	const space = body.indexOf(" ");
	if (space < 0) {
		return commands
			.filter((c) => c.name.startsWith(body))
			.map((c) => ({ value: c.args ? `/${c.name} ` : `/${c.name}`, label: `/${c.name}`, args: c.args, hint: c.help, run: c.args === undefined }));
	}
	const name = body.slice(0, space);
	const arg = body.slice(space + 1);
	const command = commands.find((c) => c.name === name);
	if (command?.complete === undefined) return [];
	return command
		.complete()
		.filter((o) => o.value.startsWith(arg) && o.value !== arg)
		.map((o) => ({ value: `/${name} ${o.value}`, label: o.value, hint: o.hint, run: true }));
}

function updateMenu() {
	const text = input.value;
	menuItems = text === dismissed ? [] : suggestions(text);
	menuIndex = Math.min(menuIndex, Math.max(0, menuItems.length - 1));
	const menu = $("menu");
	menu.hidden = menuItems.length === 0;
	menu.replaceChildren(
		...menuItems.map((item, n) => {
			const option = el("div", `item${n === menuIndex ? " active" : ""}`);
			option.id = `menu-${n}`;
			option.setAttribute("role", "option");
			option.setAttribute("aria-selected", String(n === menuIndex));
			const value = el("span", "v", item.label);
			if (item.args) value.append(" ", el("span", "a", item.args));
			option.append(value, el("span", "h", item.hint ?? ""));
			option.addEventListener("mousedown", (e) => e.preventDefault());
			option.addEventListener("click", () => accept(item, true));
			return option;
		}),
	);
	if (menuItems.length > 0) input.setAttribute("aria-activedescendant", `menu-${menuIndex}`);
	else input.removeAttribute("aria-activedescendant");
	$(`menu-${menuIndex}`)?.scrollIntoView({ block: "nearest" });
}

function accept(item: Suggestion, submitIfReady: boolean) {
	input.value = item.value;
	fit();
	menuIndex = 0;
	input.focus();
	input.setSelectionRange(input.value.length, input.value.length);
	if (submitIfReady && item.run) void submit();
	else updateMenu();
}

// --- controls ---------------------------------------------------------------------------------

const input = $("message") as HTMLTextAreaElement;

/** The prompt grows with its text, up to the CSS max-height, keeping the log pinned if it was. */
function fit() {
	const scroller = $("scroll");
	const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;
	input.style.height = "auto";
	input.style.height = `${input.scrollHeight}px`;
	if (atBottom) scroller.scrollTop = scroller.scrollHeight;
}

function prefill(text: string) {
	input.value = text;
	dismissed = undefined;
	fit();
	input.focus();
	input.setSelectionRange(text.length, text.length);
	updateMenu();
}

/** Earlier prompts from the log, then commands typed since the page opened. */
const typed: string[] = [];
let historyList: string[] = [];
let historyAt = -1;
let draft = "";

function history(): string[] {
	const prompts = [...state.entries.values()]
		.sort((a, b) => a.id - b.id)
		.filter((e) => e.kind === "pi.user")
		.flatMap((e) => (e.model ?? []).filter((m) => m.role === "user").map((m) => splitStamp(textOf(m.content as string | Part[])).text));
	return [...prompts, ...typed].filter((text, i, all) => text !== all[i - 1]);
}

function recall(step: number) {
	if (historyAt === -1) {
		historyList = history();
		historyAt = historyList.length;
		draft = input.value;
	}
	historyAt = Math.max(0, Math.min(historyList.length, historyAt + step));
	const text = historyAt === historyList.length ? draft : historyList[historyAt];
	if (historyAt === historyList.length) historyAt = -1;
	input.value = text;
	dismissed = text;
	fit();
	updateMenu();
	input.setSelectionRange(text.length, text.length);
}

/** randomUUID exists only on secure pages (HTTPS or localhost); getRandomValues works on plain http too. */
function requestId(): string {
	if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
	return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function submit() {
	const text = input.value;
	const content = text.trim();
	if (content === "") return;
	historyAt = -1;
	dismissed = undefined;
	input.value = "";
	fit();
	updateMenu();
	if (content.startsWith("/") && !content.startsWith("//")) {
		typed.push(content);
		return runCommand(content);
	}
	stick = true;
	try {
		const sent = await post("/api/message", { content: content.startsWith("//") ? content.slice(1) : content, requestId: requestId() });
		// The server takes a message as the answer when gaidin is waiting on a question.
		if (sent?.answered) say("sys", "Taken as the answer to gaidin's question; the run goes on.");
	} catch (error) {
		// Put the message back so it isn't lost.
		if (input.value === "") {
			input.value = text;
			fit();
		}
		notice(String(error));
	}
}

$("prompt").addEventListener("submit", (e) => {
	e.preventDefault();
	void submit();
});

input.addEventListener("input", () => {
	historyAt = -1;
	dismissed = undefined;
	fit();
	updateMenu();
});

input.addEventListener("keydown", (press) => {
	const { key, shiftKey, isComposing } = press;
	if (isComposing) return;
	if (menuItems.length > 0) {
		const handled = () => {
			press.preventDefault();
			press.stopPropagation();
		};
		if (key === "ArrowDown" || key === "ArrowUp") {
			handled();
			menuIndex = (menuIndex + (key === "ArrowDown" ? 1 : -1) + menuItems.length) % menuItems.length;
			return updateMenu();
		}
		if (key === "Tab") {
			handled();
			return accept(menuItems[menuIndex], false);
		}
		if (key === "Escape") {
			handled();
			dismissed = input.value;
			return updateMenu();
		}
		// Enter takes the highlighted suggestion, unless a whole command is already typed.
		if (key === "Enter" && !shiftKey && !commands.some((c) => input.value === `/${c.name}`)) {
			handled();
			return accept(menuItems[menuIndex], true);
		}
	}
	if (key === "Enter" && !shiftKey) {
		press.preventDefault();
		void submit();
		return;
	}
	const caret = input.selectionStart;
	if (key === "ArrowUp" && input.selectionEnd === caret && !input.value.slice(0, caret).includes("\n")) {
		press.preventDefault();
		recall(-1);
	} else if (key === "ArrowDown" && historyAt !== -1 && input.selectionEnd === caret && !input.value.slice(caret).includes("\n")) {
		press.preventDefault();
		recall(1);
	}
});

const SHORTCUTS = new Map<string, Decision>([["KeyY", "once"], ["KeyA", "always"], ["KeyN", "deny"]]);

document.addEventListener("keydown", (press) => {
	const { key, code, altKey, ctrlKey, metaKey } = press;
	if (altKey && !ctrlKey && !metaKey && firstApproval() !== undefined) {
		const decision = SHORTCUTS.get(code);
		if (decision !== undefined) {
			press.preventDefault();
			void decide(decision);
			return;
		}
	}
	if (key === "Escape" && state.running) {
		press.preventDefault();
		void stop();
		return;
	}
	// Ctrl+C stops a run, as in a terminal, unless there's a selection to copy.
	if (ctrlKey && !metaKey && !altKey && (key === "c" || key === "C")) {
		const selected = (window.getSelection()?.toString() ?? "") !== "" || input.selectionStart !== input.selectionEnd;
		if (selected) return;
		press.preventDefault();
		if (state.running) void stop("^C");
		else if (input.value !== "") prefill("");
		return;
	}
	// Typing anywhere goes to the prompt.
	const target = press.target as HTMLElement;
	const typing = target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
	if (!typing && !ctrlKey && !metaKey && !altKey && key.length === 1) input.focus();
});

const scroller = $("scroll");
scroller.addEventListener("scroll", () => {
	if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48) $("jump").hidden = true;
});
$("jump").addEventListener("click", () => {
	scroller.scrollTop = scroller.scrollHeight;
	$("jump").hidden = true;
});
$("next-up").addEventListener("click", () => void runCommand("/next"));
$("later").addEventListener("click", () => void runCommand("/next"));

// The service worker shows notifications, and a short page when the server can't be reached.
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch((error) => notice(String(error)));
connect();
void loadReminders();
void loadJobs();
void loadSettings();
void loadSpend();
setInterval(() => {
	void loadReminders();
	void loadJobs();
}, 60_000);
input.focus();
