// The page's copy of the root conversation, rebuilt from the server's event stream (web.ts events()): a snapshot,
// then one batch of events per commit (pi-durable's watchEvents). It only keeps state; app.ts draws it and does
// whatever else an event calls for, such as reloading the reminders. Served with its types stripped, like app.ts.
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { EntryRecord, MessageChange, UsageState } from "@earendil-works/pi-durable";
import type { StreamEvent } from "../src/web.ts";

type Block = AssistantMessage["content"][number];
/** A running tool call and its output so far. */
export type Slot = { callId: string; name: string; output: string };

export type Transcript = {
	entries: Map<number, EntryRecord>;
	/** The assistant message being generated. */
	partial: { content: Block[] } | undefined;
	/** Running tool calls, by tool call id. */
	tools: Map<string, Slot>;
	running: boolean;
	/** Why the model is being asked again, while it is. */
	retry: string | undefined;
	usage: UsageState | undefined;
};

export function newTranscript(): Transcript {
	return { entries: new Map(), partial: undefined, tools: new Map(), running: false, retry: undefined, usage: undefined };
}

export function applyEvent(transcript: Transcript, event: StreamEvent): void {
	switch (event.type) {
		case "snapshot":
			// A (re)connection may have missed changes, so everything is replaced.
			transcript.entries = new Map(event.entries.map((e) => [e.id, e]));
			transcript.partial = event.generation?.message ? structuredClone(event.generation.message) : undefined;
			transcript.tools = new Map(event.tools.filter((t) => t.status === "running").map((t) => [t.callId, { callId: t.callId, name: t.name, output: t.output ?? "" }]));
			transcript.running = event.run !== undefined;
			transcript.usage = event.usage;
			break;
		case "run_start":
			transcript.running = true;
			break;
		case "run_end":
			transcript.running = false;
			transcript.partial = undefined;
			transcript.retry = undefined;
			break;
		case "message_start":
			if (event.message.role === "assistant") transcript.partial = structuredClone(event.message);
			break;
		case "message_update":
			if (transcript.partial !== undefined) for (const change of event.changes) applyChange(transcript.partial, change);
			break;
		case "message_end":
			transcript.partial = undefined;
			transcript.entries.set(event.entry.id, event.entry);
			break;
		case "tool_execution_start":
			transcript.tools.set(event.toolCallId, { callId: event.toolCallId, name: event.toolName, output: "" });
			break;
		case "tool_execution_update": {
			const slot = transcript.tools.get(event.toolCallId);
			if (slot === undefined || event.output === undefined) break;
			if ("set" in event.output) slot.output = event.output.set;
			else slot.output = slot.output.slice(event.output.trimStart ?? 0) + (event.output.append ?? "");
			break;
		}
		case "tool_execution_end":
			transcript.tools.delete(event.toolCallId);
			if (event.entry) transcript.entries.set(event.entry.id, event.entry);
			break;
		case "entry_appended":
			transcript.entries.set(event.entry.id, event.entry);
			break;
		case "usage_changed":
			transcript.usage = event.usage;
			break;
		case "auto_retry_start":
			transcript.retry = `retrying: ${event.errorMessage}`;
			break;
		case "auto_retry_end":
			transcript.retry = undefined;
			break;
	}
}

function applyChange(message: { content: Block[] }, change: MessageChange) {
	switch (change.type) {
		case "text_start":
		case "thinking_start":
		case "toolcall_start":
		case "block":
			message.content[change.contentIndex] = structuredClone(change.block);
			break;
		case "text_delta": {
			const block = message.content[change.contentIndex];
			if (block?.type === "text") block.text += change.delta;
			break;
		}
		case "thinking_delta": {
			const block = message.content[change.contentIndex];
			if (block?.type === "thinking") block.thinking += change.delta;
			break;
		}
		case "toolcall_delta": {
			const block = message.content[change.contentIndex];
			if (block?.type !== "toolCall") break;
			// Appends to the string at `path` inside the call's arguments.
			let target: any = block.arguments;
			const { path } = change;
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
