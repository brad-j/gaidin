import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { Conversation } from "@earendil-works/pi-durable";
import { context, startHost } from "../src/host.ts";
import { defaultEntry } from "../src/agents.ts";
import type { Situation } from "../src/guards.ts";
import { createReminders, ReminderFired, type Reminder, Reminders } from "../src/reminders.ts";
import type { Adapters } from "../src/notifications.ts";

function tempDir(t: TestContext): string {
	const dir = mkdtempSync(join(tmpdir(), "gaidin-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function fauxModels(steps: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0] = []) {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	faux.setResponses(steps);
	const models = createModels();
	models.setProvider(faux.provider);
	return { models, model: { provider: "faux", modelId: "faux-1" } };
}

/** A way to reach the owner that keeps the reminders it's sent, failing the first `failFirst`. */
function recorder(failFirst = 0) {
	const sent: Reminder[] = [];
	let failures = 0;
	const adapters: Adapters = {
		push: {
			send: async (notice) => {
				if (notice.kind !== "reminder") return true;
				if (failures < failFirst) {
					failures += 1;
					throw new Error("ntfy down");
				}
				sent.push(notice.reminder);
				return true;
			},
		},
	};
	return { sent, adapters };
}

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 10_000) {
	const end = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() > end) throw new Error("timed out");
		await new Promise((r) => setTimeout(r, 50));
	}
}

async function firedEntries(root: Conversation) {
	const page = await root.commit((tx) => tx.scanEntries({ conversationId: root.id }, 100), context);
	return page.items.filter((entry) => ReminderFired.is(entry));
}

test("the remind tool schedules a push that fires and leaves a transcript record", async (t) => {
	const dir = tempDir(t);
	const { sent, adapters } = recorder();
	const host = await startHost({
		dataDir: dir,
		adapters,
		...fauxModels([
			fauxAssistantMessage(fauxToolCall("remind", { text: "stretch", inMinutes: 0.01 }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxText("Set.")),
		]),
	});
	t.after(() => host.harness.close(context));

	const settled = await (await host.root.submit({ type: "input", content: "remind me to stretch" }, context)).wait(context);
	assert.equal(settled.status, "done");
	assert.equal((await host.harness.snapshot(Reminders, context))?.items.length, 1);

	await until(() => sent.length === 1);
	assert.equal(sent[0]!.text, "stretch");
	await until(async () => (await firedEntries(host.root)).length === 1);
	assert.deepEqual((await host.harness.snapshot(Reminders, context))?.items, []);
});

test("a reminder sleeping across a restart fires in the next process", async (t) => {
	const dir = tempDir(t);
	const first = await startHost({ dataDir: dir, adapters: recorder().adapters, ...fauxModels() });
	const at = Date.now() + 1500;
	await first.root.commit(async (tx) => {
		const id = await tx.createTask(first.reminders.ReminderTask, { text: "after restart", at }, {
			ownership: { kind: "conversation" },
			background: true,
		});
		(await tx.doc(Reminders)).items.push({ taskId: id, text: "after restart", at });
	}, context);
	await first.harness.close(context);

	const { sent, adapters } = recorder();
	const second = await startHost({ dataDir: dir, adapters, ...fauxModels() });
	t.after(() => second.harness.close(context));
	await until(() => sent.length === 1);
	assert.equal(sent[0]!.text, "after restart");
	assert.ok(Date.now() >= at);
});

test("a cancelled reminder finishes without pushing", async (t) => {
	const dir = tempDir(t);
	const { sent, adapters } = recorder();
	const host = await startHost({ dataDir: dir, adapters, ...fauxModels() });
	t.after(() => host.harness.close(context));
	const at = Date.now() + 800;
	const id = await host.root.commit(async (tx) => {
		const created = await tx.createTask(host.reminders.ReminderTask, { text: "never", at }, {
			ownership: { kind: "conversation" },
			background: true,
		});
		(await tx.doc(Reminders)).items.push({ taskId: created, text: "never", at });
		return created;
	}, context);
	await host.root.commit(async (tx) => {
		const doc = await tx.doc(Reminders);
		doc.items = doc.items.filter((r) => r.taskId !== id);
	}, context);

	const { outcome } = (await host.harness.waitForTask(id, context)).state;
	assert.deepEqual(outcome, { status: "completed", result: "cancelled" });
	assert.equal(sent.length, 0);
});

test("a failed push is retried", async (t) => {
	const dir = tempDir(t);
	const { sent, adapters } = recorder(1);
	const host = await startHost({ dataDir: dir, adapters, ...fauxModels() });
	t.after(() => host.harness.close(context));
	const at = Date.now();
	const id = await host.root.commit(async (tx) => {
		const created = await tx.createTask(host.reminders.ReminderTask, { text: "retry me", at }, {
			ownership: { kind: "conversation" },
			background: true,
		});
		(await tx.doc(Reminders)).items.push({ taskId: created, text: "retry me", at });
		return created;
	}, context);
	const { outcome } = (await host.harness.waitForTask(id, context)).state;
	assert.deepEqual(outcome, { status: "completed", result: "sent" });
	assert.equal(sent.length, 1);
});

test("cancelling a reminder asks while outside text is in the conversation, and says which", async () => {
	const guard = createReminders(async () => {}, "Brad").guards.find((g) => g.tool === "cancel_reminder")!;
	const reminders = { items: [{ taskId: 9, text: "stretch", at: 0 }] };
	const ask = (id: number, read: string[]) => {
		const situation: Situation = { fetchHosts: [], grants: [], conversationId: 1, callId: "c1", agent: defaultEntry(), outside: async () => read, searched: async () => [], snapshot: async (doc: object) => (doc === Reminders ? reminders : undefined) as never };
		return guard.ask({ id }, situation);
	};
	assert.equal(await ask(9, []), undefined);
	assert.equal((await ask(9, ["fetch_url"]))!.summary, 'cancel reminder 9 "stretch", after reading outside text (fetch_url)');
});
