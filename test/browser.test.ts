import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { BrowserState, capSnapshot } from "../src/browser/index.ts";
import { Chromium } from "../src/browser/chromium.ts";
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
	const big = Array.from({ length: 400 }, (_, i) => `<p>Paragraph ${i} with some words in it to fill the page</p>`).join("");
	const pages = new Map(Object.entries({
		"/": `<title>Home</title><h1>Welcome</h1><a href="/landing">Landing</a>`,
		"/landing": `<title>Landing</title><h1>Landed</h1>`,
		"/away": `<title>Away</title><h1>Going</h1><script>setTimeout(() => { location.href = "http://other.test:PORT/landing"; }, 50)</script>`,
		"/hop": `<title>Hop</title><script>setTimeout(() => { location.href = "/landing"; }, 50)</script>`,
		"/lan-image": `<title>Picture</title><img src="http://lan.test:PORT/pixel">`,
		"/popup": `<title>Opener</title><script>window.open("/landing")</script>`,
		"/big": `<title>Big</title><nav aria-label="Menu"><a href="/">Home</a><a href="/landing">Landing</a></nav><main>${big}</main>`,
		"/cookie": `<title>Cookie</title><p id="c"></p><script>const before = document.cookie; document.cookie = "kept=1; max-age=3600"; document.getElementById("c").textContent = "before: " + (before || "none");</script>`,
	}));
	const server = createServer((req, res) => {
		const path = new URL(req.url ?? "/", "http://x").pathname;
		hits.set(path, (hits.get(path) ?? 0) + 1);
		const page = pages.get(path);
		res.writeHead(page === undefined ? 404 : 200, { "Content-Type": "text/html" });
		res.end((page ?? "<title>Missing</title>").replaceAll("PORT", String((server.address() as AddressInfo).port)));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise((resolve) => server.close(resolve)));
	const port = (server.address() as AddressInfo).port;
	const names = new Map(Object.entries({ "public.test": "127.0.0.1", "other.test": "127.0.0.1", "lan.test": "192.168.3.177" }));
	const fetch: FetchOptions = {
		blocked: blockedRanges({ allowLoopback: true }),
		resolve: async (host) => {
			const address = names.get(host);
			if (address === undefined) throw new Error(`no ${host}`);
			return [{ address, family: 4 }];
		},
	};
	return { hits, port, fetch, url: (host: string, path = "/") => `http://${host}.test:${port}${path}` };
}

/** gaidin with profiles personal and work, and scout, given personal; approvals answered by `decide` (default: once). */
async function start(t: TestContext, options: { decide?: (r: ApprovalRequest) => "once" | "always" | "deny"; idleMs?: number } = {}) {
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
		void host.approvals.decide(r.id, options.decide?.(r) ?? "once", "test");
	});
	await host.agents.add({ id: "scout", name: "Scout", job: "Reads the web" });
	await host.agents.update("scout", { profiles: ["personal"] });
	const scout = await host.agents.home("scout");
	return { host, scout, asked, ...web };
}

async function say(conversation: Conversation, text: string): Promise<string> {
	const settled = await (await conversation.submit({ type: "input", content: text }, context)).wait(context);
	if (settled.status !== "done" || settled.type !== "input") throw new Error(`the run didn't finish: ${settled.status} ${settled.reason ?? ""}`);
	return assistantText(await conversation.commit((tx) => tx.entry(settled.answer), context)) ?? "";
}

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
	assert.deepEqual(await offered(scout), ["browser_open", "browser_snapshot", "browser_screenshot", "browser_tabs"]);
	// A thread starts with its agent's home settings, browser or not.
	assert.deepEqual(await offered(await host.threads.start({ agent: "scout", origin: "app" })), ["browser_open", "browser_snapshot", "browser_screenshot", "browser_tabs"]);
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
	assert.deepEqual(await offered(host.root), ["browser_open", "browser_snapshot", "browser_screenshot", "browser_tabs"]);
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
	assert.match(lan, new RegExp(`Couldn't open ${url("lan")}: stopped, ${url("lan")} \\(lan.test resolves to 192.168.3.177, a private or reserved address\\)`));
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

