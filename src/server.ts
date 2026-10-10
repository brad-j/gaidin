// `gaidin serve`: owns the SQLite file and runs the agent. Clients talk to it over a Unix socket in the
// data directory, one JSON object per line. With Slack in the settings it also runs the Slack surface
// (src/slack.ts), and with `web` the web view (src/web.ts).
//
// client → server: {"type":"ask","content":"...","requestId":"..."} or {"type":"watch"}
// server → client: {"type":"line","text":"..."} and, after an ask settles, {"type":"done","status":"..."}
import { randomUUID } from "node:crypto";
import { chmodSync, rmSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { type AgentEvent, type EntryId, watchEvents } from "@earendil-works/pi-durable";
import type { Config } from "./config.ts";
import { assistantText, context, openHost } from "./host.ts";
import { ReminderFired } from "./reminders.ts";
import { createSlackSurface, recordPosted, slackApi, slackPoster, socketMode } from "./slack.ts";
import { createSlackApprovals } from "./slack-approvals.ts";
import { stamp } from "./time.ts";
import { createWebServer } from "./web.ts";

export const socketPathFor = (config: Config) => resolve(config.dataDir, "gaidin.sock");

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

	const { harness, root, switchable, approvals, setDeliver } = await openHost({ config });

	let slack: { stop(): void } | undefined;
	if (config.slack !== undefined) {
		const { botToken, appToken, channelId: channel, userId: user } = config.slack;
		const api = slackApi(botToken);
		const surface = createSlackSurface({ harness, root, post: slackPoster(api), channel, user });
		const approvalButtons = createSlackApprovals({ harness, approvals, api, channel, user });
		void surface.recover();
		approvalButtons.recover().catch((error) => console.error("[slack] approvals:", error));
		slack = socketMode(appToken, { event: surface.receive, action: approvalButtons.action });
		// Job reports go to the channel; a thread on one continues that run's conversation.
		const post = slackPoster(api);
		setDeliver(async (report) => {
			const posted = await post(channel, `*${report.title}*\n\n${report.text}`);
			if (report.answer !== undefined) await recordPosted(root, posted, report.answer, report.conversationId);
		});
		console.error(`gaidin on Slack in ${channel}`);
	}

	const web = config.web === undefined
		? undefined
		: createWebServer({ harness, root, user: config.web.user, switchable, approvals, models: config.model.choices });
	if (web !== undefined) {
		const port = config.web!.port;
		// Loopback only: tailscale serve is the way in, and it vouches for who's asking.
		web.listen(port, "127.0.0.1", () => console.error(`gaidin web view on 127.0.0.1:${port}`));
	}

	const send = (socket: Socket, message: object) => {
		if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
	};

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
		const submission = await root.submit({ type: "input", content: stamp(request.content), requestId: request.requestId ?? randomUUID() }, context);
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
		slack?.stop();
		web?.closeAllConnections();
		web?.close();
		server.close();
		await harness.close(context);
		process.exit(0);
	}
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);
}
