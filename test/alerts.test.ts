import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { ALERT_TOOLS, followAlerts } from "../src/alerts.ts";
import { configFor } from "../src/config.ts";
import { context, openHost } from "../src/host.ts";
import type { Report } from "../src/jobs.ts";

/** A topic that streams what `send` writes, and records each subscription's `since`. */
async function topic(t: TestContext) {
	const since: (string | null)[] = [];
	const open = new Set<ServerResponse>();
	const server = createServer((request, response) => {
		since.push(new URL(request.url!, "http://ntfy").searchParams.get("since"));
		response.writeHead(200, { "Content-Type": "application/x-ndjson" });
		response.write(`${JSON.stringify({ event: "open" })}\n`);
		open.add(response);
		request.on("close", () => open.delete(response));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => {
		server.closeAllConnections();
		return new Promise((resolve) => server.close(resolve));
	});
	const send = (id: string, title: string, message: string) => {
		for (const response of open) response.write(`${JSON.stringify({ event: "message", id, time: Math.floor(Date.now() / 1000), title, message, priority: 4 })}\n`);
	};
	return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/alerts`, since, send, connected: () => open.size > 0 };
}

async function until<T>(get: () => T | undefined, timeoutMs = 10_000): Promise<T> {
	const end = Date.now() + timeoutMs;
	for (;;) {
		const value = get();
		if (value !== undefined) return value;
		if (Date.now() > end) throw new Error("timed out");
		await new Promise((r) => setTimeout(r, 20));
	}
}

async function start(t: TestContext, dir: string, url: string, reports: Report[]) {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	faux.setResponses(Array.from({ length: 5 }, () => fauxAssistantMessage(fauxText("Linkding is down: its container exited. Restart it on apps-01."))));
	const models = createModels();
	models.setProvider(faux.provider);
	const host = await openHost({ config: configFor({ owner: "Brad" }), dataDir: dir, models, model: { provider: "faux", modelId: "faux-1" }, notify: async () => {}, deliver: async (r) => void reports.push(r) });
	const alerts = followAlerts({ url, root: host.root, owner: "Brad", addJob: host.jobs.addJob, batchMs: 200 });
	t.after(async () => {
		alerts.stop();
		await host.harness.close(context);
	});
	return { host, alerts };
}

test("alerts close together are one investigation, with read-only tools, and a restart reads on from the last one", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "gaidin-alerts-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const ntfy = await topic(t);
	const reports: Report[] = [];
	const { host, alerts } = await start(t, dir, ntfy.url, reports);

	await until(() => (ntfy.connected() ? true : undefined));
	assert.deepEqual(ntfy.since, [null]);
	ntfy.send("a1", "Linkding", "[🔴 Down] connect ECONNREFUSED 192.168.3.189:9090");
	ntfy.send("a2", "apps-01", "container linkding exited (137)");

	const report = await until(() => reports[0]);
	assert.equal(reports.length, 1);
	assert.equal(report.title, "Alert: Linkding and 1 more");
	assert.match(report.text, /^Linkding is down/);
	const run = await host.harness.conversation(report.conversationId as ConversationId, context);
	const prompt = (await run!.context(context)).messages.find((m) => m.role === "user")!;
	assert.match(JSON.stringify(prompt.content), /Linkding: \[🔴 Down\] connect ECONNREFUSED.*apps-01: container linkding exited/);
	const tools = (await run!.agent(context)).tools.map((tool) => tool.name);
	assert.ok(tools.length > 0 && tools.every((name) => ALERT_TOOLS.includes(name)), `run tools: ${tools.join(", ")}`);

	alerts.stop();
	await host.harness.close(context);
	await start(t, dir, ntfy.url, reports);
	await until(() => (ntfy.since.length === 2 ? true : undefined));
	assert.equal(ntfy.since[1], "a2");
});
