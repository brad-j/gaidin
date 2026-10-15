import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { context, startHost } from "../src/host.ts";
import { Reminders } from "../src/reminders.ts";
import { createWebServer, type Settings } from "../src/web.ts";

const BRAD = "brad@example.com";

async function start(t: TestContext, app?: string) {
	const dir = mkdtempSync(join(tmpdir(), "gaidin-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	faux.setResponses(Array.from({ length: 10 }, () => fauxAssistantMessage(fauxText("Hello, Brad."))));
	const models = createModels();
	models.setProvider(faux.provider);
	const host = await startHost({ dataDir: dir, models, model: { provider: "faux", modelId: "faux-1" }, adapters: { push: { send: async () => true } } });
	const server = createWebServer({ harness: host.harness, root: host.root, agents: host.agents, threads: host.threads, user: BRAD, app, switchable: host.switchable, approvals: host.approvals, snooze: host.reminders.snooze });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(async () => {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
		await host.harness.close(context);
	});
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const call = (path: string, init: RequestInit & { as?: string } = {}) =>
		fetch(base + path, { ...init, headers: { "Tailscale-User-Login": init.as ?? BRAD, ...(init.headers as Record<string, string>) } });
	const post = (path: string, body: unknown) =>
		call(path, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
	return { host, call, post };
}

test("only Brad's tailnet login gets in", async (t) => {
	const { call } = await start(t);
	assert.equal((await fetch((await call("/")).url)).status, 403);
	assert.equal((await call("/", { as: "someone@example.com" })).status, 403);
	const page = await call("/");
	assert.equal(page.status, 200);
	assert.match(await page.text(), /<title>gaidin<\/title>/);
	// /app.js and every module it imports, directly or not, are served with their types stripped.
	const served = new Set(["/app.js"]);
	for (const path of served) {
		const script = await call(path);
		assert.equal(script.status, 200, path);
		assert.match(script.headers.get("content-type")!, /^text\/javascript/);
		const code = await script.text();
		assert.doesNotMatch(code, /: (HTMLElement|Transcript|Job|Reminder)\b/, `${path} has types left`);
		// Only the page's own modules: the server's types it imports are stripped with the rest.
		for (const [, from] of code.matchAll(/^import .* from "([^"]+)";$/gm)) {
			assert.match(from, /^\.\/[a-z]+\.ts$/, `${path} imports ${from}`);
			served.add(from.slice(1));
		}
	}
	assert.ok(served.has("/transcript.ts") && served.has("/schedule.ts"), [...served].join());
	for (const path of ["/favicon.svg", "/logo.svg"]) {
		const icon = await call(path);
		assert.equal(icon.headers.get("content-type"), "image/svg+xml");
		assert.match(await icon.text(), /<title>gaidin<\/title>/);
	}
	const manifest = await (await call("/manifest.webmanifest")).json();
	for (const path of ["/apple-touch-icon.png", ...manifest.icons.map((icon: { src: string }) => icon.src)]) {
		const png = await call(path);
		assert.equal(png.headers.get("content-type"), "image/png", path);
		assert.deepEqual([...new Uint8Array(await png.arrayBuffer()).subarray(1, 4)], [0x50, 0x4e, 0x47], path);
	}
});

test("every response forbids framing and runs only the page's own script", async (t) => {
	const { call } = await start(t);
	for (const response of [await call("/"), await call("/api/settings"), await call("/", { as: "someone@example.com" })]) {
		assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
		assert.match(response.headers.get("content-security-policy") ?? "", /script-src 'self';/);
		assert.equal(response.headers.get("x-frame-options"), "DENY");
		assert.equal(response.headers.get("x-content-type-options"), "nosniff");
	}
});

test("the app's files are served at /app/, and its shell for every other path there, with its inline scripts allowed by hash", async (t) => {
	const app = mkdtempSync(join(tmpdir(), "gaidin-app-"));
	t.after(() => rmSync(app, { recursive: true, force: true }));
	const inline = ["document.currentScript.remove()", "self.$_TSR={};"];
	writeFileSync(join(app, "_shell.html"), `<html><body><script>${inline[0]}</script><script data-part="">${inline[1]}</script><script type="module" src="/app/assets/index-abc.js"></script></body></html>`);
	mkdirSync(join(app, "assets"));
	writeFileSync(join(app, "assets", "index-abc.js"), "console.log(1)");
	writeFileSync(join(app, "robots.txt"), "no");
	writeFileSync(join(app, ".hidden"), "not served");
	const { call } = await start(t, app);

	const script = await call("/app/assets/index-abc.js");
	assert.equal(await script.text(), "console.log(1)");
	assert.match(script.headers.get("content-type")!, /^text\/javascript/);
	assert.match(script.headers.get("cache-control")!, /immutable/);
	assert.equal((await call("/app/robots.txt")).headers.get("cache-control"), "no-store");

	// Any other path, a dotfile and a way out of the directory included, gets the shell, which isn't cached.
	const hashes = inline.map((code) => `'sha256-${createHash("sha256").update(code).digest("base64")}'`);
	for (const path of ["/app", "/app/", "/app/gaidin/t/12", "/app/.hidden", "/app/..%2fpackage.json", "/app/_shell.html", "/app/assets/missing.js"]) {
		const shell = await call(path);
		assert.equal(shell.status, 200, path);
		assert.match(await shell.text(), /^<html>/, path);
		assert.equal(shell.headers.get("cache-control"), "no-store", path);
		assert.ok(shell.headers.get("content-security-policy")!.includes(`script-src 'self' ${hashes.join(" ")};`), path);
		assert.match(shell.headers.get("content-security-policy")!, /frame-ancestors 'none'/, path);
	}
	assert.equal((await call("/app/%E0%A4%A")).status, 400);
	assert.equal((await call("/app/", { as: "someone@example.com" })).status, 403);
	// Other pages keep the policy without the hashes.
	assert.match((await call("/")).headers.get("content-security-policy")!, /script-src 'self';/);
});

test("without web.app there's no app, and a missing build says so", async (t) => {
	assert.equal((await (await start(t)).call("/app/")).status, 404);
	const empty = mkdtempSync(join(tmpdir(), "gaidin-app-"));
	t.after(() => rmSync(empty, { recursive: true, force: true }));
	const missing = await (await start(t, empty)).call("/app/");
	assert.equal(missing.status, 404);
	assert.match(await missing.text(), /The app isn't built/);
});

test("a post from another site is refused", async (t) => {
	const { call } = await start(t);
	const form = await call("/api/message", { method: "POST", body: "content=hi", headers: { "Content-Type": "application/x-www-form-urlencoded" } });
	assert.equal(form.status, 403);
	const foreign = await call("/api/message", {
		method: "POST",
		body: JSON.stringify({ content: "hi" }),
		headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
	});
	assert.equal(foreign.status, 403);
});

test("a message sent from the page is answered, and the answer comes down the event stream", async (t) => {
	const { call, post } = await start(t);
	const events = await call("/events");
	assert.equal(events.headers.get("content-type"), "text/event-stream");
	const reader = events.body!.pipeThrough(new TextDecoderStream()).getReader();
	t.after(() => reader.cancel());

	const seen: { type: string; entry?: { kind: string; model?: { content: unknown }[] } }[] = [];
	let buffer = "";
	const until = async (check: () => boolean) => {
		while (!check()) {
			const { value, done } = await reader.read();
			if (done) throw new Error("stream ended");
			buffer += value;
			let end: number;
			while ((end = buffer.indexOf("\n\n")) >= 0) {
				const frame = buffer.slice(0, end);
				buffer = buffer.slice(end + 2);
				if (frame.startsWith("data: ")) seen.push(JSON.parse(frame.slice(6)));
			}
		}
	};
	await until(() => seen.length > 0);
	assert.equal(seen[0]!.type, "snapshot");

	assert.equal((await post("/api/message", { content: "hi", requestId: "r1" })).status, 200);
	await until(() => seen.some((e) => e.type === "run_end"));
	const answer = seen.find((e) => e.type === "message_end" && e.entry?.kind === "pi.assistant");
	assert.match(JSON.stringify(answer?.entry?.model), /Hello, Brad\./);
	const user = seen.find((e) => e.entry?.kind === "pi.user");
	assert.match(JSON.stringify(user?.entry?.model), /\] hi"/);
});

test("settings change the agent, and switched-off tools leave the request", async (t) => {
	const { host, call, post } = await start(t);
	const before = (await (await call("/api/settings")).json()) as Settings;
	assert.equal(before.model, "faux-1");
	assert.ok(before.tools.every((tool) => tool.enabled));

	const saved = await post("/api/settings", { model: "faux-1", thinkingLevel: "low", instructions: "Answer in French.", disabledTools: ["bash"] });
	assert.equal(saved.status, 200);
	const after = (await saved.json()) as Settings;
	assert.equal(after.thinkingLevel, "low");
	assert.equal(after.instructions, "Answer in French.");
	assert.deepEqual(after.tools.filter((tool) => !tool.enabled).map((tool) => tool.name), ["bash"]);
	const agent = await host.root.agent(context);
	assert.ok(!agent.tools.some((tool) => tool.name === "bash"));
	assert.ok(agent.tools.some((tool) => tool.name === "remind"));

	assert.equal((await post("/api/settings", { model: "gpt-something" })).status, 400);
	assert.equal((await post("/api/settings", { thinkingLevel: "max" })).status, 400);
	const reset = (await (await post("/api/settings", { instructions: "", disabledTools: [] })).json()) as Settings;
	assert.equal(reset.instructions, "");
	assert.ok(reset.tools.every((tool) => tool.enabled));
});

test("reminders are listed and can be cancelled", async (t) => {
	const { host, call, post } = await start(t);
	const at = Date.now() + 60 * 60_000;
	await host.root.commit(async (tx) => {
		const id = await tx.createTask(host.reminders.ReminderTask, { text: "water the plants", at }, {
			ownership: { kind: "conversation" },
			background: true,
		});
		(await tx.doc(Reminders)).items.push({ taskId: id, text: "water the plants", at });
	}, context);
	const listed = (await (await call("/api/reminders")).json()) as { taskId: number; text: string }[];
	assert.deepEqual(listed.map((r) => r.text), ["water the plants"]);
	assert.deepEqual(await (await post("/api/reminders/cancel", { id: listed[0]!.taskId })).json(), { ok: true });
	assert.deepEqual(await (await call("/api/reminders")).json(), []);
});

test("a fired reminder is snoozed from its push's button", async (t) => {
	const { host, call, post } = await start(t);
	const fired = await host.root.commit(async (tx) => {
		const id = await tx.createTask(host.reminders.ReminderTask, { text: "take the bread out", at: Date.now() }, { ownership: { kind: "conversation" }, background: true });
		(await tx.doc(Reminders)).items.push({ taskId: id, text: "take the bread out", at: Date.now() });
		return id;
	}, context);
	await host.harness.waitForTask(fired, context);
	// The transcript's record of it carries its id, for the web view's snooze buttons.
	const record = (await host.root.entries({}, 5, undefined, context)).items.find((e) => e.kind === "gaidin.reminder-fired");
	assert.equal((record?.data as { taskId?: number } | undefined)?.taskId, fired);

	const before = Date.now();
	const response = await post("/api/reminders/snooze", { id: fired, minutes: 10 });
	assert.equal(response.status, 200);
	const { at } = (await response.json()) as { at: number };
	assert.ok(at >= before + 10 * 60_000 && at <= Date.now() + 10 * 60_000);
	const listed = (await (await call("/api/reminders")).json()) as { text: string; at: number }[];
	assert.deepEqual(listed.map((r) => [r.text, r.at]), [["take the bread out", at]]);

	assert.equal((await post("/api/reminders/snooze", { id: 999_999, minutes: 10 })).status, 404);
	assert.equal((await post("/api/reminders/snooze", { id: fired, minutes: 0 })).status, 400);
});

test("scheduled jobs are listed, paused, resumed and cancelled", async (t) => {
	const { Jobs } = await import("../src/jobs.ts");
	const { host, call, post } = await start(t);
	const firstAt = Date.now() + 60 * 60_000;
	await host.root.commit(async (tx) => {
		const id = await tx.createTask(host.jobs.JobTask, { title: "Briefing", firstAt }, { ownership: { kind: "conversation" }, background: true });
		(await tx.doc(Jobs)).items.push({ taskId: id as number, title: "Briefing", instruction: "Brief me.", schedule: { kind: "daily", time: "08:00", days: [1, 2, 3, 4, 5] }, mode: "report", createdAt: Date.now(), nextAt: firstAt, runs: 0 });
	}, context);
	const listed = (await (await call("/api/jobs")).json()) as { taskId: number; title: string; when: string }[];
	assert.deepEqual(listed.map((j) => [j.title, j.when]), [["Briefing", "at 08:00, weekdays"]]);
	const id = listed[0]!.taskId;
	assert.deepEqual(await (await post("/api/jobs/pause", { id })).json(), { ok: true });
	assert.equal(((await (await call("/api/jobs")).json()) as { paused?: { reason: string } }[])[0]!.paused?.reason, "paused by the owner");
	assert.deepEqual(await (await post("/api/jobs/pause", { id })).json(), { ok: false }, "it's already paused");
	assert.deepEqual(await (await post("/api/jobs/resume", { id })).json(), { ok: true });
	assert.equal(((await (await call("/api/jobs")).json()) as { paused?: unknown }[])[0]!.paused, undefined);
	assert.deepEqual(await (await post("/api/jobs/cancel", { id })).json(), { ok: true });
	assert.deepEqual(await (await call("/api/jobs")).json(), []);
});
