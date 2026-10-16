// The web view on a scripted model, for the browser tests: a fresh data directory, a page at
// site.test to fetch, and a model that picks its tool call from the owner's message. Lets in the
// tailnet login given as its first argument, prints the port once it listens, and removes the data
// directory when stopped. A second argument is a directory of moiraine's build to serve at /app/, for moiraine's tests.
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { configFor } from "../src/config.ts";
import { BrowserState } from "../src/browser/index.ts";
import { fakeMcp } from "../test/fake-mcp.ts";
import { blockedRanges } from "../src/fetch.ts";
import { context, startHost } from "../src/host.ts";
import { createWebServer } from "../src/web.ts";

const user = process.argv[2] ?? "brad@example.com";
const app = process.argv[3];

// site.test: plain text, and at /form a page with a field in its top left corner, for the browser's take-over view.
const site = createServer((request, response) => {
	if (request.url === "/form") {
		response.writeHead(200, { "Content-Type": "text/html" });
		return response.end(`<title>Sign in</title><input aria-label="Name" style="position:absolute;left:0;top:0;width:400px;height:60px;font-size:30px">`);
	}
	response.writeHead(200, { "Content-Type": "text/plain" });
	response.end("page text");
});
await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
const sitePort = (site.address() as AddressInfo).port;

type Context = { messages: readonly { role: string; content?: unknown }[] };

/**
 * A message with images is answered with how many it sees, and one with a saved file with where it's saved.
 * Otherwise "fetch" fetches site.test, "ask" asks a question, "remind" sets a reminder due now, "dentist" one due in two hours,
 * "briefing" schedules a weekday job, "soon" a one-off job three seconds away, "hand over" asks Brad to take over browser profile
 * personal, and "markdown" gets a long answer; then it says what came back, in short for a fetch.
 */
function step(ctx: Context) {
	const last = ctx.messages.at(-1);
	if (last?.role === "toolResult") {
		const result = JSON.stringify(last.content);
		const page = /---\\n(.*)"\}\]$/.exec(result)?.[1];
		const answer = result.includes("page text") ? "The page says: page text."
			: result.includes("said no") ? "Brad said no."
			: result.includes("is done with profile") && page !== undefined ? `Back from the browser: ${page}`
			: `Came back: ${result.slice(0, 300)}`;
		return fauxAssistantMessage(fauxText(answer));
	}
	if (Array.isArray(last?.content) && last.content.some((part: { type?: string }) => part.type === "image")) {
		const images = last.content.filter((part: { type?: string }) => part.type === "image").length;
		return fauxAssistantMessage(fauxText(`I can see ${images} image${images === 1 ? "" : "s"}.`));
	}
	const said = JSON.stringify(last?.content ?? "");
	const saved = /saved as (uploads\/[^ ]+)/.exec(said);
	if (saved !== null) return fauxAssistantMessage(fauxText(`It's saved as ${saved[1]}.`));
	const call = (name: string, args: Record<string, string | number | string[]>) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
	if (said.includes("fetch")) return call("fetch_url", { url: `http://site.test:${sitePort}/` });
	if (said.includes("hand over")) return call("browser_hand_over", { profile: "personal", reason: "Sign in to site.test" });
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
// FAUX_TOKENS_PER_SECOND streams answers at about that pace, as a real model does, for watching the app draw them.
const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }], tokensPerSecond: Number(process.env.FAUX_TOKENS_PER_SECOND) || undefined });
faux.setResponses(Array.from({ length: 500 }, () => step));
const models = createModels();
models.setProvider(faux.provider);
// The app's port, found ahead, so a connector's sign-in can come back to it.
const probe = createServer();
await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
const webPort = (probe.address() as AddressInfo).port;
await new Promise((resolve) => probe.close(resolve));
// A connector like Home Assistant's: an MCP server with OAuth on its own host, its tools a read-only search and a send.
const cleanups: (() => unknown)[] = [];
const mcp = await fakeMcp({ after: (cleanup) => cleanups.push(cleanup) }, {
	era: "legacy",
	oauth: {},
	tools: () => [
		{ name: "GetLiveContext", description: "The state of the house", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
		{ name: "HassTurnOn", description: "Turns on a device", inputSchema: { type: "object", properties: { name: { type: "string" } } } },
	],
});

const host = await startHost({
	connectorAppUrl: `http://127.0.0.1:${webPort}`,
	// A browser profile to give agents; Chromium only starts when a tool uses it, which these tests don't.
	config: configFor({ owner: "Brad", browser: { profiles: ["personal"] } }, {}),
	dataDir: dir,
	models,
	model: { provider: "faux", modelId: "faux-1" },
	adapters: { push: { send: async () => true } },
	fetch: { blocked: blockedRanges({ allowLoopback: true }), resolve: async () => [{ address: "127.0.0.1", family: 4 }] },
	chromium: { args: ["--host-resolver-rules=MAP *.test 127.0.0.1"] },
});
// The connector, added and waiting for its first sign-in.
await host.connectors.add({ name: "home", url: mcp.url });
// Taking profile personal over opens it at site.test's form, as if an agent had left it there.
await host.root.commit(async (tx) => {
	(await tx.doc(BrowserState)).profiles.personal = { url: `http://site.test:${sitePort}/form`, agent: "gaidin", at: Date.now() };
}, context);
const web = createWebServer({
	harness: host.harness,
	root: host.root,
	agents: host.agents,
	workspaces: host.workspaces,
	profiles: host.profiles,
	takeOver: host.takeOver,
	connectors: host.connectors,
	rules: host.rules,
	uploads: host.uploads,
	avatars: host.avatars,
	threads: host.threads,
	user,
	app,
	switchable: host.switchable,
	approvals: host.approvals,
	budget: host.budget,
	timeline: host.timeline,
	history: host.history,
	skills: host.skills,
	stop: host.stop,
	snooze: host.reminders.snooze,
});
await new Promise<void>((resolve) => web.listen(webPort, "127.0.0.1", resolve));
console.log(`port ${(web.address() as AddressInfo).port}`);

async function stop() {
	web.closeAllConnections();
	web.close();
	site.close();
	for (const cleanup of cleanups) await cleanup();
	await host.close();
	rmSync(dir, { recursive: true, force: true });
	process.exit(0);
}
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
