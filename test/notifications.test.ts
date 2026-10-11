import assert from "node:assert/strict";
import test from "node:test";
import { type Adapter, type Adapters, createNotifications, type Notice } from "../src/notifications.ts";

/** An adapter that records what it's sent, in `log` as "<name> <kind>", and answers with `reached` or throws. */
function fake(name: string, log: string[], reached: boolean | Error = true): Adapter {
	return {
		send: async (notice) => {
			log.push(`${name} ${notice.kind}`);
			if (reached instanceof Error) throw reached;
			return reached;
		},
	};
}

const reminder: Notice = { kind: "reminder", reminder: { taskId: 1, text: "stretch", at: 0 } };
const report = { taskId: 2, title: "Backups", text: "All fine.", conversationId: 3 };
const request: Notice = {
	kind: "request",
	request: { id: "r1", conversationId: 1, taskId: 4, tool: "fetch_url", summary: "fetch https://a.example/", createdAt: 0, expiresAt: 1, status: "pending" },
};
const notices: Notice[] = [reminder, { kind: "report", report }, { kind: "paused", report }, { kind: "budget", text: "80% of today's limit" }, request];

/** What each way got for each notice, with or without Slack. */
async function routed(withSlack: boolean) {
	const log: string[] = [];
	const adapters: Adapters = { push: fake("push", log), ntfy: fake("ntfy", log) };
	if (withSlack) adapters.slack = fake("slack", log);
	const notifications = createNotifications(adapters);
	for (const notice of notices) await notifications.send(notice);
	return log;
}

test("with Slack, reports, paused jobs and budget warnings go to Slack alone; reminders go to the phone and then Slack", async () => {
	assert.deepEqual(await routed(true), [
		"ntfy reminder", "push reminder", "slack reminder",
		"slack report",
		"slack paused",
		"slack budget",
		"push request", "slack request",
	]);
});

test("without Slack, everything goes to the phone by Web Push and ntfy", async () => {
	assert.deepEqual(await routed(false), [
		"ntfy reminder", "push reminder",
		"ntfy report", "push report",
		"ntfy paused", "push paused",
		"ntfy budget", "push budget",
		"push request",
	]);
});

test("one way reaching the owner is enough; when every way fails it throws, and Slack waits for the retry", async () => {
	const log: string[] = [];
	await createNotifications({ push: fake("push", log, new Error("push down")), ntfy: fake("ntfy", log), slack: fake("slack", log) }).send(reminder);
	assert.deepEqual(log, ["ntfy reminder", "push reminder", "slack reminder"]);

	log.length = 0;
	const down = createNotifications({ push: fake("push", log, new Error("push down")), ntfy: fake("ntfy", log, new Error("ntfy down")), slack: fake("slack", log) });
	await assert.rejects(down.send(reminder), /ntfy down/);
	assert.deepEqual(log, ["ntfy reminder", "push reminder"]);

	log.length = 0;
	await assert.rejects(createNotifications({ slack: fake("slack", log, new Error("slack down")) }).send({ kind: "report", report }), /slack down/);
});

test("reaching no one without an error, as with no device signed up or nothing set up, isn't retried", async () => {
	const log: string[] = [];
	await createNotifications({ push: fake("push", log, false), slack: fake("slack", log) }).send(reminder);
	assert.deepEqual(log, ["push reminder", "slack reminder"]);
	await createNotifications({}).send(reminder);
	await createNotifications({}).send({ kind: "budget", text: "over" });
});

test("a request never throws: it waits in the web view whatever happens to its notifications", async () => {
	const log: string[] = [];
	await createNotifications({ push: fake("push", log, new Error("push down")), slack: fake("slack", log, new Error("slack down")) }).send(request);
	assert.deepEqual(log, ["push request", "slack request"]);
});
