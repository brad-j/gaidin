import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { context, openHost } from "../src/host.ts";
import { createRedactor } from "../src/redact.ts";
import { findBwrap, SandboxEnv } from "../src/sandbox.ts";

const bwrap = findBwrap();
const noRedaction = createRedactor(new Map());

/** A data directory with a sandbox in it, a secret next to it, and a directory outside. */
function layout(t: TestContext) {
	const dir = mkdtempSync(join(tmpdir(), "gaidin-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const root = join(dir, "sandbox");
	mkdirSync(root);
	mkdirSync(join(dir, "outside"));
	writeFileSync(join(dir, "gaidin.sqlite"), "the transcript");
	writeFileSync(join(root, "mine.txt"), "mine");
	return { dir, root };
}

async function run(env: SandboxEnv, command: string) {
	let output = "";
	const result = await env.exec(command, { onOutput: (text) => (output += text) }, context);
	return { output, exitCode: result.ok ? result.value.exitCode : -1, error: result.ok ? undefined : result.error.message };
}

test("file tools stay inside the sandbox, through .., absolute paths and symlinks", async (t) => {
	const { dir, root } = layout(t);
	symlinkSync(join(dir, "gaidin.sqlite"), join(root, "link"));
	symlinkSync(join(dir, "outside"), join(root, "out"));
	const env = new SandboxEnv({ root, redactor: noRedaction, bwrap: undefined });

	const denied = async (result: Promise<{ ok: boolean; error?: { code: string } }>) => {
		const r = await result;
		assert.equal(r.ok, false);
		assert.equal(r.error?.code, "permission_denied");
	};
	await denied(env.readTextFile("../gaidin.sqlite", context));
	await denied(env.readTextFile(join(dir, "gaidin.sqlite"), context));
	await denied(env.readTextFile("link", context));
	await denied(env.readTextFile("/proc/self/environ", context));
	await denied(env.writeFile("link", "overwritten", context));
	await denied(env.writeFile("out/new.txt", "escaped", context));
	await denied(env.writeFile("out/deeper/new.txt", "escaped", context));
	await denied(env.renameFile("mine.txt", "../moved.txt", context));
	await denied(env.listDir("..", context));
	await denied(env.exists("../gaidin.sqlite", context));
	assert.equal(readFileSync(join(dir, "gaidin.sqlite"), "utf8"), "the transcript");
	assert.equal(existsSync(join(dir, "outside", "new.txt")), false);

	const read = await env.readTextFile("mine.txt", context);
	assert.ok(read.ok && read.value === "mine");
	assert.ok((await env.writeFile("notes/today.txt", "hi", context)).ok);
	assert.equal(readFileSync(join(root, "notes", "today.txt"), "utf8"), "hi");
	const temp = await env.createTempFile({ prefix: "pi-output-" }, context);
	assert.ok(temp.ok && temp.value.startsWith(join(env.root, ".tmp")));

	const outside = await env.exec("true", { cwd: dir }, context);
	assert.equal(outside.ok, false);
	assert.throws(() => new SandboxEnv({ root, cwd: dir, redactor: noRedaction, bwrap: undefined }), /outside the sandbox/);
});

test("shell commands see only the sandbox, their own processes and no network", { skip: bwrap === undefined && "bwrap isn't installed" }, async (t) => {
	const { dir, root } = layout(t);
	const server = createServer((_req, res) => res.end("reached"));
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise((resolve) => server.close(resolve)));
	const port = (server.address() as AddressInfo).port;
	const env = new SandboxEnv({ root, redactor: noRedaction, bwrap });

	const inside = await run(env, "cat mine.txt; echo; echo made > made.txt; pwd; echo home=$HOME");
	assert.equal(inside.exitCode, 0, inside.output + (inside.error ?? ""));
	assert.match(inside.output, /^mine\n/);
	assert.match(inside.output, new RegExp(`^${env.root}$`, "m"));
	assert.equal(readFileSync(join(root, "made.txt"), "utf8"), "made\n");

	const files = await run(env, `cat ${join(dir, "gaidin.sqlite")} 2>&1; ls ${dir}`);
	assert.doesNotMatch(files.output, /the transcript/);
	assert.doesNotMatch(files.output, /outside/);

	const procs = await run(env, `test -e /proc/${process.pid}/environ && echo visible || echo hidden`);
	assert.match(procs.output, /hidden/);

	const net = await run(env, `(exec 3<>/dev/tcp/127.0.0.1/${port} && echo connected) 2>/dev/null || echo blocked`);
	assert.match(net.output, /blocked/);

	// Background processes end with the command.
	await run(env, "(sleep 2; echo late > late.txt) &");
	await new Promise((r) => setTimeout(r, 2500));
	assert.equal(existsSync(join(root, "late.txt")), false);
});

test("the agent's bash runs in the sandbox", { skip: bwrap === undefined && "bwrap isn't installed" }, async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "gaidin-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("bash", { command: "touch made.txt; ls -a ..; head -c 16 ../gaidin.sqlite || echo no-database" }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxText("Done.")),
	]);
	const models = createModels();
	models.setProvider(faux.provider);
	const host = await openHost({ dataDir: dir, models, model: { provider: "faux", modelId: "faux-1" }, notify: async () => {} });
	t.after(() => host.harness.close(context));

	const settled = await (await host.root.submit({ type: "input", content: "go" }, context)).wait(context);
	assert.equal(settled.status, "done");
	const result = JSON.stringify((await host.root.context(context)).messages.find((m) => m.role === "toolResult"));
	assert.match(result, /no-database/);
	assert.doesNotMatch(result, /SQLite format/);
	assert.ok(existsSync(join(dir, "sandbox", "made.txt")));
});

test("the server refuses to start without bwrap unless told to", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "gaidin-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const path = process.env.PATH;
	process.env.PATH = "/nonexistent";
	t.after(() => {
		process.env.PATH = path;
	});
	await assert.rejects(openHost({ dataDir: dir, notify: async () => {} }), /bwrap isn't on PATH/);
});
