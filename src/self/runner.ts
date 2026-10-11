// Runs one self-written extension inside its box (self/index.ts): `node runner.ts <dir>`. It talks to the
// server in JSON lines on fd 3, so whatever the extension prints on stdout or stderr can't pass for a
// message. It sends the extension's tools first, then answers calls, asking the server for each fetch.
import { Socket } from "node:net";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import type { Json } from "../parse.ts";
import type { Fetched, Tool } from "./api.ts";

/** What the server sends: a call, or the page or error for one of a call's fetches. */
export type ToRunner = { id: number; call: string; args: Json } | { fetchId: number; page?: Fetched; error?: string };
/** What the runner sends: the tools first, then each call's fetches and its result or error. */
export type FromRunner =
	| { tools: { name: string; description: string; parameters: Tool["parameters"] }[] }
	| { id: number; fetchId: number; fetch: string }
	| { id: number; result: string }
	| { id: number; error: string };

const channel = new Socket({ fd: 3 });
const send = (message: FromRunner) => channel.write(`${JSON.stringify(message)}\n`);
const fetches = new Map<number, { resolve: (page: Fetched) => void; reject: (error: Error) => void }>();
let nextFetch = 0;

// SAFETY: index.ts passed a strict type check that its tools are Tools before it was approved (self/index.ts).
const { tools } = (await import(pathToFileURL(`${process.argv[2]}/index.ts`).href)) as { tools: Tool[] };
send({ tools: tools.map(({ name, description, parameters }) => ({ name, description, parameters })) });

async function call(id: number, name: string, args: Json) {
	const fetch = (url: string) =>
		new Promise<Fetched>((resolve, reject) => {
			const fetchId = nextFetch++;
			fetches.set(fetchId, { resolve, reject });
			send({ id, fetchId, fetch: url });
		});
	try {
		const tool = tools.find((t) => t.name === name);
		if (tool === undefined) throw new Error(`There's no tool ${name}`);
		send({ id, result: String(await tool.execute(args, { fetch })) });
	} catch (error) {
		send({ id, error: error instanceof Error ? error.message : String(error) });
	}
}

for await (const line of createInterface({ input: channel })) {
	// SAFETY: only the server writes to this side of the channel (self/index.ts).
	const message = JSON.parse(line) as ToRunner;
	if ("call" in message) {
		void call(message.id, message.call, message.args);
		continue;
	}
	const waiting = fetches.get(message.fetchId);
	fetches.delete(message.fetchId);
	if (message.page !== undefined) waiting?.resolve(message.page);
	else waiting?.reject(new Error(message.error));
}
