import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { Budget } from "../src/budget.ts";
import { configFor, loadConfig } from "../src/config.ts";
import { context, startHost } from "../src/host.ts";
import { createWebServer } from "../src/web.ts";
import type { Notice } from "../src/notifications.ts";

/** gaidin whose spend total is `spent.value`, with what it tells the owner collected. */
async function start(t: TestContext, budget = { daily: 5, monthly: 0 }) {
	const dir = mkdtempSync(join(tmpdir(), "gaidin-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	faux.setResponses(Array.from({ length: 20 }, () => fauxAssistantMessage(fauxText("ok"))));
	const models = createModels();
	models.setProvider(faux.provider);
	const spent = { value: 0 };
	const told: string[] = [];
	const push = { send: async (notice: Notice) => (notice.kind === "budget" && told.push(notice.text), true) };
	const host = await startHost({ config: configFor({ budget }), dataDir: dir, models, model: { provider: "faux", modelId: "faux-1" }, adapters: { push }, spend: async () => spent.value });
	t.after(() => host.harness.close(context));
	const ask = async () => (await host.root.submit({ type: "input", content: "hi" }, context)).wait(context);
	return { host, spent, told, ask };
}

const wait = () => new Promise((r) => setTimeout(r, 50));

test("requests stop at the daily limit, say why, and tell the owner once", async (t) => {
	const { host, spent, told, ask } = await start(t);
	assert.equal((await ask()).status, "done");

	spent.value = 4.1;
	await host.budget.refresh();
	await wait();
	assert.equal(told.length, 1);
	assert.match(told[0]!, /spent \$4\.10 today, 80% of the daily limit of \$5\.00/);
	assert.equal((await ask()).status, "done", "80% still answers");

	spent.value = 5.2;
	await host.budget.refresh();
	await wait();
	const refused = await ask();
	assert.equal(refused.status, "unanswered");
	assert.equal(refused.reason, "no_model");
	assert.match(host.explain(refused.reason)!, /Today's spend is \$5\.20, at the daily limit of \$5\.00/);
	assert.equal(told.length, 2);
	assert.match(told[1]!, /stopped making model requests.*starts again tomorrow/);
	await ask();
	await host.budget.refresh();
	await wait();
	assert.equal(told.length, 2, "told twice about the same stop");
});

test("allowing more lets requests through until the new limit", async (t) => {
	const { host, spent, told, ask } = await start(t);
	spent.value = 6;
	await host.budget.refresh();
	assert.equal((await ask()).status, "unanswered");
	const status = await host.budget.allowMore(5);
	assert.deepEqual([status.stopped, status.dailyLimit], [false, 10]);
	assert.equal((await ask()).status, "done");
	spent.value = 10.5;
	await host.budget.refresh();
	await wait();
	assert.equal((await ask()).status, "unanswered");
	assert.equal(told.filter((m) => /stopped/.test(m)).length, 2, "the second stop wasn't told");
});

test("a new day starts the count again", async (t) => {
	const { host, spent, ask } = await start(t);
	spent.value = 7;
	await host.budget.refresh();
	assert.equal((await ask()).status, "unanswered");
	// As if the stop happened yesterday: the next read moves the baseline to today.
	await host.root.commit(async (tx) => {
		(await tx.doc(Budget)).day = "2000-01-01";
	}, context);
	const status = await host.budget.refresh();
	assert.deepEqual([status.today, status.stopped], [0, false]);
	assert.equal((await ask()).status, "done");
});

test("the monthly limit holds across days", async (t) => {
	const { host, spent, told, ask } = await start(t, { daily: 0, monthly: 20 });
	spent.value = 21;
	await host.budget.refresh();
	await wait();
	assert.equal((await ask()).status, "unanswered");
	assert.match(told.at(-1)!, /monthly limit of \$20\.00.*next month/);
	await host.root.commit(async (tx) => {
		(await tx.doc(Budget)).day = "2000-01-01";
	}, context);
	assert.equal((await host.budget.refresh()).stopped, true);
});

test("the web view shows the budget and allows more", async (t) => {
	const { host, spent } = await start(t);
	const server = createWebServer({ harness: host.harness, root: host.root, agents: host.agents, threads: host.threads, user: "me", switchable: host.switchable, approvals: host.approvals, budget: host.budget });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise((resolve) => {
		server.closeAllConnections();
		server.close(resolve);
	}));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const headers = { "Tailscale-User-Login": "me", "Content-Type": "application/json" };
	spent.value = 5.5;
	const shown = (await (await fetch(`${base}/api/budget`, { headers })).json()) as { today: number; stopped: boolean };
	assert.deepEqual([shown.today, shown.stopped], [5.5, true]);
	assert.equal((await fetch(`${base}/api/budget/allow`, { method: "POST", headers, body: JSON.stringify({ amount: -1 }) })).status, 400);
	const allowed = (await (await fetch(`${base}/api/budget/allow`, { method: "POST", headers, body: "{}" })).json()) as { dailyLimit: number; stopped: boolean };
	assert.deepEqual([allowed.dailyLimit, allowed.stopped], [10, false]);
});

test("budget settings are checked", () => {
	assert.deepEqual(configFor({}, {}).budget, { daily: 5, monthly: 0 });
	assert.deepEqual(loadConfig({ env: { GAIDIN_BUDGET_DAILY: "2.5", GAIDIN_BUDGET_MONTHLY: "40" }, search: false }).config.budget, { daily: 2.5, monthly: 40 });
	assert.ok(loadConfig({ env: { GAIDIN_BUDGET_DAILY: "-1" }, search: false }).errors.some((e) => /budget\.daily must be a dollar amount/.test(e)));
	assert.ok(loadConfig({ env: { GAIDIN_BUDGET_DAILY: "0" }, search: false }).warnings.some((w) => /No budget/.test(w)));
});

test("a refresh still running when gaidin shuts down ends with the last status instead of an error", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "gaidin-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	// Slow enough that the Harness closes while the refresh waits for the total.
	const spend = async () => new Promise<number>((resolve) => setTimeout(() => resolve(1), 100));
	const host = await startHost({ config: configFor({ budget: { daily: 5, monthly: 0 } }), dataDir: dir, models: createModels(), model: { provider: "faux", modelId: "x" }, spend });
	const before = host.budget.status();
	const pending = host.budget.refresh();
	await host.harness.close(context);
	assert.deepEqual(await pending, before);
});
