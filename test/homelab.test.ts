import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { configFor, type HomelabConfig } from "../src/config.ts";
import { collectAttention, fetchFeeds, type FetchJson, homelabGate, report } from "../src/extensions/homelab/status.ts";
import { context, openHost } from "../src/host.ts";
import { Jobs, type Report } from "../src/jobs.ts";

const HOMELAB: HomelabConfig = { feeds: "http://feeds.test/data", kuma: { url: "https://kuma.test", page: "homelab" }, dashboard: "https://dash.test", logHosts: {} };

const NOW = Date.parse("2026-10-10T20:00:00Z");
const HOUR = 3_600_000;

/** A healthy homelab as of `now`; `change` edits the parsed feeds before they're served. */
function fixtures(change: (f: any, iso: (msAgo: number) => string) => void = () => {}, now = NOW) {
	const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
	const f: any = {
		page: { publicGroupList: [{ monitorList: [{ id: 1, name: "Infra" }, { id: 2, name: "Hermes" }] }] },
		heartbeat: {
			heartbeatList: { 1: [{ status: 1, time: "2026-10-10 19:59:00", msg: "" }], 2: [{ status: 1, time: "2026-10-10 19:59:00", msg: "" }] },
			uptimeList: { "1_24": 1, "2_24": 0.9993 },
		},
		beszel: {
			schemaVersion: 1,
			generatedAt: iso(60_000),
			systems: [
				{ name: "infra-01", status: "up", updatedAt: iso(60_000), cpu: 3, memory: 40, disk: 30, temperature: null },
				{ name: "think-01", status: "up", updatedAt: iso(60_000), cpu: 8, memory: 55, disk: 40, temperature: 45 },
			],
		},
		docker: {
			schemaVersion: 1,
			generatedAt: iso(30_000),
			hosts: [{ name: "apps-01", status: "up", error: null, containers: [
				{ name: "linkding", state: "running", health: "healthy", status: "running", image: "linkding" },
				{ name: "dozzle", state: "running", health: "none", status: "running", image: "dozzle" },
			] }],
		},
		backups: {
			schemaVersion: 1,
			generatedAt: iso(10 * 60_000),
			node: "think-1",
			jobs: [{
				id: "nightly-think-1",
				enabled: true,
				storage: "synology-backups",
				guests: [{ vmid: 104, name: "gaidin", latestAt: iso(14 * HOUR) }],
				storageStatus: { active: true, totalBytes: 100, usedBytes: 50 },
			}],
			runs: [{ endedAt: iso(14 * HOUR), status: "OK" }],
		},
	};
	change(f, iso);
	const get: FetchJson = async (url) => {
		const key = url.endsWith("/heartbeat/homelab") ? "heartbeat"
			: url.endsWith("/status-page/homelab") ? "page"
			: url.slice(url.lastIndexOf("/") + 1, -".json".length);
		const value = f[key];
		if (value instanceof Error) throw value;
		if (value === undefined) throw new Error(`no fixture for ${url}`);
		return structuredClone(value);
	};
	return get;
}

test("a healthy homelab needs nothing", async () => {
	const feeds = await fetchFeeds(HOMELAB, fixtures());
	assert.deepEqual(collectAttention(feeds, NOW), []);
	const text = report(feeds, false, NOW);
	assert.match(text, /^Nothing needs attention\./);
	assert.match(text, /Kuma: 2 of 2 monitors up\./);
	assert.match(text, /Docker: 2 of 2 containers running on 1 hosts\./);
	assert.doesNotMatch(text, /Hosts \(CPU/);
	assert.match(report(feeds, true, NOW), /- think-01: up, 8%, 55%, 40%, 45°C/);
});

test("problems are listed most severe first, with the dashboard's thresholds", async () => {
	const feeds = await fetchFeeds(HOMELAB, fixtures((f, iso) => {
		f.heartbeat.heartbeatList[2].push({ status: 0, time: "2026-10-10 19:59:30", msg: "timeout of 48000ms exceeded" });
		f.docker.hosts[0].containers[0].health = "unhealthy";
		f.docker.hosts[0].containers[1].state = "exited";
		f.beszel.systems[0].disk = 96;
		f.beszel.systems[1].memory = 92;
		f.backups.jobs[0].guests[0].latestAt = iso(30 * HOUR);
		f.backups.jobs[0].storageStatus.usedBytes = 90;
	}));
	const items = collectAttention(feeds, NOW);
	assert.deepEqual(items.map((i) => [i.severity, i.title]), [
		["critical", "Hermes is down"],
		["critical", "linkding on apps-01 is unhealthy"],
		["critical", "infra-01 disk 96% full"],
		["warning", "dozzle on apps-01 is exited"],
		["warning", "think-01 memory at 92%"],
		["warning", "Backup storage synology-backups 90% full"],
		["warning", "gaidin last backed up 30 hours ago"],
	]);
	assert.match(report(feeds, false, NOW), /^CRITICAL: Hermes is down\. timeout of 48000ms exceeded/);
});

test("a feed that's down is reported and the others still are", async () => {
	const feeds = await fetchFeeds(HOMELAB, fixtures((f) => {
		f.docker = new Error("connect ECONNREFUSED 192.168.3.177:8080");
		f.backups.runs[0].status = "job errors";
	}));
	const titles = collectAttention(feeds, NOW).map((i) => i.title);
	assert.deepEqual(titles, ["Last backup run on think-1 failed", "Docker snapshot unavailable"]);
	assert.match(report(feeds, false, NOW), /Kuma: 2 of 2 monitors up\./);
});

test("a stale snapshot is a warning", async () => {
	const feeds = await fetchFeeds(HOMELAB, fixtures((f, iso) => {
		f.beszel.generatedAt = iso(10 * 60_000);
	}));
	assert.deepEqual(collectAttention(feeds, NOW).map((i) => i.title), ["Beszel snapshot is stale"]);
});

test("the agent can call homelab_status", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "gaidin-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("homelab_status", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxText("All good.")),
	]);
	const models = createModels();
	models.setProvider(faux.provider);
	const host = await openHost({ config: configFor({ homelab: HOMELAB }), dataDir: dir, models, model: { provider: "faux", modelId: "faux-1" }, homelab: { fetch: fixtures(undefined, Date.now()) }, notify: async () => {} });
	t.after(() => host.harness.close(context));
	const settled = await (await host.root.submit({ type: "input", content: "is the homelab ok?" }, context)).wait(context);
	assert.equal(settled.status, "done");
	const result = (await host.root.context(context)).messages.find((m) => m.role === "toolResult");
	assert.match(JSON.stringify(result), /Nothing needs attention\./);
	assert.match(JSON.stringify(result), /dash\.test/);
});

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 10_000) {
	const end = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() > end) throw new Error("timed out");
		await new Promise((r) => setTimeout(r, 20));
	}
}

test("the homelab gate wakes on a new or worse problem, not on numbers that drift", async () => {
	let feeds: any;
	const gate = homelabGate(HOMELAB, fixtures((f) => void (feeds = f), Date.now()));
	const signal = new AbortController().signal;
	assert.deepEqual(await gate.check({}, signal), { wake: false });
	feeds.beszel.systems[1].disk = 87;
	const warning = await gate.check({}, signal);
	assert.equal(warning.wake, true);
	assert.match(warning.data!, /^WARNING: think-01 disk 87% full\./);
	feeds.beszel.systems[1].disk = 88;
	assert.equal((await gate.check({}, signal)).topic, warning.topic, "the same problem");
	assert.deepEqual(await gate.check({ severity: "critical" }, signal), { wake: false });
	feeds.beszel.systems[1].disk = 96;
	const critical = await gate.check({ severity: "critical" }, signal);
	assert.equal(critical.wake, true);
	assert.notEqual(critical.topic, warning.topic, "worse is new");
});

test("a gated job wakes the model only for something new, and what the gate found counts as outside text", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "gaidin-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	let feeds: any;
	const get = fixtures((f) => {
		feeds = f;
		f.beszel.systems[1].disk = 87;
	}, Date.now());
	const prompts: string[] = [];
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	faux.setResponses([
		(ctx) => {
			prompts.push(JSON.stringify(ctx.messages.find((m) => m.role === "user")));
			return fauxAssistantMessage(fauxToolCall("remember", { text: "think-01 fills up" }), { stopReason: "toolUse" });
		},
		fauxAssistantMessage(fauxText("think-01's disk is at 87%.")),
		(ctx) => {
			prompts.push(JSON.stringify(ctx.messages.find((m) => m.role === "user")));
			return fauxAssistantMessage(fauxText("think-01's disk is critical."));
		},
	]);
	const models = createModels();
	models.setProvider(faux.provider);
	const reports: Report[] = [];
	const host = await openHost({
		config: configFor({ homelab: HOMELAB }),
		dataDir: dir,
		models,
		model: { provider: "faux", modelId: "faux-1" },
		homelab: { fetch: get },
		notify: async () => {},
		deliver: async (r) => void reports.push(r),
	});
	t.after(() => host.harness.close(context));
	const asked: string[] = [];
	host.approvals.onChange((r) => {
		if (r.status !== "pending") return;
		asked.push(r.summary);
		void host.approvals.decide(r.id, "once", "test");
	});
	const firstAt = Date.now() + 200;
	const taskId = await host.root.commit(async (tx) => {
		const id = await tx.createTask(host.jobs.JobTask, { title: "Disks", firstAt }, { ownership: { kind: "conversation" }, background: true });
		const fields = { instruction: "Check the disks.", schedule: { kind: "every" as const, minutes: 0.01, from: firstAt }, mode: "watch" as const, gate: { name: "homelab" } };
		(await tx.doc(Jobs)).items.push({ taskId: id as number, title: "Disks", ...fields, createdAt: Date.now(), nextAt: firstAt, runs: 0 });
		return id as number;
	}, context);
	const job = async () => (await host.harness.snapshot(Jobs, context))!.items.find((j) => j.taskId === taskId)!;

	await until(() => reports.length === 1);
	assert.match(prompts[0]!, /\[gate findings\] The gate homelab woke this run.*WARNING: think-01 disk 87% full/);
	assert.match(asked[0]!, /^remember "think-01 fills up", after reading outside text \(the job's gate\)$/);
	// The disk drifts to 88%: the same problem, so no run.
	feeds.beszel.systems[1].disk = 88;
	const skipped = (await job()).skipped ?? 0;
	await until(async () => ((await job()).skipped ?? 0) >= skipped + 2);
	assert.equal(reports.length, 1);
	// It gets worse.
	feeds.beszel.systems[1].disk = 96;
	await until(() => reports.length === 2);
	assert.match(prompts[1]!, /CRITICAL: think-01 disk 96% full/);
	assert.deepEqual(reports.map((r) => r.text), ["think-01's disk is at 87%.", "think-01's disk is critical."]);
	// Fixed: the gate finds nothing, and forgets what it found.
	feeds.beszel.systems[1].disk = 40;
	await until(async () => (await job()).gateTopic === undefined);
	assert.equal((await job()).failures, 0);
	await host.root.commit(async (tx) => {
		const doc = await tx.doc(Jobs);
		doc.items = doc.items.filter((j) => j.taskId !== taskId);
	}, context);
});
