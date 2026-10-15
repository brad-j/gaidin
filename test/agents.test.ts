import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { AgentDoc, type Conversation } from "@earendil-works/pi-durable";
import { AgentOf, Agents, defaultEntry, messageProblem, type Roster } from "../src/agents.ts";
import type { ApprovalRequest } from "../src/approvals.ts";
import { configFor } from "../src/config.ts";
import { assistantText, context, startHost } from "../src/host.ts";
import { Jobs } from "../src/jobs.ts";
import { Memory, WorkNotes } from "../src/memory.ts";
import type { Notice } from "../src/notifications.ts";
import { Reminders } from "../src/reminders.ts";
import { describeAgent, parseClientMessage } from "../src/server.ts";
import { conversationId } from "../src/ids.ts";

type Message = { role: string; content?: unknown };
const textOf = (m: Message) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content));

/**
 * A model that does what each message says: `CALL {"name": ..., "args": ...}` anywhere in it calls that tool, and
 * anything else is echoed with the agent's name, which it reads from the system prompt. After a tool, it reports what
 * came back. Every conversation shares it, so tests don't depend on which runs first.
 */
function scripted(prompts: string[] = []) {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	const step = (ctx: { messages: readonly Message[] }) => {
		const system = ctx.messages.filter((m) => m.role === "system").map((m) => JSON.parse(JSON.stringify(m)) as unknown).map((m) => JSON.stringify(m).replace(/\\n/g, "\n")).join("\n");
		prompts.push(system);
		const who = /You are ([^,]+),/.exec(system)?.[1] ?? "?";
		// A section that changed is sent as a system message after the transcript.
		const last = ctx.messages.filter((m) => m.role !== "system").at(-1)!;
		if (last.role === "toolResult") return fauxAssistantMessage(fauxText(`${who} got: ${textOf(last)}`));
		const text = textOf(last);
		const call = /CALL (\{.*\})/.exec(text);
		if (call !== null) {
			const { name, args } = JSON.parse(call[1]!) as { name: string; args: Record<string, unknown> };
			return fauxAssistantMessage(fauxToolCall(name, args as never), { stopReason: "toolUse" });
		}
		return fauxAssistantMessage(fauxText(`${who} heard: ${text.replace(/^\[[^\]]*\] /, "")}`));
	};
	faux.setResponses(Array.from({ length: 200 }, () => step));
	const models = createModels();
	models.setProvider(faux.provider);
	return { models, model: { provider: "faux", modelId: "faux-1" } };
}

const CALL = (name: string, args: Record<string, unknown>) => `CALL ${JSON.stringify({ name, args })}`;

/** gaidin with a second agent, scout, whose notices are recorded, and approvals answered by `decide` (default: deny). */
async function start(t: TestContext, options: { prompts?: string[]; decide?: (r: ApprovalRequest) => "once" | "always" | "deny" } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "gaidin-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const notices: Notice[] = [];
	const host = await startHost({
		config: configFor({ owner: "Brad" }),
		dataDir: dir,
		sandbox: "none",
		...scripted(options.prompts),
		adapters: { push: { send: async (notice) => (notices.push(notice), true) } },
		workspaces: { list: [{ name: "egwene", target: "me@egwene" }], remote: async () => ({ code: 0, output: "{}" }) },
	});
	t.after(() => host.harness.close(context));
	const asked: ApprovalRequest[] = [];
	host.approvals.onChange((r) => {
		if (r.status !== "pending") return;
		asked.push(r);
		void host.approvals.decide(r.id, options.decide?.(r) ?? "deny", "test");
	});
	await host.agents.add({ id: "scout", name: "Scout", job: "Finds things out" });
	const scout = await host.agents.home("scout");
	return { host, dir, scout, notices, asked };
}

/** Sends `text` and gives back the answer. */
async function say(conversation: Conversation, text: string): Promise<string> {
	const settled = await (await conversation.submit({ type: "input", content: text }, context)).wait(context);
	if (settled.status !== "done" || settled.type !== "input") throw new Error(`the run didn't finish: ${settled.status} ${settled.reason ?? ""}`);
	return assistantText(await conversation.commit((tx) => tx.entry(settled.answer), context)) ?? "";
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

test("the default agent is in the roster from the start, and a new agent has its own home, sandbox and prompt", async (t) => {
	const prompts: string[] = [];
	const { host, dir, scout } = await start(t, { prompts });
	await host.root.configure({ thinkingLevel: "high", instructions: "Only gaidin's" }, context);

	const roster = (await host.harness.snapshot(Agents, context))!;
	assert.deepEqual(roster.agents.map((a) => [a.id, a.home]), [["gaidin", host.root.id], ["scout", scout.id]]);
	assert.equal((await host.harness.snapshot(AgentOf, scout.id, context))?.agent, "scout");
	// Its sandbox is outside the default agent's, and it starts without the default agent's instructions.
	assert.ok(existsSync(join(dir, "agents/scout/sandbox")));
	assert.equal((await scout.agent(context)).cwd, join(dir, "agents/scout/sandbox"));
	assert.equal((await scout.agent(context)).instructions, undefined);

	assert.equal(await say(scout, "hello"), "Scout heard: hello");
	assert.match(prompts.at(-1)!, /You are Scout, one of Brad's agents\. Your job: Finds things out\./);
	assert.equal(await say(host.root, "hello"), "gaidin heard: hello");
	assert.match(prompts.at(-1)!, /You are gaidin, Brad's personal agent\./);

	await assert.rejects(host.agents.add({ id: "scout", name: "Another", job: "" }), /already an agent scout/);
	await assert.rejects(host.agents.add({ id: "Bad Name", name: "Bad", job: "" }), /lowercase letters/);
	await assert.rejects(host.agents.add({ id: "other", name: "scout", job: "" }), /Another agent is called scout/);
	await assert.rejects(host.agents.update("scout", { canMessage: ["nobody"] }), /no agent nobody/);
	await assert.rejects(host.agents.update("scout", { workspaces: ["nowhere"] }), /no workspace nowhere/);
	await assert.rejects(host.agents.home("nobody"), /no agent nobody/);
});

test("an agent's file tools stay in its own sandbox", async (t) => {
	const { host, dir, scout } = await start(t);
	assert.match(await say(scout, CALL("write", { path: "note.txt", content: "scout's" })), /Scout got/);
	assert.equal(readFileSync(join(dir, "agents/scout/sandbox/note.txt"), "utf8"), "scout's");
	assert.ok(!existsSync(join(dir, "sandbox/note.txt")));
	assert.match(await say(host.root, CALL("read", { path: "../agents/scout/sandbox/note.txt" })), /outside the sandbox/);
	assert.match(await say(scout, CALL("read", { path: "../../../sandbox/slept.log" })), /outside the sandbox/);
});

test("notes: shared ones reach every agent, work notes only their own", async (t) => {
	const prompts: string[] = [];
	const { host, scout } = await start(t, { prompts });
	await say(host.root, CALL("remember", { text: "Brad's birthday is in June.", shared: true }));
	await say(host.root, CALL("remember", { text: "gaidin's own work note." }));
	await say(scout, CALL("remember", { text: "Scout's own work note." }));
	assert.deepEqual((await host.harness.snapshot(Memory, context))?.notes.map((n) => [n.text, n.by]), [["Brad's birthday is in June.", "gaidin"]]);
	assert.deepEqual((await host.harness.snapshot(WorkNotes, "scout", context))?.notes.map((n) => n.text), ["Scout's own work note."]);

	await say(scout, "what do you know?");
	const seen = prompts.at(-1)!;
	assert.match(seen, /\[s1\] Brad's birthday is in June\./);
	assert.match(seen, /\[w1\] Scout's own work note\./);
	assert.doesNotMatch(seen, /gaidin's own work note/);
	// w1 is each agent's own: forgetting it in scout's conversation leaves gaidin's.
	await say(scout, CALL("forget", { id: "w1" }));
	assert.deepEqual((await host.harness.snapshot(WorkNotes, "scout", context))?.notes, []);
	assert.deepEqual((await host.harness.snapshot(WorkNotes, "gaidin", context))?.notes.map((n) => n.text), ["gaidin's own work note."]);
});

test("an agent lists and cancels only its own reminders and jobs", async (t) => {
	const { host, scout } = await start(t, { decide: () => "once" });
	await say(host.root, CALL("remind", { text: "gaidin's reminder", inMinutes: 60 }));
	await say(scout, CALL("remind", { text: "Scout's reminder", inMinutes: 60 }));
	await say(host.root, CALL("schedule_job", { title: "gaidin's job", instruction: "check", every: "1d" }));
	const reminders = (await host.harness.snapshot(Reminders, context))!.items;
	assert.deepEqual(reminders.map((r) => [r.text, r.agent]), [["gaidin's reminder", undefined], ["Scout's reminder", "scout"]]);
	const theirs = reminders[0]!.taskId;
	const job = (await host.harness.snapshot(Jobs, context))!.items[0]!;

	const listed = await say(scout, CALL("list_reminders", {}));
	assert.match(listed, /Scout's reminder/);
	assert.doesNotMatch(listed, /gaidin's reminder/);
	assert.match(await say(scout, CALL("cancel_reminder", { id: theirs })), /No open reminder/);
	assert.match(await say(scout, CALL("list_jobs", {})), /No scheduled jobs/);
	assert.match(await say(scout, CALL("cancel_job", { id: job.taskId })), /No job/);
	assert.equal((await host.harness.snapshot(Reminders, context))!.items.length, 2);
	assert.equal((await host.harness.snapshot(Jobs, context))!.items.length, 1);
});

test("a job an agent schedules runs as that agent, in its sandbox, and its report says whose it is", async (t) => {
	const { host, scout, notices } = await start(t, { decide: () => "once" });
	const at = new Date(Date.now() + 1500).toISOString();
	await say(scout, CALL("schedule_job", { title: "Scout's check", instruction: "look around", at }));
	assert.equal((await host.harness.snapshot(Jobs, context))!.items[0]!.agent, "scout");
	const report = await until(() => notices.find((n) => n.kind === "report"));
	if (report.kind !== "report") throw new Error("not a report");
	assert.equal(report.report.agent, "scout");
	assert.match(report.report.text, /^Scout heard: Scheduled job "Scout's check"/);
	const run = await host.harness.conversation(conversationId(report.report.conversationId), context);
	assert.equal((await host.harness.snapshot(AgentOf, run!.id, context))?.agent, "scout");
	assert.equal((await run!.agent(context)).cwd, (await scout.agent(context)).cwd);
});

test("search_history finds only the agent's own conversations", async (t) => {
	const { host, scout } = await start(t);
	await say(host.root, "the pineapple is in the fridge");
	await say(scout, "the mango is on the shelf");
	// The search's own message has the word in it, so it finds that, and nothing of gaidin's.
	const found = await say(scout, CALL("search_history", { query: "pineapple" }));
	assert.doesNotMatch(found, /fridge/);
	assert.match(found, /main conversation · Brad: CALL/, "an agent's home is its main conversation");
	assert.match(await say(scout, CALL("search_history", { query: "mango" })), /«mango» is on the shelf/);
	assert.match(await say(host.root, CALL("search_history", { query: "pineapple" })), /«pineapple» is in the fridge/);
});

test("allowing a host for good allows it for the agent that asked", async (t) => {
	const { host, scout } = await start(t, { decide: () => "always" });
	const ask = (conversation: Conversation, id: string) => host.approvals.open(id, { conversationId: conversation.id, taskId: 1 }, "fetch_url", {
		summary: "fetch https://example.com/",
		always: { kind: "fetch-host", value: "example.com", label: "Always allow example.com", done: "Always allowed example.com" },
	});
	const request = await ask(scout, "r1");
	assert.equal(request.agent, "scout");
	await until(async () => ((await host.approvals.hostsFor("scout")).length > 0 ? true : undefined));
	assert.deepEqual(await host.approvals.hostsFor("scout"), ["example.com"]);
	assert.deepEqual(await host.approvals.hostsFor("gaidin"), []);
	const theirs = await ask(host.root, "r2");
	assert.equal(theirs.agent, undefined);
	await until(async () => ((await host.approvals.hostsFor("gaidin")).length > 0 ? true : undefined));
});

test("a workspace an agent wasn't given is refused, not asked", async (t) => {
	const { host, scout, asked } = await start(t);
	const refused = await say(scout, CALL("workspace_read", { workspace: "egwene", path: "README.md" }));
	assert.match(refused, /Scout hasn't been given the workspace egwene; it has none/);
	assert.equal(asked.length, 0);
	await host.agents.update("scout", { workspaces: ["egwene"] });
	await say(scout, CALL("workspace_read", { workspace: "egwene", path: "README.md" }));
	assert.deepEqual(asked.map((r) => [r.tool, r.agent]), [["workspace_read", "scout"]]);
});

test("message_agent asks another agent and returns its answer, which counts as outside text on both sides", async (t) => {
	const { host, scout, asked } = await start(t, { decide: (r) => (r.tool === "message_agent" ? "once" : "deny") });
	// Scout may not reach gaidin: refused, not put to Brad.
	assert.match(await say(scout, CALL("message_agent", { agent: "gaidin", text: "where's the pineapple?" })), /Scout can only reach these agents: none/);
	assert.equal(asked.length, 0);

	await host.agents.update("gaidin", { canMessage: ["scout"] });
	const answer = await say(host.root, CALL("message_agent", { agent: "scout", text: "where's the mango?" }));
	assert.match(answer, /Scout answered/);
	assert.match(answer, /Scout heard: .*\[from another agent\] gaidin, another of Brad's agents, asks this/s);
	assert.match(answer, /where's the mango\?/);
	assert.equal(asked.length, 0, "a message from a conversation with no outside text doesn't ask");

	// Scout's answer is in gaidin's context now, so the next message asks. The conversation it starts is scout's and
	// starts with the marker, so scout's note writes there ask too.
	const started = await say(host.root, CALL("message_agent", { agent: "scout", text: CALL("remember", { text: "Planted note." }) }));
	assert.deepEqual(asked.map((r) => [r.tool, r.agent]), [["message_agent", undefined], ["remember", "scout"]]);
	assert.match(asked[0]!.summary, /after reading outside text \(message_agent\)/);
	assert.match(started, /Scout answered[^]*Needs Brad's approval to remember .*Planted note\..*, after reading outside text \(a message from another agent\)/);
	assert.deepEqual((await host.harness.snapshot(WorkNotes, "scout", context))?.notes ?? [], []);

	// What came back is outside text in gaidin's conversation, so gaidin's own note writes ask now too.
	assert.match(await say(host.root, CALL("remember", { text: "From scout." })), /Needs Brad's approval .* \(message_agent\)/);

	// The other agent's conversations are its own, and listed as messages between agents.
	const listed = (await host.history.conversations()).items.filter((c) => c.place === "agent");
	assert.deepEqual(listed.map((c) => c.agent), ["scout", "scout"]);
	assert.notEqual(listed[0]!.id, scout.id);
});

test("hand_off gives work to another agent as a job, whose report goes to Brad", async (t) => {
	const { host, notices } = await start(t);
	await host.agents.update("gaidin", { canMessage: ["scout"] });
	assert.match(await say(host.root, CALL("hand_off", { agent: "scout", title: "Find the mango", task: "Look on the shelf." })), /Handed to Scout as job \d+/);
	const report = await until(() => notices.find((n) => n.kind === "report"));
	if (report.kind !== "report") throw new Error("not a report");
	assert.equal(report.report.agent, "scout");
	assert.equal(report.report.title, "Find the mango (from gaidin)");
	assert.match(report.report.text, /^Scout heard: Work handed to you: "Find the mango \(from gaidin\)"\./);
	assert.match(report.report.text, /Look on the shelf\./);
	// The run is scout's, with scout's settings.
	assert.equal((await host.harness.snapshot(AgentOf, conversationId(report.report.conversationId), context))?.agent, "scout");
	const run = await host.harness.conversation(conversationId(report.report.conversationId), context);
	assert.equal((await run!.agent(context)).cwd, (await (await host.agents.home("scout")).agent(context)).cwd);
});

test("message_agent and hand_off carry files from the sender's sandbox as copies in the receiver's uploads/", async (t) => {
	// Scout's answer is outside text, so the calls after it ask; these are allowed.
	const { host, dir, notices, asked } = await start(t, { decide: (r) => (r.tool === "hand_off" || r.tool === "message_agent" ? "once" : "deny") });
	await host.agents.update("gaidin", { canMessage: ["scout"] });
	assert.match(await say(host.root, CALL("write", { path: "work/list.txt", content: "mango, papaya" })), /gaidin got/);
	assert.match(await say(host.root, CALL("write", { path: "other/list.txt", content: "kiwi" })), /gaidin got/);

	const answer = await say(host.root, CALL("message_agent", { agent: "scout", text: "check these", files: ["work/list.txt", "other/list.txt"] }));
	const saved = /list\.txt is saved as (uploads\/[\w-]+-list\.txt)[^;]*; list\.txt is saved as (uploads\/[\w-]+-list\.txt)/.exec(answer);
	assert.ok(saved, answer);
	assert.match(answer, /Files from gaidin/);
	assert.equal(readFileSync(join(dir, "agents/scout/sandbox", saved[1]!), "utf8"), "mango, papaya");
	assert.equal(readFileSync(join(dir, "agents/scout/sandbox", saved[2]!), "utf8"), "kiwi", "two files with one name each keep theirs");
	assert.match(readFileSync(join(dir, "sandbox/work/list.txt"), "utf8"), /mango/, "the sender keeps its own");

	assert.match(await say(host.root, CALL("hand_off", { agent: "scout", title: "Sort it", task: "Sort the list.", files: ["work/list.txt"] })), /Handed to Scout as job \d+, with copies of 1 file/);
	const report = await until(() => notices.find((n) => n.kind === "report"));
	if (report.kind !== "report") throw new Error("not a report");
	const handed = /saved as (uploads\/[\w-]+-list\.txt)/.exec(report.report.text);
	assert.ok(handed, report.report.text);
	assert.equal(readFileSync(join(dir, "agents/scout/sandbox", handed[1]!), "utf8"), "mango, papaya");

	// Only files in the sender's own sandbox go, and nothing is handed when one can't.
	writeFileSync(join(dir, "agents/scout/sandbox/secret.txt"), "scout's own");
	assert.match(await say(host.root, CALL("hand_off", { agent: "scout", title: "Peek", task: "x", files: ["../agents/scout/sandbox/secret.txt"] })), /outside the sandbox/);
	assert.match(await say(host.root, CALL("hand_off", { agent: "scout", title: "Dir", task: "x", files: ["work"] })), /it's a directory/);
	assert.match(await say(host.root, CALL("hand_off", { agent: "scout", title: "Gone", task: "x", files: ["missing.txt"] })), /Can't pass missing\.txt/);
	const jobs = (await host.harness.snapshot(Jobs, context))?.items ?? [];
	assert.deepEqual(jobs.filter((j) => j.title !== "Sort it (from gaidin)").map((j) => j.title), []);

	// Too many is refused before anyone is asked.
	const before = asked.length;
	const many = Array.from({ length: 11 }, (_, i) => `f${i}.txt`);
	assert.match(await say(host.root, CALL("message_agent", { agent: "scout", text: "x", files: many })), /up to 10 files/);
	assert.equal(asked.length, before);
});

test("an approval to pass files names them", async (t) => {
	const { host, asked } = await start(t);
	await host.agents.update("gaidin", { canMessage: ["scout"] });
	await say(host.root, CALL("write", { path: "a.txt", content: "a" }));
	// Scout's answer is outside text in gaidin's context, so the next call asks, and is denied.
	await say(host.root, CALL("message_agent", { agent: "scout", text: "hi" }));
	assert.match(await say(host.root, CALL("hand_off", { agent: "scout", title: "More", task: "go", files: ["a.txt"] })), /Brad said no/);
	assert.match(asked.at(-1)!.summary, /hand agent scout "More" with file a\.txt/);
});

test("messages go only where the roster allows, and a chain stops", () => {
	const entry = (id: string, canMessage: string[]) => ({ ...defaultEntry(), id, name: id, canMessage });
	const roster: Roster = { agents: [entry("a", ["b", "c"]), entry("b", ["a", "c"]), entry("c", ["a", "b", "d", "e"]), { ...entry("d", []), archived: 1 }, entry("e", ["f"]), entry("f", [])], owners: {} };
	const [a, b, c, , e] = roster.agents as ReturnType<typeof entry>[];
	if (a === undefined || b === undefined || c === undefined || e === undefined) throw new Error("no roster");
	assert.equal(messageProblem(roster, a, "b", []), undefined);
	assert.match(messageProblem(roster, a, "a", [])!, /can't message itself/);
	assert.match(messageProblem(roster, a, "x", [])!, /no agent x\. Agents a can reach: b, c/);
	assert.match(messageProblem(roster, c, "d", [])!, /no agent d/, "an archived agent can't be reached");
	// b was asked by a, so it can't ask a back; the third message in a chain is the last.
	assert.match(messageProblem(roster, b, "a", ["a"])!, /a is already part of this chain \(a → b\)/);
	assert.equal(messageProblem(roster, b, "c", ["a"]), undefined);
	assert.match(messageProblem(roster, c, "b", ["a", "b"])!, /already part of this chain/);
	assert.equal(messageProblem(roster, c, "e", ["a", "b"]), undefined);
	assert.match(messageProblem(roster, e, "f", ["a", "b", "c"])!, /This would be message 4 in a chain \(a → b → c → e → f\); a chain stops at 3/);
});

test("the CLI's agent commands read right", () => {
	assert.deepEqual(parseClientMessage('{"type":"agent","action":"list"}'), { type: "agent", action: "list" });
	assert.deepEqual(parseClientMessage('{"type":"agent","action":"add","id":"scout","name":"Scout"}'), { type: "agent", action: "add", id: "scout", name: "Scout", job: "" });
	assert.deepEqual(parseClientMessage('{"type":"agent","action":"set","id":"scout","change":{"canMessage":["gaidin"]}}'), { type: "agent", action: "set", id: "scout", change: { canMessage: ["gaidin"] } });
	assert.deepEqual(parseClientMessage('{"type":"ask","content":"hi","agent":"scout"}'), { type: "ask", content: "hi", agent: "scout" });
	assert.deepEqual(parseClientMessage('{"type":"watch"}'), { type: "watch" });
	assert.throws(() => parseClientMessage('{"type":"agent","action":"add","id":"scout"}'), /needs a name/);
	assert.equal(describeAgent({ ...defaultEntry(), channel: "C1", canMessage: ["scout"] }), "gaidin (gaidin): no job given · Slack C1 · may message: scout · workspaces: all");
	assert.equal(describeAgent({ ...defaultEntry(), profiles: ["personal"] }), "gaidin (gaidin): no job given · may message: none · workspaces: all · browser profiles: personal");
	assert.deepEqual(parseClientMessage('{"type":"agent","action":"set","id":"scout","change":{"profiles":["personal"]}}'), { type: "agent", action: "set", id: "scout", change: { profiles: ["personal"] } });
});

test("a new agent's settings start from the default agent's, without its instructions or self-written tools", async (t) => {
	const { host } = await start(t);
	await host.root.configure({ thinkingLevel: "high", instructions: "Only for gaidin" }, context);
	await host.agents.add({ id: "other", name: "Other", job: "" });
	const other = await host.agents.home("other");
	const settings = await other.commit((tx) => tx.doc(AgentDoc, other.id).then((d) => JSON.parse(JSON.stringify(d))), context);
	assert.equal(settings.thinkingLevel, "high");
	assert.equal(settings.instructions, undefined);
});

test("an index of past messages from before agents is made again, with every row's agent", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "gaidin-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const old = new DatabaseSync(join(dir, "history.sqlite"));
	old.exec(`
		CREATE TABLE messages (id INTEGER PRIMARY KEY, conversation INTEGER NOT NULL, place TEXT NOT NULL, role TEXT NOT NULL, at INTEGER NOT NULL, text TEXT NOT NULL);
		CREATE TABLE activity (ref TEXT PRIMARY KEY, entry INTEGER NOT NULL, conversation INTEGER NOT NULL, place TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, detail TEXT NOT NULL, outcome TEXT NOT NULL);
		INSERT INTO messages VALUES (1, 1, 'main', 'user', 0, 'from the old index');
	`);
	old.close();
	const host = await startHost({ config: configFor({ owner: "Brad" }), dataDir: dir, sandbox: "none", ...scripted(), adapters: { push: { send: async () => true } } });
	t.after(() => host.harness.close(context));
	await say(host.root, "the papaya is ripe");
	assert.match(await say(host.root, CALL("search_history", { query: "papaya" })), /main conversation · Brad: the «papaya» is ripe/);
	assert.doesNotMatch(await say(host.root, CALL("search_history", { query: "old index" })), /from the old index/, "the old rows went with the old tables");
});
