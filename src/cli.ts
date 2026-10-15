// `gaidin ask`, `gaidin watch` and `gaidin agent`: clients of a running server, over its Unix socket.
import { randomUUID } from "node:crypto";
import { connect } from "node:net";
import { createInterface } from "node:readline";
import type { Config } from "./config.ts";
import { type ClientMessage, parseServerMessage, socketPathFor } from "./server.ts";

/** Sends a message to `agent`, the default agent unless given, and prints the run until it settles. Resolves with the exit code. */
export function ask(config: Config, prompt: string, id?: string, agent?: string): Promise<number> {
	const requestId = id ?? randomUUID();
	if (id === undefined) console.error(`request ${requestId}`);
	const request: ClientMessage = { type: "ask", content: prompt, requestId };
	if (agent !== undefined) request.agent = agent;
	return talk(config, request, true);
}

/** Prints everything `agent` does in its conversation until Ctrl+C. */
export function watch(config: Config, agent?: string): Promise<number> {
	const request: ClientMessage = { type: "watch" };
	if (agent !== undefined) request.agent = agent;
	return talk(config, request, false);
}

/** Lists, adds or changes an agent. */
export function agents(config: Config, request: Extract<ClientMessage, { type: "agent" }>): Promise<number> {
	return talk(config, request, true);
}

function talk(config: Config, request: ClientMessage, waitForDone: boolean): Promise<number> {
	return new Promise((resolvePromise) => {
		const socket = connect(socketPathFor(config));
		socket.once("error", (error) => {
			console.error(`can't reach the gaidin server (${error.message}). Start it with: gaidin serve`);
			resolvePromise(1);
		});
		socket.once("connect", async () => {
			socket.write(`${JSON.stringify(request)}\n`);
			let status: string | undefined;
			for await (const line of createInterface({ input: socket })) {
				const message = parseServerMessage(line);
				if (message.type === "line") console.log(message.text);
				else status = message.status;
			}
			if (status === undefined && waitForDone) {
				console.error("lost the server before the answer. The run is stored; rerun with the same --id to reattach.");
				resolvePromise(1);
				return;
			}
			resolvePromise(status === undefined || status === "done" ? 0 : 1);
		});
	});
}
