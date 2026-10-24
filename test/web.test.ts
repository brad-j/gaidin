import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { watchEvents } from "@earendil-works/pi-durable";
import { type Config, configFor } from "../src/config.ts";
import { context, startHost } from "../src/host.ts";
import { Reminders } from "../src/reminders.ts";
import { createWebServer, type Settings } from "../src/web.ts";

const BRAD = "brad@example.com";

async function start(t: TestContext, config?: Config) {
	const dir = mkdtempSync(join(tmpdir(), "gaidin-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	faux.setResponses(Array.from({ length: 10 }, () => fauxAssistantMessage(fauxText("Hello, Brad."))));
	const models = createModels();
	models.setProvider(faux.provider);
	const host = await startHost({ config, dataDir: dir, models, model: { provider: "faux", modelId: "faux-1" }, adapters: { push: { send: async () => true } } });
	const server = createWebServer({ harness: host.harness, root: host.root, agents: host.agents, profiles: host.profiles, threads: host.threads, user: BRAD, uploads: host.uploads, avatars: host.avatars, history: host.history, switchable: host.switchable, approvals: host.approvals, snooze: host.reminders.snooze });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(async () => {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
		await host.close();
	});
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const call = (path: string, init: RequestInit & { as?: string } = {}) =>
		fetch(base + path, { ...init, headers: { "Tailscale-User-Login": init.as ?? BRAD, ...(init.headers as Record<string, string>) } });
	const post = (path: string, body: unknown) =>
		call(path, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
	return { host, server, call, post, faux };
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

test("only Brad's tailnet login gets in", async (t) => {
	const { call } = await start(t);
	assert.equal((await fetch((await call("/api/version")).url)).status, 403);
	assert.equal((await call("/api/version", { as: "someone@example.com" })).status, 403);
	assert.equal((await call("/api/version")).status, 200);
});

test("every response forbids framing and runs no script", async (t) => {
	const { call } = await start(t);
	for (const response of [await call("/"), await call("/api/settings"), await call("/", { as: "someone@example.com" })]) {
		assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
		assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'none'/);
		assert.equal(response.headers.get("x-frame-options"), "DENY");
		assert.equal(response.headers.get("x-content-type-options"), "nosniff");
	}
});

test("there's no web app: every path that isn't the API is a 404, the app's old addresses included", async (t) => {
	const { call } = await start(t);
	for (const path of ["/", "/gaidin", "/gaidin/t/12", "/sw.js", "/manifest.webmanifest", "/icon-192.png", "/app/gaidin", "/api/nothing"]) {
		assert.equal((await call(path)).status, 404, path);
	}
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

test("/events?all follows the approvals from no conversation, and stops when the client leaves", async (t) => {
	const { host, server, call } = await start(t);
	// What the server writes to an `/events?all` response after it has closed: a stream left in the set would keep writing.
	let closed = 0;
	let late = 0;
	server.prependListener("request", (request, response) => {
		if (request.url !== "/events?all") return;
		const write = response.write.bind(response);
		let ended = false;
		response.once("close", () => {
			ended = true;
			closed++;
		});
		response.write = ((...args: Parameters<typeof write>) => {
			if (ended) late++;
			return write(...args);
		}) as typeof response.write;
	});
	/** Reads the frames of one `/events?all` stream. */
	const follow = async () => {
		const response = await call("/events?all");
		assert.equal(response.headers.get("content-type"), "text/event-stream");
		const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
		t.after(() => reader.cancel().catch(() => {}));
		const seen: { type: string }[] = [];
		let buffer = "";
		const until = async (count: number) => {
			while (seen.length < count) {
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
		return { seen, until, reader };
	};
	const ask = (id: string) => host.approvals.open(id, { conversationId: host.root.id, taskId: 1 }, "fetch_url", { summary: "fetch https://example.com/" });

	const first = await follow();
	const second = await follow();
	await ask("r1");
	await first.until(1);
	assert.deepEqual(first.seen, [{ type: "approvals_changed" }]);
	await host.approvals.decide("r1", "deny", BRAD);
	await first.until(2);
	assert.deepEqual(first.seen, [{ type: "approvals_changed" }, { type: "approvals_changed" }]);

	// Once the first client has left, the second still hears the next request, and the first hears nothing.
	await first.reader.cancel();
	while (closed === 0) await new Promise((r) => setTimeout(r, 10));
	await second.until(2);
	await ask("r2");
	await second.until(3);
	assert.equal(late, 0);
	assert.equal(first.seen.length, 2);
});

test("/events?all says when an agent's runs start and end and its conversations change, and only for that agent", async (t) => {
	const { call, post, faux } = await start(t);
	await post("/api/agents/save", { id: "scout", name: "Scout", job: "" });
	const response = await call("/events?all");
	const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
	t.after(() => reader.cancel().catch(() => {}));
	const seen: { type: string; agent?: string }[] = [];
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
	const heard = (type: string, agent: string) => seen.filter((e) => e.type === type && e.agent === agent).length;

	// A message to scout starts a run, which the model holds open until released, and then ends it. Gaidin hears of neither.
	let release = () => {};
	const held = new Promise<void>((resolve) => (release = resolve));
	faux.setResponses([async () => (await held, fauxAssistantMessage(fauxText("Hello.")))]);
	assert.equal((await post("/api/message", { content: "hi", agent: "scout" })).status, 200);
	await until(() => heard("activity_changed", "scout") >= 1);
	release();
	await until(() => heard("activity_changed", "scout") >= 2);
	assert.equal(seen.some((e) => e.agent === "gaidin"), false);
	assert.ok(seen.every((e) => ["activity_changed", "conversations_changed"].includes(e.type)));

	// A thread of gaidin's is gaidin's conversation, not scout's.
	const before = seen.length;
	assert.equal((await post("/api/threads/start", { content: "a thread" })).status, 200);
	await until(() => heard("conversations_changed", "gaidin") >= 1);
	assert.equal(seen.slice(before).some((e) => e.agent === "scout"), false);
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

test("an agent's browser profiles are listed, given and taken away through the roster routes", async (t) => {
	const { call, post } = await start(t, configFor({ browser: { profiles: ["personal", "work"] } }));
	type Entry = { id: string; profiles?: string[] };
	assert.deepEqual(await (await call("/api/profiles")).json(), { names: ["personal", "work"] });
	await post("/api/agents/save", { id: "scout", name: "Scout", job: "" });
	assert.equal((await (await call("/api/agents")).json() as Entry[]).find((a) => a.id === "scout")?.profiles, undefined);
	const given = (await (await post("/api/agents/save", { id: "scout", profiles: ["work"] })).json()) as Entry;
	assert.deepEqual(given.profiles, ["work"]);
	assert.equal((await post("/api/agents/save", { id: "scout", profiles: ["bank"] })).status, 400);
	const taken = (await (await post("/api/agents/save", { id: "scout", profiles: [] })).json()) as Entry;
	assert.equal(taken.profiles, undefined);

	// The hosts it acts on without asking: each profile named gets its whole list, and the others stay.
	type Acting = { actHosts?: Record<string, string[]> };
	const save = async (actHosts: unknown) => ((await (await post("/api/agents/save", { id: "scout", actHosts })).json()) as Acting).actHosts;
	assert.deepEqual(await save([{ profile: "work", hosts: ["a.example", "b.example"] }, { profile: "personal", hosts: ["c.example"] }]), { work: ["a.example", "b.example"], personal: ["c.example"] });
	assert.deepEqual(await save([{ profile: "work", hosts: ["b.example"] }]), { work: ["b.example"], personal: ["c.example"] });
	assert.equal(await save([{ profile: "work", hosts: [] }, { profile: "personal", hosts: [] }]), undefined);
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

test("an agent's color is one of the app's, set, kept with the roster, refused when it isn't one, and taken away", async (t) => {
	const { call, post } = await start(t);
	type Entry = { id: string; color?: string };
	const save = async (body: Record<string, unknown>) => {
		const response = await post("/api/agents/save", body);
		return { status: response.status, entry: response.ok ? ((await response.json()) as Entry) : undefined, text: response.ok ? "" : await response.text() };
	};
	const listed = async (id: string) => ((await (await call("/api/agents")).json()) as Entry[]).find((a) => a.id === id);
	await save({ id: "scout", name: "Scout", job: "" });
	assert.equal((await listed("scout"))?.color, undefined);

	assert.equal((await save({ id: "scout", color: "violet" })).entry?.color, "violet");
	assert.equal((await listed("scout"))?.color, "violet");
	// Changing another field keeps it.
	await save({ id: "scout", job: "Finds things" });
	assert.equal((await listed("scout"))?.color, "violet");

	const odd = await save({ id: "scout", color: "#ff8800" });
	assert.equal(odd.status, 400);
	assert.match(odd.text, /"violet"/);
	assert.equal((await listed("scout"))?.color, "violet");

	assert.equal((await save({ id: "scout", color: "" })).entry?.color, undefined);
	assert.equal((await listed("scout"))?.color, undefined);
	assert.equal((await save({ id: "gaidin", color: "teal" })).entry?.color, "teal");
});

test("an agent's shared notes are turned off and on from the app, but never the default agent's", async (t) => {
	const { call, post } = await start(t);
	type Entry = { id: string; sharedNotes?: boolean };
	const listed = async (id: string) => ((await (await call("/api/agents")).json()) as Entry[]).find((a) => a.id === id);
	await post("/api/agents/save", { id: "scout", name: "Scout", job: "" });
	assert.equal((await listed("scout"))?.sharedNotes, undefined);
	assert.equal((await post("/api/agents/save", { id: "scout", sharedNotes: false })).status, 200);
	assert.equal((await listed("scout"))?.sharedNotes, false);
	assert.equal((await post("/api/agents/save", { id: "scout", sharedNotes: true })).status, 200);
	assert.equal((await listed("scout"))?.sharedNotes, undefined);
	const refused = await post("/api/agents/save", { id: "gaidin", sharedNotes: false });
	assert.equal(refused.status, 400);
	assert.match(await refused.text(), /always sees the shared notes/);
});

test("each agent's activity: its newest message, from any of its conversations, and whether it's running", async (t) => {
	const { host, call, post } = await start(t);
	await post("/api/agents/save", { id: "scout", name: "Scout", job: "" });
	type Activity = { agent: string; running: boolean; last?: { at: number; role: string; text: string; place: string; conversation: number } };
	const activity = async () => (await (await call("/api/agents/activity")).json()) as Activity[];
	assert.deepEqual((await activity()).map((a) => [a.agent, a.running, a.last]), [["gaidin", false, undefined], ["scout", false, undefined]]);

	await post("/api/message", { content: "hi", requestId: "a1" });
	for (let tries = 0; ; tries++) {
		const gaidin = (await activity())[0]!;
		if (gaidin.last?.role === "assistant" && !gaidin.running) {
			assert.deepEqual(gaidin.last, { at: gaidin.last.at, role: "assistant", text: "Hello, Brad.", conversation: host.root.id, place: "main" });
			break;
		}
		if (tries > 200) throw new Error("no answer in the activity");
		await new Promise((r) => setTimeout(r, 20));
	}
	assert.equal((await activity())[1]!.last, undefined);
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
