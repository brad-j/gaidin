import assert from "node:assert/strict";
import { createDecipheriv, createECDH, createPublicKey, type ECDH, hkdfSync, randomBytes, verify } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { configFor } from "../src/config.ts";
import { context, startHost } from "../src/host.ts";
import { deviceProblem, encrypt, loadPushKeys, vapid } from "../src/push.ts";
import { createWebServer } from "../src/web.ts";

const b64 = (text: string) => Buffer.from(text.replace(/\s+/g, ""), "base64url");
const hkdf = (salt: Buffer, ikm: Buffer, info: Buffer | string, length: number) => Buffer.from(hkdfSync("sha256", ikm, salt, info, length));

function dir(t: TestContext) {
	const d = mkdtempSync(join(tmpdir(), "gaidin-test-"));
	t.after(() => rmSync(d, { recursive: true, force: true }));
	return d;
}

/** What a device does with a push: the receiving half of RFC 8291. */
function decrypt(body: Buffer, device: ECDH, auth: Buffer): string {
	const salt = body.subarray(0, 16);
	const senderPublic = body.subarray(21, 21 + body[20]!);
	const sealed = body.subarray(21 + body[20]!);
	const ikm = hkdf(auth, device.computeSecret(senderPublic), Buffer.concat([Buffer.from("WebPush: info\0"), device.getPublicKey(), senderPublic]), 32);
	const decipher = createDecipheriv("aes-128-gcm", hkdf(salt, ikm, "Content-Encoding: aes128gcm\0", 16), hkdf(salt, ikm, "Content-Encoding: nonce\0", 12));
	decipher.setAuthTag(sealed.subarray(-16));
	const plain = Buffer.concat([decipher.update(sealed.subarray(0, -16)), decipher.final()]);
	assert.equal(plain.at(-1), 2, "the padding delimiter");
	return plain.subarray(0, -1).toString("utf8");
}

function device() {
	const ecdh = createECDH("prime256v1");
	ecdh.generateKeys();
	const auth = randomBytes(16);
	return { ecdh, auth, p256dh: ecdh.getPublicKey("base64url"), authText: auth.toString("base64url") };
}

test("encryption matches RFC 8291's worked example", () => {
	const body = encrypt(
		Buffer.from("When I grow up, I want to be a watermelon"),
		"BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
		"BTBZMqHH6r4Tts7J_aSIgg",
		{ salt: b64("DGv6ra1nlYgDCS1FRnbzlw"), privateKey: b64("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw") },
	);
	assert.equal(
		body.toString("base64url"),
		"DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
	);
});

test("a device decrypts what's sent to it, and only a point on the curve is a device key", () => {
	const d = device();
	assert.equal(decrypt(encrypt(Buffer.from("check the oven ✓"), d.p256dh, d.authText), d.ecdh, d.auth), "check the oven ✓");
	assert.throws(() => encrypt(Buffer.from("x"), Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString("base64url"), d.authText));
	assert.equal(deviceProblem({ endpoint: "https://push.test/a", p256dh: d.p256dh, auth: d.authText }), undefined);
	assert.equal(deviceProblem({ endpoint: "http://push.test/a", p256dh: d.p256dh, auth: d.authText }), "endpoint isn't https");
	assert.equal(deviceProblem({ endpoint: "https://push.test/a", p256dh: "AAAA", auth: d.authText }), "p256dh isn't a P-256 public key");
	assert.equal(deviceProblem({ endpoint: "https://push.test/a", p256dh: d.p256dh, auth: "AAAA" }), "auth isn't 16 bytes");
});

test("the key pair is made once and kept private, and pushes are signed with it", (t) => {
	const data = dir(t);
	const keys = loadPushKeys(data);
	assert.deepEqual(loadPushKeys(data), keys);
	assert.equal(statSync(join(data, "push-keys.json")).mode & 0o777, 0o600);

	const now = Date.parse("2026-10-11T12:00:00Z");
	const header = vapid("https://web.push.apple.com/QGuQyavXutnMH", keys, "https://gaidin.example.ts.net", now);
	const [, token, k] = /^vapid t=(.+), k=(.+)$/.exec(header)!;
	assert.equal(k, keys.publicKey);
	const [head, claims, signature] = token!.split(".");
	assert.deepEqual(JSON.parse(b64(claims!).toString()), { aud: "https://web.push.apple.com", exp: now / 1000 + 12 * 3600, sub: "https://gaidin.example.ts.net" });
	const point = b64(keys.publicKey);
	const publicKey = createPublicKey({ key: { kty: "EC", crv: "P-256", x: point.subarray(1, 33).toString("base64url"), y: point.subarray(33).toString("base64url") }, format: "jwk" });
	assert.ok(verify("sha256", Buffer.from(`${head}.${claims}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, b64(signature!)));
});

test("reminders and requests reach signed-up devices, a device that's gone is dropped, and the web view signs devices up", async (t) => {
	const sent: { url: string; headers: Record<string, string>; body: Buffer }[] = [];
	const pushFetch = (async (url: string, init: RequestInit) => {
		sent.push({ url, headers: init.headers as Record<string, string>, body: Buffer.from(init.body as Uint8Array) });
		return new Response(null, { status: url.endsWith("/gone") ? 410 : 201 });
	}) as typeof fetch;
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("remind", { text: "stretch", inMinutes: 0.01 }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("schedule_job", { title: "Briefing", instruction: "Brief me.", time: "08:00" }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxText("Done.")),
	]);
	const models = createModels();
	models.setProvider(faux.provider);
	const BRAD = "brad@example.com";
	const host = await startHost({
		config: configFor({ owner: "Brad", web: { user: BRAD, port: 0, url: "https://gaidin.example.ts.net" } }),
		dataDir: dir(t),
		models,
		model: { provider: "faux", modelId: "faux-1" },
		pushFetch,
	});
	const server = createWebServer({ harness: host.harness, root: host.root, agents: host.agents, threads: host.threads, user: BRAD, switchable: host.switchable, approvals: host.approvals, push: host.push! });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(async () => {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
		await host.harness.close(context);
	});
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const post = (path: string, body: unknown) =>
		fetch(base + path, { method: "POST", body: JSON.stringify(body), headers: { "Tailscale-User-Login": BRAD, "Content-Type": "application/json" } });

	const worker = await fetch(`${base}/sw.js`, { headers: { "Tailscale-User-Login": BRAD } });
	assert.match(worker.headers.get("content-type")!, /^text\/javascript/);
	assert.match(await worker.text(), /addEventListener\("push"/);

	const phone = device();
	const old = device();
	assert.equal((await post("/api/push/subscribe", { endpoint: "http://push.test/a", keys: { p256dh: phone.p256dh, auth: phone.authText } })).status, 400);
	assert.deepEqual(await (await post("/api/push/subscribe", { endpoint: "https://push.test/phone", keys: { p256dh: phone.p256dh, auth: phone.authText }, label: "iPhone" })).json(), { ok: true });
	assert.deepEqual(await (await post("/api/push/subscribe", { endpoint: "https://push.test/gone", keys: { p256dh: old.p256dh, auth: old.authText }, label: "old" })).json(), { ok: true });
	const listed = (await (await fetch(`${base}/api/push`, { headers: { "Tailscale-User-Login": BRAD } })).json()) as { publicKey: string; devices: { label: string }[] };
	assert.equal(listed.publicKey, host.push!.publicKey);
	assert.deepEqual(listed.devices.map((d) => d.label), ["iPhone", "old"]);

	host.approvals.onChange((r) => void (r.status === "pending" && host.approvals.decide(r.id, "deny", "test")));
	await (await host.root.submit({ type: "input", content: "remind me, and brief me" }, context)).wait(context);
	const toPhone = async (count: number) => {
		const end = Date.now() + 10_000;
		for (;;) {
			const messages = sent.filter((s) => s.url.endsWith("/phone")).map((s) => JSON.parse(decrypt(s.body, phone.ecdh, phone.auth)) as Record<string, string>);
			if (messages.length >= count) return messages;
			if (Date.now() > end) throw new Error("timed out");
			await new Promise((r) => setTimeout(r, 20));
		}
	};
	const messages = await toPhone(2);
	const byTag = (prefix: string) => messages.find((m) => m.tag?.startsWith(prefix));
	assert.deepEqual({ ...byTag("approval-"), tag: undefined }, { title: "gaidin wants to", body: 'schedule "Briefing", at 08:00, every day: Brief me.', urgency: "high", tag: undefined });
	assert.deepEqual({ ...byTag("reminder-"), tag: undefined }, { title: "gaidin", body: "stretch", urgency: "high", tag: undefined });

	const request = sent.find((s) => s.url.endsWith("/phone"))!;
	assert.equal(request.headers["Content-Encoding"], "aes128gcm");
	assert.match(request.headers.Authorization!, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
	assert.deepEqual((await host.push!.devices()).map((d) => d.label), ["iPhone"], "the push service said the old one is gone");

	assert.deepEqual(await (await post("/api/push/unsubscribe", { endpoint: "https://push.test/phone" })).json(), { ok: true });
	assert.deepEqual(await host.push!.devices(), []);
});

test("a push fits the 4,096 bytes a push service takes, however its text escapes, cut where it has to be", async (t) => {
	const bodies: Buffer[] = [];
	const pushFetch = (async (_url: string, init: RequestInit) => {
		bodies.push(Buffer.from(init.body as Uint8Array));
		return new Response(null, { status: 201 });
	}) as typeof fetch;
	const host = await startHost({ config: configFor({ web: { user: "me", port: 0, url: "https://gaidin.example.ts.net" } }), dataDir: dir(t), models: createModels(), model: { provider: "faux", modelId: "x" }, pushFetch });
	t.after(() => host.harness.close(context));
	const phone = device();
	await host.push!.add({ endpoint: "https://push.test/phone", p256dh: phone.p256dh, auth: phone.authText, label: "phone" });

	// Each control character escapes to six bytes in JSON, and an emoji is four bytes in UTF-8.
	// The last is cut after the emoji, at 1,000 characters, not inside it.
	for (const body of ["\u0001".repeat(1000), "😀".repeat(1000), `${"x".repeat(999)}😀y`]) {
		await host.push!.send({ title: "\u0002".repeat(200), body, tag: "t" });
		const sent = bodies.at(-1)!;
		assert.ok(sent.length <= 4096, `${sent.length} bytes`);
		const message = JSON.parse(decrypt(sent, phone.ecdh, phone.auth)) as { title: string; body: string };
		assert.ok(message.body.endsWith("…"), "it says it was cut");
		assert.ok(!/[\ud800-\udbff]…$/.test(message.body), "a character was split in two");
		assert.ok(body.startsWith(message.body.slice(0, -1)));
		assert.ok(message.title.endsWith("…"));
	}
	await host.push!.send({ title: "gaidin", body: "stretch" });
	assert.deepEqual(JSON.parse(decrypt(bodies.at(-1)!, phone.ecdh, phone.auth)), { title: "gaidin", body: "stretch" });
});
