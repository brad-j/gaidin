// Socket Mode: Slack's events and button presses over a WebSocket, so the host needs no inbound port.
import { boolean, isObject, json, object, optional, parse, ParseError, parseJson, string } from "../parse.ts";
import { type SlackAction, slackAction, type SlackMessage, slackMessage } from "./api.ts";

/** A Socket Mode frame: hello, disconnect, or an envelope to ack, holding an event or a button press. */
const frame = object({ type: string, envelope_id: optional(string), payload: optional(json) });

/**
 * Keeps a Socket Mode connection open and hands each message event to `event` and each button press to
 * `action`, acking once they resolve. A new connection opens before the old one closes: on Slack's
 * disconnect notices, and hourly in case a connection dies without either side noticing.
 */
export function socketMode(appToken: string, handlers: { event: (event: SlackMessage) => Promise<void>; action?: (action: SlackAction) => Promise<void> }) {
	let stopped = false;
	let failures = 0;
	const sockets = new Set<WebSocket>();

	async function open(): Promise<void> {
		if (stopped) return;
		let url: string;
		try {
			const response = await fetch("https://slack.com/api/apps.connections.open", {
				method: "POST",
				headers: { Authorization: `Bearer ${appToken}`, "Content-Type": "application/x-www-form-urlencoded" },
				signal: AbortSignal.timeout(15_000),
			});
			const body = parse(await response.json(), object({ ok: boolean, url: optional(string), error: optional(string) }), "Slack's answer to apps.connections.open");
			if (!body.ok || body.url === undefined) throw new Error(`apps.connections.open: ${body.error ?? response.status}`);
			url = body.url;
		} catch (error) {
			retry(error);
			return;
		}
		const socket = new WebSocket(url);
		sockets.add(socket);
		let replaced = false;
		// Opens the next connection, then closes this one once Slack has had time to switch over.
		const replace = () => {
			if (replaced) return;
			replaced = true;
			void open();
			setTimeout(() => socket.close(), 10_000).unref();
		};
		const refresh = setTimeout(replace, 60 * 60_000);
		refresh.unref();
		socket.addEventListener("message", (message) => {
			let data;
			try {
				data = parseJson(String(message.data), frame, "a Socket Mode frame");
			} catch (error) {
				console.error("[slack]", error instanceof Error ? error.message : error);
				return;
			}
			if (data.type === "hello") {
				failures = 0;
				return;
			}
			if (data.type === "disconnect") {
				replace();
				return;
			}
			if (data.envelope_id === undefined) return;
			const ack = () => {
				if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ envelope_id: data.envelope_id }));
			};
			let event: SlackMessage | undefined;
			try {
				if (data.type === "interactive" && handlers.action !== undefined) {
					const payload = parse(data.payload, slackAction, "a button press");
					if (payload.type !== "block_actions") return ack();
					// Slack doesn't resend a button press, and wants its ack within 3 seconds either way.
					handlers.action(payload).catch((error) => console.error("[slack] action failed:", error)).finally(ack);
					return;
				}
				const raw = data.type === "events_api" && isObject(data.payload) ? data.payload.event : undefined;
				event = raw === undefined ? undefined : parse(raw, slackMessage, "a Slack event");
			} catch (error) {
				// Sent again, it would read no better.
				if (!(error instanceof ParseError)) throw error;
				console.error("[slack]", error.message);
				return ack();
			}
			if (event === undefined) return ack();
			// Not acked on failure, so Slack sends it again.
			handlers.event(event).then(ack, (error) => console.error("[slack] event failed:", error));
		});
		socket.addEventListener("close", () => {
			clearTimeout(refresh);
			sockets.delete(socket);
			if (!replaced) retry(new Error("connection closed"));
		});
		socket.addEventListener("error", () => {});
	}

	function retry(cause: unknown) {
		if (stopped) return;
		failures += 1;
		const delay = Math.min(1000 * 2 ** failures, 60_000);
		console.error(`[slack] ${cause instanceof Error ? cause.message : cause}; reconnecting in ${delay / 1000}s`);
		setTimeout(() => void open(), delay).unref();
	}

	void open();
	return {
		stop() {
			stopped = true;
			for (const socket of sockets) socket.close();
		},
	};
}
