import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { context, openHost } from "../src/host.ts";
import { type RunRemote, scrubSecrets, stripAnsi } from "../src/logs.ts";

const LOGS = [
	"2026-10-10T20:00:00Z GET /bookmarks 200",
	"2026-10-10T20:00:01Z login ok password=hunter2 user=brad",
	'2026-10-10T20:00:02Z {"api_key": "abc123def", "Authorization": "Bearer xyz.789"}',
	"2026-10-10T20:00:03Z connecting to postgres://linkding:s3cret@db:5432/linkding",
	"2026-10-10T20:00:04Z token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJicmFkIn0.c2lnbmF0dXJlLWhlcmU",
].join("\n");

/** apps-01 has linkding, infra-01 has uptime-kuma; `down` hosts fail. */
function remote(down: string[] = []) {
	const calls: [string, string][] = [];
	const run: RunRemote = async (host, command) => {
		calls.push([host, command]);
		if (down.includes(host)) throw new Error("ssh: connect to host timed out");
		if (command === "list") return host === "apps-01" ? "linkding\trunning\tUp 10 days (healthy)\tlinkding:1.45.0\n" : "uptime-kuma\trunning\tUp\tkuma:2.4.0\n";
		return `${LOGS}\n`;
	};
	return { calls, run };
}

async function call(run: RunRemote, args: Record<string, string | number>) {
	const dir = mkdtempSync(join(tmpdir(), "gaidin-test-"));
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	faux.setResponses([fauxAssistantMessage(fauxToolCall("container_logs", args), { stopReason: "toolUse" }), fauxAssistantMessage(fauxText("Done."))]);
	const models = createModels();
	models.setProvider(faux.provider);
	const host = await openHost({ dataDir: dir, models, model: { provider: "faux", modelId: "faux-1" }, logs: run, notify: async () => {} });
	try {
		await (await host.root.submit({ type: "input", content: "logs" }, context)).wait(context);
		const result = (await host.root.context(context)).messages.find((m) => m.role === "toolResult") as { content: { text: string }[]; isError?: boolean };
		return { text: result.content.map((c) => c.text).join(""), isError: result.isError === true };
	} finally {
		await host.harness.close(context);
		rmSync(dir, { recursive: true, force: true });
	}
}

test("secrets in log lines are scrubbed, and the rest is kept", () => {
	const scrubbed = scrubSecrets(LOGS);
	for (const secret of ["hunter2", "abc123def", "xyz.789", "s3cret", "eyJhbGciOiJIUzI1NiJ9"]) assert.ok(!scrubbed.includes(secret), secret);
	assert.match(scrubbed, /GET \/bookmarks 200/);
	assert.match(scrubbed, /password=\[scrubbed\] user=brad/);
	assert.match(scrubbed, /postgres:\/\/linkding:\[scrubbed\]@db:5432/);
});

test("terminal color codes are removed", () => {
	assert.equal(stripAnsi("\x1b[36m2026-10-10\x1b[0m [\x1b[38;5;208mAUTH\x1b[0m] ok"), "2026-10-10 [AUTH] ok");
});

test("without a container it lists every host's containers, and says which host it couldn't reach", async () => {
	const { run } = remote(["infra-01"]);
	const { text } = await call(run, {});
	assert.match(text, /apps-01:\n- linkding {2}running {2}Up 10 days \(healthy\)/);
	assert.match(text, /infra-01: couldn't list \(ssh: connect to host timed out\)/);
});

test("a container's logs come from the host that has it, labelled and scrubbed", async () => {
	const { calls, run } = remote();
	const { text } = await call(run, { container: "uptime-kuma", lines: 50, since: "2h" });
	assert.deepEqual(calls.at(-1), ["infra-01", "logs uptime-kuma 50 2h"]);
	assert.match(text, /^Logs of uptime-kuma on infra-01, oldest first\./);
	assert.match(text, /not by Brad/);
	assert.match(text, /GET \/bookmarks 200/);
	assert.doesNotMatch(text, /hunter2/);
});

test("bad input is refused before anything is sent", async () => {
	const { calls, run } = remote();
	assert.match((await call(run, { container: "linkding; id" })).text, /Not a container name/);
	assert.match((await call(run, { container: "nope" })).text, /No container named nope/);
	assert.match((await call(run, { container: "linkding", host: "hermes" })).text, /Unknown host hermes/);
	assert.ok(calls.every(([, command]) => command === "list"));
});

test("without a key there's no container_logs tool", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "gaidin-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const host = await openHost({ dataDir: dir, logs: null, notify: async () => {}, models: createModels(), model: { provider: "faux", modelId: "x" } });
	t.after(() => host.harness.close(context));
	assert.ok(!(await host.root.agent(context)).tools.some((tool) => tool.name === "container_logs"));
});
