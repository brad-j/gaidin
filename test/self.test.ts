import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { blockedRanges } from "../src/fetch.ts";
import { configFor } from "../src/config.ts";
import { Approvals } from "../src/approvals.ts";
import { context, openHost } from "../src/host.ts";
import { Jobs } from "../src/jobs.ts";
import { findBwrap } from "../src/sandbox.ts";

const skip = findBwrap() === undefined ? "needs bubblewrap" : false;

const INDEX = `import { existsSync } from "node:fs";
import type { Tool } from "gaidin";

export const add = {
	name: "add_numbers",
	description: "Add two numbers.",
	parameters: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
	execute: async (args: { a: number; b: number }) => String(args.a + args.b),
} satisfies Tool;

export const pageLength = {
	name: "page_length",
	description: "The length of a page's text.",
	parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
	execute: async (args: { url: string }, api: Parameters<Tool["execute"]>[1]) => String((await api.fetch(args.url)).text.length),
} satisfies Tool;

export const canRead: Tool<{ path: string }> = {
	name: "can_read",
	description: "Whether a path exists.",
	parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
	execute: async (args) => String(existsSync(args.path)),
};

export const tools = [add, pageLength, canRead];
`;

const TEST = `import assert from "node:assert/strict";
import test from "node:test";
import { add, canRead, pageLength } from "./index.ts";

test("adds", async () => assert.equal(await add.execute({ a: 2, b: 3 }), "5"));
test("measures a page", async () => {
	const fetch = async (url: string) => ({ url, status: 200, contentType: "text/plain", text: "abc" });
	assert.equal(await pageLength.execute({ url: "https://x.test/" }, { fetch }), "3");
});
test("checks a path", async () => {
	const fetch = async () => assert.fail("no fetch");
	assert.equal(await canRead.execute({ path: "/nowhere" }, { fetch }), "false");
});
`;

type Step = (ctx: Parameters<FauxResponseFactory>[0]) => ReturnType<typeof fauxAssistantMessage>;

/** The main conversation's steps in order; the reviewer answers `verdict`. */
async function start(t: TestContext, steps: Step[], verdict = "OK", dir = mkdtempSync(join(tmpdir(), "gaidin-self-"))) {
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	// /hop redirects to b.test on the same server.
	const server = createServer((req, res) => {
		if (req.url !== "/hop") return res.end("page text");
		res.writeHead(302, { Location: `http://b.test:${req.headers.host?.split(":")[1]}/` });
		res.end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise((resolve) => server.close(resolve)));
	const step: FauxResponseFactory = (ctx) => {
		// The reviewer's conversation starts with the diff.
		const first = ctx.messages.find((m) => m.role === "user");
		if (JSON.stringify(first?.content).includes("diff --git")) return fauxAssistantMessage(fauxText(verdict));
		return steps.shift()?.(ctx) ?? fauxAssistantMessage(fauxText("Done."));
	};
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	faux.setResponses(Array.from({ length: 30 }, () => step));
	const models = createModels();
	models.setProvider(faux.provider);
	const fetch = { blocked: blockedRanges({ allowLoopback: true }), resolve: async () => [{ address: "127.0.0.1", family: 4 }] };
	const host = await openHost({ config: configFor({ owner: "Brad" }), dataDir: dir, models, model: { provider: "faux", modelId: "faux-1" }, fetch, notify: async () => {} });
	t.after(() => host.harness.close(context));
	return { host, dir, port: (server.address() as AddressInfo).port };
}

const call = (name: string, args: Parameters<typeof fauxToolCall>[1]): Step => () => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

function draft(dir: string, files: Record<string, string>) {
	const at = join(dir, "sandbox", "extensions", "kit");
	mkdirSync(at, { recursive: true });
	for (const [name, text] of Object.entries(files)) writeFileSync(join(at, name), text);
}

/** The text of every tool result in the root conversation. */
async function results(host: Awaited<ReturnType<typeof openHost>>) {
	return (await host.root.context(context)).messages.flatMap((m) => (m.role === "toolResult" ? [m.content.map((c) => (c.type === "text" ? c.text : "")).join("")] : []));
}

/** Runs `content`, approving every request as it comes, and returns what was asked. */
async function runApproving(host: Awaited<ReturnType<typeof openHost>>, content: string) {
	const asked: string[] = [];
	host.approvals.onChange((request) => {
		if (request.status !== "pending") return;
		asked.push(`${request.tool}: ${request.summary}`);
		void host.approvals.decide(request.id, "once", "test");
	});
	await (await host.root.submit({ type: "input", content }, context)).wait(context);
	return asked;
}

test("a checked draft is loaded after approval, runs in its box, fetches through the server, and comes back after a restart", { skip, timeout: 120_000 }, async (t) => {
	const steps = [call("load_extension", { name: "kit" }), call("add_numbers", { a: 2, b: 3 })];
	const { host, dir, port } = await start(t, steps);
	draft(dir, { "index.ts": INDEX, "test.ts": TEST });
	steps.push(call("page_length", { url: `http://a.test:${port}/` }), call("page_length", { url: `http://a.test:${port}/hop` }), call("can_read", { path: join(dir, "gaidin.sqlite") }));

	const asked = await runApproving(host, "load the kit");
	assert.match(asked[0]!, /^load_extension: add extension kit with add_numbers, page_length, can_read \(\+\d+ −0 lines\)$/);
	assert.match(asked[1]!, /^page_length: fetch http:\/\/a\.test:\d+\/$/);
	// A redirect to another host asks for that host too.
	assert.match(asked[2]!, /^page_length: fetch http:\/\/a\.test:\d+\/hop$/);
	assert.match(asked[3]!, /^page_length: fetch http:\/\/b\.test:\d+\/$/);
	const [loaded, ...ran] = await results(host);
	assert.match(loaded!, /^Loaded kit\./);
	assert.deepEqual(ran, ["5", "9", "9", "false"]);
	const request = Object.values((await host.approvals.state()).requests).find((r) => r.tool === "load_extension");
	assert.match(request!.detail!, /\+export const tools = \[add, pageLength, canRead\];/);
	assert.ok(host.switchable().some((tool) => tool.name === "add_numbers"));
	await host.harness.close(context);

	const again = await start(t, [call("add_numbers", { a: 1, b: 1 }), call("remove_extension", { name: "kit" })], "OK", dir);
	const removing = await runApproving(again.host, "add and remove");
	assert.deepEqual((await results(again.host)).slice(-2), ["2", "Removed kit."]);
	assert.deepEqual(removing, ["remove_extension: remove extension kit and its tools add_numbers, page_length, can_read"]);
	assert.ok(!again.host.switchable().some((tool) => tool.name === "add_numbers"));
});

test("a draft that fails the checks never reaches Brad", { skip, timeout: 120_000 }, async (t) => {
	const { host, dir } = await start(t, [call("load_extension", { name: "kit" })]);
	const sloppy = INDEX.replace('import type { Tool } from "gaidin";', 'import type { Tool } from "gaidin";\nawait import(`left-pad`);\n// eslint-disable-next-line\nconst unused = 1;\nconst raw = JSON.parse("{}") as unknown as { a: number };');
	draft(dir, { "index.ts": sloppy, "test.ts": TEST });

	assert.deepEqual(await runApproving(host, "load the kit"), []);
	const [failed] = await results(host);
	assert.match(failed!, /The checks failed, so Brad wasn't asked/);
	assert.match(failed!, /imports "left-pad"/);
	assert.match(failed!, /turns a check off with eslint-disable/);
	assert.match(failed!, /The type check failed:[\s\S]*'unused' is declared but its value is never read/);
	assert.match(failed!, /Lint failed:[\s\S]*no-chained-type-assertions/);
});

test("the reviewer's objections go back to gaidin, and with keep they go to Brad with the diff", { skip, timeout: 120_000 }, async (t) => {
	const steps = [call("load_extension", { name: "kit" }), call("load_extension", { name: "kit", keep: "can_read is what Brad asked for" })];
	const { host, dir } = await start(t, steps, "- index.ts: can_read isn't needed");
	draft(dir, { "index.ts": INDEX, "test.ts": TEST });

	const asked = await runApproving(host, "load the kit");
	const [objected, loaded] = await results(host);
	assert.match(objected!, /^The reviewer objects:\n- index\.ts: can_read isn't needed/);
	assert.equal(asked.length, 1);
	const request = Object.values((await host.approvals.state()).requests)[0]!;
	assert.match(request.detail!, /The reviewer objected:\n- index\.ts: can_read isn't needed\n\ngaidin kept it because: can_read is what Brad asked for$/);
	assert.match(loaded!, /^Loaded kit\./);
});

const GATE_INDEX = `import type { Tool } from "gaidin";

export const pageGate = {
	name: "page_gate",
	description: "Wake a job when a page has text.",
	parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
	execute: async (args: { url: string }, api: Parameters<Tool["execute"]>[1]) => {
		const page = await api.fetch(args.url);
		return JSON.stringify({ wake: page.text.length > 0, data: page.text, topic: page.text });
	},
} satisfies Tool;

export const tools = [pageGate];
`;

const GATE_TEST = `import assert from "node:assert/strict";
import test from "node:test";
import { pageGate } from "./index.ts";

test("wakes when the page has text", async () => {
	const fetch = async (url: string) => ({ url, status: 200, contentType: "text/plain", text: "news" });
	assert.equal(await pageGate.execute({ url: "https://x.test/" }, { fetch }), '{"wake":true,"data":"news","topic":"news"}');
});
`;

async function until(check: () => Promise<boolean>, timeoutMs = 20_000) {
	const end = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() > end) throw new Error("timed out");
		await new Promise((r) => setTimeout(r, 50));
	}
}

test("a self-written tool is a gate, and its fetches reach only hosts allowed for good", { skip, timeout: 120_000 }, async (t) => {
	const steps = [call("load_extension", { name: "kit" })];
	const { host, dir, port } = await start(t, steps);
	draft(dir, { "index.ts": GATE_INDEX, "test.ts": GATE_TEST });
	await runApproving(host, "load the gate");
	assert.match((await results(host))[0]!, /^Loaded kit\./);

	const url = `http://a.test:${port}/`;
	const addJob = (title: string, page = url) =>
		host.root.commit(async (tx) => {
			const firstAt = Date.now() + 200;
			const id = await tx.createTask(host.jobs.JobTask, { title, firstAt }, { ownership: { kind: "conversation" }, background: true });
			const fields = { instruction: "Read the page.", schedule: { kind: "every" as const, minutes: 0.01, from: firstAt }, mode: "report" as const, gate: { name: "page_gate", args: { url: page } } };
			(await tx.doc(Jobs)).items.push({ taskId: id as number, title, ...fields, createdAt: Date.now(), nextAt: firstAt, runs: 0 });
			return id as number;
		}, context);
	const job = async (id: number) => (await host.harness.snapshot(Jobs, context))!.items.find((j) => j.taskId === id)!;
	const cancel = (id: number) =>
		host.root.commit(async (tx) => {
			const doc = await tx.doc(Jobs);
			doc.items = doc.items.filter((j) => j.taskId !== id);
		}, context);

	// a.test isn't allowed for good, and a gate can't ask, so the check fails.
	const blocked = await addJob("Blocked");
	await until(async () => (await job(blocked)).failures === 1);
	assert.equal((await host.approvals.pending()).length, 0);
	await cancel(blocked);

	await host.root.commit(async (tx) => void (await tx.doc(Approvals)).fetchHosts.push("a.test"), context);
	steps.push((ctx) => fauxAssistantMessage(fauxText(/\[gate findings\][^]*page text/.test(JSON.stringify(ctx.messages)) ? "The page says page text." : "no findings")));
	const open = await addJob("Open");
	await until(async () => (await job(open)).recent?.length === 1);
	assert.equal((await job(open)).recent![0]!.text, "The page says page text.");
	await until(async () => ((await job(open)).skipped ?? 0) >= 1);
	await cancel(open);

	// A redirect from a.test to b.test, which isn't allowed for good, fails the check too.
	const redirected = await addJob("Redirected", `${url}hop`);
	await until(async () => (await job(redirected)).failures === 1);
	await cancel(redirected);
});
