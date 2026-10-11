import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ApprovalRequest, ApprovalService } from "../src/approvals.ts";
import { configFor } from "../src/config.ts";
import { blockedRanges } from "../src/fetch.ts";
import { context, openHost } from "../src/host.ts";
import { fakeSlack, message } from "./fake-slack.ts";

type Steps = Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0];

const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage(fauxToolCall(name, args as never), { stopReason: "toolUse" });
const say = (text: string) => fauxAssistantMessage(fauxText(text));
/** Answers with the last tool result it saw, so a test can read what the tool returned. */
const echoTool = () => (ctx: { messages: readonly { role: string; content?: unknown }[] }) => {
	const last = [...ctx.messages].reverse().find((m) => m.role === "toolResult");
	return say(`saw: ${JSON.stringify(last?.content ?? null)}`);
};

function dataDir(t: TestContext) {
	const dir = mkdtempSync(join(tmpdir(), "gaidin-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

/** A host on the scripted steps, started unless `started` is false, for a test that gives it Slack first. */
async function open(t: TestContext, steps: Steps, dir = dataDir(t), extra: Parameters<typeof openHost>[0] = {}, started = true) {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	faux.setResponses(steps);
	const models = createModels();
	models.setProvider(faux.provider);
	const host = await openHost({ config: configFor({ owner: "Brad" }), dataDir: dir, models, model: { provider: "faux", modelId: "faux-1" }, adapters: { push: { send: async () => true } }, ...extra });
	if (started) await host.start();
	return host;
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

const pendingOne = (approvals: ApprovalService) => until(async () => (await approvals.pending())[0]);

async function lastAnswer(host: Awaited<ReturnType<typeof openHost>>) {
	const messages = (await host.root.context(context)).messages.filter((m) => m.role === "assistant");
	return JSON.stringify(messages.at(-1));
}

test("ask_owner waits for the answer and the run goes on with it", async (t) => {
	const host = await open(t, [call("ask_owner", { question: "Delete the 3 branches with unmerged work too?", choices: ["Yes", "No, keep them"] }), echoTool()]);
	t.after(() => host.harness.close(context));
	const run = await host.root.submit({ type: "input", content: "clean up branches" }, context);
	const question = await pendingOne(host.approvals);
	assert.equal(question.kind, "question");
	assert.deepEqual(question.choices, ["Yes", "No, keep them"]);
	assert.ok(question.expiresAt - question.createdAt >= 7 * 24 * 3_600_000 - 1000, "doesn't wait a week");
	assert.equal(await host.approvals.decide(question.id, "once", "test"), undefined, "a question was approved like a call");
	await host.approvals.answer(question.id, "No, keep them", "test");
	assert.equal((await run.wait(context)).status, "done");
	assert.match(await lastAnswer(host), /Brad answered: No, keep them/);
});

test("the owner's next message in the conversation is the answer", async (t) => {
	const host = await open(t, [call("ask_owner", { question: "Which machine?" }), echoTool()]);
	t.after(() => host.harness.close(context));
	const run = await host.root.submit({ type: "input", content: "run the tests" }, context);
	const question = await pendingOne(host.approvals);
	assert.equal(await host.approvals.intercept(host.root.id, "egwene please", "test"), "answered");
	await run.wait(context);
	assert.match(await lastAnswer(host), /Brad answered: egwene please/);
	assert.equal((await host.approvals.state()).requests[question.id]!.status, "answered");
});

test("a new message instead of an approval skips it, and the run goes on", async (t) => {
	const server = createServer((_req, res) => res.end("page"));
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise((resolve) => server.close(resolve)));
	const url = `http://a.test:${(server.address() as AddressInfo).port}/`;
	const host = await open(t, [call("fetch_url", { url }), echoTool(), say("second message answered")], dataDir(t), {
		fetch: { blocked: blockedRanges({ allowLoopback: true }), resolve: async () => [{ address: "127.0.0.1", family: 4 }] },
	});
	t.after(() => host.harness.close(context));
	const first = await host.root.submit({ type: "input", content: "read it" }, context);
	const request = await pendingOne(host.approvals);
	assert.equal(await host.approvals.intercept(host.root.id, "never mind, something else", "test"), "continue");
	const second = await host.root.submit({ type: "input", content: "never mind, something else" }, context);
	await first.wait(context);
	assert.equal((await second.wait(context)).status, "done");
	assert.equal((await host.approvals.state()).requests[request.id]!.status, "superseded");
	const results = (await host.root.context(context)).messages.filter((m) => m.role === "toolResult").map((m) => JSON.stringify(m.content));
	assert.match(results[0]!, /Brad sent a new message instead of answering/);
});

test("a question open across a restart is the same question, and the run continues once answered", async (t) => {
	const dir = dataDir(t);
	const first = await open(t, [call("ask_owner", { question: "Which branch?" })], dir);
	await first.root.submit({ type: "input", content: "go", requestId: "r1" }, context);
	const before = await pendingOne(first.approvals);
	await first.harness.close(context);
	await new Promise((r) => setTimeout(r, 700));

	const second = await open(t, [echoTool()], dir);
	t.after(() => second.harness.close(context));
	const after = await pendingOne(second.approvals);
	assert.equal(after.id, before.id);
	await second.approvals.answer(after.id, "main", "test");
	await (await second.root.submit({ type: "input", content: "go", requestId: "r1" }, context)).wait(context);
	assert.match(await lastAnswer(second), /Brad answered: main/);
});

test("Slack asks a question with buttons, and a reply in its thread answers it, once", async (t) => {
	const host = await open(t, [call("ask_owner", { question: "Ship it?", choices: ["Ship", "Wait"] }), echoTool()], undefined, {}, false);
	t.after(() => host.harness.close(context));
	const { slack, calls, posts, receive } = fakeSlack(host);
	await host.start(slack.adapter);

	const run = await host.root.submit({ type: "input", content: "release" }, context);
	const question = await pendingOne(host.approvals);
	await until(async () => ((await host.approvals.state()).requests[question.id]!.slackTs ? true : undefined));
	const ask = calls.find((c) => c.method === "chat.postMessage")!;
	assert.deepEqual(ask.body.blocks[1].elements.map((b: any) => b.text.text), ["Ship", "Wait"]);
	assert.match(JSON.stringify(ask.body.blocks), /Reply in this thread/);

	// A reply in the question's thread is the answer; the same event again isn't taken twice.
	const reply = message("9.1", "Wait for Monday", { thread_ts: ask.ts! });
	await receive(reply);
	await run.wait(context);
	assert.match(await lastAnswer(host), /Brad answered: Wait for Monday/);
	await receive(reply);
	await new Promise((r) => setTimeout(r, 200));
	assert.deepEqual(posts(), [], "the reply was also taken as a new message");
	const update = await until(async () => calls.find((c) => c.method === "chat.update"));
	assert.match(update.body.text, /Ship it\?/);
	assert.match(JSON.stringify(update.body.blocks), /Answered: Wait for Monday/);
	const answered: ApprovalRequest = (await host.approvals.state()).requests[question.id]!;
	assert.equal(answered.by, "slack");
});
