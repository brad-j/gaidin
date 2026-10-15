import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { watchEvents } from "@earendil-works/pi-durable";
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
	const server = createWebServer({ harness: host.harness, root: host.root, agents: host.agents, threads: host.threads, user: BRAD, app, uploads: host.uploads, avatars: host.avatars, switchable: host.switchable, approvals: host.approvals, snooze: host.reminders.snooze });
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

/** The newest message the owner sent to the default agent's home, once it's in the transcript. */
async function lastUserEntry(host: Awaited<ReturnType<typeof startHost>>) {
	for (let tries = 0; tries < 200; tries++) {
		const stream = await watchEvents(host.harness, host.root.id, context);
		await stream.stop();
		const users = stream.snapshot.entries.filter((e) => e.kind === "pi.user");
		if (users.length > 0) return users.at(-1)!;
		await new Promise((r) => setTimeout(r, 20));
	}
	throw new Error("no message from the owner");
}

/** A stand-in for moiraine's build: a shell with two inline scripts, a hashed script, an icon and a dotfile. */
function fakeApp(t: TestContext) {
	const app = mkdtempSync(join(tmpdir(), "gaidin-app-"));
	t.after(() => rmSync(app, { recursive: true, force: true }));
	const inline = ["document.currentScript.remove()", "self.$_TSR={};"];
	writeFileSync(join(app, "_shell.html"), `<html><head><title>gaidin</title></head><body><script>${inline[0]}</script><script data-part="">${inline[1]}</script><script type="module" src="/assets/index-abc.js"></script></body></html>`);
	mkdirSync(join(app, "assets"));
	writeFileSync(join(app, "assets", "index-abc.js"), "console.log(1)");
	writeFileSync(join(app, "icon-192.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
	writeFileSync(join(app, "manifest.webmanifest"), JSON.stringify({ id: "/", start_url: "/" }));
	writeFileSync(join(app, ".hidden"), "not served");
	return { app, hashes: inline.map((code) => `'sha256-${createHash("sha256").update(code).digest("base64")}'`) };
}

test("only Brad's tailnet login gets in, and the app's files are its own: icons and manifest at the paths they had", async (t) => {
	const { call } = await start(t, fakeApp(t).app);
	assert.equal((await fetch((await call("/")).url)).status, 403);
	assert.equal((await call("/", { as: "someone@example.com" })).status, 403);
	const page = await call("/");
	assert.equal(page.status, 200);
	assert.match(await page.text(), /<title>gaidin<\/title>/);
	const icon = await call("/icon-192.png");
	assert.equal(icon.headers.get("content-type"), "image/png");
	assert.equal(icon.headers.get("cache-control"), "no-store");
	assert.equal((await call("/manifest.webmanifest")).headers.get("content-type"), "application/manifest+json");
});

test("every response forbids framing, and runs only the app's own script", async (t) => {
	const { call } = await start(t, fakeApp(t).app);
	for (const response of [await call("/"), await call("/api/settings"), await call("/", { as: "someone@example.com" })]) {
		assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
		assert.match(response.headers.get("content-security-policy") ?? "", /script-src 'self'[ ;]/);
		assert.equal(response.headers.get("x-frame-options"), "DENY");
		assert.equal(response.headers.get("x-content-type-options"), "nosniff");
	}
	assert.match((await call("/api/settings")).headers.get("content-security-policy")!, /script-src 'self';/);
});

test("the app's shell answers every path that isn't the API or one of its files, with its inline scripts allowed by hash, and its old /app/ addresses go to the new ones", async (t) => {
	const { app, hashes } = fakeApp(t);
	const { call } = await start(t, app);

	const script = await call("/assets/index-abc.js");
	assert.equal(await script.text(), "console.log(1)");
	assert.match(script.headers.get("content-type")!, /^text\/javascript/);
	assert.match(script.headers.get("cache-control")!, /immutable/);

	// Any other path, a dotfile and a way out of the directory included, gets the shell, which isn't cached.
	for (const path of ["/", "/gaidin", "/gaidin/t/12", "/activity", "/.hidden", "/..%2fpackage.json", "/_shell.html", "/assets/missing.js"]) {
		const shell = await call(path);
		assert.equal(shell.status, 200, path);
		assert.match(await shell.text(), /^<html>/, path);
		assert.equal(shell.headers.get("cache-control"), "no-store", path);
		assert.ok(shell.headers.get("content-security-policy")!.includes(`script-src 'self' ${hashes.join(" ")};`), path);
	}
	assert.equal((await call("/%E0%A4%A")).status, 400);
	// The API's own paths aren't the app's.
	assert.equal((await call("/api/nothing")).status, 404);

	for (const [from, to] of [["/app", "/"], ["/app/", "/"], ["/app/gaidin/t/12", "/gaidin/t/12"], ["/app/gaidin/skills/gaidin/tools.md?create=true", "/gaidin/skills/gaidin/tools.md?create=true"]] as const) {
		const moved = await call(from, { redirect: "manual" });
		assert.equal(moved.status, 308, from);
		assert.equal(moved.headers.get("location"), to, from);
	}
});

test("without web.app there's no app, and a missing build says so", async (t) => {
	const none = await (await start(t)).call("/");
	assert.equal(none.status, 404);
	assert.match(await none.text(), /set web\.app/);
	const empty = mkdtempSync(join(tmpdir(), "gaidin-app-"));
	t.after(() => rmSync(empty, { recursive: true, force: true }));
	const missing = await (await start(t, empty)).call("/");
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

test("the default agent's hosts are the approvals' fetch hosts, read and saved through the roster routes", async (t) => {
	const { host, call, post } = await start(t);
	type Entry = { id: string; hosts: string[] };
	const saved = await post("/api/agents/save", { id: "gaidin", hosts: ["example.com", "example.org"] });
	assert.equal(saved.status, 200);
	assert.deepEqual(((await saved.json()) as Entry).hosts, ["example.com", "example.org"]);
	assert.deepEqual(await host.approvals.hostsFor("gaidin"), ["example.com", "example.org"]);
	await post("/api/agents/save", { id: "gaidin", hosts: ["example.org"] });
	const listed = (await (await call("/api/agents")).json()) as Entry[];
	assert.deepEqual(listed.find((a) => a.id === "gaidin")?.hosts, ["example.org"]);

	// Another agent's are its own, in its entry.
	await post("/api/agents/save", { id: "scout", name: "Scout", job: "" });
	await post("/api/agents/save", { id: "scout", hosts: ["scout.example"] });
	assert.deepEqual(await host.approvals.hostsFor("scout"), ["scout.example"]);
	assert.deepEqual(await host.approvals.hostsFor("gaidin"), ["example.org"]);
	assert.deepEqual(await (await call("/api/workspaces")).json(), { names: [] });
});

test("files sent from the app: an image goes to the model, another file to the agent's sandbox, and a cross-site upload is refused", async (t) => {
	const { host, call, post } = await start(t);
	const upload = (name: string, data: Uint8Array<ArrayBuffer>, headers: Record<string, string> = {}) =>
		call("/api/files", { method: "POST", body: data, headers: { "X-Gaidin-File": encodeURIComponent(name), "Content-Type": "application/octet-stream", ...headers } });
	// A 1×1 PNG.
	const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));

	// Without the header a browser asks first for, or from another site, it's refused.
	assert.equal((await call("/api/files", { method: "POST", body: png, headers: { "Content-Type": "image/png" } })).status, 403);
	assert.equal((await upload("x.png", png, { Origin: "https://evil.example" })).status, 403);
	assert.equal((await upload("big.bin", new Uint8Array(20_000_001))).status, 413);

	const image = await upload("dog.png", png, { "Content-Type": "image/png" });
	assert.equal(image.status, 200);
	const sentImage = (await image.json()) as { id: string; image: boolean };
	assert.equal(sentImage.image, true);
	const pdf = (await (await upload("Q3 report.pdf", new TextEncoder().encode("%PDF-1.4 a report"), { "Content-Type": "application/pdf" })).json()) as { id: string; image: boolean };
	assert.equal(pdf.image, false);

	assert.equal((await post("/api/message", { content: "look", files: [sentImage.id, pdf.id], requestId: "f1" })).status, 200);
	const user = await lastUserEntry(host);
	const content = user.model?.[0]?.content;
	assert.ok(Array.isArray(content), "the message has its image");
	assert.deepEqual(content.map((part: { type: string }) => part.type), ["text", "image"]);
	const text = (content[0] as { text: string }).text;
	assert.match(text, /\] look\n\n\[Files from the app: Q3 report\.pdf is saved as uploads\/[0-9a-f]{8}-Q3_report\.pdf \(application\/pdf, 1 KB\)/);
	const path = /saved as (uploads\/\S+)/.exec(text)![1]!;
	assert.equal(readFileSync(join(await host.agents.sandbox("gaidin"), path), "utf8"), "%PDF-1.4 a report");

	// Another agent's files go to its own sandbox; a file it doesn't have is refused.
	await post("/api/agents/save", { id: "scout", name: "Scout", job: "" });
	const notes = (await (await upload("notes.txt", new TextEncoder().encode("hello"))).json()) as { id: string };
	assert.equal((await post("/api/message", { content: "", agent: "scout", files: [notes.id], requestId: "f2" })).status, 200);
	const scoutUploads = join(await host.agents.sandbox("scout"), "uploads");
	assert.deepEqual(readdirSync(scoutUploads).map((f) => f.replace(/^[0-9a-f]{8}-/, "")), ["notes.txt"]);
	assert.equal((await post("/api/message", { content: "again", files: ["00000000-0000-0000-0000-000000000000"] })).status, 400);
	assert.equal((await post("/api/message", { content: "  " })).status, 400);
});

test("an agent's picture is set from a file sent to /api/files, served from its own address, replaced, and taken away", async (t) => {
	const { call, post } = await start(t);
	const upload = async (name: string, data: Uint8Array<ArrayBuffer>) =>
		((await (await call("/api/files", { method: "POST", body: data, headers: { "X-Gaidin-File": name, "Content-Type": "application/octet-stream" } })).json()) as { id: string }).id;
	const png = (n: number) => Uint8Array.from([...Buffer.from("89504e470d0a1a0a", "hex"), n]);
	type Entry = { id: string; avatar?: string };
	const save = async (body: Record<string, unknown>) => {
		const response = await post("/api/agents/save", body);
		return { status: response.status, entry: response.ok ? ((await response.json()) as Entry) : undefined, text: response.ok ? "" : await response.text() };
	};
	await save({ id: "scout", name: "Scout", job: "" });
	await save({ id: "scout-2", name: "Scout Two", job: "" });

	const first = await save({ id: "scout", avatar: await upload("a.png", png(1)) });
	assert.match(first.entry?.avatar ?? "", /^scout-[0-9a-f]{12}\.png$/);
	const other = await save({ id: "scout-2", avatar: await upload("b.png", png(2)) });
	const picture = await call(`/api/agents/avatar?id=scout&v=${first.entry!.avatar}`);
	assert.equal(picture.status, 200);
	assert.equal(picture.headers.get("content-type"), "image/png");
	assert.match(picture.headers.get("cache-control")!, /immutable/);
	assert.deepEqual([...new Uint8Array(await picture.arrayBuffer())].at(-1), 1);

	// A new one has a new name, and the old one's file goes; Scout Two's, whose id starts the same, stays.
	const second = await save({ id: "scout", avatar: await upload("c.png", png(3)) });
	assert.notEqual(second.entry?.avatar, first.entry?.avatar);
	assert.deepEqual([...new Uint8Array(await (await call("/api/agents/avatar?id=scout")).arrayBuffer())].at(-1), 3);
	assert.equal((await call("/api/agents/avatar?id=scout-2")).status, 200);
	assert.ok(other.entry?.avatar !== undefined);

	const text = await save({ id: "scout", avatar: await upload("notes.txt", new TextEncoder().encode("not a picture")) });
	assert.equal(text.status, 400);
	assert.match(text.text, /PNG, JPEG or WebP/);

	const cleared = await save({ id: "scout", avatar: "" });
	assert.equal(cleared.entry?.avatar, undefined);
	assert.equal((await call("/api/agents/avatar?id=scout")).status, 404);
	assert.equal((await call("/api/agents/avatar?id=nobody")).status, 404);
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
	// The transcript's record of it carries its id, for the app's snooze buttons.
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
