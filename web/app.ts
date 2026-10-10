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
type Approval = { id: string; summary: string; tool: string; expiresAt: number; always?: { kind: string; value: string; label: string } };
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
};
/** Tool calls and thinking blocks Brad has opened, so a re-render keeps them open. */
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

/** Brad's messages start with the local time in brackets; show it apart from the text. */
function splitStamp(text: string): { time?: string; text: string } {
	const match = /^\[([^\]]+)\] /.exec(text);
	return match ? { time: match[1], text: text.slice(match[0].length) } : { text };
}

function argsSummary(name: string, args: Record<string, unknown>): string {
	if (name === "bash" && typeof args.command === "string") return args.command;
	if (typeof args.path === "string") return args.path;
	if (name === "remind") return `${args.text ?? ""} ${args.at ?? (args.inMinutes === undefined ? "" : `in ${args.inMinutes} min`)}`;
	return JSON.stringify(args);
}

function collapsible(key: string, className: string, summary: HTMLElement[], body: string): HTMLDetailsElement {
	const details = el("details", className);
	details.open = opened.has(key);
	details.addEventListener("toggle", () => (details.open ? opened.add(key) : opened.delete(key)));
	const head = el("summary");
	head.append(...summary);
	details.append(head, el("pre", undefined, body));
	return details;
}

function renderBlocks(blocks: Block[], key: string, results: Map<string, Extract<Message, { role: "toolResult" }>>, out: HTMLElement[]) {
	blocks.forEach((block, index) => {
		if (block.type === "text" && block.text.trim() !== "") out.push(el("div", "text", block.text));
		else if (block.type === "thinking") {
			const label = el("span", undefined, block.redacted ? "thinking (redacted)" : "thinking");
			out.push(collapsible(`${key}:${index}`, "thinking", [label], block.redacted ? "" : block.thinking));
		} else if (block.type === "toolCall") {
			const result = results.get(block.id);
			const slot = state.slots.get(block.id);
			const status = result ? (result.isError ? "error" : "done") : slot ? "running" : state.running ? "waiting" : "no result";
			const output = result ? textOf(result.content) : slot?.output ?? "";
			const details = collapsible(block.id, `tool${result?.isError ? " error" : ""}`, [
				el("span", "name", block.name),
				el("span", "args", argsSummary(block.name, block.arguments ?? {})),
				el("span", `state ${status}`, status),
			], output || JSON.stringify(block.arguments, null, 2));
			out.push(details);
		}
	});
}

function render() {
	const status = $("status");
	status.className = "";
	if (!state.connected) {
		status.textContent = "reconnecting";
		status.className = "problem";
	} else if (state.retry) {
		status.textContent = state.retry;
		status.className = "problem";
	} else if (state.running) {
		status.textContent = "working";
		status.className = "running";
	} else status.textContent = "idle";
	($("stop") as HTMLButtonElement).disabled = !state.running;

	const here = state.usage
		? [...Object.values(state.usage.models), ...Object.values(state.usage.tools)].reduce((sum, u) => sum + (u.cost?.total ?? 0), 0)
		: undefined;
	const parts = [];
	if (here !== undefined) parts.push(`${money(here)} this conversation`);
	if (state.allSpend !== undefined) parts.push(`${money(state.allSpend)} all`);
	$("spend").textContent = parts.join(" · ");

	const entries = [...state.entries.values()].sort((a, b) => a.id - b.id);
	const results = new Map<string, Extract<Message, { role: "toolResult" }>>();
	for (const entry of entries) for (const m of entry.model ?? []) if (m.role === "toolResult") results.set(m.toolCallId, m);

	// One group per message from Brad or fired reminder, oldest first inside, newest group on top.
	const groups: HTMLElement[][] = [];
	for (const entry of entries) {
		const out: HTMLElement[] = [];
		let starts = false;
		if (entry.kind === "gaidin.reminder-fired") {
			const data = entry.data ?? {};
			starts = true;
			out.push(el("div", "fired", `Reminder: ${data.text}${data.delivered ? "" : ` (push failed: ${data.error})`}`));
		}
		for (const message of entry.model ?? []) {
			if (message.role === "user") {
				const { time, text } = splitStamp(textOf(message.content));
				if (entry.kind === "pi.user") {
					starts = true;
					const block = el("div", "user");
					if (time) block.append(el("div", "meta", time));
					block.append(el("div", "text", text));
					out.push(block);
				} else out.push(el("div", "note", `${entry.kind}: ${text}`));
			} else if (message.role === "assistant") {
				renderBlocks(message.content, String(entry.id), results, out);
				if (message.stopReason === "error") out.push(el("div", "note bad", message.errorMessage ?? "The model returned an error."));
				if (message.stopReason === "aborted") out.push(el("div", "note", "Stopped."));
			}
		}
		if (out.length === 0) continue;
		if (starts || groups.length === 0) groups.push(out);
		else groups.at(-1)!.push(...out);
	}
	if (state.partial !== undefined) {
		const out: HTMLElement[] = [];
		renderBlocks(state.partial.content, "partial", results, out);
		if (groups.length === 0) groups.push(out);
		else groups.at(-1)!.push(...out);
	}

	const transcript = $("transcript");
	transcript.replaceChildren(
		...groups.reverse().map((group) => {
			const node = el("section", "exchange");
			node.append(...group);
			return node;
		}),
	);
	if (groups.length === 0) transcript.append(el("div", "note", "No messages yet."));
}

function money(dollars: number): string {
	return `$${dollars.toFixed(dollars < 1 ? 3 : 2)}`;
}

// --- requests ---------------------------------------------------------------------------------

function notice(text: string) {
	$("notice").textContent = text;
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
		schedule();
	} catch (error) {
		notice(String(error));
	}
}

const when = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

async function loadReminders() {
	try {
		const reminders = await load<Reminder[]>("/api/reminders");
		const list = $("reminders");
		list.replaceChildren(
			...reminders.map((r) => {
				const item = el("li");
				const body = el("div");
				body.append(el("span", "when", when.format(r.at)), el("span", undefined, r.text));
				const cancel = el("button", "danger", "Cancel");
				cancel.addEventListener("click", async () => {
					cancel.disabled = true;
					try {
						await post("/api/reminders/cancel", { id: r.taskId });
					} catch (error) {
						notice(String(error));
					}
					await loadReminders();
				});
				item.append(body, cancel);
				return item;
			}),
		);
		if (reminders.length === 0) list.append(el("li", "note", "None open."));
	} catch (error) {
		notice(String(error));
	}
}

async function loadApprovals() {
	try {
		const pending = await load<Approval[]>("/api/approvals");
		$("approvals").replaceChildren(
			...pending.map((request) => {
				const card = el("section", "approval");
				card.append(
					el("div", "meta", `gaidin wants to use ${request.tool}. Waits until ${when.format(request.expiresAt)}.`),
					el("div", "what", request.summary),
				);
				const buttons = el("div", "buttons");
				const choices: [string, string, string?][] = [["once", "Allow once"]];
				if (request.always !== undefined) choices.push(["always", request.always.label]);
				choices.push(["deny", "Deny", "danger"]);
				for (const [decision, label, className] of choices) {
					const button = el("button", className, label);
					button.addEventListener("click", async () => {
						for (const b of buttons.querySelectorAll("button")) b.disabled = true;
						try {
							await post("/api/approvals/decide", { id: request.id, decision });
						} catch (error) {
							notice(String(error));
						}
						await loadApprovals();
					});
					buttons.append(button);
				}
				card.append(buttons);
				return card;
			}),
		);
	} catch (error) {
		notice(String(error));
	}
}

function showSettings(settings: Settings) {
	const model = $("settings-model") as HTMLSelectElement;
	model.replaceChildren(...settings.models.map((id) => el("option", undefined, id)));
	model.value = settings.model;
	($("settings-thinking") as HTMLSelectElement).value = settings.thinkingLevel;
	($("settings-instructions") as HTMLTextAreaElement).value = settings.instructions;
	$("settings-tools").replaceChildren(
		...settings.tools.map((tool) => {
			const label = el("label", "check");
			const box = el("input");
			box.type = "checkbox";
			box.name = tool.name;
			box.checked = tool.enabled;
			label.append(box, tool.name);
			return label;
		}),
	);
}

async function loadSettings() {
	try {
		showSettings(await load<Settings>("/api/settings"));
	} catch (error) {
		notice(String(error));
	}
}

// --- controls ---------------------------------------------------------------------------------

const input = $("message") as HTMLTextAreaElement;
const send = $("send") as HTMLButtonElement;

$("composer").addEventListener("submit", async (event) => {
	event.preventDefault();
	const content = input.value.trim();
	if (content === "") return;
	send.disabled = true;
	try {
		await post("/api/message", { content, requestId: crypto.randomUUID() });
		input.value = "";
		notice("");
	} catch (error) {
		notice(String(error));
	} finally {
		send.disabled = false;
		input.focus();
	}
});

input.addEventListener("keydown", (event) => {
	if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
		event.preventDefault();
		($("composer") as HTMLFormElement).requestSubmit();
	}
});

$("stop").addEventListener("click", async () => {
	try {
		await post("/api/abort", {});
	} catch (error) {
		notice(String(error));
	}
});

$("settings").addEventListener("submit", async (event) => {
	event.preventDefault();
	const stateText = $("settings-state");
	const disabledTools = [...document.querySelectorAll<HTMLInputElement>("#settings-tools input")].filter((b) => !b.checked).map((b) => b.name);
	try {
		showSettings(await post("/api/settings", {
			model: ($("settings-model") as HTMLSelectElement).value,
			thinkingLevel: ($("settings-thinking") as HTMLSelectElement).value,
			instructions: ($("settings-instructions") as HTMLTextAreaElement).value,
			disabledTools,
		}));
		stateText.textContent = "Saved. Applies from the next request.";
	} catch (error) {
		stateText.textContent = String(error);
	}
});

connect();
void loadReminders();
void loadSettings();
void loadSpend();
setInterval(() => void loadReminders(), 60_000);
