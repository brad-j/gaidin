import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { context, openHost, startHost } from "../src/host.ts";
import { type Job, Jobs } from "../src/jobs.ts";
import { Reminders } from "../src/reminders.ts";
import { slackDownload } from "../src/slack/api.ts";
import { conversationId } from "../src/ids.ts";
import { recordPosted, SlackState } from "../src/slack/index.ts";
import { createWebServer } from "../src/web.ts";
import { BRAD, type Call, CHANNEL, fakeSlack, message, press, SETTINGS } from "./fake-slack.ts";
import { agentIdOf } from "../src/agents.ts";
import { configFor } from "../src/config.ts";

function tempDir(t: TestContext): string {
	const dir = mkdtempSync(join(tmpdir(), "gaidin-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

// Answers with every user message it can see, without the time stamp, so a test can tell which
// history a conversation has.
function echoModels() {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	const step = (ctx: { messages: readonly { role: string; content?: unknown }[] }) => {
		const seen = ctx.messages
			.filter((m) => m.role === "user")
			.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)).replace(/^\[[^\]]*\] /, ""));
		return fauxAssistantMessage(fauxText(seen.join(" / ")));
	};
	faux.setResponses(Array.from({ length: 50 }, () => step));
	const models = createModels();
	models.setProvider(faux.provider);
	return { models, model: { provider: "faux", modelId: "faux-1" } };
}

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 10_000) {
	const end = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() > end) throw new Error("timed out");
		await new Promise((r) => setTimeout(r, 20));
	}
}

test("each top-level message starts its own conversation, answered in its thread", async (t) => {
	const host = await startHost({ dataDir: tempDir(t), ...echoModels() });
	t.after(() => host.harness.close(context));
	const { posts, receive } = fakeSlack(host);
	await host.root.configure({ thinkingLevel: "high" }, context);
	const said = await (await host.root.submit({ type: "input", content: "main" }, context)).wait(context);

	await receive(message("1.0", "a"));
	await until(() => posts().length === 1);
	await receive(message("2.0", "b"));
	await until(() => posts().length === 2);
	// Neither sees the main conversation or the other.
	assert.deepEqual(posts().map((p) => [p.text, p.threadTs]), [["a", "1.0"], ["b", "2.0"]]);

	await receive(message("3.0", "c", { thread_ts: "1.0" }));
	await until(() => posts().length === 3);
	assert.deepEqual([posts()[2]!.text, posts()[2]!.threadTs], ["a / c", "1.0"]);

	// A thread's conversation has the main conversation's settings, and the main conversation saw none of it.
	const threads = (await host.harness.snapshot(SlackState, context))!.threads;
	const thread = await host.harness.conversation(conversationId(threads["1.0"]!), context);
	assert.equal((await thread!.agent(context)).thinkingLevel, "high");
	const listed = (await host.history.conversations()).items.find((c) => c.id === thread!.id);
	assert.deepEqual([listed?.place, listed?.title, listed?.forkedAt], ["thread", "a", undefined]);
	const next = await (await host.root.submit({ type: "input", content: "main again" }, context)).wait(context);
	if (next.status !== "done" || next.type !== "input") throw new Error("the run didn't finish");
	assert.match(JSON.stringify(await host.root.commit((tx) => tx.entry(next.answer), context)), /main \/ main again/);

	// A thread on an answer posted in the channel before threads were separate still forks the main conversation there.
	if (said.status !== "done" || said.type !== "input") throw new Error("the run didn't finish");
	await recordPosted(host.root, ["old.1"], said.answer, host.root.id as number);
	await receive(message("4.0", "d", { thread_ts: "old.1" }));
	await until(() => posts().length === 4);
	assert.deepEqual([posts()[3]!.text, posts()[3]!.threadTs], ["main / d", "old.1"]);
});

test("a redelivered event is answered once", async (t) => {
	const host = await startHost({ dataDir: tempDir(t), ...echoModels() });
	t.after(() => host.harness.close(context));
	const { posts, receive } = fakeSlack(host);

	await Promise.all([receive(message("1.0", "a")), receive(message("1.0", "a"))]);
	await until(() => posts().length === 1);
	await receive(message("1.0", "a"));
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(posts().length, 1);
});

test("other people, other channels, bots and edits are ignored", async (t) => {
	const host = await startHost({ dataDir: tempDir(t), ...echoModels() });
	t.after(() => host.harness.close(context));
	const { posts, receive } = fakeSlack(host);

	await receive(message("1.0", "x", { user: "U2" }));
	await receive(message("2.0", "x", { channel: "C2" }));
	await receive(message("3.0", "x", { bot_id: "B1" }));
	await receive(message("4.0", "x", { subtype: "message_changed" }));
	await receive(message("5.0", "a"));
	await until(() => posts().length === 1);
	assert.equal(posts()[0]!.text, "a");
});

test("a thread on a message gaidin never answered gets a note instead of a fork", async (t) => {
	const host = await startHost({ dataDir: tempDir(t), ...echoModels() });
	t.after(() => host.harness.close(context));
	const { posts, receive } = fakeSlack(host);

	await receive(message("2.0", "hello", { thread_ts: "1.0" }));
	assert.equal(posts().length, 1);
	assert.equal(posts()[0]!.threadTs, "1.0");
	assert.match(posts()[0]!.text, /only pick up threads/);
});

test("an answer that wasn't posted before a restart is posted by the next process", async (t) => {
	const dir = tempDir(t);
	const first = await startHost({ dataDir: dir, ...echoModels() });
	let posting = false;
	// Slack never answers, as if the process died mid-post.
	const before = fakeSlack(first, {
		api: () => {
			posting = true;
			return new Promise(() => {});
		},
	});
	await before.receive(message("1.0", "a"));
	await until(() => posting);
	await first.harness.close(context);

	const second = await startHost({ dataDir: dir, ...echoModels() });
	t.after(() => second.harness.close(context));
	// Starting Slack answers it.
	const after = fakeSlack(second);
	const { posts } = after;
	await until(() => posts().length === 1);
	assert.deepEqual(posts().map((p) => p.text), ["a"]);

	// The recovered answer is recorded, so a thread on it forks.
	await after.receive(message("2.0", "b", { thread_ts: "1.0" }));
	await until(() => posts().length === 2);
	assert.equal(posts()[1]!.text, "a / b");
});

test("a message from the app to a Slack thread's conversation is posted there, marked, and then its answer", async (t) => {
	const host = await startHost({ dataDir: tempDir(t), ...echoModels() });
	t.after(() => host.harness.close(context));
	const { slack, posts, receive } = fakeSlack(host);
	const web = createWebServer({ harness: host.harness, root: host.root, agents: host.agents, threads: host.threads, user: "brad@example.com", switchable: host.switchable, approvals: host.approvals, mirror: slack.mirror });
	await new Promise<void>((resolve) => web.listen(0, "127.0.0.1", resolve));
	t.after(() => {
		web.closeAllConnections();
		web.close();
	});
	const send = (body: unknown) =>
		fetch(`http://127.0.0.1:${(web.address() as AddressInfo).port}/api/message`, {
			method: "POST",
			headers: { "Tailscale-User-Login": "brad@example.com", "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});

	await receive(message("1.0", "a"));
	await until(() => posts().length === 1);
	const thread = (await host.harness.snapshot(SlackState, context))!.threads["1.0"]!;
	assert.equal((await send({ content: "b", conversation: thread, requestId: "r1" })).status, 200);
	await until(() => posts().length === 3);
	assert.deepEqual(posts().slice(1).map((p) => [p.text, p.threadTs]), [["*From the app:* b", "1.0"], ["a / b", "1.0"]]);
	assert.deepEqual((await host.harness.snapshot(SlackState, context))!.mirrored, {});

	// A conversation with no Slack thread, such as the home conversation, posts nothing.
	assert.equal((await send({ content: "c", requestId: "r2" })).status, 200);
	await (await host.root.submit({ type: "input", content: "after" }, context)).wait(context);
	await new Promise((r) => setTimeout(r, 100));
	assert.equal(posts().length, 3);
});

test("a message from the app that wasn't posted in Slack before a restart is posted by the next process, then its answer", async (t) => {
	const dir = tempDir(t);
	const first = await startHost({ dataDir: dir, ...echoModels() });
	let stuck = false;
	// Slack never answers, as if the process died mid-post.
	const before = fakeSlack(first, {
		api: () => {
			stuck = true;
			return new Promise(() => {});
		},
	});
	await before.receive(message("1.0", "a"));
	await until(() => stuck);
	const threadId = (await first.harness.snapshot(SlackState, context))!.threads["1.0"]!;
	const thread = (await first.harness.conversation(conversationId(threadId), context))!;
	const submission = await thread.submit({ type: "input", content: "[Fri 2026-10-16 09:00 GMT-4] b", requestId: "web:r1" }, context);
	assert.equal(await before.slack.mirror({ conversationId: threadId, submission: submission.id, text: "b" }), true);
	await submission.wait(context);
	await first.harness.close(context);

	const second = await startHost({ dataDir: dir, ...echoModels() });
	t.after(() => second.harness.close(context));
	const { posts } = fakeSlack(second);
	await until(() => posts().length === 3);
	const texts = posts().map((p) => p.text);
	// The app's message comes before its answer; Slack's own answer to "a" may come at any point.
	assert.ok(texts.includes("a"), texts.join(" | "));
	assert.ok(texts.indexOf("*From the app:* b") < texts.indexOf("a / b"), texts.join(" | "));
	assert.ok(posts().every((p) => p.threadTs === "1.0"));
});

test("a thread on a job's report forks the run's conversation, not the root", async (t) => {
	const host = await startHost({ dataDir: tempDir(t), ...echoModels() });
	t.after(() => host.harness.close(context));
	const { posts, receive } = fakeSlack(host);

	// A job run: its own conversation, with its own history.
	const run = await host.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "faux-1" } } }, context);
	const settled = await (await run.submit({ type: "input", content: "job prompt" }, context)).wait(context);
	assert.equal(settled.status, "done");
	if (settled.status !== "done" || settled.type !== "input") throw new Error("the run didn't finish");
	await recordPosted(host.root, ["job.1"], settled.answer, run.id as number);

	await receive(message("2.0", "about that", { thread_ts: "job.1" }));
	await until(() => posts().length === 1);
	assert.deepEqual([posts()[0]!.text, posts()[0]!.threadTs], ["job prompt / about that", "job.1"]);
});

test("images in a message go to the model, other files are saved in the sandbox, and one that can't be fetched is noted", async (t) => {
	const dir = tempDir(t);
	let seen: unknown;
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	faux.setResponses([
		(ctx) => {
			seen = ctx.messages.findLast((m) => m.role === "user")?.content;
			return fauxAssistantMessage(fauxText("Got them."));
		},
	]);
	const models = createModels();
	models.setProvider(faux.provider);
	const host = await startHost({ dataDir: dir, models, model: { provider: "faux", modelId: "faux-1" } });
	t.after(() => host.harness.close(context));
	const png = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("pixels")]);
	const downloads: string[] = [];
	const download = async (url: string) => {
		downloads.push(url);
		if (url === "u/gone") throw new Error("Slack answered 404");
		return url === "u/receipt" ? Buffer.from("%PDF-1.4 receipt") : png;
	};
	const { posts, receive } = fakeSlack(host, { download });

	await receive(message("5.0", "what are these?", {
		subtype: "file_share",
		files: [
			{ name: "shot.png", mimetype: "image/png", size: 14, url_private: "u/shot" },
			{ name: "huge.png", mimetype: "image/png", size: 9_000_000, url_private: "u/huge", thumb_1024: "u/huge-1024" },
			{ name: "receipt 1.pdf", mimetype: "application/pdf", size: 16, url_private: "u/receipt" },
			{ name: "gone.txt", mimetype: "text/plain", size: 3, url_private: "u/gone" },
		],
	}));
	await until(() => posts().length === 1);

	assert.deepEqual(downloads, ["u/shot", "u/huge-1024", "u/receipt", "u/gone"]);
	const [text, ...images] = seen as { type: string; text?: string; data?: string; mimeType?: string }[];
	assert.match(text!.text!, /what are these\?\n\n\[Files from Slack: receipt 1\.pdf is saved as uploads\/5\.0-receipt_1\.pdf \(application\/pdf, 1 KB\); gone\.txt couldn't be fetched: Slack answered 404\./);
	assert.deepEqual(images, [png, png].map((data) => ({ type: "image", data: data.toString("base64"), mimeType: "image/png" })));
	assert.equal(readFileSync(join(host.sandbox, "uploads", "5.0-receipt_1.pdf"), "utf8"), "%PDF-1.4 receipt");

	// A file with no text is a message too.
	await receive(message("6.0", "", { subtype: "file_share", files: [{ name: "a.png", mimetype: "image/png", size: 14, url_private: "u/a" }] }));
	await until(() => posts().length === 2);
});

test("a fired reminder is posted with snooze buttons, and Brad's press snoozes it and says until when", async (t) => {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	faux.setResponses([fauxAssistantMessage(fauxToolCall("remind", { text: "take the bread out", inMinutes: 0.01 }), { stopReason: "toolUse" }), fauxAssistantMessage(fauxText("Set."))]);
	const models = createModels();
	models.setProvider(faux.provider);
	const host = await openHost({ dataDir: tempDir(t), models, model: { provider: "faux", modelId: "faux-1" }, adapters: { push: { send: async () => true } } });
	t.after(() => host.harness.close(context));
	const { slack, calls, press: pressed } = fakeSlack(host);
	await host.start(slack.adapter);

	await (await host.root.submit({ type: "input", content: "remind me" }, context)).wait(context);
	await until(() => calls.some((c) => c.body.blocks !== undefined));
	const posted = calls[0]!.body as { channel: string; blocks: { type: string; elements?: { action_id: string; value: string }[] }[] };
	assert.equal(posted.channel, CHANNEL);
	const [ten, hour] = posted.blocks[1]!.elements!.map((b) => [b.action_id, JSON.parse(b.value)]);
	assert.deepEqual([ten![0], hour![0]], ["gaidin-snooze-10", "gaidin-snooze-60"]);
	assert.deepEqual([ten![1].minutes, hour![1].minutes], [10, 60]);
	const id = hour![1].id as number;

	const snooze = (user: string) => pressed(press("gaidin-snooze-60", JSON.stringify({ id, minutes: 60 }), { user: { id: user }, message: { ts: calls[0]!.ts! } }));
	const open = async () => (await host.harness.snapshot(Reminders, context))?.items ?? [];
	await snooze("U2");
	assert.deepEqual(await open(), []);
	await snooze(BRAD);
	const [again] = await open();
	assert.equal(again!.text, "take the bread out");
	assert.ok(Math.abs(again!.at - (Date.now() + 60 * 60_000)) < 5000);
	const update = calls[1]!;
	assert.equal(update.method, "chat.update");
	assert.equal(update.body.ts, calls[0]!.ts);
	assert.match(JSON.stringify(update.body.blocks), /Snoozed until /);
	assert.doesNotMatch(JSON.stringify(update.body.blocks), /gaidin-snooze/);
});

test("a paused job is posted with a resume button, and Brad's press resumes it", async (t) => {
	const host = await startHost({ dataDir: tempDir(t), ...echoModels(), adapters: { push: { send: async () => true } } });
	t.after(() => host.harness.close(context));
	const { slack, calls, press: pressed } = fakeSlack(host);
	const job = { taskId: 4, title: "Disks", paused: { at: 0, reason: "5 failed runs in a row" }, failures: 5 } as unknown as Job;
	await host.root.commit(async (tx) => void (await tx.doc(Jobs)).items.push(job), context);
	const paused = async () => (await host.harness.snapshot(Jobs, context))?.items[0]?.paused !== undefined;

	await slack.adapter.send({ kind: "paused", report: { taskId: 4, title: "Disks", text: "Paused after 5 failed runs in a row", conversationId: 9, paused: true } });
	const posted = calls[0]!.body as { blocks: { type: string; elements?: { action_id: string; value: string }[] }[] };
	assert.deepEqual(posted.blocks[1]!.elements!.map((b) => [b.action_id, b.value]), [["gaidin-resume-job", "4"]]);

	const resume = (user: string) => pressed(press("gaidin-resume-job", "4", { user: { id: user }, message: { ts: calls[0]!.ts!, text: "Disks: paused", blocks: posted.blocks } }));
	await resume("U2");
	assert.equal(await paused(), true);
	await resume(BRAD);
	assert.equal(await paused(), false);
	const update = calls[1]!.body as { ts: string; blocks: { type: string }[] };
	assert.equal(update.ts, calls[0]!.ts);
	assert.deepEqual(update.blocks.map((b) => b.type), ["section", "context"]);
	assert.match(JSON.stringify(update.blocks), /"Resumed"/);
	// A second press finds it running already.
	await resume(BRAD);
	assert.match(JSON.stringify(calls[2]!.body.blocks), /Not paused any more/);
});

test("only Brad's messages and presses in the gaidin channel reach either part", async (t) => {
	const host = await startHost({ dataDir: tempDir(t), ...echoModels(), adapters: { push: { send: async () => true } } });
	t.after(() => host.harness.close(context));
	const { calls, receive, press: pressed } = fakeSlack(host);
	const job = { taskId: 4, title: "Disks", paused: { at: 0, reason: "stuck" } } as unknown as Job;
	await host.root.commit(async (tx) => void (await tx.doc(Jobs)).items.push(job), context);

	for (const extra of [{ user: "U2" }, { channel: "C2" }]) await receive(message("1.0", "hi", extra));
	await pressed(press("gaidin-resume-job", "4", { user: { id: "U2" } }));
	await pressed(press("gaidin-resume-job", "4", { channel: { id: "C2" } }));
	await new Promise((r) => setTimeout(r, 300));
	assert.deepEqual(calls, []);
	assert.notEqual((await host.harness.snapshot(Jobs, context))?.items[0]?.paused, undefined);
});

test("a file is downloaded with the bot token only from Slack's file host", async (t) => {
	const seen: (string | undefined)[] = [];
	const server = createServer((req, res) => {
		seen.push(req.headers.authorization);
		res.writeHead(200, { "Content-Type": "image/png" });
		res.end("png");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise((resolve) => server.close(resolve)));
	const download = slackDownload("xoxb-secret");
	const port = (server.address() as AddressInfo).port;
	for (const url of [`http://127.0.0.1:${port}/files-pri/T1-F1/shot.png`, "https://files.slack.com.evil.example/shot.png", "http://files.slack.com/shot.png", "not a url"]) {
		await assert.rejects(download(url), /only from https:\/\/files\.slack\.com/, url);
	}
	assert.deepEqual(seen, [], "the token was sent elsewhere");
});

/** A model that asks Brad with ask_owner when a message says "ask", and says what came back; otherwise it echoes. */
function askingModels() {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	const step = (ctx: { messages: readonly { role: string; content?: unknown }[] }) => {
		const last = ctx.messages.filter((m) => m.role !== "system").at(-1)!;
		const text = typeof last.content === "string" ? last.content : JSON.stringify(last.content);
		if (last.role === "toolResult") return fauxAssistantMessage(fauxText(`got: ${text}`));
		if (text.includes("ask")) return fauxAssistantMessage(fauxToolCall("ask_owner", { question: "Which one?" }), { stopReason: "toolUse" });
		return fauxAssistantMessage(fauxText(text.replace(/^\[[^\]]*\] /, "")));
	};
	faux.setResponses(Array.from({ length: 50 }, () => step));
	const models = createModels();
	models.setProvider(faux.provider);
	return { models, model: { provider: "faux", modelId: "faux-1" } };
}

/** gaidin with Scout, whose own channel is C2, and Verin, who has none; Slack started. */
async function withAgents(t: TestContext, scopes?: string[], models = echoModels()) {
	const host = await openHost({ dataDir: tempDir(t), ...models, adapters: { push: { send: async () => true } } });
	t.after(() => host.harness.close(context));
	await host.agents.add({ id: "scout", name: "Scout", job: "" });
	await host.agents.update("scout", { channel: "C2" });
	await host.agents.add({ id: "verin", name: "Verin", job: "" });
	const slack = fakeSlack(host, { scopes });
	await host.start(slack.slack.adapter);
	return { host, ...slack };
}

/** What a post says and where, as gaidin made it. */
const shown = (c: Call) => ({ channel: c.body.channel as string, thread: c.body.thread_ts as string | undefined, name: c.body.username as string | undefined, text: (c.body.markdown_text ?? c.body.text) as string });

test("a message in an agent's channel starts a thread with that agent, answered there under its name, and other channels' timestamps don't collide", async (t) => {
	const { host, calls, receive } = await withAgents(t);
	const posts = () => calls.filter((c) => c.method === "chat.postMessage").map(shown);
	// The same ts in both channels, as Slack can give.
	await receive(message("1.0", "for scout", { channel: "C2" }));
	await until(() => posts().length === 1);
	await receive(message("1.0", "for gaidin"));
	await until(() => posts().length === 2);
	assert.deepEqual(posts(), [
		{ channel: "C2", thread: "1.0", name: "Scout", text: "for scout" },
		{ channel: CHANNEL, thread: "1.0", name: undefined, text: "for gaidin" },
	]);
	const threads = (await host.harness.snapshot(SlackState, context))!.threads;
	assert.equal(await agentIdOf(host.harness, threads["C2:1.0"]!, context), "scout");
	assert.equal(await agentIdOf(host.harness, threads["1.0"]!, context), "gaidin");

	await receive(message("2.0", "more", { channel: "C2", thread_ts: "1.0" }));
	await until(() => posts().length === 3);
	assert.deepEqual(posts()[2], { channel: "C2", thread: "1.0", name: "Scout", text: "for scout / more" });

	// A channel that's no agent's, or an archived agent's, isn't answered.
	await receive(message("3.0", "hello?", { channel: "C9" }));
	await host.agents.archive("scout", true);
	await receive(message("4.0", "still there?", { channel: "C2" }));
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(posts().length, 3);
});

test("an agent's reminders, reports and requests go to its channel under its name; one without a channel uses the default one, named", async (t) => {
	const { host, slack, calls } = await withAgents(t);
	const posts = () => calls.filter((c) => c.method === "chat.postMessage").map(shown);
	await slack.adapter.send({ kind: "reminder", reminder: { taskId: 1, text: "stretch", at: 0, agent: "scout" } });
	await slack.adapter.send({ kind: "report", report: { taskId: 2, title: "News", text: "Quiet day", conversationId: 9, agent: "verin" } });
	await slack.adapter.send({ kind: "budget", text: "Half the day's budget is spent" });
	assert.deepEqual(posts().map((p) => [p.channel, p.name]), [["C2", "Scout"], [CHANNEL, "Verin"], [CHANNEL, undefined]]);

	// A request from Scout's home is asked in its channel, and its outcome shown there.
	const scout = await host.agents.home("scout");
	const request = await host.approvals.open("r1", { conversationId: scout.id, taskId: 1 }, "fetch_url", { summary: "fetch https://example.com/" });
	await until(() => posts().length === 4);
	assert.deepEqual([posts()[3]!.channel, posts()[3]!.name], ["C2", "Scout"]);
	await until(async () => (await host.approvals.state()).requests.r1?.slackChannel === "C2");
	await host.approvals.decide(request.id, "deny", "web");
	await until(() => calls.some((c) => c.method === "chat.update"));
	assert.equal(calls.find((c) => c.method === "chat.update")!.body.channel, "C2");
});

test("a question asked in an agent's channel is answered by a reply in its thread there", async (t) => {
	const { host, calls, receive } = await withAgents(t, undefined, askingModels());
	const scout = await host.agents.home("scout");
	const answered = (await scout.submit({ type: "input", content: "ask Brad" }, context)).wait(context);
	await until(() => calls.some((c) => c.method === "chat.postMessage" && /Which one\?/.test(JSON.stringify(c.body))));
	const asked = calls.find((c) => c.method === "chat.postMessage")!;
	assert.deepEqual([asked.body.channel, asked.body.username], ["C2", "Scout"]);
	await until(async () => (await host.approvals.pending()).some((r) => r.slackTs === asked.ts && r.slackChannel === "C2"));
	// The same ts in the default channel is another message, and not its answer.
	await receive(message("5.0", "wrong place", { thread_ts: asked.ts! }));
	await new Promise((r) => setTimeout(r, 200));
	assert.equal((await host.approvals.pending()).length, 1);
	await receive(message("6.0", "the blue one", { channel: "C2", thread_ts: asked.ts! }));
	const settled = await answered;
	if (settled.status !== "done" || settled.type !== "input") throw new Error("the run didn't finish");
	assert.match(JSON.stringify(await scout.commit((tx) => tx.entry(settled.answer), context)), /the user answered: the blue one/);
});

test("without chat:write.customize an agent's posts go out under the app's name with the agent's in front", async (t) => {
	const { slack, calls } = await withAgents(t, ["chat:write", "channels:history"]);
	await slack.adapter.send({ kind: "reminder", reminder: { taskId: 1, text: "stretch", at: 0, agent: "scout" } });
	await slack.adapter.send({ kind: "report", report: { taskId: 2, title: "News", text: "Quiet day", conversationId: 9, agent: "scout" } });
	const [reminder, report] = calls.filter((c) => c.method === "chat.postMessage");
	assert.equal(reminder!.body.username, undefined);
	assert.equal(reminder!.body.text, "Scout: stretch");
	assert.match(JSON.stringify(reminder!.body.blocks[0]), /\*Scout\*/);
	assert.equal(report!.body.username, undefined);
	assert.match(report!.body.markdown_text, /^\*Scout:\* \*News\*/);
});

test("a post refused for want of the scope goes again under the app's name, and later ones don't try", async (t) => {
	const host = await openHost({ dataDir: tempDir(t), ...echoModels(), adapters: { push: { send: async () => true } } });
	t.after(() => host.harness.close(context));
	await host.agents.add({ id: "scout", name: "Scout", job: "" });
	await host.agents.update("scout", { channel: "C2" });
	const sent: Record<string, any>[] = [];
	// Slack doesn't say the scopes here, so the first post finds out.
	const { slack } = fakeSlack(host, {
		api: async (method, body) => {
			if (method === "auth.test") return {};
			sent.push(body);
			if (body.username !== undefined) throw new Error("chat.postMessage: missing_scope");
			return { ts: `bot.${sent.length}` };
		},
	});
	await slack.adapter.send({ kind: "reminder", reminder: { taskId: 1, text: "one", at: 0, agent: "scout" } });
	await slack.adapter.send({ kind: "reminder", reminder: { taskId: 2, text: "two", at: 0, agent: "scout" } });
	assert.deepEqual(sent.map((b) => [b.username, b.text]), [["Scout", "one"], [undefined, "Scout: one"], [undefined, "Scout: two"]]);
});

test("an agent's Slack channel is checked: an ID, not the default agent's, not another agent's", async (t) => {
	const host = await openHost({ config: configFor({ slack: SETTINGS }), dataDir: tempDir(t), ...echoModels(), adapters: { push: { send: async () => true } } });
	t.after(() => host.harness.close(context));
	await host.agents.add({ id: "scout", name: "Scout", job: "" });
	await host.agents.add({ id: "verin", name: "Verin", job: "" });
	await assert.rejects(host.agents.update("scout", { channel: "#scout" }), /looks like C0123ABCD/);
	await assert.rejects(host.agents.update("scout", { channel: CHANNEL }), /the default agent's Slack channel/);
	await assert.rejects(host.agents.update("gaidin", { channel: "C2" }), /slack\.channelId in the settings file/);
	await host.agents.update("scout", { channel: "C2" });
	await assert.rejects(host.agents.update("verin", { channel: "C2" }), /That's Scout's Slack channel\./);
	assert.equal((await host.agents.update("scout", { channel: "" })).channel, undefined);
});
