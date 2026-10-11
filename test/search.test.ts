import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { UNTRUSTED_TOOLS } from "../src/approvals.ts";
import { configFor, loadConfig, maskedConfig, secretsOf } from "../src/config.ts";
import { context, openHost } from "../src/host.ts";
import { type SearchBackend, type SearchQuery, tavily } from "../src/search.ts";

const KEY = "tvly-dev-0123456789abcdef";

async function host(t: TestContext, search: SearchBackend | undefined, args: Record<string, unknown>) {
	const dir = mkdtempSync(join(tmpdir(), "gaidin-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	faux.setResponses([fauxAssistantMessage(fauxToolCall("web_search", args as never), { stopReason: "toolUse" }), fauxAssistantMessage(fauxText("ok"))]);
	const models = createModels();
	models.setProvider(faux.provider);
	const h = await openHost({ config: configFor({ owner: "Brad" }), dataDir: dir, models, model: { provider: "faux", modelId: "faux-1" }, notify: async () => {}, ...(search === undefined ? {} : { search }) });
	t.after(() => h.harness.close(context));
	return h;
}

test("Tavily is called with the key and the query, and its results are mapped", async () => {
	const sent: { url: string; init: RequestInit }[] = [];
	const fake = (async (url: string, init: RequestInit) => {
		sent.push({ url, init });
		return new Response(JSON.stringify({ results: [{ title: "Bubblewrap", url: "https://github.com/containers/bubblewrap", content: "Low-level\n unprivileged   sandboxing", published_date: "2026-09-01" }, { title: "no url" }] }), { status: 200 });
	}) as typeof fetch;
	const results = await tavily(KEY, fake)({ query: "bubblewrap", maxResults: 3, topic: "news", timeRange: "week" });
	assert.deepEqual(results, [{ title: "Bubblewrap", url: "https://github.com/containers/bubblewrap", snippet: "Low-level unprivileged sandboxing", published: "2026-09-01" }]);
	assert.equal(sent[0]!.url, "https://api.tavily.com/search");
	assert.equal((sent[0]!.init.headers as Record<string, string>).Authorization, `Bearer ${KEY}`);
	assert.deepEqual(JSON.parse(String(sent[0]!.init.body)), { query: "bubblewrap", max_results: 3, topic: "news", search_depth: "basic", time_range: "week" });

	const refused = (async () => new Response("bad key", { status: 401 })) as unknown as typeof fetch;
	await assert.rejects(tavily(KEY, refused)({ query: "x", maxResults: 1, topic: "general" }), /the API key was refused/);
});

test("the agent's web_search returns labelled results", async (t) => {
	const queries: SearchQuery[] = [];
	const h = await host(t, async (q) => {
		queries.push(q);
		return [{ title: "Pi Durable", url: "https://example.com/pi", snippet: "A durable agent harness." }];
	}, { query: " pi durable ", maxResults: 2 });
	await (await h.root.submit({ type: "input", content: "look it up" }, context)).wait(context);
	assert.deepEqual(queries, [{ query: "pi durable", maxResults: 2, topic: "general" }]);
	const result = JSON.stringify((await h.root.context(context)).messages.find((m) => m.role === "toolResult"));
	assert.match(result, /Search results for \\"pi durable\\"/);
	assert.match(result, /not from Brad/);
	assert.match(result, /1\. Pi Durable\\n   https:\/\/example\.com\/pi/);
	assert.ok(UNTRUSTED_TOOLS.has("web_search"));
	assert.ok(h.switchable.some((tool) => tool.name === "web_search"));
});

test("without a search backend there's no web_search", async (t) => {
	const h = await host(t, undefined, {});
	assert.ok(!(await h.root.agent(context)).tools.some((tool) => tool.name === "web_search"));
});

test("search settings are checked, and the key is a secret", () => {
	const { config, errors } = loadConfig({ env: { TAVILY_API_KEY: KEY }, search: false });
	assert.deepEqual(errors.filter((e) => /search/.test(e)), []);
	assert.deepEqual(config.search, { provider: "tavily", apiKey: KEY });
	assert.equal(secretsOf(config).TAVILY_API_KEY, KEY);
	assert.ok(!JSON.stringify(maskedConfig(config)).includes(KEY));
	assert.ok(loadConfig({ env: { TAVILY_API_KEY: "sk-wrong" }, search: false }).errors.some((e) => /tvly-/.test(e)));
});
