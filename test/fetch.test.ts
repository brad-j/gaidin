import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { gzipSync } from "node:zlib";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { blockedRanges, fetchPublic, type FetchOptions, htmlToText, render } from "../src/fetch.ts";
import { context, openHost } from "../src/host.ts";

const PAGE = `<html><head><title>Fish &amp; Chips</title><script>alert("x")</script></head>
<body><nav>Home | About</nav><main><h1>Recipe</h1><p>Batter &mdash; light.</p>
<ul><li>Cod</li><li>Potatoes</li></ul><p>See <a href="/more">the guide</a>.</p>${"<p>filler</p>".repeat(60)}</main>
<footer>© someone</footer></body></html>`;

/** A server on loopback reached as public.test, with loopback allowed; other names point at private ranges. */
async function setup(t: TestContext): Promise<{ base: string; options: FetchOptions }> {
	const server = createServer((req, res) => {
		switch (req.url) {
			case "/page":
				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
				return res.end(PAGE);
			case "/gzip":
				res.writeHead(200, { "Content-Type": "text/plain", "Content-Encoding": "gzip" });
				return res.end(gzipSync("compressed hello"));
			case "/to-lan":
				res.writeHead(302, { Location: "http://lan.test/admin" });
				return res.end();
			case "/to-page":
				res.writeHead(301, { Location: "/page" });
				return res.end();
			case "/big":
				res.writeHead(200, { "Content-Type": "text/plain" });
				return res.end("x".repeat(50_000));
			case "/image":
				res.writeHead(200, { "Content-Type": "image/png" });
				return res.end(Buffer.alloc(100));
			default:
				res.writeHead(404, { "Content-Type": "text/plain" });
				return res.end("not here");
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise((resolve) => server.close(resolve)));
	const names: Record<string, string[]> = {
		"public.test": ["127.0.0.1"],
		"lan.test": ["192.168.3.177"],
		"tailnet.test": ["100.79.108.50"],
		"mixed.test": ["127.0.0.1", "10.0.0.5"],
		"ula.test": ["fd7a:115c:a1e0::1"],
	};
	const options: FetchOptions = {
		blocked: blockedRanges({ allowLoopback: true }),
		resolve: async (host) => (names[host] ?? []).map((address) => ({ address, family: address.includes(":") ? 6 : 4 })),
		maxBytes: 10_000,
	};
	return { base: `http://public.test:${(server.address() as AddressInfo).port}`, options };
}

test("private, LAN, tailnet and loopback addresses are refused, by name, literal or redirect", async (t) => {
	const { base, options } = await setup(t);
	const port = new URL(base).port;
	const refused = (url: string, pattern: RegExp, opts = options) => assert.rejects(fetchPublic(url, opts), pattern);
	await refused(`http://lan.test:${port}/`, /192\.168\.3\.177, a private or reserved address/);
	await refused(`http://tailnet.test:${port}/`, /100\.79\.108\.50/);
	await refused(`http://mixed.test:${port}/`, /10\.0\.0\.5/);
	await refused(`http://ula.test:${port}/`, /fd7a/);
	await refused("http://10.0.0.1/", /private or reserved/);
	await refused("http://[::ffff:192.168.1.1]/", /private or reserved/);
	await refused(`${base}/to-lan`, /lan\.test resolves to 192\.168\.3\.177/);
	await refused("file:///etc/passwd", /Only http and https/);
	await refused(`http://user:pass@public.test:${port}/`, /credentials/);
	// Without the test's exception, loopback is refused too.
	await refused(`http://127.0.0.1:${port}/page`, /private or reserved/, { ...options, blocked: blockedRanges() });
});

test("pages come back as labelled, readable text", async (t) => {
	const { base, options } = await setup(t);
	const fetched = await fetchPublic(`${base}/to-page`, options);
	assert.equal(fetched.url, `${base}/page`);
	const text = render(fetched, 20_000);
	assert.match(text, /^Fetched http:\/\/public\.test:\d+\/page \(HTTP 200, text\/html\)\./);
	assert.match(text, /not from Brad/);
	assert.match(text, /# Fish & Chips/);
	assert.match(text, /# Recipe\n\nBatter - light\./);
	assert.match(text, /- Cod\n- Potatoes/);
	assert.match(text, new RegExp(`See the guide \\(${base}/more\\)\\.`));
	assert.doesNotMatch(text, /alert|Home \| About|someone/);

	assert.match(render(await fetchPublic(`${base}/gzip`, options), 20_000), /compressed hello/);
	const big = await fetchPublic(`${base}/big`, options);
	assert.equal(big.truncated, true);
	assert.equal(big.body.length, 10_000);
	assert.match(render(big, 5_000), /stopped at the size limit; cut to the first 5000 characters/);
	assert.match(render(await fetchPublic(`${base}/image`, options), 20_000), /is image\/png \(100 bytes\), not text/);
});

test("htmlToText keeps the whole page when it marks no main content", () => {
	const text = htmlToText("<body><nav>menu</nav><p>Only &#x26; this&#33;</p></body>", "https://example.com/");
	assert.equal(text, "Only & this!");
});

test("the agent can call fetch_url, and an error status is an error result", async (t) => {
	const { base, options } = await setup(t);
	const dir = mkdtempSync(join(tmpdir(), "gaidin-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("fetch_url", { url: `${base}/page` }), fauxToolCall("fetch_url", { url: `${base}/missing` })], { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxText("Read it.")),
	]);
	const models = createModels();
	models.setProvider(faux.provider);
	const host = await openHost({ dataDir: dir, models, model: { provider: "faux", modelId: "faux-1" }, fetch: options, notify: async () => {} });
	t.after(() => host.harness.close(context));
	// New hosts need approval (test/approvals.test.ts); say yes to each.
	host.approvals.onChange((r) => void (r.status === "pending" && host.approvals.decide(r.id, "once", "test")));
	assert.equal((await (await host.root.submit({ type: "input", content: "read the recipe" }, context)).wait(context)).status, "done");
	const results = (await host.root.context(context)).messages.filter((m) => m.role === "toolResult");
	assert.match(JSON.stringify(results[0]), /Batter - light/);
	assert.equal((results[1] as { isError?: boolean }).isError, true);
	assert.ok(host.switchable.some((tool) => tool.name === "fetch_url"));
});
