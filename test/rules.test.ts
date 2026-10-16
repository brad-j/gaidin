import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { Conversation } from "@earendil-works/pi-durable";
import type { ApprovalRequest } from "../src/approvals.ts";
import { configFor } from "../src/config.ts";
import { assistantText, context, startHost } from "../src/host.ts";
import { covers, describeRule, type Rule, rulesFor } from "../src/rules.ts";
import { parseClientMessage } from "../src/server.ts";
import { createWebServer } from "../src/web.ts";
import { fakeMcp } from "./fake-mcp.ts";

const rule = (fields: Partial<Rule>): Rule => ({ id: "r1", effect: "allow", tool: "home_*", createdAt: 0, ...fields });

test("a rule covers its agent, its tool or family, and arguments that meet every condition, until it ends", () => {
	const args = { name: "Kitchen Light", url: "https://www.Example.com/a", n: 3, device: { area: "kitchen" } };
	assert.equal(covers(rule({}), "lan", "home_intent__HassTurnOn", args, 0), true);
	assert.equal(covers(rule({ tool: "home_intent__HassTurnOn" }), "lan", "home_intent__HassTurnOff", args, 0), false);
	assert.equal(covers(rule({ agent: "verin" }), "lan", "home_x", args, 0), false);
	assert.equal(covers(rule({ when: [{ arg: "name", op: "contains", value: "light" }] }), "lan", "home_x", args, 0), true);
	assert.equal(covers(rule({ when: [{ arg: "name", op: "equals", value: "kitchen light" }] }), "lan", "home_x", args, 0), false);
	assert.equal(covers(rule({ when: [{ arg: "name", op: "starts-with", value: "kitchen" }, { arg: "n", op: "one-of", value: ["2", "3"] }] }), "lan", "home_x", args, 0), true);
	assert.equal(covers(rule({ when: [{ arg: "url", op: "host", value: "www.example.com" }] }), "lan", "home_x", args, 0), true);
	assert.equal(covers(rule({ when: [{ arg: "device.area", op: "equals", value: "kitchen" }] }), "lan", "home_x", args, 0), true);
	assert.equal(covers(rule({ when: [{ arg: "missing", op: "contains", value: "x" }] }), "lan", "home_x", args, 0), false);
	assert.equal(covers(rule({ until: 1000 }), "lan", "home_x", args, 999), true);
	assert.equal(covers(rule({ until: 1000 }), "lan", "home_x", args, 1000), false);
	assert.equal(describeRule(rule({ agent: "lan", when: [{ arg: "name", op: "contains", value: "light" }], note: "lights" })), "r1: allow home_* for lan, when name contains light, until outside text is read, (lights)");
});

test("an ask rule decides before allow rules, and no allow rule reaches the floor", () => {
	const rules = [rule({ id: "r1" }), rule({ id: "r2", effect: "ask", tool: "home_send" }), rule({ id: "r3", tool: "schedule_*" })];
	assert.deepEqual(rulesFor(rules, "lan", "home_send", {}).ask?.id, "r2");
	assert.deepEqual(rulesFor(rules, "lan", "home_other", {}).allow.map((r) => r.id), ["r1"]);
	assert.deepEqual(rulesFor(rules, "lan", "schedule_job", {}), { allow: [] });
});

type Message = { role: string; content?: unknown };
const textOf = (m: Message) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content));

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
	faux.setResponses(Array.from({ length: 300 }, () => step));
	const models = createModels();
	models.setProvider(faux.provider);
	return { models, model: { provider: "faux", modelId: "faux-1" } };
}

const CALL = (name: string, args: Record<string, unknown>) => `CALL ${JSON.stringify({ name, args })}`;

async function say(conversation: Conversation, text: string): Promise<string> {
	const settled = await (await conversation.submit({ type: "input", content: text }, context)).wait(context);
	if (settled.status !== "done" || settled.type !== "input") throw new Error(`the run didn't finish: ${settled.status} ${settled.reason ?? ""}`);
	return assistantText(await conversation.commit((tx) => tx.entry(settled.answer), context)) ?? "";
}

/** gaidin with Lan, given the home connector, whose tools are a read (allow) and a switch (ask); requests answered by `decide` (default: deny). */
async function start(t: TestContext, decide: (r: ApprovalRequest) => "once" | "always" | "deny" = () => "deny") {
	const server = await fakeMcp(t, {
		era: "modern",
		tools: () => [
			{ name: "homeassistant__GetLiveContext", description: "The house", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
			{ name: "intent__HassTurnOn", description: "Turns on a device", inputSchema: { type: "object", properties: { name: { type: "string" } } } },
		],
		call: (name, args) => ({ content: [{ type: "text", text: `${name} ${JSON.stringify(args)}` }] }),
	});
	const dir = mkdtempSync(join(tmpdir(), "gaidin-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const host = await startHost({
		config: configFor({ owner: "Brad" }),
		dataDir: dir,
		sandbox: "none",
		...scripted(),
		adapters: { push: { send: async () => true } },
		workspaces: { list: [{ name: "egwene", target: "me@egwene" }], remote: async () => ({ code: 0, output: '{"ok":true,"path":"README.md","text":"x","offset":1,"totalLines":1}' }) },
	});
	t.after(() => host.close());
	const asked: ApprovalRequest[] = [];
	host.approvals.onChange((r) => {
		if (r.status !== "pending") return;
		asked.push(r);
		void host.approvals.decide(r.id, decide(r), "test");
	});
	await host.agents.add({ id: "lan", name: "Lan", job: "" });
	await host.connectors.add({ name: "home", url: server.url });
	await host.agents.update("lan", { connectors: ["home"] });
	const lan = await host.agents.home("lan");
	return { host, lan, asked };
}

test("an allow rule lets a call through that would ask, records which rule did, and stops after outside text unless it holds even after", async (t) => {
	const { host, lan, asked } = await start(t);
	const lights = await host.rules.add({ effect: "allow", agent: "lan", tool: "home_intent__HassTurnOn", when: [{ arg: "name", op: "contains", value: "light" }], note: "lights" });
	assert.match(await say(lan, CALL("home_intent__HassTurnOn", { name: "Kitchen light" })), /intent__HassTurnOn \{\\"name\\":\\"Kitchen light\\"\}/);
	assert.equal(asked.length, 0);
	const timeline = await host.timeline();
	assert.ok(timeline.items.some((i) => i.kind === "approval" && i.name === "home_intent__HassTurnOn" && i.outcome === `allowed once by rule ${lights.id}`), JSON.stringify(timeline.items.slice(0, 3)));

	// Not a light: as before, it asks.
	await say(lan, CALL("home_intent__HassTurnOn", { name: "Garage door" }));
	assert.equal(asked.length, 1);

	// After reading the house, which is outside text, the rule stops; ticked, it holds.
	await say(lan, CALL("home_homeassistant__GetLiveContext", {}));
	await say(lan, CALL("home_intent__HassTurnOn", { name: "Hall light" }));
	assert.equal(asked.length, 2);
	await host.rules.remove(lights.id);
	await host.rules.add({ effect: "allow", agent: "lan", tool: "home_*", when: [{ arg: "name", op: "contains", value: "light" }], afterOutside: true });
	await say(lan, CALL("home_intent__HassTurnOn", { name: "Hall light" }));
	assert.equal(asked.length, 2);
});

test("an ask rule asks whatever would let the call through, a tool without a guard and a connector tool set to allow included", async (t) => {
	const { host, lan, asked } = await start(t);
	await host.rules.add({ effect: "ask", tool: "remind", note: "reminders are mine" });
	const refused = await say(lan, CALL("remind", { text: "stretch", inMinutes: 5 }));
	assert.match(refused, /Needs Brad's approval to use remind with .*stretch.* \(rule r1, reminders are mine, asks\), and Brad said no\./);
	await host.rules.add({ effect: "ask", agent: "lan", tool: "home_homeassistant__GetLiveContext" });
	await say(lan, CALL("home_homeassistant__GetLiveContext", {}));
	assert.deepEqual(asked.map((r) => [r.tool, r.agent]), [["remind", "lan"], ["home_homeassistant__GetLiveContext", "lan"]]);
	// Another agent's rule doesn't reach the default agent.
	await say(host.root, CALL("remind", { text: "a", inMinutes: 5 }));
	assert.equal(asked.at(-1)!.agent, undefined);
	await host.rules.remove("r1");
	await say(host.root, CALL("remind", { text: "b", inMinutes: 5 }));
	assert.equal(asked.length, 3);
});

test("a guard's refusal wins over an allow rule, and the floor keeps asking", async (t) => {
	const { host, lan, asked } = await start(t);
	await host.rules.add({ effect: "allow", agent: "lan", tool: "workspace_*", afterOutside: true });
	assert.match(await say(lan, CALL("workspace_read", { workspace: "egwene", path: "README.md" })), /Lan hasn't been given the workspace egwene/);
	await host.rules.add({ effect: "allow", tool: "schedule*", afterOutside: true });
	await say(lan, CALL("schedule_job", { title: "Lights", instruction: "Turn the lights off.", time: "23:00" }));
	assert.deepEqual(asked.map((r) => r.tool), ["schedule_job"]);
});

test("a rule is checked when it's made", async (t) => {
	const { host } = await start(t);
	await assert.rejects(host.rules.add({ effect: "allow", tool: "schedule_job" }), /schedule_job always asks; no allow rule reaches it\./);
	await assert.rejects(host.rules.add({ effect: "allow", tool: "*" }), /not every tool/);
	await assert.rejects(host.rules.add({ effect: "ask", agent: "nobody", tool: "remind" }), /There's no agent nobody\./);
	await assert.rejects(host.rules.add({ effect: "ask", tool: "remind", afterOutside: true }), /for allow rules/);
	await assert.rejects(host.rules.add({ effect: "ask", tool: "remind", until: Date.now() - 1 }), /end before it starts/);
	await assert.rejects(host.rules.add({ effect: "ask", tool: "bad name" }), /a prefix ending in \*/);
	const hour = await host.rules.add({ effect: "ask", tool: "*", until: Date.now() + 3_600_000 });
	assert.equal(hour.id, "r1");
	assert.deepEqual((await host.rules.list()).map((r) => r.id), ["r1"]);
	await assert.rejects(host.rules.remove("r9"), /There's no rule r9\./);
});

test("the CLI's rule commands read right", () => {
	assert.deepEqual(parseClientMessage('{"type":"rule"}'), { type: "rule", action: "list" });
	assert.deepEqual(parseClientMessage('{"type":"rule","action":"remove","id":"r2"}'), { type: "rule", action: "remove", id: "r2" });
	const added = parseClientMessage('{"type":"rule","action":"add","rule":{"effect":"allow","tool":"home_*","when":[{"arg":"name","op":"one-of","value":["a","b"]}],"afterOutside":true}}');
	assert.deepEqual(added, { type: "rule", action: "add", rule: { effect: "allow", tool: "home_*", when: [{ arg: "name", op: "one-of", value: ["a", "b"] }], afterOutside: true } });
	assert.throws(() => parseClientMessage('{"type":"rule","action":"add","rule":{"effect":"maybe","tool":"x"}}'));
});

test("the app's routes list the rules beside the grants and the floor, add and remove rules, and a request carries its short arguments", async (t) => {
	const { host, lan, asked } = await start(t);
	const web = createWebServer({ harness: host.harness, root: host.root, agents: host.agents, threads: host.threads, user: "brad@example.com", connectors: host.connectors, rules: host.rules, switchable: host.switchable, approvals: host.approvals });
	await new Promise<void>((resolve) => web.listen(0, "127.0.0.1", resolve));
	t.after(async () => {
		web.closeAllConnections();
		await new Promise((resolve) => web.close(resolve));
	});
	const base = `http://127.0.0.1:${(web.address() as AddressInfo).port}`;
	const headers = { "Tailscale-User-Login": "brad@example.com" };
	const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", body: JSON.stringify(body), headers: { ...headers, "Content-Type": "application/json" } });
	await host.approvals.setFetchHosts(["example.com"]);
	await host.agents.update("lan", { hosts: ["news.example"], actHosts: { personal: ["shop.example"] } });
	type Listed = { rules: { id: string }[]; grants: { kind: string; agent?: string; what: string }[]; floor: string[] };
	let listed = (await (await fetch(`${base}/api/rules`, { headers })).json()) as Listed;
	assert.deepEqual(listed.rules, []);
	assert.deepEqual(listed.grants, [
		{ kind: "host", agent: "gaidin", what: "example.com" },
		{ kind: "host", agent: "lan", what: "news.example" },
		{ kind: "act-host", agent: "lan", what: "shop.example in personal" },
		{ kind: "connector-tool", what: "home: homeassistant__GetLiveContext" },
	]);
	assert.ok(listed.floor.includes("schedule_job"));

	assert.equal((await post("/api/rules/add", { effect: "allow", tool: "schedule_job" })).status, 400);
	const made = (await (await post("/api/rules/add", { effect: "ask", agent: "lan", tool: "remind", note: "mine" })).json()) as { id: string };
	listed = (await (await fetch(`${base}/api/rules`, { headers })).json()) as Listed;
	assert.deepEqual(listed.rules.map((r) => r.id), [made.id]);

	await say(lan, CALL("remind", { text: "stretch", inMinutes: 5 }));
	assert.deepEqual(asked.at(-1)!.ruleArgs, { text: "stretch", inMinutes: "5" });
	assert.equal((await post("/api/rules/remove", { id: made.id })).status, 200);
	assert.equal((await post("/api/rules/remove", { id: made.id })).status, 400);
});
