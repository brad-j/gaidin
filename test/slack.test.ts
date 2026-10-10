import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { context, openHost } from "../src/host.ts";
import { createSlackSurface, type SlackMessage, type SlackPost } from "../src/slack.ts";

const CHANNEL = "C1";
const BRAD = "U1";

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

function recorder() {
	const posts: { text: string; threadTs?: string; ts: string }[] = [];
	const post: SlackPost = async (_channel, text, threadTs) => {
		const ts = `bot.${posts.length + 1}`;
		posts.push({ text, ts, ...(threadTs === undefined ? {} : { threadTs }) });
		return [ts];
	};
	return { posts, post };
}

function message(ts: string, text: string, extra: Partial<SlackMessage> = {}): SlackMessage {
	return { type: "message", channel: CHANNEL, user: BRAD, ts, text, ...extra };
}

async function until(check: () => boolean, timeoutMs = 10_000) {
	const end = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > end) throw new Error("timed out");
		await new Promise((r) => setTimeout(r, 20));
	}
}

test("the channel is the root conversation and a thread forks it at the answer it hangs off", async (t) => {
	const host = await openHost({ dataDir: tempDir(t), ...echoModels() });
	t.after(() => host.harness.close(context));
	const { posts, post } = recorder();
	const slack = createSlackSurface({ harness: host.harness, root: host.root, post, channel: CHANNEL, user: BRAD });

	await slack.receive(message("1.0", "a"));
	await until(() => posts.length === 1);
	await slack.receive(message("2.0", "b"));
	await until(() => posts.length === 2);
	assert.deepEqual(posts.map((p) => [p.text, p.threadTs]), [["a", undefined], ["a / b", undefined]]);

	// A thread on gaidin's first answer sees the channel up to that answer, not "b".
	await slack.receive(message("3.0", "c", { thread_ts: "bot.1" }));
	await until(() => posts.length === 3);
	assert.deepEqual([posts[2]!.text, posts[2]!.threadTs], ["a / c", "bot.1"]);
	await slack.receive(message("4.0", "d", { thread_ts: "bot.1" }));
	await until(() => posts.length === 4);
	assert.deepEqual([posts[3]!.text, posts[3]!.threadTs], ["a / c / d", "bot.1"]);

	// A thread on Brad's own message forks at the same point, but it's a separate thread.
	await slack.receive(message("5.0", "e", { thread_ts: "1.0" }));
	await until(() => posts.length === 5);
	assert.deepEqual([posts[4]!.text, posts[4]!.threadTs], ["a / e", "1.0"]);

	// The channel didn't see any of the thread.
	await slack.receive(message("6.0", "f"));
	await until(() => posts.length === 6);
	assert.deepEqual([posts[5]!.text, posts[5]!.threadTs], ["a / b / f", undefined]);
});

test("a redelivered event is answered once", async (t) => {
	const host = await openHost({ dataDir: tempDir(t), ...echoModels() });
	t.after(() => host.harness.close(context));
	const { posts, post } = recorder();
	const slack = createSlackSurface({ harness: host.harness, root: host.root, post, channel: CHANNEL, user: BRAD });

	await Promise.all([slack.receive(message("1.0", "a")), slack.receive(message("1.0", "a"))]);
	await until(() => posts.length === 1);
	await slack.receive(message("1.0", "a"));
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(posts.length, 1);
});

test("other people, other channels, bots and edits are ignored", async (t) => {
	const host = await openHost({ dataDir: tempDir(t), ...echoModels() });
	t.after(() => host.harness.close(context));
	const { posts, post } = recorder();
	const slack = createSlackSurface({ harness: host.harness, root: host.root, post, channel: CHANNEL, user: BRAD });

	await slack.receive(message("1.0", "x", { user: "U2" }));
	await slack.receive(message("2.0", "x", { channel: "C2" }));
	await slack.receive(message("3.0", "x", { bot_id: "B1" }));
	await slack.receive(message("4.0", "x", { subtype: "message_changed" }));
	await slack.receive(message("5.0", "a"));
	await until(() => posts.length === 1);
	assert.equal(posts[0]!.text, "a");
});

test("a thread on a message gaidin never answered gets a note instead of a fork", async (t) => {
	const host = await openHost({ dataDir: tempDir(t), ...echoModels() });
	t.after(() => host.harness.close(context));
	const { posts, post } = recorder();
	const slack = createSlackSurface({ harness: host.harness, root: host.root, post, channel: CHANNEL, user: BRAD });

	await slack.receive(message("2.0", "hello", { thread_ts: "1.0" }));
	assert.equal(posts.length, 1);
	assert.equal(posts[0]!.threadTs, "1.0");
	assert.match(posts[0]!.text, /only pick up threads/);
});

test("an answer that wasn't posted before a restart is posted by the next process", async (t) => {
	const dir = tempDir(t);
	const first = await openHost({ dataDir: dir, ...echoModels() });
	let posting = false;
	// Slack never answers, as if the process died mid-post.
	const hang: SlackPost = () => {
		posting = true;
		return new Promise(() => {});
	};
	const before = createSlackSurface({ harness: first.harness, root: first.root, post: hang, channel: CHANNEL, user: BRAD });
	await before.receive(message("1.0", "a"));
	await until(() => posting);
	await first.harness.close(context);

	const second = await openHost({ dataDir: dir, ...echoModels() });
	t.after(() => second.harness.close(context));
	const { posts, post } = recorder();
	const after = createSlackSurface({ harness: second.harness, root: second.root, post, channel: CHANNEL, user: BRAD });
	await after.recover();
	assert.deepEqual(posts.map((p) => p.text), ["a"]);

	// The recovered answer is recorded, so a thread on it forks.
	await after.receive(message("2.0", "b", { thread_ts: "1.0" }));
	await until(() => posts.length === 2);
	assert.equal(posts[1]!.text, "a / b");
});

test("a thread on a job's report forks the run's conversation, not the root", async (t) => {
	const { recordPosted } = await import("../src/slack.ts");
	const host = await openHost({ dataDir: tempDir(t), ...echoModels() });
	t.after(() => host.harness.close(context));
	const { posts, post } = recorder();
	const slack = createSlackSurface({ harness: host.harness, root: host.root, post, channel: CHANNEL, user: BRAD });

	// A job run: its own conversation, with its own history.
	const run = await host.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "faux-1" } } }, context);
	const settled = await (await run.submit({ type: "input", content: "job prompt" }, context)).wait(context);
	assert.equal(settled.status, "done");
	if (settled.status !== "done" || settled.type !== "input") throw new Error("the run didn't finish");
	await recordPosted(host.root, ["job.1"], settled.answer, run.id as number);

	await slack.receive(message("2.0", "about that", { thread_ts: "job.1" }));
	await until(() => posts.length === 1);
	assert.deepEqual([posts[0]!.text, posts[0]!.threadTs], ["job prompt / about that", "job.1"]);
});
