import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ApprovalRequest } from "../src/approvals.ts";
import { loadConfig, maskedConfig, secretsOf } from "../src/config.ts";
import { context, startHost } from "../src/host.ts";
import { conversationId } from "../src/ids.ts";
import { originOf, spoken, unspoken } from "../src/threads.ts";
import { createVoice, QUIET_MS, type VoiceEvent, VoiceState } from "../src/voice.ts";
import { createWebServer } from "../src/web.ts";

const BRAD = "brad@example.com";
const TOKEN = "a-bridge-token-that-is-long-enough-1234";

type Message = { role: string; content?: unknown };
const textOf = (m: Message) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content));

/** Echoes what was said with the agent's name; `CALL {...}` in it calls that tool, and a tool's result is reported. */
function scripted() {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	const step = (ctx: { messages: readonly Message[] }) => {
		const system = ctx.messages.filter((m) => m.role === "system").map((m) => JSON.stringify(m)).join("\n");
		const who = /You are ([^,]+),/.exec(system)?.[1] ?? "?";
		const last = ctx.messages.filter((m) => m.role !== "system").at(-1)!;
		if (last.role === "toolResult") return fauxAssistantMessage(fauxText(`${who} got: ${textOf(last)}`));
		const text = textOf(last);
		const call = /CALL (\{.*\})/.exec(text);
		if (call !== null) {
			const { name, args } = JSON.parse(call[1]!.replace(/\\"/g, '"')) as { name: string; args: Record<string, unknown> };
			return fauxAssistantMessage(fauxToolCall(name, args as never), { stopReason: "toolUse" });
		}
		return fauxAssistantMessage(fauxText(`${who} heard: ${text.replace(/^.*\(([a-z-]+) speaker\) /, "$1: ")}`));
	};
	faux.setResponses(Array.from({ length: 200 }, () => step));
	const models = createModels();
	models.setProvider(faux.provider);
	return { models, model: { provider: "faux", modelId: "faux-1" } };
}

/** gaidin with a family agent and the voice route, whose one token reaches only family. Approvals are recorded and denied. */
async function start(t: TestContext) {
	const dir = mkdtempSync(join(tmpdir(), "gaidin-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const host = await startHost({ dataDir: dir, sandbox: "none", ...scripted(), adapters: { push: { send: async () => true } } });
	await host.agents.add({ id: "family", name: "Family", job: "Answers the household" });
	await host.agents.update("family", { sharedNotes: false });
	const asked: ApprovalRequest[] = [];
	host.approvals.onChange((r) => {
		if (r.status !== "pending") return;
		asked.push(r);
		setTimeout(() => void host.approvals.decide(r.id, "deny", "test"), 50);
	});
	const voice = createVoice({ harness: host.harness, threads: host.threads, approvals: host.approvals, tokens: [{ name: "thom", token: TOKEN, agents: ["family"] }] });
	const server = createWebServer({ harness: host.harness, root: host.root, agents: host.agents, threads: host.threads, voice, user: BRAD, switchable: host.switchable, approvals: host.approvals });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(async () => {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
		await host.close();
	});
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const send = (body: unknown, headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}` }) =>
		fetch(`${base}/api/voice/turn`, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...headers } });
	/** A turn's events, in order. */
	const turn = async (body: Record<string, unknown>): Promise<VoiceEvent[]> => {
		const response = await send(body);
		assert.equal(response.status, 200, await response.clone().text());
		assert.equal(response.headers.get("content-type"), "text/event-stream");
		return (await response.text()).split("\n\n").filter((block) => block !== "").map((block) => JSON.parse(block.split("\ndata: ")[1]!) as VoiceEvent);
	};
	return { host, base, send, turn, asked };
}

const doneOf = (events: VoiceEvent[]) => events.find((e) => e.type === "done") as Extract<VoiceEvent, { type: "done" }>;
const said = (events: VoiceEvent[]) => events.flatMap((e) => (e.type === "say" ? [e.text] : []));

test("a bridge's token reaches only the voice route and the agents it lists", async (t) => {
	const { base, send } = await start(t);
	const body = { speaker: "kitchen", text: "hello", key: "k1" };
	assert.equal((await send(body, {})).status, 401);
	assert.equal((await send(body, { Authorization: "Bearer wrong" })).status, 401);
	// The owner's login doesn't stand in for the token.
	assert.equal((await send(body, { "Tailscale-User-Login": BRAD })).status, 401);
	assert.equal((await send({ ...body, agent: "gaidin" })).status, 403);
	assert.equal((await send({ ...body, speaker: "Kitchen!" })).status, 400);
	assert.equal((await send({ ...body, text: "  " })).status, 400);
	assert.equal((await send({ speaker: "kitchen" })).status, 400);
	assert.equal((await fetch(`${base}/api/voice/turn`, { headers: { Authorization: `Bearer ${TOKEN}` } })).status, 405);
	// Everywhere else the token is nothing: the login check still stands.
	for (const path of ["/api/agents", "/api/settings", "/events"]) {
		assert.equal((await fetch(base + path, { headers: { Authorization: `Bearer ${TOKEN}` } })).status, 403, path);
	}
	const message = await fetch(`${base}/api/message`, { method: "POST", body: JSON.stringify({ content: "hi" }), headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` } });
	assert.equal(message.status, 403);
});

test("a turn is answered in its speaker's thread, which carries on until the speaker's been quiet, and a turn sent again lands once", async (t) => {
	const { host, turn } = await start(t);
	const first = await turn({ speaker: "kitchen", text: "set a timer", key: "k1" });
	assert.deepEqual(said(first), ["Family heard: kitchen: set a timer"]);
	const kitchen = doneOf(first);
	assert.equal(kitchen.status, "done");
	const conversation = (await host.harness.conversation(conversationId(kitchen.conversation), context))!;
	assert.equal(await originOf(host.harness, conversation.id), "voice");
	assert.equal(unspoken(spoken("kitchen", "set a timer")), "set a timer");
	assert.equal(unspoken("[spoken] by me"), "[spoken] by me");

	// The same speaker carries on in the same thread; another speaker has its own.
	assert.equal(doneOf(await turn({ speaker: "kitchen", text: "and another", key: "k2" })).conversation, kitchen.conversation);
	const office = doneOf(await turn({ speaker: "office", text: "hello", key: "k3" }));
	assert.notEqual(office.conversation, kitchen.conversation);

	// Sent again, a turn finds its thread and its answer, and isn't submitted twice.
	const again = await turn({ speaker: "kitchen", text: "and another", key: "k2" });
	assert.deepEqual(said(again), ["Family heard: kitchen: and another"]);
	const inputs = async () => (await conversation.commit((tx) => tx.scanEntries({ conversationId: conversation.id, order: "ascending" }, 100), context)).items.filter((e) => e.kind === "pi.user").length;
	assert.equal(await inputs(), 2);

	// After the speaker's been quiet, the next turn starts a new thread.
	await host.harness.commit(async (tx) => {
		(await tx.doc(VoiceState)).speakers.kitchen!.at -= QUIET_MS + 1000;
	}, context);
	assert.notEqual(doneOf(await turn({ speaker: "kitchen", text: "later", key: "k4" })).conversation, kitchen.conversation);
});

test("speech is outside text: a note it would write asks the owner, and the turn ends waiting", async (t) => {
	const { turn, asked } = await start(t);
	const events = await turn({ speaker: "kitchen", text: `CALL {"name":"remember","args":{"text":"Soccer is on Tuesdays."}}`, key: "k1" });
	const waiting = events.find((e) => e.type === "waiting");
	assert.ok(waiting !== undefined, JSON.stringify(events));
	assert.equal(doneOf(events).status, "waiting");
	assert.equal(asked.length, 1);
	assert.match(asked[0]!.summary, /speech at a speaker/);

	// Once the owner has answered, the same turn sent again hears how the run ended.
	const after = await turn({ speaker: "kitchen", text: "unused", key: "k1" });
	assert.equal(doneOf(after).status, "done");
	assert.equal(asked.length, 1);
	assert.match(said(after).at(-1)!, /^Family got: /);
});

test("voice.tokens: each a long token with its agents, masked and redacted, and needing the app's server", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "gaidin-config-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const file = (settings: unknown) => {
		const path = join(dir, "gaidin.json");
		writeFileSync(path, JSON.stringify({ model: { apiKey: "sk-test" }, ...(settings as object) }));
		return path;
	};
	const good = loadConfig({ file: file({ web: { user: BRAD }, voice: { tokens: [{ name: "thom", token: TOKEN, agents: ["family"] }] } }), env: {} });
	assert.deepEqual(good.errors, []);
	assert.deepEqual(good.config.voice, { tokens: [{ name: "thom", token: TOKEN, agents: ["family"] }] });
	assert.equal(maskedConfig(good.config).voice!.tokens[0]!.token, "a-brid…");
	assert.ok(Object.values(secretsOf(good.config)).includes(TOKEN));

	const bad = loadConfig({ file: file({ voice: { tokens: [{ name: "thom", token: "short", agents: [] }, { name: "thom", token: "short", agents: ["family"] }], other: 1 } }), env: {} });
	assert.match(bad.errors.join("\n"), /under 32 characters/);
	assert.match(bad.errors.join("\n"), /thom names no agent/);
	assert.match(bad.errors.join("\n"), /names a bridge twice/);
	assert.match(bad.errors.join("\n"), /same token/);
	assert.match(bad.errors.join("\n"), /Unknown setting "voice.other"/);
	assert.match(bad.warnings.join("\n"), /needs web.user/);
});
