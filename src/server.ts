// Owns the SQLite file and runs the agent. Clients talk to it over a Unix socket in the data
// directory, one JSON object per line.
//
// client → server: {"type":"ask","content":"...","requestId":"..."} or {"type":"watch"}
// server → client: {"type":"line","text":"..."} and, after an ask settles, {"type":"done","status":"..."}
import { randomUUID } from "node:crypto";
import { chmodSync, rmSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { AssistantEntry, type AgentEvent, type EntryId, type EntryRecord, watchEvents } from "@earendil-works/pi-durable";
import { context, dataDir, openHost } from "./host.ts";
import { ReminderFired } from "./reminders.ts";
import { formatTime } from "./time.ts";

const socketPath = resolve(dataDir(), "gaidin.sock");

if (await isListening(socketPath)) {
	console.error(`gaidin is already running on ${socketPath}`);
	process.exit(1);
}

const { harness, root } = await openHost();

function assistantText(entry: EntryRecord | undefined): string | undefined {
	if (!AssistantEntry.is(entry)) return undefined;
	const message = entry.model?.[0];
	if (message?.role !== "assistant") return undefined;
	return message.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("") || undefined;
}

function describe(event: AgentEvent): string | undefined {
	switch (event.type) {
		case "tool_execution_start":
			return `· ${event.toolName} ${JSON.stringify(event.args)}`;
		case "message_end":
			return assistantText(event.entry);
		case "entry_appended":
			if (!ReminderFired.is(event.entry)) return undefined;
			return `⏰ ${event.entry.data.text}${event.entry.data.delivered ? "" : ` (push failed: ${event.entry.data.error})`}`;
		case "task_failed":
			return `! ${event.kind}: ${event.message}`;
		default:
			return undefined;
	}
}

function send(socket: Socket, message: object) {
	if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
}

async function follow(socket: Socket) {
	const shown = new Set<EntryId>();
	const events = await watchEvents(harness, root.id, context);
	events.start(async (batch) => {
		for (const event of batch) {
			const text = describe(event);
			if (text === undefined) continue;
			if (event.type === "message_end") shown.add(event.entry.id);
			send(socket, { type: "line", text });
		}
	});
	socket.once("close", () => void events.stop());
	return { events, shown };
}

async function handle(socket: Socket, line: string) {
	const request = JSON.parse(line) as { type: "ask"; content: string; requestId?: string } | { type: "watch" };
	const { events, shown } = await follow(socket);
	if (request.type === "watch") return;
	// The time goes in the message, not the system prompt, so the prompt cache stays valid.
	const content = `[${formatTime(Date.now())}] ${request.content}`;
	const submission = await root.submit({ type: "input", content, requestId: request.requestId ?? randomUUID() }, context);
	// If the client goes away, the run continues; only this wait and its watch end.
	const settled = await submission.wait(context);
	await events.stop();
	// A client reattaching to a run that finished without it still gets the answer.
	if (settled.status === "done" && settled.type === "input" && !shown.has(settled.answer)) {
		const text = assistantText(await root.commit((tx) => tx.entry(settled.answer), context));
		if (text !== undefined) send(socket, { type: "line", text });
	}
	send(socket, { type: "done", status: settled.status });
	socket.end();
}

const server = createServer((socket) => {
	const lines = createInterface({ input: socket });
	lines.once("line", (line) => {
		handle(socket, line).catch((error) => {
			send(socket, { type: "line", text: `! ${error instanceof Error ? error.message : String(error)}` });
			socket.end();
		});
	});
	socket.on("error", () => {});
});

rmSync(socketPath, { force: true });
server.listen(socketPath, () => {
	chmodSync(socketPath, 0o600);
	console.error(`gaidin listening on ${socketPath}`);
});

async function shutdown() {
	server.close();
	await harness.close(context);
	process.exit(0);
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

function isListening(path: string): Promise<boolean> {
	return new Promise((resolve) => {
		const probe = connect(path);
		probe.once("connect", () => {
			probe.end();
			resolve(true);
		});
		probe.once("error", () => resolve(false));
	});
}
