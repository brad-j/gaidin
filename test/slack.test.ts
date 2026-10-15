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
import { BRAD, CHANNEL, fakeSlack, message, press } from "./fake-slack.ts";

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

async function until(check: () => boolean, timeoutMs = 10_000) {
	const end = Date.now() + timeoutMs;
	while (!check()) {
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
