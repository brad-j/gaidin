import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { Config } from "../src/config.ts";
import type { Check } from "../src/doctor.ts";
import { type SetupDeps, setup, Stopped, type Tailnet } from "../src/setup.ts";

const KEY = "sk-ant-api03-test-key-0123456789";
const OTHER_KEY = "sk-ant-api03-other-key-9876543210";
const TAVILY = "tvly-test-0123456789abcdef";
const OK: Check[] = [{ status: "ok", area: "test", detail: "fine" }];

/** The settings each check was given, and for ntfy whether it sent a test. */
type Checked = { model: Config[]; ntfy: [Config, boolean][]; search: Config[] };

function settingsFile(t: TestContext, settings?: unknown, mode = 0o600) {
	const dir = mkdtempSync(join(tmpdir(), "gaidin-setup-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const path = join(dir, "gaidin.json");
	if (settings !== undefined) {
		writeFileSync(path, typeof settings === "string" ? settings : JSON.stringify(settings, null, 2));
		chmodSync(path, mode);
	}
	return path;
}

/** Answers the questions in order; a question past the last answer ends the input. */
function scripted(answers: string[], change: Partial<SetupDeps> = {}) {
	const output: string[] = [];
	const asked: string[] = [];
	const checked: Checked = { model: [], ntfy: [], search: [] };
	const queue = [...answers];
	const deps: SetupDeps = {
		terminal: {
			say: (line) => output.push(line),
			ask: async (question) => {
				asked.push(question);
				output.push(question);
				const answer = queue.shift();
				if (answer === undefined) throw new Stopped();
				return answer;
			},
		},
		env: {},
		model: async (config) => (checked.model.push(config), OK),
		ntfy: async (config, push) => (checked.ntfy.push([config, push]), OK),
		search: async (config) => (checked.search.push(config), OK),
		tailscale: (): Tailnet | undefined => ({ url: "https://gaidin.example.ts.net", login: "owner@example.com" }),
		doctor: async () => 0,
		...change,
	};
	return { deps, output, asked, checked, left: queue };
}

const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));

test("a first run writes each section to a new file only its owner can read, and never prints a secret", async (t) => {
	const path = settingsFile(t);
	const run = scripted([
		"Alex", "America/Chicago", // you
		KEY, "", "3", "40", // the model: key, model, limits
		"", "", "", // the API: set up, login and address from Tailscale
		"", "", "", "n", // ntfy: set up, ntfy.sh, no token, no test
		"", TAVILY, // search
	]);
	assert.equal(await setup(path, run.deps), 0);
	assert.deepEqual(run.left, []);
	const written = read(path);
	assert.equal(written.owner, "Alex");
	assert.equal(written.timeZone, "America/Chicago");
	assert.deepEqual(written.model, { apiKey: KEY, id: "claude-haiku-5-5" });
	assert.deepEqual(written.budget, { daily: 3, monthly: 40 });
	assert.deepEqual(written.web, { user: "owner@example.com", url: "https://gaidin.example.ts.net" });
	assert.match(written.ntfy.url, /^https:\/\/ntfy\.sh\/gaidin-[-\w]{24}$/);
	assert.equal(written.ntfy.token, undefined);
	assert.deepEqual(written.search, { provider: "tavily", apiKey: TAVILY });
	assert.equal(statSync(path).mode & 0o777, 0o600);

	// Each check got what was just entered, not the environment's.
	assert.equal(run.checked.model[0]?.model.apiKey, KEY);
	assert.equal(run.checked.ntfy[0]?.[0].ntfy?.url, written.ntfy.url);
	assert.equal(run.checked.ntfy[0]?.[1], false);
	assert.equal(run.checked.search[0]?.search?.apiKey, TAVILY);

	const text = run.output.join("\n");
	assert.doesNotMatch(text, new RegExp(KEY));
	assert.doesNotMatch(text, new RegExp(TAVILY));
	// The topic it made is shown once, to subscribe to, and ntfy.sh without a token is warned about.
	assert.equal(text.split(written.ntfy.url).length - 1, 1);
	assert.match(text, /warning: ntfy\.url is on ntfy\.sh without a token/);
});

test("a rerun shows the sections with secrets shortened, and keeping them all changes nothing", async (t) => {
	const settings = {
		owner: "Alex",
		timeZone: "America/Chicago",
		model: { apiKey: KEY },
		web: { user: "owner@example.com" },
		ntfy: { url: "https://ntfy.example.com/gaidin-secret-topic", token: "tk_0123456789" },
		search: { provider: "tavily", apiKey: TAVILY },
	};
	const path = settingsFile(t, settings, 0o640);
	const before = readFileSync(path, "utf8");
	const run = scripted(["", "", "", "", ""]);
	assert.equal(await setup(path, run.deps), 0);
	assert.equal(readFileSync(path, "utf8"), before);
	const text = run.output.join("\n");
	assert.match(text, /Nothing changed/);
	assert.match(text, /apiKey: sk-ant…/);
	assert.match(text, /url: https:\/\/ntfy\.example\.com\/gaid…/);
	assert.match(text, /token: tk_012…/);
	for (const secret of [KEY, TAVILY, "gaidin-secret-topic", "tk_0123456789"]) assert.doesNotMatch(text, new RegExp(secret));
	assert.deepEqual(run.checked, { model: [], ntfy: [], search: [] });
});

test("changing one section keeps the rest of the file, settings setup doesn't ask about included, and the file's mode", async (t) => {
	const path = settingsFile(t, {
		owner: "Alex",
		model: { apiKey: KEY, choices: ["claude-haiku-5-5"] },
		budget: { daily: 2, monthly: 30 },
		slack: { botToken: "xoxb-1-2", appToken: "xapp-1-2", channelId: "C0123ABCD", userId: "U0123ABC" },
		keys: "/srv/keys",
	}, 0o640);
	const run = scripted([
		"", // keep you
		"c", OTHER_KEY, "claude-sonnet-5-5", "", "", // change the key and model, keep the limits
		"n", "n", "n", // no API, ntfy or search
	]);
	assert.equal(await setup(path, run.deps), 0);
	const written = read(path);
	assert.deepEqual(written.model, { apiKey: OTHER_KEY, choices: ["claude-haiku-5-5"], id: "claude-sonnet-5-5" });
	assert.deepEqual(written.budget, { daily: 2, monthly: 30 });
	assert.equal(written.slack.botToken, "xoxb-1-2");
	assert.equal(written.keys, "/srv/keys");
	assert.equal(written.web, undefined);
	assert.equal(statSync(path).mode & 0o777, 0o640);
	// Enter at the key's question would have kept it, shown shortened.
	assert.ok(run.asked.some((q) => q.startsWith("API key [sk-ant…]")));
});

test("an answer that doesn't check out is asked again", async (t) => {
	const path = settingsFile(t);
	let tries = 0;
	const run = scripted([
		"Alex", "Mars/Olympus", "Europe/Oslo",
		"sk-wrong", KEY, "", // a key of the wrong kind, then one the check refuses
		"", KEY, "", // asked again, and accepted
		"five", "5", "0",
		"n", "n", "n",
	], {
		model: async () => (++tries === 1 ? [{ status: "fail", area: "model", detail: "Anthropic refused the API key (401)" }] : OK),
	});
	assert.equal(await setup(path, run.deps), 0);
	assert.equal(tries, 2);
	const written = read(path);
	assert.equal(written.timeZone, "Europe/Oslo");
	assert.equal(written.budget.daily, 5);
	const text = run.output.join("\n");
	assert.match(text, /There's no time zone "Mars\/Olympus"/);
	assert.match(text, /starts with sk-ant-/);
	assert.match(text, /fail {2}Anthropic refused the API key/);
	assert.match(text, /A dollar amount/);
});

test("a failed check can be kept anyway, as when the network is down", async (t) => {
	const path = settingsFile(t, { owner: "Alex", model: { apiKey: KEY } });
	const run = scripted(["", "", "n", "n", "", TAVILY, "n"], { search: async () => [{ status: "fail", area: "search", detail: "fetch failed" }] });
	await setup(path, run.deps);
	assert.equal(read(path).search.apiKey, TAVILY);
});

test("a section can be removed", async (t) => {
	const path = settingsFile(t, { owner: "Alex", model: { apiKey: KEY }, web: { user: "owner@example.com" }, ntfy: { url: "https://ntfy.example.com/gaidin-topic" } });
	const run = scripted(["", "", "r", "r", "n"]);
	assert.equal(await setup(path, run.deps), 0);
	assert.deepEqual(read(path), { owner: "Alex", model: { apiKey: KEY } });
});

test("ntfy keeps its topic unless a new one is asked for, and can send a test", async (t) => {
	const url = "https://ntfy.example.com/gaidin-topic";
	const path = settingsFile(t, { owner: "Alex", model: { apiKey: KEY }, ntfy: { url, icon: "https://example.com/icon.png" } });
	const run = scripted(["", "", "n", "c", "", "", "tk_new_token", "y", "n"]);
	assert.equal(await setup(path, run.deps), 0);
	assert.deepEqual(read(path).ntfy, { url, icon: "https://example.com/icon.png", token: "tk_new_token" });
	assert.deepEqual(run.checked.ntfy.map(([, push]) => push), [false, true]);
	assert.doesNotMatch(run.output.join("\n"), /Subscribe/);
});

test("without Tailscale the API's values are asked for, and the address can be left out", async (t) => {
	const path = settingsFile(t, { owner: "Alex", model: { apiKey: KEY } });
	const run = scripted(["", "", "y", "owner@example.com", "", "n", "n"], { tailscale: () => undefined });
	assert.equal(await setup(path, run.deps), 0);
	assert.deepEqual(read(path).web, { user: "owner@example.com" });
	assert.match(run.output.join("\n"), /Tailscale isn't logged in here/);
});

test("stopping part-way writes nothing", async (t) => {
	const path = settingsFile(t, { owner: "Alex", model: { apiKey: KEY } });
	const before = readFileSync(path, "utf8");
	const run = scripted(["c", "Sam"]);
	assert.equal(await setup(path, run.deps), 1);
	assert.equal(readFileSync(path, "utf8"), before);
	assert.match(run.output.join("\n"), /Stopped; nothing written/);
});

test("a file that isn't JSON is left alone", async (t) => {
	const path = settingsFile(t, "{ not json");
	const run = scripted([]);
	assert.equal(await setup(path, run.deps), 1);
	assert.equal(readFileSync(path, "utf8"), "{ not json");
	assert.deepEqual(run.asked, []);
});

test("variables that override the settings are named", async (t) => {
	const path = settingsFile(t);
	const run = scripted([], { env: { ANTHROPIC_API_KEY: KEY, GAIDIN_SANDBOX: "none" } });
	await setup(path, run.deps);
	assert.match(run.output.join("\n"), /These variables override what you enter: ANTHROPIC_API_KEY \(model\.apiKey\)\./);
	assert.doesNotMatch(run.output.join("\n"), new RegExp(KEY));
});

test("gaidin setup with nothing on stdin stops without writing", (t) => {
	const path = settingsFile(t);
	const result = spawnSync("node", ["--no-warnings", join(import.meta.dirname, "..", "src", "main.ts"), "setup"], {
		encoding: "utf8",
		input: "",
		env: { ...process.env, GAIDIN_CONFIG: path, ANTHROPIC_API_KEY: "" },
	});
	assert.equal(result.status, 1);
	assert.match(result.stdout, /Stopped; nothing written/);
	assert.equal(existsSync(path), false);
});
