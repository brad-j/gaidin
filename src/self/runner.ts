// Runs one self-written extension inside its box (self/index.ts): `node runner.ts <dir>`. It talks to the
// server in JSON lines on fd 3, so whatever the extension prints on stdout or stderr can't pass for a
// message. It sends the extension's tools first, then answers calls, asking the server for each fetch.
import { Socket } from "node:net";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import type { Fetched, Tool } from "./api.ts";

const channel = new Socket({ fd: 3 });
const send = (message: object) => channel.write(`${JSON.stringify(message)}\n`);
const fetches = new Map<number, { resolve: (page: Fetched) => void; reject: (error: Error) => void }>();
let nextFetch = 0;

const { tools } = (await import(pathToFileURL(`${process.argv[2]}/index.ts`).href)) as { tools: Tool[] };
send({ tools: tools.map(({ name, description, parameters }) => ({ name, description, parameters })) });

async function call(id: number, name: string, args: never) {
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
	const message = JSON.parse(line) as { id: number; call: string; args: never } | { fetchId: number; page?: Fetched; error?: string };
	if ("call" in message) {
		void call(message.id, message.call, message.args);
		continue;
	}
	const waiting = fetches.get(message.fetchId);
	fetches.delete(message.fetchId);
	if (message.page !== undefined) waiting?.resolve(message.page);
	else waiting?.reject(new Error(message.error));
}
