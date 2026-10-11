import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { configFor } from "../src/config.ts";
import { context, openHost } from "../src/host.ts";
import { backoff, describeSchedule, type Job, JobReported, Jobs, nextRun, NOTHING, parseSchedule, recordReport, type Report, resumeJob } from "../src/jobs.ts";
import { setTimeZone } from "../src/time.ts";

type Steps = Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0];

function dir(t: TestContext) {
	const d = mkdtempSync(join(tmpdir(), "gaidin-test-"));
	t.after(() => rmSync(d, { recursive: true, force: true }));
	return d;
}

function faux(steps: Steps) {
	const provider = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	provider.setResponses(steps);
	const models = createModels();
	models.setProvider(provider.provider);
	return { models, model: { provider: "faux", modelId: "faux-1" } };
}

async function until<T>(get: () => Promise<T | undefined> | T | undefined, timeoutMs = 10_000): Promise<T> {
	const end = Date.now() + timeoutMs;
	for (;;) {
		const value = await get();
		if (value !== undefined) return value;
		if (Date.now() > end) throw new Error("timed out");
		await new Promise((r) => setTimeout(r, 20));
	}
}

/** Opens gaidin with every approval granted and reports collected. */
async function start(t: TestContext, steps: Steps, data = dir(t)) {
	const reports: Report[] = [];
	const host = await openHost({ config: configFor({ timeZone: "America/New_York" }), dataDir: data, ...faux(steps), notify: async () => {}, deliver: async (r) => void reports.push(r) });
	host.approvals.onChange((r) => void (r.status === "pending" && host.approvals.decide(r.id, "once", "test")));
	return { host, reports, data };
}

test("schedules are parsed and described", () => {
	const now = Date.parse("2026-10-10T12:00:00Z");
	assert.deepEqual(parseSchedule({ every: "6h" }, now), { kind: "every", minutes: 360, from: now + 360 * 60_000 });
	assert.deepEqual(parseSchedule({ time: "8:05", days: "weekdays" }, now), { kind: "daily", time: "08:05", days: [1, 2, 3, 4, 5] });
	assert.deepEqual(parseSchedule({ time: "21:00", days: "Mon, thursday" }, now), { kind: "daily", time: "21:00", days: [1, 4] });
	assert.throws(() => parseSchedule({ every: "5m" }, now), /at most every 15 minutes/);
	assert.throws(() => parseSchedule({ at: "2026-10-09T12:00:00Z" }, now), /in the past/);
	assert.throws(() => parseSchedule({ every: "1h", time: "08:00" }, now), /exactly one/);
	assert.throws(() => parseSchedule({ time: "25:00" }, now), /HH:MM/);
	assert.throws(() => parseSchedule({ time: "08:00", days: "someday" }, now), /Unknown day/);
	assert.equal(describeSchedule({ kind: "daily", time: "08:00", days: [1, 2, 3, 4, 5] }), "at 08:00, weekdays");
	assert.equal(describeSchedule({ kind: "every", minutes: 30, from: 0 }), "every 30 minutes");
});

test("the next run follows the time zone, weekdays and DST", () => {
	setTimeZone("America/New_York");
	t2();
	function t2() {
		const weekdays = { kind: "daily" as const, time: "08:00", days: [1, 2, 3, 4, 5] };
		// Saturday 2026-10-10, noon New York time: next is Monday 08:00 EDT.
		assert.equal(new Date(nextRun(weekdays, Date.parse("2026-10-10T16:00:00Z"))!).toISOString(), "2026-10-12T12:00:00.000Z");
		// Monday 07:59 EDT: the same morning.
		assert.equal(new Date(nextRun(weekdays, Date.parse("2026-10-12T11:59:00Z"))!).toISOString(), "2026-10-12T12:00:00.000Z");
		// Across the end of DST (2026-11-01): 08:00 EST is 13:00 UTC.
		assert.equal(new Date(nextRun({ kind: "daily", time: "08:00", days: [0, 1, 2, 3, 4, 5, 6] }, Date.parse("2026-11-01T00:00:00Z"))!).toISOString(), "2026-11-01T13:00:00.000Z");
		const every = { kind: "every" as const, minutes: 30, from: 1_000_000 };
		assert.equal(nextRun(every, 0), 1_000_000);
		assert.equal(nextRun(every, 1_000_000), 1_000_000 + 1_800_000);
		assert.equal(nextRun({ kind: "once", at: 5 }, 5), undefined);
	}
});

test("a job asks first, runs in its own conversation, reports, and is recorded", async (t) => {
	const at = new Date(Date.now() + 400).toISOString();
	const { host, reports } = await start(t, [
		fauxAssistantMessage(fauxToolCall("schedule_job", { title: "Oven", instruction: "Say the oven is off.", at }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxText("Scheduled.")),
		(ctx) => {
			// The run sees only its own prompt, not the conversation that made the job.
			const users = ctx.messages.filter((m) => m.role === "user").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
			return fauxAssistantMessage(fauxText(users.length === 1 && /Scheduled job "Oven"/.test(users[0]!) && !/check later/.test(users[0]!) ? "The oven is off." : `wrong context: ${users.join(" | ")}`));
		},
	]);
	t.after(() => host.harness.close(context));
	let asked = "";
	host.approvals.onChange((r) => void (r.status === "pending" && (asked = r.summary)));
	await (await host.root.submit({ type: "input", content: "check later" }, context)).wait(context);
	assert.match(asked, /^schedule "Oven", once, at .*: Say the oven is off\.$/);
	assert.equal((await host.harness.snapshot(Jobs, context))?.items.length, 1);

	const [report] = await until(() => (reports.length > 0 ? reports : undefined));
	assert.equal(report!.title, "Oven");
	assert.equal(report!.text, "The oven is off.");
	assert.notEqual(report!.conversationId, host.root.id);
	const entries = await until(async () => {
		const page = await host.root.commit((tx) => tx.scanEntries({ conversationId: host.root.id }, 100), context);
		const found = page.items.filter((e) => JobReported.is(e));
		return found.length > 0 ? found : undefined;
	});
	assert.equal(entries[0]!.data.delivered, true);
	// A one-off job is gone once it's run.
	await until(async () => ((await host.harness.snapshot(Jobs, context))?.items.length === 0 ? true : undefined));
	// The run couldn't schedule jobs of its own.
	const runTools = (await (await host.harness.conversation(report!.conversationId as never, context))!.agent(context)).tools.map((tool) => tool.name);
	assert.ok(!runTools.includes("schedule_job"));
	assert.ok(runTools.includes("fetch_url"));
});

test("a watch with nothing to report stays quiet", async (t) => {
	const at = new Date(Date.now() + 300).toISOString();
	const { host, reports } = await start(t, [
		fauxAssistantMessage(fauxToolCall("schedule_job", { title: "Backups", instruction: "Check the backups.", at, mode: "watch" }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxText("Watching.")),
		(ctx) => fauxAssistantMessage(fauxText(/This is a watch/.test(JSON.stringify(ctx.messages)) ? NOTHING : "not told it was a watch")),
	]);
	t.after(() => host.harness.close(context));
	await (await host.root.submit({ type: "input", content: "watch the backups" }, context)).wait(context);
	await until(async () => ((await host.harness.snapshot(Jobs, context))?.items.length === 0 ? true : undefined));
	assert.deepEqual(reports, []);
});

test("a cancelled job doesn't run", async (t) => {
	const soon = () => new Date(Date.now() + 500).toISOString();
	const reports: string[] = [];
	let failures = 0;
	const host = await openHost({
		config: configFor({}),
		dataDir: dir(t),
		...faux([
			fauxAssistantMessage(fauxToolCall("schedule_job", { title: "Never", instruction: "x", at: soon() }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxText("ok")),
			fauxAssistantMessage(fauxToolCall("list_jobs", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxText("ok")),
		]),
		notify: async () => {},
		deliver: async (r) => {
			if (failures++ < 1) throw new Error("slack down");
			reports.push(r.title);
		},
	});
	t.after(() => host.harness.close(context));
	host.approvals.onChange((r) => void (r.status === "pending" && host.approvals.decide(r.id, "once", "test")));
	await (await host.root.submit({ type: "input", content: "one" }, context)).wait(context);
	const [job] = (await host.harness.snapshot(Jobs, context))!.items;
	await host.root.commit(async (tx) => {
		const doc = await tx.doc(Jobs);
		doc.items = doc.items.filter((j) => j.taskId !== job!.taskId);
	}, context);
	const { outcome } = (await host.harness.waitForTask(job!.taskId as never, context)).state as { outcome: unknown };
	assert.deepEqual(outcome, { status: "completed", result: "cancelled" });
	assert.deepEqual(reports, []);
});

test("a job due while the server was down runs when it starts", async (t) => {
	const data = dir(t);
	const at = new Date(Date.now() + 1200).toISOString();
	const first = await start(t, [
		fauxAssistantMessage(fauxToolCall("schedule_job", { title: "Later", instruction: "Report in.", at }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxText("Scheduled.")),
	], data);
	await (await first.host.root.submit({ type: "input", content: "go" }, context)).wait(context);
	await first.host.harness.close(context);
	await new Promise((r) => setTimeout(r, 1500));

	const second = await start(t, [fauxAssistantMessage(fauxText("Reporting in."))], data);
	t.after(() => second.host.harness.close(context));
	const [report] = await until(() => (second.reports.length > 0 ? second.reports : undefined));
	assert.equal(report!.text, "Reporting in.");
});

test("a failed delivery is retried", async (t) => {
	const at = new Date(Date.now() + 300).toISOString();
	let calls = 0;
	const host = await openHost({
		config: configFor({}),
		dataDir: dir(t),
		...faux([
			fauxAssistantMessage(fauxToolCall("schedule_job", { title: "Retry", instruction: "x", at }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxText("ok")),
			fauxAssistantMessage(fauxText("Report.")),
		]),
		notify: async () => {},
		deliver: async () => {
			calls += 1;
			if (calls === 1) throw new Error("slack down");
		},
	});
	t.after(() => host.harness.close(context));
	host.approvals.onChange((r) => void (r.status === "pending" && host.approvals.decide(r.id, "once", "test")));
	await (await host.root.submit({ type: "input", content: "go" }, context)).wait(context);
	const entry = await until(async () => {
		const page = await host.root.commit((tx) => tx.scanEntries({ conversationId: host.root.id }, 100), context);
		return page.items.find((e) => JobReported.is(e));
	});
	assert.equal(calls, 2);
	assert.equal((entry as { data: { delivered: boolean } }).data.delivered, true);
});

test("a repeating job runs again until it's cancelled", async (t) => {
	const { host, reports } = await start(t, Array.from({ length: 10 }, (_, i) => fauxAssistantMessage(fauxText(`Run ${i + 1}.`))));
	t.after(() => host.harness.close(context));
	const step = 0.01; // minutes; the tool's 15-minute floor doesn't apply here
	const firstAt = Date.now() + 200;
	const taskId = await host.root.commit(async (tx) => {
		const id = await tx.createTask(host.jobs.JobTask, { title: "Tick", firstAt }, { ownership: { kind: "conversation" }, background: true });
		(await tx.doc(Jobs)).items.push({ taskId: id as number, title: "Tick", instruction: "Count.", schedule: { kind: "every", minutes: step, from: firstAt }, mode: "report", createdAt: Date.now(), nextAt: firstAt, runs: 0 });
		return id;
	}, context);
	await until(() => (reports.length >= 2 ? true : undefined));
	assert.deepEqual(reports.slice(0, 2).map((r) => r.text), ["Run 1.", "Run 2."]);
	assert.notEqual(reports[0]!.conversationId, reports[1]!.conversationId, "each run has its own conversation");
	await host.root.commit(async (tx) => {
		const doc = await tx.doc(Jobs);
		doc.items = doc.items.filter((j) => j.taskId !== (taskId as number));
	}, context);
	const { outcome } = (await host.harness.waitForTask(taskId as never, context)).state as { outcome: unknown };
	assert.deepEqual(outcome, { status: "completed", result: "cancelled" });
});

test("a job keeps its last 3 reports, each cut short", () => {
	const job = { quietRuns: 2 } as Job;
	for (const text of ["one", "two", "three", "x".repeat(1000)]) recordReport(job, 1, text);
	assert.deepEqual(job.recent!.slice(0, 2).map((r) => r.text), ["two", "three"]);
	assert.equal(job.recent![2]!.text, `${"x".repeat(800)}…`);
	assert.equal(job.quietRuns, 0);
});

test("a watch's runs see its earlier reports and the quiet runs since", async (t) => {
	const seen: string[] = [];
	const reply = (text: string): Steps[number] => (ctx) => {
		seen.push(JSON.stringify(ctx.messages.filter((m) => m.role === "user")));
		return fauxAssistantMessage(fauxText(text));
	};
	const { host, reports } = await start(t, ["Disk at 87%.", NOTHING, "Disk at 96%.", ...Array<string>(10).fill(NOTHING)].map(reply));
	t.after(() => host.harness.close(context));
	const step = 0.01; // minutes; the tool's 15-minute floor doesn't apply here
	const firstAt = Date.now() + 200;
	const taskId = await host.root.commit(async (tx) => {
		const id = await tx.createTask(host.jobs.JobTask, { title: "Disks", firstAt }, { ownership: { kind: "conversation" }, background: true });
		(await tx.doc(Jobs)).items.push({ taskId: id as number, title: "Disks", instruction: "Check the disks.", schedule: { kind: "every", minutes: step, from: firstAt }, mode: "watch", createdAt: Date.now(), nextAt: firstAt, runs: 0 });
		return id;
	}, context);
	await until(() => (reports.length >= 2 ? true : undefined));
	const job = (await host.harness.snapshot(Jobs, context))!.items.find((j) => j.taskId === (taskId as number))!;
	await host.root.commit(async (tx) => {
		const doc = await tx.doc(Jobs);
		doc.items = doc.items.filter((j) => j.taskId !== (taskId as number));
	}, context);

	assert.doesNotMatch(seen[0]!, /earlier answers/);
	assert.match(seen[1]!, /Your last report for this job.*Disk at 87%\..*Don't report again/);
	assert.doesNotMatch(seen[1]!, /nothing to report\./);
	assert.match(seen[2]!, /Disk at 87%\..*Since the last one, 1 run had nothing to report\./);
	assert.deepEqual(job.recent!.map((r) => r.text), ["Disk at 87%.", "Disk at 96%."]);
});

/** Adds a job that runs every `step` minutes from 200 ms on, past the tool's 15-minute floor. */
async function addTestJob(host: Awaited<ReturnType<typeof start>>["host"], title: string, fields: Partial<Job> = {}, step = 0.01): Promise<number> {
	const firstAt = Date.now() + 200;
	return host.root.commit(async (tx) => {
		const id = await tx.createTask(host.jobs.JobTask, { title, firstAt }, { ownership: { kind: "conversation" }, background: true });
		(await tx.doc(Jobs)).items.push({ taskId: id as number, title, instruction: `Do ${title}.`, schedule: { kind: "every", minutes: step, from: firstAt }, mode: "report", createdAt: Date.now(), nextAt: firstAt, runs: 0, ...fields });
		return id as number;
	}, context);
}

async function jobNamed(host: Awaited<ReturnType<typeof start>>["host"], title: string): Promise<Job | undefined> {
	return (await host.harness.snapshot(Jobs, context))?.items.find((j) => j.title === title);
}

test("failures wait longer each time, tell the owner once, and pause the job after five in a row", async (t) => {
	assert.deepEqual([1, 2, 3, 4, 5, 6].map((n) => backoff(n) / 60_000), [15, 30, 60, 120, 240, 240]);
	// Every run fails but the one for "Healthy".
	const answer: Steps[number] = (ctx) =>
		/Healthy/.test(JSON.stringify(ctx.messages)) ? fauxAssistantMessage(fauxText("All good.")) : fauxAssistantMessage("", { stopReason: "error", errorMessage: "model down" });
	const { host, reports } = await start(t, Array<Steps[number]>(20).fill(answer));
	t.after(() => host.harness.close(context));
	const started = Date.now();
	await addTestJob(host, "First");
	await addTestJob(host, "Second", { failures: 1 });
	await addTestJob(host, "Fifth", { failures: 4 });
	await addTestJob(host, "Healthy", { failures: 3 });
	const [first, second, fifth, healthy] = await until(async () => {
		const jobs = await Promise.all(["First", "Second", "Fifth", "Healthy"].map((title) => jobNamed(host, title)));
		return jobs.every((j) => j?.lastAt !== undefined) ? (jobs as Job[]) : undefined;
	});

	assert.equal(first!.failures, 1);
	assert.ok(first!.nextAt! >= started + backoff(1), "the next run waits 15 minutes");
	assert.equal(second!.failures, 2);
	assert.ok(second!.nextAt! >= started + backoff(2));
	assert.equal(fifth!.failures, 5);
	assert.equal(fifth!.paused?.reason, "5 failed runs in a row");
	assert.ok(fifth!.nextAt! < started + 60_000, "a paused job doesn't wait out a backoff");
	assert.equal(healthy!.failures, 0);
	assert.equal(healthy!.lastResult, "reported");

	const told = reports.filter((r) => r.title !== "Healthy").map((r) => [r.title, r.paused ?? false]);
	assert.deepEqual(told.sort(), [["Fifth", true], ["First", false]]);
	assert.match(reports.find((r) => r.title === "Fifth")!.text, /^Paused after 5 failed runs in a row; .*The last one: The run didn't finish/);
});

test("a paused job skips its runs until it's resumed", async (t) => {
	const { host, reports } = await start(t, Array.from({ length: 10 }, () => fauxAssistantMessage(fauxText("Ran."))));
	t.after(() => host.harness.close(context));
	const id = await addTestJob(host, "Held", { paused: { at: Date.now(), reason: "paused by the owner" }, failures: 5 });
	// A one-off job paused past its time is skipped and gone.
	await addTestJob(host, "Once", { paused: { at: Date.now(), reason: "paused by the owner" }, schedule: { kind: "once", at: Date.now() + 200 } });
	const firstAt = (await jobNamed(host, "Held"))!.nextAt!;
	await until(async () => ((await jobNamed(host, "Held"))!.nextAt! > firstAt + 1000 && (await jobNamed(host, "Once")) === undefined ? true : undefined));
	assert.equal(reports.length, 0);
	assert.equal((await jobNamed(host, "Held"))!.runs, 0);

	const resumed = await host.root.commit((tx) => resumeJob(tx, id), context);
	assert.equal(resumed?.failures, 0);
	assert.equal(await host.root.commit((tx) => resumeJob(tx, id), context), undefined, "it isn't paused any more");
	await until(() => (reports.length > 0 ? true : undefined));
	assert.equal(reports[0]!.text, "Ran.");
});
