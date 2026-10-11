import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { context, openHost } from "../src/host.ts";
import { findBwrap } from "../src/sandbox.ts";
import { readWorkspaces, type Remote } from "../src/workspaces.ts";

const HELPER = resolve(import.meta.dirname, "../deploy/workspace/gaidin-workspace.py");
const bwrap = findBwrap();

/** A machine: a home with the helper's config, and a project root with a git repo in it. */
function machine(t: TestContext) {
	const dir = mkdtempSync(join(tmpdir(), "gaidin-ws-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const home = join(dir, "home");
	const root = join(dir, "projects");
	mkdirSync(join(home, ".config", "gaidin-workspace"), { recursive: true });
	mkdirSync(join(root, "app"), { recursive: true });
	writeFileSync(join(home, ".config", "gaidin-workspace", "config.json"), JSON.stringify({ roots: [root] }));
	writeFileSync(join(root, "app", "README.md"), "# app\nline two\n");
	writeFileSync(join(root, "app", "secret.pem"), "PRIVATE");
	spawnSync("git", ["init", "-q"], { cwd: join(root, "app") });
	return { home, root };
}

/** What ssh does, without ssh: runs the helper with the operation in SSH_ORIGINAL_COMMAND. */
function localRemote(home: string): Remote {
	return (_workspace, operation, request, { signal, onOutput }) =>
		new Promise((resolvePromise, reject) => {
			const child = spawn("python3", ["-I", HELPER], { env: { HOME: home, PATH: process.env.PATH, SSH_ORIGINAL_COMMAND: operation } });
			let output = "";
			child.stdout.setEncoding("utf8").on("data", (text: string) => {
				output += text;
				onOutput?.(text);
			});
			child.stdin.write(`${JSON.stringify(request)}\n`);
			if (operation !== "run") child.stdin.end();
			signal?.addEventListener("abort", () => child.stdin.end(), { once: true });
			child.once("close", (code) => (signal?.aborted ? reject(new Error("stopped")) : resolvePromise({ code: code ?? 1, output })));
		});
}

async function host(t: TestContext, home: string, steps: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0]) {
	const dir = mkdtempSync(join(tmpdir(), "gaidin-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	faux.setResponses(steps);
	const models = createModels();
	models.setProvider(faux.provider);
	const h = await openHost({
		dataDir: dir,
		models,
		model: { provider: "faux", modelId: "faux-1" },
		notify: async () => {},
		workspaces: { list: [{ name: "desk", target: "me@desk" }], remote: localRemote(home) },
	});
	t.after(() => h.harness.close(context));
	return h;
}

async function results(h: Awaited<ReturnType<typeof openHost>>) {
	return (await h.root.context(context)).messages.filter((m) => m.role === "toolResult").map((m) => JSON.stringify(m.content));
}

const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage(fauxToolCall(name, args as never), { stopReason: "toolUse" });
const done = fauxAssistantMessage(fauxText("Done."));

test("the workspaces file lists name and target per line", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "gaidin-keys-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	assert.deepEqual(readWorkspaces(dir), []);
	writeFileSync(join(dir, "workspaces"), "# machines\negwene brad@192.168.1.36\n\nlaptop  me@laptop.lan\n");
	assert.deepEqual(readWorkspaces(dir), [{ name: "egwene", target: "brad@192.168.1.36" }, { name: "laptop", target: "me@laptop.lan" }]);
	writeFileSync(join(dir, "workspaces"), "Bad Name me@x\n");
	assert.throws(() => readWorkspaces(dir), /Bad line/);
});

test("read, write and edit work inside the roots and refuse secrets, .git and the outside", async (t) => {
	const { home, root } = machine(t);
	const h = await host(t, home, [
		call("workspace_read", { workspace: "desk", path: "app/README.md" }),
		done,
		call("workspace_write", { workspace: "desk", path: "app/notes/todo.md", content: "- one\n" }),
		done,
		call("workspace_edit", { workspace: "desk", path: "app/notes/todo.md", edits: [{ oldText: "one", newText: "two" }] }),
		done,
		call("workspace_read", { workspace: "desk", path: "app/secret.pem" }),
		done,
		call("workspace_write", { workspace: "desk", path: "app/.git/config", content: "x" }),
		done,
		call("workspace_read", { workspace: "desk", path: "/etc/hostname" }),
		done,
		call("workspace_read", { workspace: "elsewhere", path: "x" }),
		done,
	]);
	h.approvals.onChange((r) => void (r.status === "pending" && h.approvals.decide(r.id, "once", "test")));
	for (let i = 0; i < 7; i += 1) await (await h.root.submit({ type: "input", content: `step ${i}` }, context)).wait(context);
	const out = await results(h);
	assert.match(out[0]!, /README\.md \(lines 1-2 of 2\)\\n# app\\nline two/);
	assert.match(out[1]!, /Created .*todo\.md \(6 bytes\)/);
	assert.match(out[2]!, /Edited .*todo\.md \(1 changes\)/);
	assert.equal(readFileSync(join(root, "app", "notes", "todo.md"), "utf8"), "- two\n");
	assert.match(out[3]!, /looks like a secret file/);
	assert.match(out[4]!, /inside \.git/);
	assert.match(out[5]!, /outside/);
	assert.match(out[6]!, /No workspace elsewhere; one of desk/);
});

test("run executes in the roots, with secrets hidden and the exit code reported", { skip: bwrap === undefined && "bwrap isn't installed" }, async (t) => {
	const { home } = machine(t);
	const h = await host(t, home, [
		call("workspace_run", { workspace: "desk", cwd: "app", command: "cat README.md; wc -c < secret.pem; touch made.txt; git status --short; exit 4" }),
		done,
	]);
	h.approvals.onChange((r) => void (r.status === "pending" && h.approvals.decide(r.id, "once", "test")));
	await (await h.root.submit({ type: "input", content: "go" }, context)).wait(context);
	const [out] = await results(h);
	assert.match(out!, /# app/);
	assert.doesNotMatch(out!, /PRIVATE/, "the secret file wasn't masked");
	assert.match(out!, /secret\.pem: Permission denied/);
	assert.match(out!, /\?\? made\.txt/);
	assert.match(out!, /Exit code 4/);
});

test("every workspace call asks; an hour's grant covers that conversation only", async (t) => {
	const { home } = machine(t);
	const read = call("workspace_read", { workspace: "desk", path: "app/README.md" });
	const h = await host(t, home, [read, done, read, done, read, done]);
	const asked: string[] = [];
	h.approvals.onChange((r) => {
		if (r.status !== "pending") return;
		asked.push(r.summary);
		void h.approvals.decide(r.id, asked.length === 1 ? "always" : "once", "test");
	});
	await (await h.root.submit({ type: "input", content: "one" }, context)).wait(context);
	assert.deepEqual(asked, ["read app/README.md on desk"]);
	await (await h.root.submit({ type: "input", content: "two" }, context)).wait(context);
	assert.equal(asked.length, 1, "asked again in the same conversation within the hour");

	const answer = (await h.root.entries({}, 1, undefined, context)).items[0]!;
	const fork = await h.root.fork(answer.id, { ownership: { kind: "ownerless" } }, context);
	await (await fork.submit({ type: "input", content: "three" }, context)).wait(context);
	assert.equal(asked.length, 2, "a different conversation used the grant");
	const grants = (await h.approvals.state()).grants ?? [];
	assert.equal(grants.length, 1);
	assert.ok(grants[0]!.until > Date.now() + 59 * 60_000);
});

test("a call to a workspace that isn't in the settings isn't put to Brad", async (t) => {
	const { home } = machine(t);
	const h = await host(t, home, [call("workspace_run", { workspace: "laptop", command: "ls" }), done]);
	const asked: string[] = [];
	h.approvals.onChange((r) => void (r.status === "pending" && asked.push(r.summary)));
	await (await h.root.submit({ type: "input", content: "list it" }, context)).wait(context);
	assert.deepEqual(asked, []);
	assert.match((await results(h))[0]!, /No workspace laptop; one of desk/);
});

test("without workspaces there are no workspace tools", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "gaidin-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const h = await openHost({ dataDir: dir, notify: async () => {}, models: createModels(), model: { provider: "faux", modelId: "x" }, workspaces: { list: [], remote: undefined } });
	t.after(() => h.harness.close(context));
	assert.ok(!(await h.root.agent(context)).tools.some((tool) => tool.name.startsWith("workspace_")));
	assert.ok(!existsSync(join(dir, "nothing")));
});
