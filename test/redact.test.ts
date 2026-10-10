import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ShellOutputInfo } from "@earendil-works/pi-durable/env";
import { configFor } from "../src/config.ts";
import { context, openHost } from "../src/host.ts";
import { createRedactor, redactingStream, redactorFromEnv } from "../src/redact.ts";

const TOKEN = "xoxb-1234567890-abcdefghijklmnop";

function tempDir(t: TestContext): string {
	const dir = mkdtempSync(join(tmpdir(), "gaidin-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

test("a secret split across chunks at any point is still redacted, and nothing else changes", () => {
	const redactor = createRedactor(new Map([[TOKEN, "SLACK_BOT_TOKEN"]]));
	const text = `before ${TOKEN} middle ${TOKEN}\nafter`;
	for (let a = 1; a < text.length; a += 1) {
		for (const b of [a + 1, a + 7, text.length - 1]) {
			if (b <= a || b >= text.length) continue;
			const out: string[] = [];
			const stream = redactingStream(redactor, (chunk) => out.push(chunk));
			for (const chunk of [text.slice(0, a), text.slice(a, b), text.slice(b)]) stream.write(chunk, { stream: "stdout" });
			stream.end();
			assert.equal(out.join(""), "before [redacted SLACK_BOT_TOKEN] middle [redacted SLACK_BOT_TOKEN]\nafter");
		}
	}
});

test("an omission marker still goes out when its chunk is held back", () => {
	const redactor = createRedactor(new Map([[TOKEN, "SLACK_BOT_TOKEN"]]));
	const out: [string, ShellOutputInfo][] = [];
	const stream = redactingStream(redactor, (chunk, info) => out.push([chunk, info]));
	const skipped = { bytes: 10, lines: 1 } as unknown as NonNullable<ShellOutputInfo["skipped"]>;
	stream.write("held", { stream: "stdout" });
	stream.write("x", { stream: "stdout", skipped });
	stream.end();
	assert.deepEqual(out, [["held", { stream: "stdout" }], ["x", { stream: "stdout", skipped }]]);
});

test("an ntfy URL redacts the bare topic too, and short values are left alone", () => {
	const redactor = redactorFromEnv({ NTFY_URL: "https://ntfy.sh/gaidin-0123456789abcdef", NTFY_TOKEN: "short" });
	assert.equal(
		redactor.redact("https://ntfy.sh/gaidin-0123456789abcdef and gaidin-0123456789abcdef and short"),
		"[redacted NTFY_URL] and [redacted NTFY_TOPIC] and short",
	);
});

test("tools don't see the credentials in their environment, and none reach storage", async (t) => {
	const dir = tempDir(t);
	const saved = process.env.SLACK_BOT_TOKEN;
	process.env.SLACK_BOT_TOKEN = TOKEN;
	t.after(() => {
		if (saved === undefined) delete process.env.SLACK_BOT_TOKEN;
		else process.env.SLACK_BOT_TOKEN = saved;
	});

	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	faux.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall("bash", { command: `echo "env:[$SLACK_BOT_TOKEN]"; cat secret.txt` }),
				fauxToolCall("read", { path: "secret.txt" }),
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage(fauxText("Done.")),
	]);
	const models = createModels();
	models.setProvider(faux.provider);
	const config = configFor({ slack: { botToken: TOKEN, appToken: "xapp-1-test", channelId: "C1", userId: "U1" } });
	const host = await openHost({ config, dataDir: dir, models, model: { provider: "faux", modelId: "faux-1" } });
	writeFileSync(join(dir, "sandbox", "secret.txt"), `token=${TOKEN}\n`);

	const settled = await (await host.root.submit({ type: "input", content: "go" }, context)).wait(context);
	assert.equal(settled.status, "done");
	const view = await host.root.context(context);
	const results = view.messages.filter((m) => m.role === "toolResult").map((m) => JSON.stringify(m.content));
	assert.equal(results.length, 2);
	assert.match(results[0]!, /env:\[\]/);
	assert.match(results[0]!, /token=\[redacted SLACK_BOT_TOKEN\]/);
	assert.match(results[1]!, /token=\[redacted SLACK_BOT_TOKEN\]/);
	await host.harness.close(context);

	for (const file of readdirSync(dir).filter((f) => f.startsWith("gaidin.sqlite"))) {
		assert.ok(!readFileSync(join(dir, file)).includes(TOKEN), `${file} holds the token`);
	}
});
