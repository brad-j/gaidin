import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { configFor } from "../src/config.ts";
import { blockedRanges, type FetchOptions } from "../src/fetch.ts";
import type { Activity } from "../src/history.ts";
import { context, openHost } from "../src/host.ts";
import { stamp } from "../src/time.ts";

type Step = (lastResult: string) => ReturnType<typeof fauxAssistantMessage>;

const say = (text: string): Step => () => fauxAssistantMessage(fauxText(text));
const call = (name: string, args: (lastResult: string) => Parameters<typeof fauxToolCall>[1]): Step => (last) =>
	fauxAssistantMessage(fauxToolCall(name, args(last)), { stopReason: "toolUse" });

/** A host whose model plays `steps` in order, across every conversation. */
async function start(t: TestContext, steps: Step[], dir: string, extra: { fetch?: FetchOptions } = {}) {
	const step: FauxResponseFactory = (ctx) => {
		const last = ctx.messages.at(-1);
		const text = last?.role === "toolResult" ? last.content.map((c) => (c.type === "text" ? c.text : "")).join("") : "";
		return steps.shift()?.(text) ?? fauxAssistantMessage(fauxText("Done."));
	};
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	faux.setResponses(Array.from({ length: 20 }, () => step));
	const models = createModels();
	models.setProvider(faux.provider);
	const host = await openHost({ config: configFor({ owner: "Brad" }), dataDir: dir, models, model: { provider: "faux", modelId: "faux-1" }, sandbox: "none", notify: async () => {}, ...extra });
	t.after(() => host.harness.close(context));
	return host;
}

function dataDir(t: TestContext) {
	const dir = mkdtempSync(join(tmpdir(), "gaidin-history-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

async function ask(conversation: Awaited<ReturnType<typeof start>>["root"], content: string) {
	await (await conversation.submit({ type: "input", content: stamp(content) }, context)).wait(context);
}

async function results(host: Awaited<ReturnType<typeof start>>) {
	return (await host.root.context(context)).messages.flatMap((m) => (m.role === "toolResult" ? [m.content.map((c) => (c.type === "text" ? c.text : "")).join("")] : []));
}

test("messages and answers are found, in the main conversation and a thread, and read in context; tool output isn't", async (t) => {
	const steps = [say("Noted: the NAS is in the hall closet."), call("list_reminders", () => ({})), say("Nothing open."), say("Fine.")];
	const host = await start(t, steps, dataDir(t));
	await ask(host.root, "the NAS lives in the hall closet now");
	await ask(host.root, "any open reminders?");
	const answer = (await host.root.entries({}, 1, undefined, context)).items[0]!;
	const thread = await host.root.fork(answer.id, { ownership: { kind: "ownerless" } }, context);
	await ask(thread, "the closet key is on the hook");

	steps.push(
		call("search_history", () => ({ query: "closets" })),
		call("search_history", () => ({ query: "open reminders" })),
		call("read_history", (last) => ({ id: Number(/#(\d+)/.exec(last)![1]) })),
	);
	await ask(host.root, "where's the NAS?");
	const [found, reminders, around] = (await results(host)).slice(-3);

	const lines = found!.split("\n");
	assert.equal(lines.length, 3);
	assert.match(lines[0]!, /^#\d+ · .+ · Slack thread · Brad: the «closet» key is on the hook$/);
	assert.match(lines[1]!, /· main conversation · gaidin: Noted: the NAS is in the hall «closet»\.$/);
	assert.match(lines[2]!, /· main conversation · Brad: the NAS lives in the hall «closet» now$/);
	// "No open reminders." is list_reminders' output, so only Brad's question matches.
	assert.match(reminders!, /^#\d+ · .+ · Brad: any «open» «reminders»\?$/);
	assert.match(around!, /Brad: the NAS lives in the hall closet now\n\n#\d+ · .+ · gaidin: Noted: the NAS is in the hall closet\.\n\n#\d+ · .+ · Brad: any open reminders\?/);
});

test("the index is rebuilt from the transcript when its file is gone", async (t) => {
	const dir = dataDir(t);
	const first = await start(t, [say("Noted.")], dir);
	await ask(first.root, "the spare router is a GL.iNet in the garage");
	await first.harness.close(context);
	rmSync(join(dir, "history.sqlite"));

	const second = await start(t, [call("search_history", () => ({ query: "router garage" }))], dir);
	await ask(second.root, "where's the spare router?");
	assert.match((await results(second)).at(-1)!, /Brad: the spare «router» is a GL\.iNet in the «garage»$/);
});

test("the timeline lists what gaidin did and who allowed it, newest first, and is rebuilt with the index", async (t) => {
	const dir = dataDir(t);
	const server = createServer((_req, res) => res.end("page text"));
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise((resolve) => server.close(resolve)));
	const url = `http://a.test:${(server.address() as AddressInfo).port}/`;
	const fetch = { blocked: blockedRanges({ allowLoopback: true }), resolve: async () => [{ address: "127.0.0.1", family: 4 }] };
	const steps = [call("fetch_url", () => ({ url })), call("list_reminders", () => ({})), call("remember", () => ({ text: "the page says page text" })), say("Done.")];
	const host = await start(t, steps, dir, { fetch });
	host.approvals.onChange((request) => void (request.status === "pending" && host.approvals.decide(request.id, "once", "slack")));
	await ask(host.root, "read the page and remember it");

	// An approval is recorded when it's decided, after the call that asked. list_reminders isn't listed.
	const pick = (items: Activity[]) => items.map(({ kind, name, outcome }) => `${kind} ${name}: ${outcome}`);
	const { items } = await host.timeline();
	assert.deepEqual(pick(items), [
		"approval remember: allowed once in Slack",
		"tool remember: ok",
		"approval fetch_url: allowed once in Slack",
		"tool fetch_url: ok",
	]);
	assert.ok(items.every((item) => item.at > 0 && item.place === "main"));
	assert.match(items.find((i) => i.kind === "approval" && i.name === "fetch_url")!.detail, /^fetch http:\/\/a\.test:\d+\/$/);
	await host.harness.close(context);

	rmSync(join(dir, "history.sqlite"));
	const again = await start(t, [], dir);
	assert.deepEqual(pick((await again.timeline()).items), pick(items));
});
