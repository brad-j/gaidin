// A conversation drawn as the console shows it. Everything is a row: the time on the first row of an exchange, a
// label saying what kind of line it is, and the body. Thinking and tool calls fold to one line each. The console
// draws the live conversation with one; the history page draws past ones, read-only, with another.
import type { Message } from "@earendil-works/pi-ai";
import { argsSummary, el, isFields, isNumber, isText } from "./dom.ts";
import { markdown } from "./markdown.ts";
import type { newTranscript } from "./transcript.ts";

type Transcript = ReturnType<typeof newTranscript>;
type Block = NonNullable<Transcript["partial"]>["content"][number];
type Entry = Transcript["entries"] extends Map<number, infer E> ? E : never;
type Part = { type: string; text?: string };
type ToolResult = Extract<Message, { role: "toolResult" }>;

export function textOf(content: string | Part[]): string {
	return Array.isArray(content) ? content.map((p) => p.text ?? `[${p.type}]`).join("") : content;
}

/** The owner's messages start with the local time in brackets; show it apart from the text. */
export function splitStamp(text: string): { time?: string; text: string } {
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

export function row(kind: string, label: string, ...body: (Node | string)[]): HTMLElement {
	const node = el("div", `row ${kind}`);
	const b = el("div", "b");
	b.append(...body);
	node.append(el("span", "t"), el("span", "k", label), b);
	return node;
}

function lastLines(text: string, count: number): string {
	return text.replace(/\s+$/, "").split("\n").slice(-count).join("\n");
}

export type LogOptions = {
	/** Buttons beside a fired reminder, for the live console. */
	reminderActions?: (taskId: number) => HTMLElement;
	/** In a job run, the prompts are the job's, not the owner's: drawn as instructions under this label. */
	prompts?: string;
};

/** A drawer for one conversation's log, which keeps its opened folds and rendered answers between draws. */
export function createLog(options: LogOptions = {}) {
	/** Tool calls and thinking blocks the owner has opened, so a re-render keeps them open. */
	const opened = new Set<string>();
	/** Rendered answers by key, so a re-render while text streams in only re-parses the block that changed. */
	let rendered = new Map<string, { text: string; node: HTMLElement }>();
	let nextRendered = new Map<string, { text: string; node: HTMLElement }>();

	function answer(key: string, text: string): HTMLElement {
		const cached = rendered.get(key);
		const node = cached !== undefined && cached.text === text ? cached.node : markdown(text);
		nextRendered.set(key, { text, node });
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

	function renderBlocks(transcript: Transcript, blocks: Block[], key: string, results: Map<string, ToolResult>, out: HTMLElement[]) {
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
				const slot = transcript.tools.get(block.id);
				const status = result ? (result.isError ? "error" : "done") : slot ? "running" : transcript.running ? "waiting" : "no result";
				const output = result ? textOf(result.content) : slot?.output ?? "";
				const args = block.arguments ?? {};
				const sections: [string | undefined, string][] = [["input", block.name === "bash" && isText(args.command) ? args.command : JSON.stringify(args, null, 2)]];
				if (result || slot) sections.push(["output", output || "(no output)"]);
				const details = fold(block.id, [el("span", "name", block.name), el("span", "args", argsSummary(block.name, args)), el("span", "state", status)], sections);
				const line = row(`tool s-${status.replace(" ", "-")}`, "tool", details);
				// A running tool shows the end of its output without being opened.
				if (status === "running" && output.trim() !== "" && !details.open) line.lastElementChild!.append(el("pre", "tail", lastLines(output, 6)));
				out.push(line);
			}
		});
	}

	function entryRows(transcript: Transcript, entry: Entry, results: Map<string, ToolResult>, before: HTMLElement | undefined): HTMLElement[] {
		const out: HTMLElement[] = [];
		let starts = false;
		let time: string | undefined;
		if (entry.kind === "gaidin.reminder-fired") {
			const data = isFields(entry.data) ? entry.data : {};
			starts = true;
			const line = row("remind", "remind", String(data.text ?? ""));
			if (!data.delivered) line.lastElementChild!.append(el("span", "why", `push failed: ${data.error}`));
			if (isNumber(data.taskId) && options.reminderActions) line.lastElementChild!.append(options.reminderActions(data.taskId));
			out.push(line);
		}
		if (entry.kind === "gaidin.job-reported") {
			const data = isFields(entry.data) ? entry.data : {};
			starts = true;
			const line = row("job", "job", String(data.title ?? ""));
			if (!data.delivered) line.lastElementChild!.append(el("span", "why", `not delivered: ${data.error}`));
			const report = row("gaidin", "gaidin", answer(`${entry.id}:report`, String(data.text ?? "")));
			report.lastElementChild!.classList.add("prose");
			out.push(line, report);
		}
		// The note a stop leaves for the model (host.ts stop) says the same as the "Stopped." above it, and more.
		if (entry.kind === "gaidin.stopped") {
			const text = "Stopped. gaidin will drop that request unless you ask again.";
			if (before?.classList.contains("stopped")) before.lastElementChild!.textContent = text;
			else out.push(row("sys stopped", "sys", text));
			return out;
		}
		if (entry.kind === "pi.compaction") {
			// What the model reads from here on instead of the messages above.
			const summary = (entry.model ?? []).map((m) => (m.role === "user" ? textOf(m.content) : "")).join("\n").trim();
			const preview = el("span", "args", "Older messages summarised; the model reads this summary instead of them");
			out.push(row("think compacted", "summary", fold(`${entry.id}:summary`, [preview], [[undefined, summary || "(no summary text)"]])));
			return out;
		}
		for (const message of entry.model ?? []) {
			if (message.role === "user") {
				const split = splitStamp(textOf(message.content));
				if (entry.kind === "pi.user") {
					starts = true;
					time = split.time;
					out.push(options.prompts === undefined ? row("you", "you", split.text) : row("prompt", options.prompts, split.text));
				} else out.push(row("sys", "note", `${entry.kind}: ${split.text}`));
			} else if (message.role === "assistant") {
				renderBlocks(transcript, message.content, String(entry.id), results, out);
				if (message.stopReason === "error") out.push(row("err", "error", message.errorMessage ?? "The model returned an error."));
				if (message.stopReason === "aborted") out.push(row("sys stopped", "sys", "Stopped."));
			}
		}
		if (out.length > 0 && starts) {
			out[0].classList.add("start");
			const stamp = out[0].firstElementChild;
			if (time && stamp instanceof HTMLElement) {
				stamp.textContent = shortStamp(time);
				stamp.title = time;
			}
		}
		return out;
	}

	/**
	 * The rows for `transcript`'s entries that `include` keeps, oldest first, with each of `between` placed after the
	 * entry it followed, and the answer still coming in at the end.
	 */
	function render(transcript: Transcript, between: readonly { after: number; row: HTMLElement }[] = [], include: (entry: Entry) => boolean = () => true): HTMLElement[] {
		const entries = [...transcript.entries.values()].sort((a, b) => a.id - b.id);
		const results = new Map<string, ToolResult>();
		for (const entry of entries) for (const m of entry.model ?? []) if (m.role === "toolResult") results.set(m.toolCallId, m);
		const rows: HTMLElement[] = [];
		let shown = 0;
		const flush = (upTo: number) => {
			while (shown < between.length && between[shown].after <= upTo) rows.push(between[shown++].row);
		};
		for (const entry of entries) {
			if (include(entry)) rows.push(...entryRows(transcript, entry, results, rows.at(-1)));
			flush(entry.id);
		}
		if (transcript.partial !== undefined) renderBlocks(transcript, transcript.partial.content, "partial", results, rows);
		flush(Infinity);
		rendered = nextRendered;
		nextRendered = new Map();
		return rows;
	}

	return { render };
}
