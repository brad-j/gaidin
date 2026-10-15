import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { AgentDoc, type Conversation } from "@earendil-works/pi-durable";
import { AgentOf } from "../src/agents.ts";
import { configFor } from "../src/config.ts";
import { assistantText, context, startHost } from "../src/host.ts";
import { conversationId } from "../src/ids.ts";
import { Jobs } from "../src/jobs.ts";
import type { Notice } from "../src/notifications.ts";
import { Reminders } from "../src/reminders.ts";
import { ThreadOrigin } from "../src/threads.ts";
import { createWebServer, type Gets, PROTOCOL } from "../src/web.ts";

const BRAD = "brad@example.com";
type Message = { role: string; content?: unknown };
const textOf = (m: Message) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content));

/**
 * A model that calls a tool when a message says `CALL {"name": ..., "args": ...}`, and otherwise echoes the message
 * with the agent's name, read from the system prompt. After a tool, it reports what came back.
 */
function scripted() {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	const step = (ctx: { messages: readonly Message[] }) => {
		const system = ctx.messages.filter((m) => m.role === "system").map((m) => JSON.stringify(m)).join("\n");
		const who = /You are ([^,]+),/.exec(system)?.[1] ?? "?";
		const last = ctx.messages.filter((m) => m.role !== "system").at(-1)!;
		if (last.role === "toolResult") return fauxAssistantMessage(fauxText(`${who} got: ${textOf(last)}`));
		const call = /CALL (\{.*\})/.exec(textOf(last));
		if (call !== null) {
			const { name, args } = JSON.parse(call[1]!) as { name: string; args: Record<string, unknown> };
			return fauxAssistantMessage(fauxToolCall(name, args as never), { stopReason: "toolUse" });
		}
		return fauxAssistantMessage(fauxText(`${who} heard: ${textOf(last).replace(/^\[[^\]]*\] /, "")}`));
	};
	faux.setResponses(Array.from({ length: 200 }, () => step));
	const models = createModels();
	models.setProvider(faux.provider);
	return { models, model: { provider: "faux", modelId: "faux-1" } };
}

const CALL = (name: string, args: Record<string, unknown>) => `CALL ${JSON.stringify({ name, args })}`;

/** gaidin with a second agent, scout, behind the web server, with every approval allowed once. */
async function start(t: TestContext) {
	const dir = mkdtempSync(join(tmpdir(), "gaidin-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const notices: Notice[] = [];
	const host = await startHost({
		config: configFor({ owner: "Brad" }),
		dataDir: dir,
		sandbox: "none",
		...scripted(),
		adapters: { push: { send: async (notice) => (notices.push(notice), true) } },
	});
	host.approvals.onChange((r) => {
		if (r.status === "pending") void host.approvals.decide(r.id, "once", "test");
	});
	await host.agents.add({ id: "scout", name: "Scout", job: "Finds things out" });
	const scout = await host.agents.home("scout");
	const server = createWebServer({
		harness: host.harness,
		root: host.root,
		agents: host.agents,
		threads: host.threads,
		user: BRAD,
		switchable: host.switchable,
		approvals: host.approvals,
		history: host.history,
		stop: host.stop,
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(async () => {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
		await host.harness.close(context);
	});
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const call = (path: string, init: RequestInit = {}) => fetch(base + path, { ...init, headers: { "Tailscale-User-Login": BRAD, ...(init.headers as Record<string, string>) } });
	const post = (path: string, body: unknown) => call(path, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
	const get = async <P extends keyof Gets>(path: P, query = ""): Promise<Gets[P]> => {
		const response = await call(path + query);
		assert.equal(response.status, 200, `${path}${query}: ${response.status}`);
		return (await response.json()) as Gets[P];
	};
	return { host, scout, notices, call, post, get };
}

/** Sends `text` and gives back the answer. */
async function say(conversation: Conversation, text: string): Promise<string> {
	const settled = await (await conversation.submit({ type: "input", content: text }, context)).wait(context);
	if (settled.status !== "done" || settled.type !== "input") throw new Error(`the run didn't finish: ${settled.status} ${settled.reason ?? ""}`);
	return assistantText(await conversation.commit((tx) => tx.entry(settled.answer), context)) ?? "";
}

/** The text of every message in a conversation's history, its parent's included, oldest first, once it's idle. */
async function transcript(host: Awaited<ReturnType<typeof start>>["host"], id: number): Promise<string[]> {
	const conversation = (await host.harness.conversation(conversationId(id), context))!;
	await conversation.waitForIdle(context);
	const entries = await conversation.commit((tx) => tx.scanEntries({ conversationId: conversation.id, order: "ascending" }, 500), context);
	const words = (content: unknown) => (Array.isArray(content) ? content.flatMap((c: { type: string; text?: string }) => (c.type === "text" ? [c.text] : [])).join("") : String(content));
	return entries.items.flatMap((e) => (e.model ?? []).flatMap((m) => (m.role === "user" || m.role === "assistant" ? [words(m.content).replace(/^\[[^\]]*\] /, "")] : [])));
}

async function until<T>(get: () => T | undefined | Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
	const end = Date.now() + timeoutMs;
	for (;;) {
		const value = await get();
		if (value !== undefined) return value;
		if (Date.now() > end) throw new Error("timed out");
		await new Promise((r) => setTimeout(r, 20));
	}
}

test("a thread started from the app has its agent's home settings and none of its history, and the same request finds it again", async (t) => {
	const { host, scout, post, get } = await start(t);
	await scout.configure({ instructions: "Scout's rules" }, context);
	await say(scout, "something from earlier");

	const started = await post("/api/threads/start", { agent: "scout", content: "hello", requestId: "t1" });
	assert.equal(started.status, 200);
	const { conversation } = (await started.json()) as { conversation: number };
	assert.deepEqual(await transcript(host, conversation), ["hello", "Scout heard: hello"]);
	const id = conversationId(conversation);
	assert.equal((await host.harness.snapshot(AgentOf, id, context))?.agent, "scout");
	assert.equal((await host.harness.snapshot(ThreadOrigin, id, context))?.origin, "app");
	assert.equal((await host.harness.snapshot(AgentDoc, id, context))?.instructions, "Scout's rules");

	const again = (await (await post("/api/threads/start", { agent: "scout", content: "hello", requestId: "t1" })).json()) as { conversation: number };
	assert.equal(again.conversation, conversation);
	assert.deepEqual(await transcript(host, conversation), ["hello", "Scout heard: hello"]);

	const listed = await until(async () => (await get("/api/conversations", "?agent=scout")).items.find((c) => c.id === conversation));
	assert.equal(listed.place, "thread");
	assert.equal(listed.origin, "app");
	assert.equal(listed.agent, "scout");
	assert.ok(!(await get("/api/conversations")).items.some((c) => c.id === conversation), "the default agent's list has only its own");
	assert.equal((await post("/api/threads/start", { agent: "nobody", content: "hello" })).status, 404);
});

test("a message to a thread continues it, and one to a job run forks the run at its last answer", async (t) => {
	const { host, notices, post } = await start(t);
	const { conversation: thread } = (await (await post("/api/threads/start", { content: "first" })).json()) as { conversation: number };
	await transcript(host, thread);
	const next = (await (await post("/api/message", { conversation: thread, content: "second" })).json()) as { conversation: number };
	assert.equal(next.conversation, thread);
	assert.deepEqual(await transcript(host, thread), ["first", "gaidin heard: first", "second", "gaidin heard: second"]);

	await say(host.root, CALL("schedule_job", { title: "Check", instruction: "look around", at: new Date(Date.now() + 1500).toISOString() }));
	const report = await until(() => notices.find((n) => n.kind === "report"));
	if (report.kind !== "report") throw new Error("not a report");
	const run = report.report.conversationId;
	const sent = (await (await post("/api/message", { conversation: run, content: "tell me more", requestId: "m1" })).json()) as { conversation: number };
	assert.notEqual(sent.conversation, run);
	const forked = await transcript(host, sent.conversation);
	assert.match(forked.at(-3)!, /^gaidin heard: .*look around/s, "the fork has the run's report");
	assert.deepEqual(forked.slice(-2), ["tell me more", "gaidin heard: tell me more"]);
	assert.equal((await host.harness.snapshot(ThreadOrigin, conversationId(sent.conversation), context))?.origin, "app");
	const again = (await (await post("/api/message", { conversation: run, content: "tell me more", requestId: "m1" })).json()) as { conversation: number };
	assert.equal(again.conversation, sent.conversation, "the same request goes to the same fork");
});

test("a request that names a conversation or agent is checked", async (t) => {
	const { scout, call, post } = await start(t);
	assert.equal((await post("/api/message", { conversation: 9999, content: "hi" })).status, 404);
	assert.equal((await post("/api/message", { conversation: scout.id, agent: "gaidin", content: "hi" })).status, 400);
	assert.equal((await post("/api/message", { agent: "nobody", content: "hi" })).status, 404);
	assert.equal((await post("/api/abort", { conversation: 9999 })).status, 404);
	assert.equal((await call("/events?conversation=9999")).status, 404);
	assert.equal((await call("/api/settings?agent=nobody")).status, 404);
});

test("the event stream follows the conversation it names, or the agent's home", async (t) => {
	const { host, scout, call, post } = await start(t);
	await say(scout, "scout's own");
	const { conversation } = (await (await post("/api/threads/start", { content: "in a thread" })).json()) as { conversation: number };
	await transcript(host, conversation);
	const first = async (path: string) => {
		const response = await call(path);
		const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
		let buffer = "";
		while (!buffer.includes("\n\n")) buffer += (await reader.read()).value ?? "";
		await reader.cancel();
		return buffer.slice("data: ".length, buffer.indexOf("\n\n"));
	};
	const thread = await first(`/events?conversation=${conversation}`);
	assert.match(thread, /"type":"snapshot"/);
	assert.match(thread, /in a thread/);
	assert.match(await first("/events?agent=scout"), /scout's own/);
	assert.doesNotMatch(await first("/events"), /scout's own|in a thread/);
});

test("settings, notes, reminders and jobs are the named agent's", async (t) => {
	const { host, scout, post, get } = await start(t);
	assert.deepEqual(await get("/api/version"), { protocol: PROTOCOL });

	assert.equal((await post("/api/settings", { agent: "scout", instructions: "Scout only" })).status, 200);
	assert.equal((await get("/api/settings", "?agent=scout")).instructions, "Scout only");
	assert.equal((await get("/api/settings")).instructions, "");

	const note = (await (await post("/api/memory/add", { agent: "scout", work: true, text: "scout's work" })).json()) as { id: number };
	assert.equal((await post("/api/memory/add", { text: "about Brad" })).status, 200);
	const theirs = await get("/api/memory", "?agent=scout");
	assert.deepEqual([theirs.notes.map((n) => n.text), theirs.work.map((n) => n.text)], [["about Brad"], ["scout's work"]]);
	assert.deepEqual((await get("/api/memory")).work, []);
	assert.equal((await post("/api/memory/update", { agent: "scout", work: true, id: note.id, text: "changed" })).status, 200);
	assert.equal((await get("/api/memory", "?agent=scout")).work[0]!.text, "changed");
	assert.equal((await post("/api/memory/forget", { agent: "scout", work: true, id: note.id })).status, 200);
	assert.deepEqual((await get("/api/memory", "?agent=scout")).work, []);
	assert.equal((await post("/api/memory/add", { agent: "nobody", work: true, text: "x" })).status, 404);

	await say(scout, CALL("remind", { text: "Scout's reminder", inMinutes: 60 }));
	await say(scout, CALL("schedule_job", { title: "Scout's job", instruction: "check", every: "1d" }));
	await say(host.root, CALL("remind", { text: "gaidin's reminder", inMinutes: 60 }));
	assert.deepEqual((await get("/api/reminders", "?agent=scout")).map((r) => r.text), ["Scout's reminder"]);
	assert.deepEqual((await get("/api/reminders")).map((r) => r.text), ["gaidin's reminder"]);
	assert.deepEqual((await get("/api/jobs", "?agent=scout")).map((j) => j.title), ["Scout's job"]);
	assert.deepEqual(await get("/api/jobs"), []);
});

test("agents are made, changed, archived and restored, and archiving stops their jobs and reminders", async (t) => {
	const { host, post, get } = await start(t);
	assert.equal((await post("/api/agents/save", { id: "keeper", job: "Keeps" })).status, 400, "a new agent needs a name");
	const made = await post("/api/agents/save", { id: "keeper", name: "Keeper", job: "Keeps things" });
	assert.equal(made.status, 200);
	assert.ok((await get("/api/agents")).some((a) => a.id === "keeper" && a.name === "Keeper"));
	const changed = (await (await post("/api/agents/save", { id: "keeper", job: "Keeps everything", canMessage: ["scout"] })).json()) as { job: string; canMessage: string[] };
	assert.deepEqual([changed.job, changed.canMessage], ["Keeps everything", ["scout"]]);
	assert.equal((await post("/api/agents/save", { id: "keeper", canMessage: ["nobody"] })).status, 400);
	assert.equal((await post("/api/agents/save", { id: "Not An Id", name: "x" })).status, 400);

	const keeper = await host.agents.home("keeper");
	const { conversation: thread } = (await (await post("/api/threads/start", { agent: "keeper", content: "before" })).json()) as { conversation: number };
	await say(keeper, CALL("remind", { text: "Keeper's reminder", inMinutes: 60 }));
	await say(keeper, CALL("schedule_job", { title: "Keeper's job", instruction: "check", every: "1d" }));
	await say(host.root, CALL("remind", { text: "gaidin's reminder", inMinutes: 60 }));
	await say(host.root, CALL("schedule_job", { title: "gaidin's job", instruction: "check", every: "1d" }));

	const archived = (await (await post("/api/agents/archive", { id: "keeper", archived: true })).json()) as { archived?: number };
	assert.ok(archived.archived !== undefined);
	assert.deepEqual((await host.harness.snapshot(Reminders, context))!.items.map((r) => r.text), ["gaidin's reminder"]);
	const jobs = (await host.harness.snapshot(Jobs, context))!.items;
	assert.equal(jobs.find((j) => j.agent === "keeper")?.paused?.reason, "its agent was archived");
	assert.equal(jobs.find((j) => j.agent === undefined)?.paused, undefined);
	assert.equal((await post("/api/threads/start", { agent: "keeper", content: "hi" })).status, 404);
	assert.equal((await post("/api/message", { agent: "keeper", content: "hi" })).status, 404);
	assert.equal((await post("/api/message", { conversation: thread, content: "hi" })).status, 400, "nor its threads");

	const restored = (await (await post("/api/agents/archive", { id: "keeper", archived: false })).json()) as { archived?: number };
	assert.equal(restored.archived, undefined);
	assert.ok((await host.harness.snapshot(Jobs, context))!.items.find((j) => j.agent === "keeper")?.paused !== undefined, "its jobs stay paused");
	assert.equal((await post("/api/agents/archive", { id: "gaidin", archived: true })).status, 400);
	assert.equal((await post("/api/agents/archive", { id: "nobody", archived: true })).status, 400);
});

test("a message to a conversation another agent started forks it, so the sender's conversation is left as it was", async (t) => {
	const { host, post, get } = await start(t);
	await host.agents.update("gaidin", { canMessage: ["scout"] });
	assert.match(await say(host.root, CALL("message_agent", { agent: "scout", text: "what's new?" })), /Scout answered/);
	const asked = await until(async () => (await get("/api/conversations", "?agent=scout")).items.find((c) => c.place === "agent"));
	const before = await transcript(host, asked.id);
	const sent = (await (await post("/api/message", { conversation: asked.id, agent: "scout", content: "and since?" })).json()) as { conversation: number };
	assert.notEqual(sent.conversation, asked.id);
	assert.deepEqual((await transcript(host, sent.conversation)).slice(-2), ["and since?", "Scout heard: and since?"]);
	assert.equal((await host.harness.snapshot(AgentOf, conversationId(sent.conversation), context))?.agent, "scout");
	assert.deepEqual(await transcript(host, asked.id), before);
});
