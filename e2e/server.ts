// The web view on a scripted model, for the browser tests: a fresh data directory, a page at
// site.test to fetch, and a model that picks its tool call from the owner's message. Lets in the
// tailnet login given as its argument, prints the port once it listens, and removes the data
// directory when stopped.
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { configFor } from "../src/config.ts";
import { blockedRanges } from "../src/fetch.ts";
import { context, openHost } from "../src/host.ts";
import { createWebServer } from "../src/web.ts";

const user = process.argv[2] ?? "brad@example.com";

const site = createServer((_request, response) => {
	response.writeHead(200, { "Content-Type": "text/plain" });
	response.end("page text");
});
await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
const sitePort = (site.address() as AddressInfo).port;

type Context = { messages: readonly { role: string; content?: unknown }[] };

/** "fetch" fetches site.test, "ask" asks a question, "remind" sets a reminder due now; then it says what came back, in short for a fetch. */
function step(ctx: Context) {
	const last = ctx.messages.at(-1);
	if (last?.role === "toolResult") {
		const result = JSON.stringify(last.content);
		const answer = result.includes("page text") ? "The page says: page text." : result.includes("said no") ? "Brad said no." : `Came back: ${result.slice(0, 300)}`;
		return fauxAssistantMessage(fauxText(answer));
	}
	const said = JSON.stringify(last?.content ?? "");
	const call = (name: string, args: Record<string, string | number | string[]>) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
	if (said.includes("fetch")) return call("fetch_url", { url: `http://site.test:${sitePort}/` });
	if (said.includes("ask")) return call("ask_owner", { question: "Keep the old branch?", choices: ["Yes", "No"] });
	if (said.includes("remind")) return call("remind", { text: "stretch", inMinutes: 0 });
	return fauxAssistantMessage(fauxText("Hello, Brad."));
}

const dir = mkdtempSync(join(tmpdir(), "gaidin-e2e-"));
const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
faux.setResponses(Array.from({ length: 500 }, () => step));
const models = createModels();
models.setProvider(faux.provider);
const host = await openHost({
	config: configFor({ owner: "Brad" }, {}),
	dataDir: dir,
	models,
	model: { provider: "faux", modelId: "faux-1" },
	notify: async () => {},
	fetch: { blocked: blockedRanges({ allowLoopback: true }), resolve: async () => [{ address: "127.0.0.1", family: 4 }] },
});
const web = createWebServer({
	harness: host.harness,
	root: host.root,
	user,
	switchable: host.switchable,
	approvals: host.approvals,
	budget: host.budget,
	timeline: host.timeline,
	snooze: host.reminders.snooze,
});
await new Promise<void>((resolve) => web.listen(0, "127.0.0.1", resolve));
console.log(`port ${(web.address() as AddressInfo).port}`);

async function stop() {
	web.closeAllConnections();
	web.close();
	site.close();
	await host.harness.close(context);
	rmSync(dir, { recursive: true, force: true });
	process.exit(0);
}
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
