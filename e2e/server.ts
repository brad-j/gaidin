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
import { context, startHost } from "../src/host.ts";
import { createWebServer } from "../src/web.ts";

const user = process.argv[2] ?? "brad@example.com";

const site = createServer((_request, response) => {
	response.writeHead(200, { "Content-Type": "text/plain" });
	response.end("page text");
});
await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
const sitePort = (site.address() as AddressInfo).port;

type Context = { messages: readonly { role: string; content?: unknown }[] };

/**
 * "fetch" fetches site.test, "ask" asks a question, "remind" sets a reminder due now, "dentist" one due in two hours,
 * "briefing" schedules a weekday job, "soon" a one-off job three seconds away, and "markdown" gets a long answer; then it says what came back, in short for a fetch.
 */
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
	if (said.includes("markdown")) return fauxAssistantMessage(fauxText(RICH));
	if (said.includes("dentist")) return call("remind", { text: "Call the dentist", inMinutes: 120 });
	if (said.includes("soon")) return call("schedule_job", { title: "Quick weather check", instruction: "Check the weather once.", at: new Date(Date.now() + 3000).toISOString() });
	if (said.includes("briefing")) return call("schedule_job", { title: "Morning briefing", instruction: "Summarise the weather and today's calendar.", time: "07:30", days: "weekdays" });
	if (said.includes("remind")) return call("remind", { text: "stretch", inMinutes: 0 });
	return fauxAssistantMessage(fauxText("Hello, Brad."));
}

/** A long answer with each kind of Markdown the log renders, for "markdown". */
const RICH = [
	"Here's where things stand on **think-2** this morning.",
	"",
	"## Backups",
	"",
	"- `vm-104` finished at 03:12, 41 GB",
	"- `vm-107` failed: the NAS share was asleep",
	"- Next run tonight at 03:00",
	"",
	"```sh",
	"ssh think-2 'pvesm status | grep nas'",
	"```",
	"",
	"| Host | Disk | Memory |",
	"|---|---|---|",
	"| think-1 | 61% | 48% |",
	"| think-2 | 87% | 72% |",
	"",
	"I'd wake the NAS before tonight's run, or move `vm-107` to local storage.",
].join("\n");

const dir = mkdtempSync(join(tmpdir(), "gaidin-e2e-"));
const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
faux.setResponses(Array.from({ length: 500 }, () => step));
const models = createModels();
models.setProvider(faux.provider);
const host = await startHost({
	config: configFor({ owner: "Brad" }, {}),
	dataDir: dir,
	models,
	model: { provider: "faux", modelId: "faux-1" },
	adapters: { push: { send: async () => true } },
	fetch: { blocked: blockedRanges({ allowLoopback: true }), resolve: async () => [{ address: "127.0.0.1", family: 4 }] },
});
const web = createWebServer({
	harness: host.harness,
	root: host.root,
	agents: host.agents,
	threads: host.threads,
	user,
	switchable: host.switchable,
	approvals: host.approvals,
	budget: host.budget,
	timeline: host.timeline,
	history: host.history,
	skills: host.skills,
	stop: host.stop,
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
