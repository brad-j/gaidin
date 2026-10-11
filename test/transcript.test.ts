import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { type AgentEvent, type SnapshotEvent, watchEvents } from "@earendil-works/pi-durable";
import { context, startHost } from "../src/host.ts";
import { applyEvent, newTranscript, type Transcript } from "../web/transcript.ts";

const FIRST = "Let me check.";
const ANSWER = "All three lines came out, one after another, as expected.";

/** A host whose model runs a slow command, then streams its answer. */
async function host(t: TestContext) {
	const dir = mkdtempSync(join(tmpdir(), "gaidin-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }], tokensPerSecond: 30, tokenSize: { min: 2, max: 4 } });
	faux.setResponses([
		fauxAssistantMessage([fauxText(FIRST), fauxToolCall("bash", { command: "for i in 1 2 3; do echo line $i; sleep 0.3; done" })], { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxText(ANSWER)),
	]);
	const models = createModels();
	models.setProvider(faux.provider);
	const h = await startHost({ dataDir: dir, models, model: { provider: "faux", modelId: "faux-1" }, sandbox: "none", adapters: { push: { send: async () => true } } });
	t.after(() => h.harness.close(context));
	return h;
}

/** What the page gets: each event as JSON. */
const overTheWire = <T>(value: T): T => JSON.parse(JSON.stringify(value));

type Recording = { snapshot: SnapshotEvent; batches: AgentEvent[][] };

async function record(h: Awaited<ReturnType<typeof startHost>>): Promise<Recording & { stop: () => Promise<unknown> }> {
	const stream = await watchEvents(h.harness, h.root.id, context);
	const batches: AgentEvent[][] = [];
	stream.start(async (batch) => void batches.push(overTheWire([...batch])));
	return { snapshot: overTheWire(stream.snapshot), batches, stop: () => stream.stop() };
}

async function until(check: () => boolean, timeoutMs = 15_000) {
	const end = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > end) throw new Error("timed out");
		await new Promise((r) => setTimeout(r, 20));
	}
}

/** The transcript as a page would have it after `recording`, and what it showed between batches. */
function replay(recording: Recording) {
	const transcript = newTranscript();
	applyEvent(transcript, recording.snapshot);
	const seen = { partials: [] as string[], tools: [] as { name: string; output: string }[], running: false };
	const look = (now: Transcript) => {
		const text = now.partial?.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
		if (text) seen.partials.push(text);
		for (const slot of now.tools.values()) seen.tools.push({ name: slot.name, output: slot.output });
		if (now.running) seen.running = true;
	};
	look(transcript);
	for (const batch of recording.batches) {
		for (const event of batch) applyEvent(transcript, event);
		look(transcript);
	}
	return { transcript, seen };
}

/** The conversation as a page connecting now would get it. */
async function truth(h: Awaited<ReturnType<typeof startHost>>) {
	const stream = await watchEvents(h.harness, h.root.id, context);
	await stream.stop();
	return overTheWire(stream.snapshot);
}

const ended = (recording: Recording) => recording.batches.flat().some((e) => e.type === "run_end");

test("replaying a run's events gives the conversation as it's stored, showing the answer and the command's output as they came", async (t) => {
	const h = await host(t);
	const recording = await record(h);
	await (await h.root.submit({ type: "input", content: "check the lines" }, context)).wait(context);
	await until(() => ended(recording));
	await recording.stop();

	const { transcript, seen } = replay(recording);
	const stored = await truth(h);
	assert.deepEqual([...transcript.entries.values()], stored.entries);
	assert.equal(transcript.partial, undefined);
	assert.deepEqual([...transcript.tools.keys()], []);
	assert.equal(transcript.running, false);
	assert.deepEqual(transcript.usage, stored.usage);

	// Along the way: the answer as it streamed, and the command while it ran.
	assert.ok(seen.running);
	// Each partial is the start of what was said, and the answer grew while it streamed.
	assert.ok(seen.partials.every((text) => ANSWER.startsWith(text) || FIRST.startsWith(text)), `partials: ${JSON.stringify(seen.partials)}`);
	assert.ok(new Set(seen.partials.filter((text) => ANSWER.startsWith(text))).size >= 2, `partials: ${JSON.stringify(seen.partials)}`);
	const outputs = seen.tools.filter((tool) => tool.name === "bash").map((tool) => tool.output);
	assert.ok(outputs.includes("line 1\nline 2\nline 3\n"), `outputs: ${JSON.stringify(outputs)}`);
	assert.ok(outputs.every((output) => "line 1\nline 2\nline 3\n".startsWith(output)), `outputs: ${JSON.stringify(outputs)}`);
});

test("a page that connects mid-run starts from the snapshot and ends the same", async (t) => {
	const h = await host(t);
	const first = await record(h);
	await h.root.submit({ type: "input", content: "check the lines" }, context);
	// Connects while the command runs, as a page opened then would.
	await until(() => first.batches.flat().some((e) => e.type === "tool_execution_update"));
	const late = await record(h);
	await until(() => ended(late));
	await Promise.all([first.stop(), late.stop()]);

	const { transcript } = replay(late);
	assert.ok(late.snapshot.tools.some((slot) => slot.name === "bash" && slot.status === "running"), "the snapshot was taken while the command ran");
	const stored = await truth(h);
	assert.deepEqual([...transcript.entries.values()], stored.entries);
	assert.equal(transcript.partial, undefined);
	assert.equal(transcript.running, false);
});
