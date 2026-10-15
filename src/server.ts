// `gaidin serve`: owns the SQLite file and runs the agent. Clients talk to it over a Unix socket in the
// data directory, one JSON object per line. With Slack in the settings it also runs Slack (src/slack/),
// and with `web` the app (src/web.ts).
//
// client → server: {"type":"ask","content":"...","requestId":"...","agent":"..."}, {"type":"watch","agent":"..."}, or
//                  {"type":"agent","action":"list"|"add"|"set",...} to see and change the roster (agents.ts)
// server → client: {"type":"line","text":"..."} and, after an ask settles or an agent command ends, {"type":"done","status":"..."}
// Without "agent", an ask or a watch goes to the default agent's conversation, the root.
import { randomUUID } from "node:crypto";
import { chmodSync, rmSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { type AgentEvent, type EntryId, watchEvents } from "@earendil-works/pi-durable";
import type { AgentChange, AgentEntry } from "./agents.ts";
import type { Config } from "./config.ts";
import { assistantText, context, openHost } from "./host.ts";
import { ReminderFired } from "./reminders.ts";
import { followAlerts } from "./alerts.ts";
import { createSlack } from "./slack/index.ts";
import { array, literal, object, optional, ParseError, parseJson, string } from "./parse.ts";
import { stamp } from "./time.ts";
import { createWebServer } from "./web.ts";

export const socketPathFor = (config: Config) => resolve(config.dataDir, "gaidin.sock");

/** What a client sends: one request per connection. `agent` picks whose conversation; without it, the default agent's. */
export type ClientMessage =
	| { type: "ask"; content: string; requestId?: string; agent?: string }
	| { type: "watch"; agent?: string }
	| { type: "agent"; action: "list" }
	| { type: "agent"; action: "add"; id: string; name: string; job: string }
	| { type: "agent"; action: "set"; id: string; change: AgentChange };
/** What the server sends back. */
export type ServerMessage = { type: "line"; text: string } | { type: "done"; status: string };

const clientMessage = object({
	type: literal("ask", "watch", "agent"),
	content: optional(string),
	requestId: optional(string),
	agent: optional(string),
	action: optional(literal("list", "add", "set")),
	id: optional(string),
	name: optional(string),
	job: optional(string),
	change: optional(object({ name: optional(string), job: optional(string), channel: optional(string), canMessage: optional(array(string)), workspaces: optional(array(string)) })),
});
const serverMessage = object({ type: literal("line", "done"), text: optional(string), status: optional(string) });

export function parseClientMessage(line: string): ClientMessage {
	const message = parseJson(line, clientMessage, "the request");
	if (message.type === "watch") {
		const watch: ClientMessage = { type: "watch" };
		if (message.agent !== undefined) watch.agent = message.agent;
		return watch;
	}
	if (message.type === "agent") {
		if (message.action === "list" || message.action === undefined) return { type: "agent", action: "list" };
		if (message.id === undefined) throw new ParseError(`an agent ${message.action} needs an id`);
		if (message.action === "set") return { type: "agent", action: "set", id: message.id, change: message.change ?? {} };
		if (message.name === undefined) throw new ParseError("a new agent needs a name");
		return { type: "agent", action: "add", id: message.id, name: message.name, job: message.job ?? "" };
	}
	if (message.content === undefined) throw new ParseError("an ask needs content");
	const ask: ClientMessage = { type: "ask", content: message.content };
	if (message.requestId !== undefined) ask.requestId = message.requestId;
	if (message.agent !== undefined) ask.agent = message.agent;
	return ask;
}

/** One line about an agent, for `gaidin agent list`. */
export function describeAgent(agent: AgentEntry): string {
	const parts = [
		agent.job || "no job given",
		agent.channel === undefined ? undefined : `Slack ${agent.channel}`,
		`may message: ${agent.canMessage.join(", ") || "none"}`,
		`workspaces: ${agent.workspaces === undefined ? "all" : agent.workspaces.join(", ") || "none"}`,
		agent.archived === undefined ? undefined : "archived",
	];
	return `${agent.id} (${agent.name}): ${parts.filter((p) => p !== undefined).join(" · ")}`;
}

export function parseServerMessage(line: string): ServerMessage {
	const message = parseJson(line, serverMessage, "the server's message");
	return message.type === "line" ? { type: "line", text: message.text ?? "" } : { type: "done", status: message.status ?? "" };
}

/** Whether a server answers on the socket. */
export function isListening(path: string): Promise<boolean> {
	return new Promise((resolvePromise) => {
		const probe = connect(path);
		probe.once("connect", () => {
			probe.end();
			resolvePromise(true);
		});
		probe.once("error", () => resolvePromise(false));
	});
}

/** One line per thing the agent does, for `gaidin ask` and `gaidin watch`. */
export function describe(event: AgentEvent): string | undefined {
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

export async function serve(config: Config) {
	const socketPath = socketPathFor(config);
	if (await isListening(socketPath)) {
		console.error(`gaidin is already running on ${socketPath}`);
		process.exit(1);
	}

	const host = await openHost({ config });
	const { harness, root, switchable, approvals, budget, explain, timeline, history, reminders, jobs, skills, push, stop } = host;
	const alerts = config.alerts === undefined ? undefined : followAlerts({ ...config.alerts, root, owner: config.owner, addJob: jobs.addJob });

	const slack = config.slack === undefined ? undefined : createSlack(config.slack, host);
	if (slack !== undefined) {
		slack.start();
		console.error(`gaidin on Slack in ${config.slack!.channelId}`);
	}
	await host.start(slack?.adapter);

	const web = config.web === undefined
		? undefined
		: createWebServer({ harness, root, agents: host.agents, workspaces: host.workspaces, uploads: host.uploads, avatars: host.avatars, mirror: slack?.mirror, threads: host.threads, user: config.web.user, app: config.web.app, switchable, approvals, models: config.model.choices, budget, timeline, history, skills, stop, snooze: reminders.snooze, push });
	if (web !== undefined) {
		const port = config.web!.port;
		// Loopback only: tailscale serve is the way in, and it vouches for who's asking.
		web.listen(port, "127.0.0.1", () => console.error(`gaidin app on 127.0.0.1:${port}`));
	}

	const send = (socket: Socket, message: ServerMessage) => {
		if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
	};

	async function follow(socket: Socket, conversation: typeof root) {
		const shown = new Set<EntryId>();
		const events = await watchEvents(harness, conversation.id, context);
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

	/** Lists, adds or changes an agent, and says what it did. */
	async function manage(socket: Socket, request: Extract<ClientMessage, { type: "agent" }>) {
		if (request.action === "list") {
			for (const agent of await host.agents.list()) send(socket, { type: "line", text: describeAgent(agent) });
		} else {
			const agent = request.action === "add" ? await host.agents.add(request) : await host.agents.update(request.id, request.change);
			send(socket, { type: "line", text: describeAgent(agent) });
		}
		send(socket, { type: "done", status: "done" });
		socket.end();
	}

	async function handle(socket: Socket, line: string) {
		const request = parseClientMessage(line);
		if (request.type === "agent") return manage(socket, request);
		const conversation = await host.agents.home(request.agent);
		const { events, shown } = await follow(socket, conversation);
		if (request.type === "watch") return;
		if ((await approvals.intercept(conversation.id, request.content, "cli")) === "answered") {
			send(socket, { type: "line", text: "(taken as the answer to gaidin's question; the run goes on)" });
			send(socket, { type: "done", status: "done" });
			socket.end();
			return;
		}
		const submission = await conversation.submit({ type: "input", content: stamp(request.content), requestId: request.requestId ?? randomUUID() }, context);
		// If the client goes away, the run continues; only this wait and its watch end.
		const settled = await submission.wait(context);
		await events.stop();
		// A client reattaching to a run that finished without it still gets the answer.
		if (settled.status === "done" && settled.type === "input" && !shown.has(settled.answer)) {
			const text = assistantText(await conversation.commit((tx) => tx.entry(settled.answer), context));
			if (text !== undefined) send(socket, { type: "line", text });
		}
		if (settled.status === "unanswered") {
			const why = explain(settled.reason);
			if (why !== undefined) send(socket, { type: "line", text: `! ${why}` });
		}
		send(socket, { type: "done", status: settled.status });
		socket.end();
	}

	const server = createServer((socket) => {
		const lines = createInterface({ input: socket });
		lines.once("line", (line) => {
			handle(socket, line).catch((error) => {
				send(socket, { type: "line", text: `! ${error instanceof Error ? error.message : String(error)}` });
				send(socket, { type: "done", status: "error" });
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
		slack?.stop();
		alerts?.stop();
		web?.closeAllConnections();
		web?.close();
		server.close();
		await harness.close(context);
		process.exit(0);
	}
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);
}
