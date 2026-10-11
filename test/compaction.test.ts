import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { configFor } from "../src/config.ts";
import { context, startHost, workingWindow } from "../src/host.ts";

test("models keep their window for requests, but compaction sees a smaller one", () => {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "big", contextWindow: 1_000_000 }, { id: "small", contextWindow: 50_000 }] });
	const models = createModels();
	models.setProvider(faux.provider);
	const working = workingWindow(models, 100_000);
	assert.equal(working.getModel("faux", "big")?.contextWindow, 100_000);
	assert.equal(working.getModel("faux", "small")?.contextWindow, 50_000);
	assert.equal(working.getModel("faux", "missing"), undefined);
	assert.equal(models.getModel("faux", "big")?.contextWindow, 1_000_000);
});

test("a long conversation is summarised before a request reaches 100,000 tokens", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "gaidin-compaction-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 1_000_000 }] });
	// The summariser and the conversation share the model; each request's size is what it was sent, as faux estimates it.
	const sizes: number[] = [];
	faux.setResponses(Array.from({ length: 40 }, () => (ctx: { messages: readonly { role: string; content?: unknown }[] }) => {
		const text = JSON.stringify(ctx.messages);
		sizes.push(Math.round(text.length / 4));
		return fauxAssistantMessage(fauxText(/summar/i.test(JSON.stringify(ctx.messages.at(-1))) ? "Summary: Brad sent long notes about the homelab." : "ok"));
	}));
	const models = createModels();
	models.setProvider(faux.provider);
	const host = await startHost({ config: configFor({ owner: "Brad" }), dataDir: dir, models, model: { provider: "faux", modelId: "faux-1" }, adapters: { push: { send: async () => true } } });
	t.after(() => host.harness.close(context));

	// Six messages of about 20,000 tokens each: 120,000 in all, which the default window would have let through whole.
	for (let n = 0; n < 6; n++) {
		await (await host.root.submit({ type: "input", content: `note ${n}: ${"the backup on think-2 failed again. ".repeat(2300)}` }, context)).wait(context);
	}
	await host.root.waitForIdle(context);
	const entries = (await host.root.context(context)).messages;
	assert.ok(sizes.length > 6, "no summary was asked for");
	assert.ok(Math.max(...sizes) < 100_000, `a request went over 100,000 tokens: ${sizes.join(", ")}`);
	assert.ok(JSON.stringify(entries).length / 4 < 85_000, "the context wasn't cut down");
});
