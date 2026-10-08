// Usage:
//   node src/cli.ts "<prompt>"                    ask, and print the run until it settles
//   node src/cli.ts --id <request-id> "<prompt>"  rerunning with the same id reattaches instead of asking twice
//   node src/cli.ts --watch                       print everything the agent does until Ctrl+C
import { randomUUID } from "node:crypto";
import { connect } from "node:net";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { dataDir } from "./host.ts";

const { values, positionals } = parseArgs({
	options: { id: { type: "string" }, watch: { type: "boolean" } },
	allowPositionals: true,
});
const prompt = positionals.join(" ");
if (!values.watch && !prompt) {
	console.error('usage: gaidin [--id <request-id>] "<prompt>" | gaidin --watch');
	process.exit(2);
}

const socket = connect(resolve(dataDir(), "gaidin.sock"));
socket.once("error", (error) => {
	console.error(`can't reach the gaidin server (${error.message}). Start it with: pnpm serve`);
	process.exit(1);
});
socket.once("connect", () => {
	const request = values.watch ? { type: "watch" } : { type: "ask", content: prompt, requestId: values.id ?? randomUUID() };
	if (!values.watch && !values.id) console.error(`request ${request.requestId}`);
	socket.write(`${JSON.stringify(request)}\n`);
});

let status: string | undefined;
for await (const line of createInterface({ input: socket })) {
	const message = JSON.parse(line) as { type: "line"; text: string } | { type: "done"; status: string };
	if (message.type === "line") console.log(message.text);
	else status = message.status;
}
if (status === undefined && !values.watch) {
	console.error("lost the server before the answer. The run is stored; rerun with the same --id to reattach.");
	process.exit(1);
}
process.exit(status === undefined || status === "done" ? 0 : 1);
