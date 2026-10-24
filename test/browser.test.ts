import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { Conversation } from "@earendil-works/pi-durable";
import { chromium } from "playwright-core";
import type { ApprovalRequest } from "../src/approvals.ts";
import { BrowserState, capSnapshot, partOf } from "../src/browser/index.ts";
import { sandboxOf } from "../src/agents.ts";
import { Chromium } from "../src/browser/chromium.ts";
import { compact, keyOf, type LiveEvent } from "../src/browser/takeover.ts";
import { createWebServer } from "../src/web.ts";
import { blocksFor } from "../src/slack/notifications.ts";
import type { AddressInfo as Address } from "node:net";
import { configFor, loadConfig } from "../src/config.ts";
import { blockedRanges, type FetchOptions } from "../src/fetch.ts";
import { assistantText, context, startHost } from "../src/host.ts";

/** Whether Chromium starts here with its sandbox; the tests that need it are skipped otherwise. */
async function chromiumWorks(): Promise<boolean> {
	const dir = mkdtempSync(join(tmpdir(), "gaidin-chromium-"));
	try {
		await (await chromium.launchPersistentContext(dir, { headless: true, chromiumSandbox: true, timeout: 20_000 })).close();
		return true;
	} catch {
		return false;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
const skip = (await chromiumWorks()) ? false : "Chromium doesn't start here with its sandbox";

type Message = { role: string; content?: unknown };
const textOf = (m: Message) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content));

/** A model that calls the tool a message names (`CALL {...}`), then reports what came back. */
function scripted() {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	const step = (ctx: { messages: readonly Message[] }) => {
		const last = ctx.messages.filter((m) => m.role !== "system").at(-1)!;
		if (last.role === "toolResult") return fauxAssistantMessage(fauxText(`got: ${textOf(last)}`));
		const call = /CALL (\{.*\})/.exec(textOf(last));
		if (call === null) return fauxAssistantMessage(fauxText("ok"));
		const { name, args } = JSON.parse(call[1]!) as { name: string; args: Record<string, unknown> };
		return fauxAssistantMessage(fauxToolCall(name, args as never), { stopReason: "toolUse" });
	};
	faux.setResponses(Array.from({ length: 200 }, () => step));
	const models = createModels();
	models.setProvider(faux.provider);
	return { models, model: { provider: "faux", modelId: "faux-1" } };
}

const CALL = (name: string, args: Record<string, unknown>) => `CALL ${JSON.stringify({ name, args })}`;

/** Pages for every host, which Chromium reaches on loopback. `hits` counts the paths asked for. */
async function site(t: TestContext) {
	const hits = new Map<string, number>();
	/** The bodies of the forms posted to /uploaded. */
	const posted: string[] = [];
	const big = Array.from({ length: 400 }, (_, i) => `<p>Paragraph ${i} with some words in it to fill the page</p>`).join("");
	const pages = new Map(Object.entries({
		"/": `<title>Home</title><h1>Welcome</h1><a href="/landing">Landing</a>`,
		"/landing": `<title>Landing</title><h1>Landed</h1>`,
		"/away": `<title>Away</title><h1>Going</h1><script>setTimeout(() => { location.href = "http://other.test:PORT/landing"; }, 50)</script>`,
		"/hop": `<title>Hop</title><script>setTimeout(() => { location.href = "/landing"; }, 50)</script>`,
		"/lan-image": `<title>Picture</title><img src="http://lan.test:PORT/pixel">`,
		"/popup": `<title>Opener</title><script>window.open("/landing")</script>`,
		"/big": `<title>Big</title><nav aria-label="Menu"><a href="/">Home</a><a href="/landing">Landing</a></nav><main>${big}</main>`,
		"/form": `<title>Form</title><form action="/done"><label>Query <input name="q"></label><select name="size" aria-label="Size"><option value="s">Small</option><option value="m">Medium</option></select><button>Go</button></form>`,
		"/login": `<title>Login</title><label>User <input name="u"></label><label>Pass <input name="p" type="password"></label>`,
		"/file": `<title>File</title><a href="/report.csv" download>Report</a>`,
		"/upload": `<title>Upload</title><form method="post" enctype="multipart/form-data" action="/uploaded"><input type="file" name="f" aria-label="Attachment"><button>Send</button></form>`,
		"/uploaded": `<title>Uploaded</title><p>Thanks</p>`,
		"/confirm": `<title>Confirm</title><button onclick="document.title = confirm('Sure?') ? 'Yes' : 'No'">Delete</button>`,
		"/owner": `<title>Owner</title><input aria-label="Box" style="position:absolute;left:0;top:0;width:300px;height:40px">`,
		"/cookie": `<title>Cookie</title><p id="c"></p><script>const before = document.cookie; document.cookie = "kept=1; max-age=3600"; document.getElementById("c").textContent = "before: " + (before || "none");</script>`,
	}));
	const server = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", "http://x");
		const path = url.pathname;
		hits.set(path, (hits.get(path) ?? 0) + 1);
		if (req.method === "POST") {
			const chunks: Buffer[] = [];
			for await (const chunk of req) chunks.push(chunk as Buffer);
			posted.push(Buffer.concat(chunks).toString());
		}
		if (path === "/done") {
			res.writeHead(200, { "Content-Type": "text/html" });
			return res.end(`<title>Done</title><p>You searched ${url.searchParams.get("q")} in size ${url.searchParams.get("size")}</p>`);
		}
		if (path === "/report.csv") {
			res.writeHead(200, { "Content-Type": "text/csv", "Content-Disposition": 'attachment; filename="report.csv"' });
			return res.end("a,b\n1,2\n");
		}
		const page = pages.get(path);
		res.writeHead(page === undefined ? 404 : 200, { "Content-Type": "text/html" });
		res.end((page ?? "<title>Missing</title>").replaceAll("PORT", String((server.address() as AddressInfo).port)));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise((resolve) => server.close(resolve)));
	const port = (server.address() as AddressInfo).port;
	const names = new Map(Object.entries({ "public.test": "127.0.0.1", "other.test": "127.0.0.1", "lan.test": "192.168.0.177" }));
	const fetch: FetchOptions = {
		blocked: blockedRanges({ allowLoopback: true }),
		resolve: async (host) => {
			const address = names.get(host);
			if (address === undefined) throw new Error(`no ${host}`);
			return [{ address, family: 4 }];
		},
	};
	return { hits, posted, port, fetch, url: (host: string, path = "/") => `http://${host}.test:${port}${path}` };
}

/** gaidin with profiles personal and work, and scout, given personal; approvals answered by `decide` (default: once), or left waiting. */
async function start(t: TestContext, options: { decide?: (r: ApprovalRequest) => "once" | "always" | "deny" | "wait"; idleMs?: number } = {}) {
	const web = await site(t);
	const dir = mkdtempSync(join(tmpdir(), "gaidin-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const host = await startHost({
		config: configFor({ owner: "Brad", browser: { profiles: ["personal", "work"] } }),
		dataDir: dir,
		sandbox: "none",
		...scripted(),
		fetch: web.fetch,
		chromium: { args: ["--host-resolver-rules=MAP *.test 127.0.0.1"], idleMs: options.idleMs },
		adapters: { push: { send: async () => true } },
	});
	t.after(() => host.close());
	const asked: ApprovalRequest[] = [];
	host.approvals.onChange((r) => {
		if (r.status !== "pending") return;
		asked.push(r);
		const decision = options.decide?.(r) ?? "once";
		if (decision !== "wait") void host.approvals.decide(r.id, decision, "test");
	});
	await host.agents.add({ id: "scout", name: "Scout", job: "Reads the web" });
	await host.agents.update("scout", { profiles: ["personal"] });
	const scout = await host.agents.home("scout");
	return { host, dir, scout, asked, ...web };
}

async function say(conversation: Conversation, text: string): Promise<string> {
	const settled = await (await conversation.submit({ type: "input", content: text }, context)).wait(context);
	if (settled.status !== "done" || settled.type !== "input") throw new Error(`the run didn't finish: ${settled.status} ${settled.reason ?? ""}`);
	return assistantText(await conversation.commit((tx) => tx.entry(settled.answer), context)) ?? "";
}

const TOOLS = ["browser_open", "browser_snapshot", "browser_screenshot", "browser_tabs", "browser_click", "browser_type", "browser_select", "browser_back", "browser_upload", "browser_hand_over"];
const offered = async (conversation: Conversation) => (await conversation.agent(context)).tools.map((tool) => tool.name).filter((name) => name.startsWith("browser_"));
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("browser.profiles is a list of names", () => {
	const load = (browser: object) => loadConfig({ env: { GAIDIN_CONFIG: writeSettings({ browser }) }, search: false });
	assert.deepEqual(load({ profiles: ["personal", "work"] }).config.browser, { profiles: ["personal", "work"] });
	assert.match(load({ profiles: ["Personal"] }).errors.join(), /isn't a profile name/);
	assert.match(load({ profiles: ["a", "a"] }).errors.join(), /names a profile twice/);
	assert.match(load({ profiles: [], chromium: "/x" }).errors.join(), /Unknown setting "browser.chromium"/);
	assert.equal(load({ profiles: [] }).config.browser, undefined);
});

/** A settings file holding `settings`, in a directory removed when the process ends. */
function writeSettings(settings: object): string {
	const dir = mkdtempSync(join(tmpdir(), "gaidin-settings-"));
	process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
	const file = join(dir, "gaidin.json");
	writeFileSync(file, JSON.stringify({ model: { provider: "faux" }, ...settings }));
	return file;
}

test("a snapshot is cut at a line's end, saying how long it was", () => {
	assert.deepEqual(capSnapshot("short"), { text: "short" });
	const cut = capSnapshot("line one\nline two\nline three", 15);
	assert.equal(cut.text, "line one");
	assert.match(cut.note!, /first 8 of 28 characters; look closer at one part with browser_snapshot and its ref/);
});

test("a profile goes only to agents given it: another is refused, not asked, and the tools are offered only with one", { skip }, async (t) => {
	const { host, scout, asked, url } = await start(t);
	assert.deepEqual(await offered(host.root), []);
	assert.deepEqual(await offered(scout), TOOLS);
	// A thread starts with its agent's home settings, browser or not.
	assert.deepEqual(await offered(await host.threads.start({ agent: "scout", origin: "app" })), TOOLS);
	assert.deepEqual(await offered(await host.threads.start({ origin: "app" })), []);
	const refused = await say(scout, CALL("browser_open", { profile: "work", url: url("public") }));
	assert.match(refused, /Scout hasn't been given the browser profile work; it has personal\./);
	const unknown = await say(scout, CALL("browser_snapshot", { profile: "bank" }));
	assert.match(unknown, /There's no browser profile bank; Scout has personal\./);
	assert.equal(asked.length, 0);
	await assert.rejects(host.agents.update("scout", { profiles: ["bank"] }), /There's no browser profile bank\./);
	await host.agents.update("scout", { profiles: [] });
	assert.deepEqual(await offered(scout), []);
	assert.equal((await host.agents.list()).find((a) => a.id === "scout")!.profiles, undefined);
	await host.agents.update("gaidin", { profiles: ["work"] });
	assert.deepEqual(await offered(host.root), TOOLS);
});

test("browser_open asks for a host that isn't allowed for good, and gives the page with refs as outside text", { skip }, async (t) => {
	const { host, scout, asked, url } = await start(t, { decide: () => "always" });
	const answer = await say(scout, CALL("browser_open", { profile: "personal", url: url("public") }));
	assert.match(answer, /Profile personal, tab 1 of 1: \\"Home\\"/);
	assert.match(answer, /heading \\"Welcome\\" \[level=1\] \[ref=e\d+\]/);
	assert.match(answer, /not from Brad/);
	assert.deepEqual(asked.map((r) => [r.summary, r.agent, r.always?.value]), [[`open ${url("public")} in browser profile personal`, "scout", "public.test"]]);
	// Allowed for good now, for Scout.
	await say(scout, CALL("browser_open", { profile: "personal", url: url("public", "/landing") }));
	assert.equal(asked.length, 1);
	assert.deepEqual(await host.approvals.hostsFor("scout"), ["public.test"]);
	const state = await host.harness.snapshot(BrowserState, context);
	assert.equal(state?.profiles.personal?.url, url("public", "/landing"));
	assert.equal(state?.profiles.personal?.agent, "scout");
	// What it read is outside text, so a note written now asks.
	await say(scout, CALL("remember", { text: "a note" }));
	assert.match(asked.at(-1)!.summary, /after reading outside text \(browser_open\)/);
});

test("a page's own navigation goes ahead on its host and to hosts allowed for good, and is stopped elsewhere, leaving the page", { skip }, async (t) => {
	const { host, scout, url } = await start(t);
	await host.agents.update("scout", { hosts: ["public.test"] });
	await say(scout, CALL("browser_open", { profile: "personal", url: url("public", "/away") }));
	await pause(500);
	const stopped = await say(scout, CALL("browser_snapshot", { profile: "personal" }));
	assert.match(stopped, new RegExp(`URL: ${url("public", "/away")}`));
	assert.match(stopped, new RegExp(`Note: the page tried to go to ${url("other", "/landing")}, which was stopped; to go there, open it with browser_open`));
	// Said once.
	assert.doesNotMatch(await say(scout, CALL("browser_snapshot", { profile: "personal" })), /tried to go/);

	await say(scout, CALL("browser_open", { profile: "personal", url: url("public", "/hop") }));
	await pause(500);
	assert.match(await say(scout, CALL("browser_snapshot", { profile: "personal" })), new RegExp(`URL: ${url("public", "/landing")}`));

	await host.agents.update("scout", { hosts: ["public.test", "other.test"] });
	await say(scout, CALL("browser_open", { profile: "personal", url: url("public", "/away") }));
	await pause(500);
	assert.match(await say(scout, CALL("browser_snapshot", { profile: "personal" })), new RegExp(`URL: ${url("other", "/landing")}`));
});

test("private addresses are refused, for a page and for what a page loads", { skip }, async (t) => {
	const { scout, url, hits } = await start(t);
	const lan = await say(scout, CALL("browser_open", { profile: "personal", url: url("lan") }));
	assert.match(lan, new RegExp(`Couldn't open ${url("lan")}: the page tried to go to ${url("lan")}, which was refused: lan.test resolves to 192.168.0.177, a private or reserved address`));
	assert.match(await say(scout, CALL("browser_open", { profile: "personal", url: "http://10.1.2.3/" })), /10\.1\.2\.3 is a private or reserved address/);
	await say(scout, CALL("browser_open", { profile: "personal", url: url("public", "/lan-image") }));
	assert.equal(hits.get("/lan-image"), 1);
	assert.equal(hits.get("/pixel"), undefined);
	assert.match(await say(scout, CALL("browser_open", { profile: "personal", url: "file:///etc/passwd" })), /The browser opens http and https URLs, not file:/);
});

test("a long snapshot is cut, and a ref's part comes in full", { skip }, async (t) => {
	const { scout, url } = await start(t);
	const whole = await say(scout, CALL("browser_open", { profile: "personal", url: url("public", "/big") }));
	assert.match(whole, /Note: the snapshot is cut to the first \d+ of \d+ characters/);
	const ref = /navigation \\"Menu\\" \[ref=(e\d+)\]/.exec(whole)?.[1];
	assert.ok(ref !== undefined, whole.slice(0, 2000));
	const part = await say(scout, CALL("browser_snapshot", { profile: "personal", ref }));
	assert.match(part, new RegExp(`--- the part under ${ref}`));
	assert.match(part, /link \\"Landing\\"/);
	assert.doesNotMatch(part, /Paragraph/);
	assert.match(await say(scout, CALL("browser_snapshot", { profile: "personal", ref: "e9999" })), /No element e9999 on the page now/);
});

test("a screenshot comes back as an image", { skip }, async (t) => {
	const { scout, url } = await start(t);
	await say(scout, CALL("browser_open", { profile: "personal", url: url("public") }));
	await say(scout, CALL("browser_screenshot", { profile: "personal" }));
	const result = (await scout.context(context)).messages.filter((m) => m.role === "toolResult").at(-1)!;
	assert.equal(result.role, "toolResult");
	const [text, image] = result.role === "toolResult" ? result.content : [];
	assert.match(text?.type === "text" ? text.text : "", new RegExp(`Screenshot of ${url("public")}`));
	assert.equal(image?.type === "image" ? image.mimeType : "", "image/jpeg");
	assert.ok(image?.type === "image" && Buffer.from(image.data, "base64").subarray(0, 2).equals(Buffer.from([0xff, 0xd8])));
});

test("a tab a page opens becomes current, and tabs are listed, selected and closed", { skip }, async (t) => {
	const { scout, url } = await start(t);
	await say(scout, CALL("browser_open", { profile: "personal", url: url("public", "/popup") }));
	await pause(500);
	const listed = await say(scout, CALL("browser_tabs", { profile: "personal" }));
	assert.match(listed, new RegExp(`1\\. \\\\"Opener\\\\" ${url("public", "/popup")}\\\\n2\\. \\\\"Landing\\\\" ${url("public", "/landing")} \\(current\\)`));
	const selected = await say(scout, CALL("browser_tabs", { profile: "personal", select: 1, close: 2 }));
	assert.match(selected, new RegExp(`1\\. \\\\"Opener\\\\" ${url("public", "/popup")} \\(current\\)`));
	assert.doesNotMatch(selected, /2\./);
	assert.match(await say(scout, CALL("browser_tabs", { profile: "personal", select: 3 })), /There's no tab 3; there are 1\./);
});

test("a profile closes when it's idle, keeps its cookies, and reopens at its last page", { skip }, async (t) => {
	const { scout, url } = await start(t, { idleMs: 200 });
	assert.match(await say(scout, CALL("browser_open", { profile: "personal", url: url("public", "/cookie") })), /before: none/);
	await pause(1000);
	const reopened = await say(scout, CALL("browser_snapshot", { profile: "personal" }));
	assert.match(reopened, new RegExp(`URL: ${url("public", "/cookie")}`));
	assert.match(reopened, /before: kept=1/);
});

test("at most maxOpen profiles are open, the least recently used idle one closing first", { skip }, async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "gaidin-chromium-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const browsers = new Chromium({ dir, maxOpen: 2 });
	t.after(() => browsers.close());
	const use = (name: string) => browsers.use(name, { hosts: [] }, async (p) => p.name);
	assert.equal(await use("a"), "a");
	assert.equal(await use("b"), "b");
	assert.equal(await use("a"), "a");
	assert.equal(await use("c"), "c");
	assert.deepEqual(["a", "b", "c"].map((n) => browsers.isOpen(n)), [true, false, true]);
});


const ref = (text: string, line: RegExp) => new RegExp(`${line.source} \\[ref=(\\w+)\\]`).exec(text.replaceAll('\\"', '"'))?.[1] ?? "none";

test("a ref's part is cut from the snapshot by indentation", () => {
	const snapshot = ["- main [ref=e1]:", "  - list [ref=e2]:", "    - listitem [ref=e3]: one", "    - listitem [ref=e4]: two", "  - button \"Go\" [ref=e5]"].join("\n");
	assert.equal(partOf(snapshot, "e2"), ["- list [ref=e2]:", "  - listitem [ref=e3]: one", "  - listitem [ref=e4]: two"].join("\n"));
	assert.equal(partOf(snapshot, "e5"), "- button \"Go\" [ref=e5]");
	assert.equal(partOf(snapshot, "e9"), undefined);
});

test("acting asks after a page, naming the element and host, and acting without asking lets later actions through", { skip }, async (t) => {
	const { host, scout, asked, url } = await start(t, { decide: (r) => (r.tool === "browser_click" ? "always" : "once") });
	await host.agents.update("scout", { hosts: ["public.test"] });
	const page = await say(scout, CALL("browser_open", { profile: "personal", url: url("public", "/form") }));
	assert.equal(asked.length, 0);
	// Looking closer at a part keeps the page's refs.
	await say(scout, CALL("browser_snapshot", { profile: "personal", ref: ref(page, /combobox "Size"/) }));
	const box = ref(page, /textbox "Query"/);
	const clicked = await say(scout, CALL("browser_click", { profile: "personal", ref: box }));
	assert.match(clicked, /Profile personal, tab 1 of 1: \\"Form\\"/);
	assert.deepEqual(asked.map((r) => [r.tool, r.summary, r.always?.kind, r.always?.value]), [
		["browser_click", `click textbox "Query" [ref=${box}] on public.test in browser profile personal, after reading outside text (browser_open, browser_snapshot)`, "act-host", "personal/public.test"],
	]);
	assert.deepEqual((await host.agents.list()).find((a) => a.id === "scout")?.actHosts, { personal: ["public.test"] });
	// Allowed for that host now: these don't ask.
	await say(scout, CALL("browser_select", { profile: "personal", ref: ref(page, /combobox "Size"/), values: ["Medium"] }));
	const done = await say(scout, CALL("browser_type", { profile: "personal", ref: box, text: "lanterns", submit: true }));
	assert.match(done, /You searched lanterns in size m/);
	assert.equal(asked.length, 1);
	// Another agent with the profile still asks.
	await host.agents.update("gaidin", { profiles: ["personal"] });
	await host.approvals.setFetchHosts(["public.test"]);
	const theirs = await say(host.root, CALL("browser_open", { profile: "personal", url: url("public", "/form") }));
	await say(host.root, CALL("browser_click", { profile: "personal", ref: ref(theirs, /button "Go"/) }));
	assert.deepEqual(asked.map((r) => r.agent), ["scout", undefined]);
});

test("a password field is refused, not asked, and a ref that isn't in the last snapshot isn't acted on", { skip }, async (t) => {
	const { host, scout, asked, url } = await start(t);
	await host.agents.update("scout", { hosts: ["public.test"] });
	const page = await say(scout, CALL("browser_open", { profile: "personal", url: url("public", "/login") }));
	const refused = await say(scout, CALL("browser_type", { profile: "personal", ref: ref(page, /textbox "Pass"/), text: "hunter2" }));
	assert.match(refused, /That's a password field\. Passwords aren't typed by the model; tell Brad the page needs signing in\./);
	assert.equal(asked.length, 0);
	assert.match(await say(scout, CALL("browser_click", { profile: "personal", ref: "e999" })), /No element e999 in the page's last snapshot; take a new snapshot/);
	assert.equal(asked.length, 0);
});

test("a page that changes while the owner is asked isn't acted on", { skip }, async (t) => {
	const { host, scout, asked, url } = await start(t, { decide: (r) => (r.agent === "scout" && r.tool === "browser_click" ? "wait" : "once") });
	await host.agents.update("scout", { hosts: ["public.test"] });
	await host.agents.update("gaidin", { profiles: ["personal"] });
	const page = await say(scout, CALL("browser_open", { profile: "personal", url: url("public", "/form") }));
	const answer = say(scout, CALL("browser_click", { profile: "personal", ref: ref(page, /button "Go"/) }));
	const waiting = await until(() => asked.find((r) => r.tool === "browser_click"));
	// Meanwhile gaidin takes the profile to the same form on another host.
	await say(host.root, CALL("browser_open", { profile: "personal", url: url("other", "/form") }));
	await host.approvals.decide(waiting.id, "once", "test");
	assert.match(await answer, /The page changed while Brad was asked: it was button \\"Go\\" \[ref=\w+\] on public\.test, and now .* on other\.test\. Take a new snapshot and try again\./);
});

test("a download lands read-only in the agent's downloads/, and a dialog is dismissed and reported", { skip }, async (t) => {
	const { host, dir, scout, url } = await start(t);
	await host.agents.update("scout", { hosts: ["public.test"], actHosts: { personal: ["public.test"] } });
	const page = await say(scout, CALL("browser_open", { profile: "personal", url: url("public", "/file") }));
	const clicked = await say(scout, CALL("browser_click", { profile: "personal", ref: ref(page, /link "Report"/) }));
	const saved = /saved as (downloads\/[\w-]+-report\.csv) \(1 KB\); it's from the web/.exec(clicked)?.[1];
	assert.ok(saved !== undefined, clicked);
	assert.equal(readFileSync(join(sandboxOf(dir, "scout"), saved), "utf8"), "a,b\n1,2\n");
	assert.equal(existsSync(join(sandboxOf(dir, "gaidin"), "downloads")) && readdirSync(join(sandboxOf(dir, "gaidin"), "downloads")).length, 0);

	const confirm = await say(scout, CALL("browser_open", { profile: "personal", url: url("public", "/confirm") }));
	const answered = await say(scout, CALL("browser_click", { profile: "personal", ref: ref(confirm, /button "Delete"/) }));
	assert.match(answered, /Note: the page showed a confirm dialog, \\"Sure\?\\", which was dismissed\./);
	assert.match(answered, /tab 1 of 1: \\"No\\"/);
});

test("an upload asks every time, naming the files, and only the agent's own files go", { skip }, async (t) => {
	const { host, dir, scout, asked, posted, url } = await start(t);
	await host.agents.update("scout", { hosts: ["public.test"], actHosts: { personal: ["public.test"] } });
	writeFileSync(join(sandboxOf(dir, "scout"), "notes.txt"), "lantern notes");
	const page = await say(scout, CALL("browser_open", { profile: "personal", url: url("public", "/upload") }));
	const field = ref(page, /button "Attachment"/);
	await say(scout, CALL("browser_upload", { profile: "personal", ref: field, files: ["notes.txt"] }));
	assert.deepEqual(asked.map((r) => [r.summary, r.always]), [[`upload notes.txt from the sandbox into button "Attachment" [ref=${field}] on public.test in browser profile personal, after reading outside text (browser_open)`, undefined]]);
	await say(scout, CALL("browser_click", { profile: "personal", ref: ref(page, /button "Send"/) }));
	assert.match(posted.join(), /filename="notes\.txt"[\s\S]*lantern notes/);
	assert.match(await say(scout, CALL("browser_upload", { profile: "personal", ref: field, files: ["/etc/hostname"] })), /Can't upload \/etc\/hostname/);
});

test("browser_back returns to the page before, and says when there's none", { skip }, async (t) => {
	const { host, scout, url } = await start(t);
	await host.agents.update("scout", { hosts: ["public.test"], actHosts: { personal: ["public.test"] } });
	const page = await say(scout, CALL("browser_open", { profile: "personal", url: url("public") }));
	assert.match(await say(scout, CALL("browser_click", { profile: "personal", ref: ref(page, /link "Landing"/) })), new RegExp(`URL: ${url("public", "/landing")}`));
	assert.match(await say(scout, CALL("browser_back", { profile: "personal" })), new RegExp(`URL: ${url("public")}\\\\n`));
	// A profile that hasn't opened anything has nowhere to go back to.
	await host.agents.update("gaidin", { profiles: ["work"] });
	assert.match(await say(host.root, CALL("browser_back", { profile: "work" })), /There's no earlier page in this tab\./);
});

async function until<T>(get: () => T | undefined, timeoutMs = 10_000): Promise<T> {
	const end = Date.now() + timeoutMs;
	for (;;) {
		const value = get();
		if (value !== undefined) return value;
		if (Date.now() > end) throw new Error("timed out");
		await pause(20);
	}
}

test("the owner's keys are the ones the view may press", () => {
	assert.equal(keyOf("Enter"), "Enter");
	assert.equal(keyOf("a"), "a");
	assert.equal(keyOf("Control+a"), "Control+a");
	assert.equal(keyOf("Shift+ArrowLeft"), "Shift+ArrowLeft");
	assert.equal(keyOf("Space"), " ");
	assert.equal(keyOf("F12"), undefined);
	assert.equal(keyOf("Control+Control+a"), undefined);
	assert.equal(keyOf("Hyper+a"), undefined);
	assert.equal(keyOf("+"), undefined);
});

test("the owner's input is played in as few steps as have the same effect", () => {
	const wheel = (dy: number, x = 10) => ({ type: "wheel" as const, x, y: 10, dx: 0, dy });
	const move = (x: number) => ({ type: "move" as const, x, y: 10 });
	assert.deepEqual(compact([wheel(8), wheel(8), wheel(-4, 20)]), [{ ...wheel(12, 20) }]);
	assert.deepEqual(compact([move(1), move(2), move(3)]), [move(3)]);
	assert.deepEqual(compact([move(1), wheel(8), move(2), { type: "click", x: 5, y: 5 }, move(4)]), [wheel(8), { type: "click", x: 5, y: 5 }, move(4)]);
	// Text and keys between them keep the order.
	assert.deepEqual(compact([wheel(8), { type: "text", text: "a" }, wheel(8)]), [wheel(8), { type: "text", text: "a" }, wheel(8)]);
});

test("a hand-over in Slack has Done and Can't, and says how it ended", () => {
	const request: ApprovalRequest = { id: "h1", conversationId: 1, taskId: 2, tool: "browser_hand_over", summary: "Sign in to the shop", kind: "handover", profile: "personal", createdAt: 0, expiresAt: 1, status: "pending" };
	const asked = JSON.stringify(blocksFor(request));
	assert.match(asked, /take over browser profile \*personal\*: Sign in to the shop/);
	assert.doesNotMatch(asked, /"url"/);
	assert.match(asked, /"text":"Done".*"value":"\{\\"id\\":\\"h1\\",\\"decision\\":\\"once\\"\}"/);
	assert.match(asked, /"text":"Can't"/);
	assert.match(JSON.stringify(blocksFor({ ...request, status: "approved", by: "web" })), /Done in the app\./);
	assert.match(JSON.stringify(blocksFor({ ...request, status: "denied", by: "slack" })), /You couldn't in Slack\./);
});

test("while the owner has a profile, an agent's call on it waits; the owner goes anywhere public and types, and refs from before don't act", { skip }, async (t) => {
	const { host, scout, url } = await start(t);
	await host.agents.update("scout", { hosts: ["public.test"], actHosts: { personal: ["public.test"] } });
	const before = await say(scout, CALL("browser_open", { profile: "personal", url: url("public", "/form") }));
	const events: LiveEvent[] = [];
	const stop = await host.takeOver!.watch("personal", (event) => (events.push(event), true));
	assert.ok(events.some((e) => e.type === "page" && e.url === url("public", "/form")));
	await until(() => events.find((e) => e.type === "frame" && e.width === 1280));

	// Not one of Scout's hosts, but the owner can go there.
	await host.takeOver!.go("personal", { url: url("other", "/owner") });
	await host.takeOver!.input("personal", [{ type: "click", x: 10, y: 10 }, { type: "text", text: "owner typed" }, { type: "key", key: "Shift+Home" }]);
	let settled = false;
	const waiting = say(scout, CALL("browser_snapshot", { profile: "personal" })).then((answer) => ((settled = true), answer));
	await pause(500);
	assert.equal(settled, false);
	await until(() => events.find((e) => e.type === "page" && e.url === url("other", "/owner")));
	assert.equal(await host.takeOver!.release("personal", "you're done"), true);
	assert.deepEqual(events.at(-1), { type: "released", reason: "you're done" });
	stop();
	const after = await waiting;
	assert.match(after, new RegExp(`URL: ${url("other", "/owner")}`));
	assert.match(after, /textbox \\"Box\\" \[active\] \[ref=\w+\]: owner typed/);

	// A hold, even one that changes nothing, drops the refs from before it.
	await say(scout, CALL("browser_open", { profile: "personal", url: url("public", "/form") }));
	const page = await say(scout, CALL("browser_snapshot", { profile: "personal" }));
	(await host.takeOver!.watch("personal", () => true))();
	await host.takeOver!.release("personal", "you're done");
	assert.match(await say(scout, CALL("browser_click", { profile: "personal", ref: ref(page, /button "Go"/) })), /No element \w+ in the page's last snapshot/);
	assert.match(before, /Form/);
	await assert.rejects(host.takeOver!.input("personal", [{ type: "text", text: "x" }]), /isn't taken over/);
});

test("browser_hand_over waits for the owner, through the app's routes: the live view, input, and Done", { skip }, async (t) => {
	const { host, scout, asked, url } = await start(t, { decide: (r) => (r.kind === "handover" ? "wait" : "once") });
	await host.agents.update("scout", { hosts: ["public.test"] });
	await say(scout, CALL("browser_open", { profile: "personal", url: url("public") }));
	const server = createWebServer({ harness: host.harness, root: host.root, agents: host.agents, threads: host.threads, user: "brad@example.com", profiles: host.profiles, takeOver: host.takeOver, switchable: host.switchable, approvals: host.approvals });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(async () => {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	});
	const base = `http://127.0.0.1:${(server.address() as Address).port}`;
	const headers = { "Tailscale-User-Login": "brad@example.com" };
	const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", body: JSON.stringify(body), headers: { ...headers, "Content-Type": "application/json" } });
	type Listed = { name: string; url?: string; agent?: string; held: boolean };
	const listed = async () => (await (await fetch(`${base}/api/browser`, { headers })).json()) as Listed[];

	assert.deepEqual((await listed()).map((p) => [p.name, p.url, p.agent, p.held]), [["personal", url("public"), "scout", false], ["work", undefined, undefined, false]]);
	assert.equal((await post("/api/browser/input", { profile: "personal", events: [{ type: "text", text: "x" }] })).status, 409);
	assert.equal((await fetch(`${base}/api/browser/live?profile=bank`, { headers })).status, 404);
	// Another site can't take the profile over from the owner's browser.
	assert.equal((await fetch(`${base}/api/browser/live?profile=personal`, { headers: { ...headers, "Sec-Fetch-Site": "cross-site" } })).status, 403);
	assert.equal((await listed())[0]!.held, false);

	const answer = say(scout, CALL("browser_hand_over", { profile: "personal", reason: "Sign in to the shop" }));
	const request = await until(() => asked.find((r) => r.kind === "handover"));
	assert.deepEqual([request.tool, request.summary, request.profile, request.agent], ["browser_hand_over", "Sign in to the shop", "personal", "scout"]);

	const live = await fetch(`${base}/api/browser/live?profile=personal`, { headers });
	assert.equal(live.headers.get("content-type"), "text/event-stream");
	const reader = live.body!.pipeThrough(new TextDecoderStream()).getReader();
	const seen: LiveEvent[] = [];
	let buffer = "";
	const read = async (check: () => boolean) => {
		while (!check()) {
			const { value, done } = await reader.read();
			if (done) return;
			buffer += value;
			let end: number;
			while ((end = buffer.indexOf("\n\n")) >= 0) {
				const frame = buffer.slice(0, end);
				buffer = buffer.slice(end + 2);
				if (frame.startsWith("data: ")) seen.push(JSON.parse(frame.slice(6)) as LiveEvent);
			}
		}
	};
	await read(() => seen.some((e) => e.type === "frame"));
	assert.ok(seen.some((e) => e.type === "page" && e.title === "Home"));
	assert.equal((await listed())[0]!.held, true);
	assert.equal((await post("/api/browser/go", { profile: "personal", url: "file:///etc/passwd" })).status, 400);
	assert.equal((await post("/api/browser/go", { profile: "personal", url: url("other", "/owner") })).status, 200);
	assert.equal((await post("/api/browser/input", { profile: "personal", events: [{ type: "click", x: 10, y: 10 }, { type: "text", text: "signed in" }] })).status, 200);
	assert.equal((await post("/api/browser/input", { profile: "personal", events: [{ type: "key", key: "F12" }] })).status, 400);

	assert.equal((await post("/api/browser/release", { profile: "personal" })).status, 200);
	await read(() => seen.some((e) => e.type === "released"));
	assert.deepEqual(seen.at(-1), { type: "released", reason: "you're done" });
	const done = await answer;
	assert.match(done, /Brad is done with profile personal\./);
	assert.match(done, /textbox \\"Box\\".*: signed in/);
	assert.equal((await listed())[0]!.held, false);
	assert.equal((await host.approvals.state()).requests[request.id]?.status, "approved");
});

test("browser_hand_over says when the owner couldn't", { skip }, async (t) => {
	const { scout } = await start(t, { decide: (r) => (r.kind === "handover" ? "deny" : "once") });
	assert.match(await say(scout, CALL("browser_hand_over", { profile: "personal", reason: "Solve the CAPTCHA" })), /Not taken over: Brad couldn't do it\./);
});
