import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { type ApprovalRequest, type ApprovalService, askFor } from "../src/approvals.ts";
import type { Situation } from "../src/guards.ts";
import { blockedRanges, type FetchOptions } from "../src/fetch.ts";
import { configFor } from "../src/config.ts";
import { context, type HostOptions, openHost, startHost } from "../src/host.ts";

/** A page on loopback, reachable as a.test and b.test. */
async function site(t: TestContext): Promise<{ port: number; fetch: FetchOptions }> {
	const server = createServer((_req, res) => {
		res.writeHead(200, { "Content-Type": "text/plain" });
		res.end("page text");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise((resolve) => server.close(resolve)));
	return {
		port: (server.address() as AddressInfo).port,
		fetch: { blocked: blockedRanges({ allowLoopback: true }), resolve: async () => [{ address: "127.0.0.1", family: 4 }] },
	};
}

/** Each step fetches the given hosts in one round, then answers. With no rounds it only answers. */
function models(port: number, rounds: string[][]) {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	faux.setResponses(rounds.length === 0 ? [fauxAssistantMessage(fauxText("Done."))] : rounds.flatMap((hosts) => [
		fauxAssistantMessage(hosts.map((host) => fauxToolCall("fetch_url", { url: `http://${host}:${port}/` })), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxText("Done.")),
	]));
	const m = createModels();
	m.setProvider(faux.provider);
	return { models: m, model: { provider: "faux", modelId: "faux-1" } };
}

function dataDir(t: TestContext) {
	const dir = mkdtempSync(join(tmpdir(), "gaidin-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

async function until<T>(get: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
	const end = Date.now() + timeoutMs;
	for (;;) {
		const value = await get();
		if (value !== undefined) return value;
		if (Date.now() > end) throw new Error("timed out");
		await new Promise((r) => setTimeout(r, 20));
	}
}

const nextPending = (approvals: ApprovalService, count = 1) =>
	until(async () => {
		const pending = await approvals.pending();
		return pending.length === count ? pending : undefined;
	});

async function results(host: Awaited<ReturnType<typeof startHost>>) {
	return (await host.root.context(context)).messages.filter((m) => m.role === "toolResult").map((m) => JSON.stringify(m.content));
}

/** A host on the scripted fetches, started unless `started` is false, for a test that gives it Slack first. */
async function start(t: TestContext, rounds: string[][], extra: Partial<HostOptions> = {}, started = true) {
	const { port, fetch } = await site(t);
	const dir = dataDir(t);
	// Named, so the messages are checked with the owner's name in them.
	const host = await openHost({ config: configFor({ owner: "Brad" }), dataDir: dir, fetch, adapters: { push: { send: async () => true } }, ...models(port, rounds), ...extra });
	t.after(() => host.harness.close(context));
	if (started) await host.start();
	return { host, dir, port, fetch };
}

test("a fetch to a new host waits for Brad; once allows that call, always allows the host", async (t) => {
	const { host } = await start(t, [["a.test"], ["a.test"], ["a.test"]]);
	const seen: ApprovalRequest[] = [];
	host.approvals.onChange((r) => void seen.push(r));

	const first = await host.root.submit({ type: "input", content: "one" }, context);
	const [request] = await nextPending(host.approvals);
	assert.equal(request!.tool, "fetch_url");
	assert.match(request!.summary, /^fetch http:\/\/a\.test:\d+\/$/);
	assert.deepEqual(request!.always, { kind: "fetch-host", value: "a.test", label: "Always allow a.test", done: "Always allowed a.test" });
	await host.approvals.decide(request!.id, "once", "test");
	assert.equal((await first.wait(context)).status, "done");
	assert.match((await results(host))[0]!, /page text/);

	const second = await host.root.submit({ type: "input", content: "two" }, context);
	const [again] = await nextPending(host.approvals);
	assert.notEqual(again!.id, request!.id);
	await host.approvals.decide(again!.id, "always", "test");
	await second.wait(context);

	await (await host.root.submit({ type: "input", content: "three" }, context)).wait(context);
	assert.equal((await host.approvals.pending()).length, 0);
	assert.equal((await results(host)).filter((r) => /page text/.test(r)).length, 3);
	assert.deepEqual(seen.map((r) => r.status), ["pending", "approved", "pending", "approved"]);
});

test("a denied fetch is blocked, and the model is told why", async (t) => {
	const { host } = await start(t, [["a.test"]]);
	const run = await host.root.submit({ type: "input", content: "go" }, context);
	const [request] = await nextPending(host.approvals);
	await host.approvals.decide(request!.id, "deny", "test");
	await run.wait(context);
	assert.match((await results(host))[0]!, /blocked: Needs Brad's approval to fetch http:\/\/a\.test:\d+\/, and Brad said no/);
});

test("a fetch of a URL web_search returned doesn't ask; one only named in a snippet does", async (t) => {
	const { port, fetch } = await site(t);
	const found = `http://a.test:${port}/curry`;
	const named = `http://a.test:${port}/other`;
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("web_search", { query: "curry" }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("fetch_url", { url: found }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("fetch_url", { url: named }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxText("Done.")),
	]);
	const m = createModels();
	m.setProvider(faux.provider);
	const search = async () => [{ title: "Curry", url: found, snippet: `See also ${named}` }];
	const host = await startHost({ dataDir: dataDir(t), fetch, search, adapters: { push: { send: async () => true } }, models: m, model: { provider: "faux", modelId: "faux-1" } });
	t.after(() => host.harness.close(context));

	const run = await host.root.submit({ type: "input", content: "find a curry" }, context);
	const [request] = await nextPending(host.approvals);
	assert.equal(request!.summary, `fetch ${named}`);
	await host.approvals.decide(request!.id, "once", "test");
	await run.wait(context);
	assert.equal((await results(host)).filter((r) => /page text/.test(r)).length, 2);
	assert.equal(Object.keys((await host.approvals.state()).requests).length, 1);
});

test("no answer in time blocks the call", async (t) => {
	const { host } = await start(t, [["a.test"]], { approvalTimeoutMs: 300 });
	await (await host.root.submit({ type: "input", content: "go" }, context)).wait(context);
	assert.match((await results(host))[0]!, /Brad didn't answer in time/);
	assert.equal((await host.approvals.state()).requests[Object.keys((await host.approvals.state()).requests)[0]!]!.status, "expired");
});

test("stopping the run closes its request", async (t) => {
	const { host } = await start(t, [["a.test"]]);
	await host.root.submit({ type: "input", content: "go" }, context);
	const [request] = await nextPending(host.approvals);
	await host.root.abort(context);
	await until(async () => ((await host.approvals.state()).requests[request!.id]!.status === "cancelled" ? true : undefined));
	assert.equal(await host.approvals.decide(request!.id, "once", "test"), undefined);
});

test("a request open across a restart is the same request, and the call goes on once it's answered", async (t) => {
	const { port, fetch } = await site(t);
	const dir = dataDir(t);
	const first = await startHost({ dataDir: dir, fetch, adapters: { push: { send: async () => true } }, ...models(port, [["a.test"]]) });
	const asked: string[] = [];
	first.approvals.onChange((r) => void (r.status === "pending" && asked.push(r.id)));
	await first.root.submit({ type: "input", content: "go", requestId: "r1" }, context);
	const [before] = await nextPending(first.approvals);
	await first.harness.close(context);
	await new Promise((r) => setTimeout(r, 700));

	// The tool call is already stored; the model only has to answer after it.
	const second = await startHost({ dataDir: dir, fetch, adapters: { push: { send: async () => true } }, ...models(port, []) });
	t.after(() => second.harness.close(context));
	second.approvals.onChange((r) => void (r.status === "pending" && asked.push(r.id)));
	const [after] = await nextPending(second.approvals);
	assert.equal(after!.id, before!.id);
	assert.equal(after!.status, "pending");
	await second.approvals.decide(after!.id, "once", "test");
	const run = await second.root.submit({ type: "input", content: "go", requestId: "r1" }, context);
	assert.equal((await run.wait(context)).status, "done");
	assert.match((await results(second))[0]!, /page text/);
	assert.deepEqual(asked, [before!.id], "asked again after the restart");
});

test("Slack asks with buttons, in the thread for a forked conversation, and shows the outcome", async (t) => {
	const { SlackState } = await import("../src/slack/index.ts");
	const { fakeSlack, press: button } = await import("./fake-slack.ts");
	const { host } = await start(t, [["a.test"], ["b.test"]], {}, false);
	const { slack, calls, press: pressed } = fakeSlack(host);
	await host.start(slack.adapter);
	const press = (id: string, decision: string, user = "U1") => pressed(button(`gaidin-approve-${decision}`, JSON.stringify({ id, decision }), { user: { id: user } }));

	// The root conversation asks at the top of the channel.
	const run = await host.root.submit({ type: "input", content: "one" }, context);
	const [request] = await nextPending(host.approvals);
	await until(async () => ((await host.approvals.state()).requests[request!.id]!.slackTs ? true : undefined));
	assert.equal(calls[0]!.method, "chat.postMessage");
	assert.equal(calls[0]!.body.thread_ts, undefined);
	const labels = calls[0]!.body.blocks[1].elements.map((b: any) => b.text.text);
	assert.deepEqual(labels, ["Allow once", "Always allow a.test", "Deny"]);

	await press(request!.id, "once", "U2");
	assert.equal((await host.approvals.pending()).length, 1, "someone else's press counted");
	await press(request!.id, "always");
	await run.wait(context);
	await until(async () => (calls.some((c) => c.method === "chat.update") ? true : undefined));
	const update = calls.find((c) => c.method === "chat.update")!;
	assert.equal(update.body.ts, "bot.1");
	assert.match(update.body.text, /Always allowed a\.test in Slack/);
	assert.equal(update.body.blocks.length, 1);

	// A fork that a thread maps to asks in that thread.
	const answer = (await host.root.entries({}, 1, undefined, context)).items[0]!;
	const fork = await host.root.fork(answer.id, { ownership: { kind: "ownerless" } }, context);
	await host.root.commit(async (tx) => {
		(await tx.doc(SlackState)).threads["111.222"] = fork.id;
	}, context);
	await fork.submit({ type: "input", content: "two" }, context);
	await nextPending(host.approvals);
	await until(async () => (calls.filter((c) => c.method === "chat.postMessage").length === 2 ? true : undefined));
	assert.equal(calls.filter((c) => c.method === "chat.postMessage")[1]!.body.thread_ts, "111.222");
});

test("the web view lists requests and decides them", async (t) => {
	const { createWebServer } = await import("../src/web.ts");
	const { host } = await start(t, [["a.test"]]);
	const server = createWebServer({ harness: host.harness, root: host.root, user: "me", switchable: host.switchable, approvals: host.approvals });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise((resolve) => {
		server.closeAllConnections();
		server.close(resolve);
	}));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const headers = { "Tailscale-User-Login": "me", "Content-Type": "application/json" };

	const run = await host.root.submit({ type: "input", content: "go" }, context);
	await nextPending(host.approvals);
	const listed = (await (await fetch(`${base}/api/approvals`, { headers })).json()) as ApprovalRequest[];
	assert.equal(listed.length, 1);
	assert.equal((await fetch(`${base}/api/approvals/decide`, { method: "POST", headers, body: JSON.stringify({ id: listed[0]!.id, decision: "maybe" }) })).status, 400);
	const decided = await fetch(`${base}/api/approvals/decide`, { method: "POST", headers, body: JSON.stringify({ id: listed[0]!.id, decision: "deny" }) });
	assert.deepEqual(await decided.json(), { ok: true });
	await run.wait(context);
	assert.equal((await host.approvals.state()).requests[listed[0]!.id]!.by, "web");
});

test("a call whose arguments its guard can't read is asked about, showing all of them, not let through", async () => {
	const { createFetch } = await import("../src/fetch.ts");
	const { createMemory } = await import("../src/memory.ts");
	const { createWorkspaces } = await import("../src/workspaces.ts");
	const { redactorFor } = await import("../src/redact.ts");
	const guards = [
		...createFetch().guards,
		...createMemory("Brad").guards,
		...createWorkspaces({ workspaces: [{ name: "egwene", target: "me@egwene" }], remote: undefined, redactor: redactorFor({}), owner: "Brad" }).guards,
	];
	const situation: Situation = { fetchHosts: [], grants: [], conversationId: 1, outside: async () => ["fetch_url"], searched: async () => [], snapshot: async () => undefined };
	const ask = (name: string, args: Record<string, any>) => askFor(guards.find((g) => g.tool === name)!, { type: "toolCall", id: "c1", name, arguments: args }, situation);
	const run = await ask("workspace_run", { workspace: 3, command: "rm -rf ~" });
	assert.equal(run!.summary, "workspace_run with arguments that don't read right (workspace_run's arguments.workspace should be a string)");
	assert.match(run!.detail!, /rm -rf ~/);
	assert.match((await ask("fetch_url", { url: ["https://a.example/"] }))!.summary, /^fetch_url with arguments that don't read right/);
	assert.match((await ask("remember", { text: 5 }))!.summary, /^remember with arguments that don't read right/);
});
