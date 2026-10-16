// `gaidin serve`: owns the SQLite file and runs the agent. Clients talk to it over a Unix socket in the
// data directory, one JSON object per line. With Slack in the settings it also runs Slack (src/slack/),
// and with `web` the app (src/web.ts).
//
// client → server: {"type":"ask","content":"...","requestId":"...","agent":"..."}, {"type":"watch","agent":"..."},
//                  {"type":"agent","action":"list"|"add"|"set",...} to see and change the roster (agents.ts), or
//                  {"type":"connector","action":"list"|"show"|"add"|"refresh"|"tool"|"token"|"remove",...} for connectors/, or
//                  {"type":"rule","action":"list"|"add"|"remove",...} for the owner's rules (rules.ts)
// server → client: {"type":"line","text":"..."} and, after an ask settles or an agent command ends, {"type":"done","status":"..."}
// Without "agent", an ask or a watch goes to the default agent's conversation, the root.
import { randomUUID } from "node:crypto";
import { chmodSync, rmSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { type AgentEvent, type EntryId, watchEvents } from "@earendil-works/pi-durable";
import type { AgentChange, AgentEntry } from "./agents.ts";
import { type Connector, type ConnectorTool, offered, review, type ToolSetting, tokensOf } from "./connectors/index.ts";
import { describeRule, type NewRule, newRule } from "./rules.ts";
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
	| { type: "agent"; action: "set"; id: string; change: AgentChange }
	| { type: "connector"; action: "list" }
	| { type: "connector"; action: "show" | "refresh" | "remove"; name: string }
	| { type: "connector"; action: "add"; name: string; url: string; token?: string }
	| { type: "connector"; action: "tool"; name: string; tool: string; setting: ToolSetting }
	| { type: "connector"; action: "token"; name: string; token?: string }
	| { type: "connector"; action: "connect"; name: string; clientId?: string }
	| { type: "connector"; action: "client-document" }
	| { type: "rule"; action: "list" }
	| { type: "rule"; action: "add"; rule: NewRule }
	| { type: "rule"; action: "remove"; id: string };
/** What the server sends back. */
export type ServerMessage = { type: "line"; text: string } | { type: "done"; status: string };

const clientMessage = object({
	type: literal("ask", "watch", "agent", "connector", "rule"),
	content: optional(string),
	requestId: optional(string),
	agent: optional(string),
	action: optional(literal("list", "add", "set", "show", "refresh", "tool", "token", "remove", "connect", "client-document")),
	clientId: optional(string),
	rule: optional(newRule),
	url: optional(string),
	token: optional(string),
	tool: optional(string),
	setting: optional(literal("allow", "ask", "off")),
	id: optional(string),
	name: optional(string),
	job: optional(string),
	change: optional(object({ name: optional(string), job: optional(string), channel: optional(string), canMessage: optional(array(string)), workspaces: optional(array(string)), profiles: optional(array(string)), connectors: optional(array(string)) })),
});
const serverMessage = object({ type: literal("line", "done"), text: optional(string), status: optional(string) });

export function parseClientMessage(line: string): ClientMessage {
	const message = parseJson(line, clientMessage, "the request");
	if (message.type === "watch") {
		const watch: ClientMessage = { type: "watch" };
		if (message.agent !== undefined) watch.agent = message.agent;
		return watch;
	}
	if (message.type === "rule") {
		if (message.action === "list" || message.action === undefined) return { type: "rule", action: "list" };
		if (message.action === "add") {
			if (message.rule === undefined) throw new ParseError("a new rule needs its rule");
			return { type: "rule", action: "add", rule: message.rule };
		}
		if (message.action === "remove" && message.id !== undefined) return { type: "rule", action: "remove", id: message.id };
		throw new ParseError("rules are listed, added, or removed by id");
	}
	if (message.type === "connector") {
		const { action = "list", name } = message;
		if (action === "list") return { type: "connector", action: "list" };
		if (action === "client-document") return { type: "connector", action: "client-document" };
		if (name === undefined) throw new ParseError(`a connector ${action} needs a name`);
		if (action === "show" || action === "refresh" || action === "remove") return { type: "connector", action, name };
		if (action === "add") {
			if (message.url === undefined) throw new ParseError("a new connector needs a url");
			const add: ClientMessage = { type: "connector", action: "add", name, url: message.url };
			if (message.token !== undefined) add.token = message.token;
			return add;
		}
		if (action === "connect") {
			const connect: ClientMessage = { type: "connector", action: "connect", name };
			if (message.clientId !== undefined) connect.clientId = message.clientId;
			return connect;
		}
		if (action === "token") {
			const token: ClientMessage = { type: "connector", action: "token", name };
			if (message.token !== undefined) token.token = message.token;
			return token;
		}
		if (action === "tool") {
			if (message.tool === undefined || message.setting === undefined) throw new ParseError("a connector's tool needs a tool and allow, ask or off");
			return { type: "connector", action: "tool", name, tool: message.tool, setting: message.setting };
		}
		throw new ParseError(`connectors have no ${action}`);
	}
	if (message.type === "agent") {
		if (message.action === "list" || message.action === undefined) return { type: "agent", action: "list" };
		if (message.action !== "add" && message.action !== "set") throw new ParseError(`agents have no ${message.action}`);
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

/** One line about a connector, for `gaidin connector list`. */
export function describeConnector(connector: Connector): string {
	const on = connector.tools.filter(offered).length;
	const waiting = connector.tools.filter((t) => review(t) !== undefined).length;
	const parts = [
		connector.url,
		connector.state === "connected" ? `connected${connector.protocol === undefined ? "" : `, MCP ${connector.protocol}`}` : `${connector.state}: ${connector.problem ?? ""}`,
		`${on} of ${connector.tools.length} tools offered, about ${tokensOf(connector)} tokens`,
		waiting === 0 ? undefined : `${waiting} to review`,
		connector.rejected === undefined ? undefined : `${connector.rejected.length} unusable`,
	];
	return `${connector.name}: ${parts.filter((p) => p !== undefined).join(" · ")}`;
}

/** One line about a connector's tool, for `gaidin connector show`. */
export function describeTool(tool: ConnectorTool): string {
	const waiting = review(tool);
	const effect = waiting === undefined ? tool.setting : `off, ${waiting} (it was ${tool.setting}; set it to review)`;
	const readOnly = tool.annotations?.readOnlyHint === true;
	const hints = [readOnly ? "read-only" : undefined, !readOnly && tool.annotations?.destructiveHint === true ? "destructive" : undefined].filter((h) => h !== undefined);
	return `  ${tool.name} → ${tool.as}: ${effect}${hints.length === 0 ? "" : ` (says ${hints.join(", ")})`}${tool.description === undefined ? "" : ` · ${tool.description.split("\n")[0]!.slice(0, 100)}`}`;
}

/** One line about an agent, for `gaidin agent list`. */
export function describeAgent(agent: AgentEntry): string {
	const parts = [
		agent.job || "no job given",
		agent.channel === undefined ? undefined : `Slack ${agent.channel}`,
		`may message: ${agent.canMessage.join(", ") || "none"}`,
		`workspaces: ${agent.workspaces === undefined ? "all" : agent.workspaces.join(", ") || "none"}`,
		agent.profiles === undefined ? undefined : `browser profiles: ${agent.profiles.join(", ")}`,
		agent.connectors === undefined ? undefined : `connectors: ${agent.connectors.join(", ")}`,
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
		: createWebServer({ harness, root, agents: host.agents, workspaces: host.workspaces, profiles: host.profiles, takeOver: host.takeOver, connectors: host.connectors, rules: host.rules, uploads: host.uploads, avatars: host.avatars, mirror: slack?.mirror, threads: host.threads, user: config.web.user, app: config.web.app, switchable, approvals, models: config.model.choices, budget, timeline, history, skills, stop, snooze: reminders.snooze, push });
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

	/** Lists, adds or removes a rule, and says what it did. */
	async function rule(socket: Socket, request: Extract<ClientMessage, { type: "rule" }>) {
		if (request.action === "list") {
			const rules = await host.rules.list();
			if (rules.length === 0) send(socket, { type: "line", text: "No rules." });
			for (const r of rules) send(socket, { type: "line", text: describeRule(r) });
		} else if (request.action === "add") send(socket, { type: "line", text: describeRule(await host.rules.add(request.rule)) });
		else {
			await host.rules.remove(request.id);
			send(socket, { type: "line", text: `Removed ${request.id}.` });
		}
		send(socket, { type: "done", status: "done" });
		socket.end();
	}

	/** Lists, shows, adds or changes a connector, and says what it did. */
	async function connector(socket: Socket, request: Extract<ClientMessage, { type: "connector" }>) {
		const { connectors } = host;
		const show = (c: Connector) => {
			send(socket, { type: "line", text: describeConnector(c) });
			for (const tool of c.tools) send(socket, { type: "line", text: describeTool(tool) });
			for (const r of c.rejected ?? []) send(socket, { type: "line", text: `  ${r.name}: can't be offered: ${r.problem}` });
		};
		switch (request.action) {
			case "list":
				for (const c of connectors.list()) send(socket, { type: "line", text: describeConnector(c) });
				break;
			case "show": {
				const found = connectors.list().find((c) => c.name === request.name);
				if (found === undefined) throw new Error(`There's no connector ${request.name}.`);
				show(found);
				break;
			}
			case "add":
				show(await connectors.add(request));
				break;
			case "refresh":
				show(await connectors.refresh(request.name));
				break;
			case "token":
				show(await connectors.setToken(request.name, request.token));
				break;
			case "tool":
				send(socket, { type: "line", text: describeTool(await connectors.setTool(request.name, request.tool, request.setting)) });
				break;
			case "connect":
				send(socket, { type: "line", text: `Open this in a browser that can reach the service and gaidin's app, and sign in; it comes back to gaidin within 10 minutes:\n${await connectors.connect(request.name, request.clientId)}` });
				break;
			case "client-document": {
				const document = connectors.clientDocument();
				if (document === undefined) throw new Error("Signing connectors in needs web.url in the settings.");
				send(socket, { type: "line", text: JSON.stringify(document, null, 2) });
				break;
			}
			case "remove":
				await connectors.remove(request.name);
				send(socket, { type: "line", text: `Removed ${request.name}, its token and every agent's grant of it.` });
				break;
		}
		send(socket, { type: "done", status: "done" });
		socket.end();
	}

	async function handle(socket: Socket, line: string) {
		const request = parseClientMessage(line);
		if (request.type === "agent") return manage(socket, request);
		if (request.type === "connector") return connector(socket, request);
		if (request.type === "rule") return rule(socket, request);
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
		await host.close();
		process.exit(0);
	}
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);
	// A storage error closes the Harness for good; exit so systemd (Restart=on-failure) starts gaidin on a fresh one.
	void harness.closed.then((end) => {
		if (end.reason !== "failed") return;
		console.error("gaidin's storage failed; exiting to restart:", end.error);
		process.exit(1);
	});
}
