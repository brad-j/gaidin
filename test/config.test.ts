import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { configFor, loadConfig, maskedConfig, secretsOf } from "../src/config.ts";
import { runChecks } from "../src/doctor.ts";
import { context } from "../src/host.ts";
import { createRedactor, redactorFor } from "../src/redact.ts";
import { findBwrap, SandboxEnv } from "../src/sandbox.ts";

const KEY = "sk-ant-api03-test-key-0123456789";

function dir(t: TestContext) {
	const d = mkdtempSync(join(tmpdir(), "gaidin-config-"));
	t.after(() => rmSync(d, { recursive: true, force: true }));
	return d;
}

function file(t: TestContext, settings: unknown, mode = 0o600) {
	const path = join(dir(t), "gaidin.json");
	writeFileSync(path, typeof settings === "string" ? settings : JSON.stringify(settings));
	chmodSync(path, mode);
	return path;
}

test("a settings file is read, with relative paths from its directory and defaults filled in", (t) => {
	const path = file(t, {
		owner: "Brad",
		timeZone: "America/New_York",
		data: "state",
		model: { apiKey: KEY },
		ntfy: { url: "https://ntfy.sh/gaidin-abc123def456", token: "tk_reminders1234" },
		slack: { botToken: "xoxb-1-2", appToken: "xapp-1-2", channelId: "C0C7UUU1MQF", userId: "U0123ABC" },
		web: { user: "brad@example.com" },
	});
	const { config, errors, warnings } = loadConfig({ file: path, env: {} });
	assert.deepEqual(errors, []);
	assert.deepEqual(warnings, []);
	assert.equal(config.file, path);
	assert.equal(config.owner, "Brad");
	assert.equal(config.dataDir, resolve(path, "..", "state"));
	assert.equal(config.model.id, "claude-haiku-5-5");
	assert.deepEqual(config.web, { user: "brad@example.com", port: 8410 });
	assert.equal(config.sandbox, "bwrap");
	assert.equal(config.homelab, undefined);
	assert.equal(secretsOf(config).ANTHROPIC_API_KEY, KEY);
	const masked = JSON.stringify(maskedConfig(config));
	assert.ok(!masked.includes(KEY) && !masked.includes("abc123def456"));
});

test("environment variables override the file", (t) => {
	const path = file(t, { owner: "Brad", model: { apiKey: KEY, id: "claude-haiku-5-5" } });
	const { config } = loadConfig({ file: path, env: { GAIDIN_OWNER: "Sam", GAIDIN_MODEL_ID: "claude-sonnet-5-5", GAIDIN_WEB_USER: "sam@example.com", GAIDIN_WEB_PORT: "9000" } });
	assert.equal(config.owner, "Sam");
	assert.equal(config.model.id, "claude-sonnet-5-5");
	assert.deepEqual(config.web, { user: "sam@example.com", port: 9000 });
});

test("mistakes are reported, each with what to fix", (t) => {
	const path = file(t, {
		ownr: "typo",
		timeZone: "Mars/Olympus",
		model: { apiKey: KEY, choices: ["claude-haiku-5-5", 4] },
		ntfy: { token: 12345678 },
		slack: { botToken: "xapp-wrong", channelId: "warder" },
		web: { user: "me", port: 70000 },
		sandbox: "maybe",
		extensions: { homelab: { feeds: "http://x", logHosts: { nas: 7 } }, weather: {} },
	});
	const { errors } = loadConfig({ file: path, env: {} });
	const expect = [
		/Unknown setting "ownr"/,
		/unknown time zone "Mars\/Olympus"/,
		/Slack needs .*missing appToken, userId/,
		/slack\.botToken should start with xoxb-/,
		/slack\.channelId should look like/,
		/web\.port must be a port number/,
		/sandbox must be "bwrap" or "none"/,
		/Unknown extension "weather"/,
		/extensions\.homelab\.kuma\.url is missing/,
		/^model\.choices\[1\] should be a string$/,
		/^ntfy\.token should be a string$/,
		/^extensions\.homelab\.logHosts\.nas should be a string$/,
	];
	for (const pattern of expect) assert.ok(errors.some((e) => pattern.test(e)), `no error matching ${pattern}: ${errors.join(" | ")}`);
	assert.match(loadConfig({ file: file(t, "{ not json"), env: {} }).errors[0]!, /Can't read/);
	assert.match(loadConfig({ env: {}, search: false }).errors.join(), /model\.apiKey is missing/);
});

test("a world-readable file with secrets gets a warning", (t) => {
	const { warnings } = loadConfig({ file: file(t, { model: { apiKey: KEY } }, 0o644), env: {} });
	assert.ok(warnings.some((w) => /anyone on the machine can read it/.test(w)));
});

test("the homelab extension is on only when configured", () => {
	assert.equal(configFor({}, {}).homelab, undefined);
	const { config, errors } = loadConfig({
		env: { GAIDIN_CONFIG: "/nonexistent/x.json" },
		search: false,
	});
	assert.ok(errors.some((e) => /Can't read \/nonexistent\/x\.json/.test(e)));
	assert.equal(config.homelab, undefined);
});

test("commands in the sandbox can't read the settings file", { skip: findBwrap() === undefined && "bwrap isn't installed" }, async (t) => {
	const root = join(dir(t), "sandbox");
	mkdirSync(root);
	const settings = join(root, "settings.json");
	writeFileSync(settings, JSON.stringify({ model: { apiKey: KEY } }));
	const env = new SandboxEnv({ root, redactor: createRedactor(new Map()), bwrap: findBwrap(), hide: [settings] });
	let output = "";
	const result = await env.exec(`cat ${settings}`, { onOutput: (text) => (output += text) }, context);
	assert.ok(result.ok && result.value.exitCode !== 0);
	assert.match(output, /Permission denied/);
	assert.ok(!output.includes(KEY));
});

test("doctor reports bad settings and checks the sandbox without the network", async (t) => {
	const path = file(t, { model: { provider: "faux" }, slack: { botToken: "xoxb-1" }, data: join(dir(t), "data") });
	const checks = await runChecks(loadConfig({ file: path, env: {} }));
	const find = (area: string) => checks.filter((c) => c.area === area);
	assert.equal(find("settings")[0]!.status, "fail");
	assert.ok(find("settings").some((c) => /Slack needs/.test(c.detail)));
	assert.equal(find("data")[0]!.status, "ok");
	assert.equal(find("server")[0]!.status, "warn");
	assert.equal(find("model")[0]!.status, "warn");
	assert.equal(find("ntfy")[0]!.status, "skip");
	assert.equal(find("homelab")[0]!.status, "skip");
	if (findBwrap() !== undefined) assert.equal(find("sandbox")[0]!.status, "ok");
});

test("the gaidin command prints help and the settings", (t) => {
	const main = resolve(import.meta.dirname, "../src/main.ts");
	const help = spawnSync(process.execPath, ["--no-warnings", main, "--help"], { encoding: "utf8" });
	assert.equal(help.status, 0);
	assert.match(help.stdout, /doctor \[--push\]/);
	const path = file(t, { owner: "Brad", model: { apiKey: KEY } });
	const shown = spawnSync(process.execPath, ["--no-warnings", main, "--config", path, "config"], { encoding: "utf8", env: { PATH: process.env.PATH } });
	assert.equal(shown.status, 0, shown.stderr);
	assert.equal(JSON.parse(shown.stdout).owner, "Brad");
	assert.ok(!shown.stdout.includes(KEY));
	const unknown = spawnSync(process.execPath, ["--no-warnings", main, "frobnicate"], { encoding: "utf8" });
	assert.equal(unknown.status, 1);
});

test("ntfy.icon is read, kept when masked, and must be a URL", (t) => {
	const icon = "https://gaidin.example.ts.net/icon-192.png";
	const { config, errors } = loadConfig({ file: file(t, { model: { apiKey: KEY }, ntfy: { url: "https://ntfy.sh/gaidin-abc123def456", icon } }), env: {} });
	assert.deepEqual(errors, []);
	assert.equal(config.ntfy?.icon, icon);
	assert.equal(maskedConfig(config).ntfy?.icon, icon);
	const bad = loadConfig({ file: file(t, { model: { apiKey: KEY }, ntfy: { url: "https://ntfy.sh/gaidin-abc123def456", icon: "icon.png" } }), env: {} });
	assert.ok(bad.errors.some((error) => /ntfy.icon must be the URL/.test(error)));
});

test("web.url is the web view's address, without a trailing slash", (t) => {
	const read = (url: string) => loadConfig({ file: file(t, { model: { apiKey: KEY }, web: { user: "brad@example.com", url } }), env: {} });
	assert.equal(read("https://gaidin.example.ts.net/").config.web?.url, "https://gaidin.example.ts.net");
	assert.ok(read("gaidin.example.ts.net").errors.some((error) => /web\.url must be the web view's address/.test(error)));
});

test("web.app is a directory, from the settings file's own when it's relative", (t) => {
	const settings = file(t, { model: { apiKey: KEY }, web: { user: "brad@example.com", app: "moiraine" } });
	const { config, errors } = loadConfig({ file: settings, env: {} });
	assert.deepEqual(errors, []);
	assert.equal(config.web?.app, join(dirname(settings), "moiraine"));
	assert.equal(loadConfig({ file: file(t, { model: { apiKey: KEY }, web: { user: "brad@example.com", app: "/var/lib/gaidin/moiraine" } }), env: {} }).config.web?.app, "/var/lib/gaidin/moiraine");
});

test("alerts.url is a topic other than the reminders', and is redacted like it", (t) => {
	const alerts = "https://ntfy.sh/homelab-alerts-5f3a9c2e7b";
	const { config, errors } = loadConfig({ file: file(t, { model: { apiKey: KEY }, ntfy: { url: "https://ntfy.sh/gaidin-abc123def456" }, alerts: { url: alerts } }), env: {} });
	assert.deepEqual(errors, []);
	assert.equal(config.alerts?.url, alerts);
	assert.ok(!JSON.stringify(maskedConfig(config)).includes("5f3a9c2e7b"));
	const redacted = redactorFor(secretsOf(config)).redact(`subscribed to ${alerts} (homelab-alerts-5f3a9c2e7b)`);
	assert.ok(!redacted.includes("5f3a9c2e7b"), redacted);
	const same = loadConfig({ file: file(t, { model: { apiKey: KEY }, ntfy: { url: alerts }, alerts: { url: `${alerts}/` } }), env: {} });
	assert.ok(same.errors.some((error) => /alerts\.url must be another topic than ntfy\.url/.test(error)));
	const placeholder = loadConfig({ file: file(t, { model: { apiKey: KEY }, alerts: { url: "https://ntfy.sh/<homelab alerts topic>" } }), env: {} });
	assert.ok(placeholder.errors.some((error) => /alerts\.url must be a topic URL.*a topic is up to 64 letters/.test(error)));
});

test("a topic on ntfy.sh without a token is a warning, since anyone with its name can read or post to it", (t) => {
	const warned = (settings: object) => loadConfig({ file: file(t, { model: { apiKey: KEY }, ...settings }), env: {} }).warnings.join(" | ");
	const open = warned({ ntfy: { url: "https://ntfy.sh/gaidin-abc123def456" }, alerts: { url: "https://ntfy.sh/homelab-alerts-5f3a9c2e7b" } });
	assert.match(open, /ntfy\.url is on ntfy\.sh without a token: anyone who learns the topic's name can read your reminders/);
	assert.match(open, /alerts\.url is on ntfy\.sh without a token: anyone who learns the topic's name can send gaidin alerts/);
	const tokens = warned({ ntfy: { url: "https://ntfy.sh/gaidin-abc123def456", token: "tk_reminders" }, alerts: { url: "https://ntfy.sh/homelab-alerts-5f3a9c2e7b", token: "tk_alerts" } });
	assert.doesNotMatch(tokens, /without a token/);
	assert.doesNotMatch(warned({ ntfy: { url: "https://ntfy.example.net/gaidin" }, alerts: { url: "https://ntfy.example.net/alerts" } }), /without a token/);
});
