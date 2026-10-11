// Web Push: notifications from gaidin itself, to the web view installed as an app on a phone or computer.
// The page signs a device up (web/app.ts, /notifications) and its service worker (web/sw.js) shows what
// arrives. A push goes to the browser maker's push service (Apple's, Google's, Mozilla's), which hands it to
// the device; it's encrypted to the device (RFC 8291), so the push service can't read it, and signed with
// gaidin's own key (VAPID, RFC 8292), so the push service takes it only from gaidin.
//
// The key pair is made on first use and kept in the data directory. Devices are kept in a session document;
// one the push service says is gone (404 or 410) is dropped.
import { createCipheriv, createECDH, createPrivateKey, hkdfSync, type KeyObject, randomBytes, sign } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { defineDoc, type Harness } from "@earendil-works/pi-durable";
import { type Json, object, parseJson, string } from "./parse.ts";

export type PushMessage = {
	title: string;
	body: string;
	/** A later notification with the same tag replaces this one. */
	tag?: string;
	/** Where tapping it goes in the web view. Default: the web view itself. */
	url?: string;
	/** "high" for what's waiting on the owner; the push service may hold "normal" ones for a phone that's saving battery. */
	urgency?: "normal" | "high";
};

export type Device = { endpoint: string; p256dh: string; auth: string; label: string; addedAt: number };

export const PushDevices = defineDoc<{ devices: Device[] }>({
	kind: "gaidin.push",
	version: 1,
	scope: "session",
	initial: () => ({ devices: [] }),
});

/** `publicKey` is the raw P-256 point, base64url, which the page subscribes with; `privateKey` is the scalar, base64url. */
export type PushKeys = { publicKey: string; privateKey: string };

/** The VAPID key pair in `dir`, made the first time. */
export function loadPushKeys(dir: string): PushKeys {
	const file = join(dir, "push-keys.json");
	if (existsSync(file)) return parseJson(readFileSync(file, "utf8"), object({ publicKey: string, privateKey: string }), file);
	const ecdh = createECDH("prime256v1");
	ecdh.generateKeys();
	const keys = { publicKey: ecdh.getPublicKey("base64url"), privateKey: ecdh.getPrivateKey("base64url") };
	writeFileSync(file, `${JSON.stringify(keys)}\n`, { mode: 0o600, flag: "wx" });
	return keys;
}

function signingKey(keys: PushKeys): KeyObject {
	const point = Buffer.from(keys.publicKey, "base64url");
	const jwk = { kty: "EC", crv: "P-256", x: point.subarray(1, 33).toString("base64url"), y: point.subarray(33).toString("base64url"), d: keys.privateKey };
	return createPrivateKey({ key: jwk, format: "jwk" });
}

const hkdf = (salt: Buffer, ikm: Buffer, info: Buffer | string, length: number) => Buffer.from(hkdfSync("sha256", ikm, salt, info, length));
const RECORD_SIZE = 4096;

/**
 * `plaintext` encrypted for the device with public key `p256dh` and secret `auth` (both base64url), as an aes128gcm body
 * (RFC 8291, RFC 8188). `fixed` replaces the random salt and sender key, for the RFC's worked example.
 */
export function encrypt(plaintext: Buffer, p256dh: string, auth: string, fixed?: { salt: Buffer; privateKey: Buffer }): Buffer {
	const devicePublic = Buffer.from(p256dh, "base64url");
	const ecdh = createECDH("prime256v1");
	if (fixed === undefined) ecdh.generateKeys();
	else ecdh.setPrivateKey(fixed.privateKey);
	const senderPublic = ecdh.getPublicKey();
	// Throws for a point that isn't on the curve.
	const shared = ecdh.computeSecret(devicePublic);
	const salt = fixed?.salt ?? randomBytes(16);
	const ikm = hkdf(Buffer.from(auth, "base64url"), shared, Buffer.concat([Buffer.from("WebPush: info\0"), devicePublic, senderPublic]), 32);
	const cipher = createCipheriv("aes-128-gcm", hkdf(salt, ikm, "Content-Encoding: aes128gcm\0", 16), hkdf(salt, ikm, "Content-Encoding: nonce\0", 12));
	// One record, ended by the padding delimiter 0x02.
	const sealed = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
	const header = Buffer.alloc(21);
	salt.copy(header);
	header.writeUInt32BE(RECORD_SIZE, 16);
	header[20] = senderPublic.length;
	return Buffer.concat([header, senderPublic, sealed]);
}

/** The Authorization header for a push to `endpoint`: a JWT for its origin, good for 12 hours, signed with gaidin's key. */
export function vapid(endpoint: string, keys: PushKeys, subject: string, now = Date.now()): string {
	const part = (value: Json) => Buffer.from(JSON.stringify(value)).toString("base64url");
	const unsigned = `${part({ typ: "JWT", alg: "ES256" })}.${part({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })}`;
	const signature = sign("sha256", Buffer.from(unsigned), { key: signingKey(keys), dsaEncoding: "ieee-p1363" }).toString("base64url");
	return `vapid t=${unsigned}.${signature}, k=${keys.publicKey}`;
}

/** Why `device` can't be signed up, or nothing. */
export function deviceProblem(device: Pick<Device, "endpoint" | "p256dh" | "auth">): string | undefined {
	let url: URL;
	try {
		url = new URL(device.endpoint);
	} catch {
		return "endpoint isn't a URL";
	}
	if (url.protocol !== "https:") return "endpoint isn't https";
	const point = Buffer.from(device.p256dh, "base64url");
	if (point.length !== 65 || point[0] !== 4) return "p256dh isn't a P-256 public key";
	if (Buffer.from(device.auth, "base64url").length !== 16) return "auth isn't 16 bytes";
	return undefined;
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

export function createPush(options: { harness: Harness; keys: PushKeys; subject: string; fetch?: typeof fetch }) {
	const { harness, keys, subject } = options;
	const send = options.fetch ?? fetch;

	async function commit<T>(change: (doc: { devices: Device[] }) => T): Promise<T> {
		const root = await harness.root(context);
		return root.commit(async (tx) => change(await tx.doc(PushDevices)), context);
	}

	const devices = async () => (await harness.snapshot(PushDevices, context))?.devices ?? [];

	return {
		publicKey: keys.publicKey,
		devices,

		/** Signs a device up, or updates it. Throws with what's wrong. */
		async add(device: Omit<Device, "addedAt">) {
			const problem = deviceProblem(device);
			if (problem !== undefined) throw new Error(problem);
			await commit((doc) => {
				doc.devices = [...doc.devices.filter((d) => d.endpoint !== device.endpoint), { ...device, label: clip(device.label, 60), addedAt: Date.now() }];
			});
		},

		async remove(endpoint: string): Promise<boolean> {
			return commit((doc) => {
				const before = doc.devices.length;
				doc.devices = doc.devices.filter((d) => d.endpoint !== endpoint);
				return doc.devices.length < before;
			});
		},

		/**
		 * Sends `message` to every device and returns how many took it. Devices that are gone are dropped. Throws when
		 * there were devices and none took it, so the caller can try again.
		 */
		async send(message: PushMessage): Promise<number> {
			const all = await devices();
			// Well under the 3,993 bytes a push can carry, even with every character escaped.
			const payload = Buffer.from(JSON.stringify({ ...message, title: clip(message.title, 100), body: clip(message.body, 1000) }));
			const errors: string[] = [];
			const gone: string[] = [];
			let sent = 0;
			await Promise.all(
				all.map(async (device) => {
					try {
						const response = await send(device.endpoint, {
							method: "POST",
							headers: {
								Authorization: vapid(device.endpoint, keys, subject),
								TTL: String(24 * 3600),
								Urgency: message.urgency ?? "normal",
								"Content-Encoding": "aes128gcm",
								"Content-Type": "application/octet-stream",
							},
							body: new Uint8Array(encrypt(payload, device.p256dh, device.auth)),
							signal: AbortSignal.timeout(15_000),
						});
						if (response.status === 404 || response.status === 410) gone.push(device.endpoint);
						else if (response.ok) sent += 1;
						else errors.push(`${device.label}: ${new URL(device.endpoint).host} answered ${response.status} ${(await response.text()).slice(0, 200)}`);
					} catch (error) {
						errors.push(`${device.label}: ${error instanceof Error ? error.message : String(error)}`);
					}
				}),
			);
			if (gone.length > 0) await commit((doc) => void (doc.devices = doc.devices.filter((d) => !gone.includes(d.endpoint))));
			if (sent === 0 && errors.length > 0) throw new Error(`No device took the notification: ${errors.join("; ")}`);
			for (const error of errors) console.error("[push]", error);
			return sent;
		},
	};
}

export type Push = ReturnType<typeof createPush>;
