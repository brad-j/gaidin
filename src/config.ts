// gaidin's settings: one JSON file, with environment variables on top. The file is the first of
// --config, GAIDIN_CONFIG, ./gaidin.json and /etc/gaidin/config.json that exists; without one, the
// defaults and the environment are used. Relative paths in the file are relative to the file.
// docs/deploy.md lists every setting.
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { array, dictionary, isObject, type Json, optional, ParseError, type Parser, string } from "./parse.ts";

export type HomelabConfig = {
	/** Base URL of the beszel.json, docker.json and backups.json snapshots. */
	feeds: string;
	/** Uptime Kuma's base URL and the slug of its public status page. */
	kuma: { url: string; page: string };
	/** Linked from the tool's result. */
	dashboard?: string;
	/** Docker hosts container_logs reads, name to address. Without any, there's no container_logs. */
	logHosts: Record<string, string>;
};

/** The search backend web_search uses. */
export type SearchConfig = { provider: "tavily"; apiKey: string };

export type Config = {
	/** The file the settings came from, if any. */
	file?: string;
	/** What gaidin calls the person it works for. */
	owner: string;
	timeZone: string;
	dataDir: string;
	model: { provider: "anthropic" | "faux"; id: string; apiKey?: string; choices: string[] };
	/** An ntfy topic other systems send alerts to, which gaidin follows and investigates (alerts.ts). */
	alerts?: { url: string; token?: string };
	/** `icon` is the URL of a PNG or JPEG the ntfy app shows beside each push. */
	ntfy?: { url: string; token?: string; icon?: string };
	slack?: { botToken: string; appToken: string; channelId: string; userId: string };
	/** `url` is where the owner reaches the web view, for links and buttons in pushes. */
	web?: { user: string; port: number; url?: string };
	sandbox: "bwrap" | "none";
	/** Spend limits in dollars; 0 is no limit. */
	budget: { daily: number; monthly: number };
	/** Without it there's no web_search. */
	search?: SearchConfig;
	/** How long approvals and questions wait for the owner. */
	approvals: { waitHours: number };
	/** SSH keys for workspaces and container logs, and the workspace list. */
	keysDir: string;
	homelab?: HomelabConfig;
};

export type Loaded = { config: Config; errors: string[]; warnings: string[] };

const DEFAULT_MODELS = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"];
const TOP_LEVEL = ["owner", "timeZone", "data", "model", "ntfy", "alerts", "slack", "web", "sandbox", "budget", "approvals", "search", "keys", "extensions"];

/** An ntfy topic URL: a server, maybe a path, then the topic, which ntfy limits to these characters. */
const TOPIC_URL = /^https?:\/\/[^/\s]+(\/[^/\s]+)*\/[-\w]{1,64}\/?$/;
const TOPIC_NAME = "a topic is up to 64 letters, digits, - and _";

/** A topic on ntfy.sh, where anyone who has the name can read and post unless the topic needs a token. */
function onNtfySh(url: string): boolean {
	return URL.canParse(url) && new URL(url).hostname === "ntfy.sh";
}

/** Where the settings live on a server (deploy/vm/setup.sh). Commands can't see it, so a copy or backup left there stays hidden. */
export const SETTINGS_DIR = "/etc/gaidin";

/** The settings file to use: `explicit`, GAIDIN_CONFIG, or the first default location that exists. */
export function findConfigFile(explicit?: string, env: NodeJS.ProcessEnv = process.env, search = true): string | undefined {
	const named = explicit ?? env.GAIDIN_CONFIG;
	if (named) return resolve(named);
	if (!search) return undefined;
	return [resolve("gaidin.json"), `${SETTINGS_DIR}/config.json`].find((path) => existsSync(path));
}

/** Variables that override the file. Names stay as they were before there was a file. */
function fromEnv(env: NodeJS.ProcessEnv) {
	const pick = (name: string) => (env[name] === undefined || env[name] === "" ? undefined : env[name]);
	return {
		owner: pick("GAIDIN_OWNER"),
		timeZone: pick("GAIDIN_TZ"),
		data: pick("GAIDIN_DATA"),
		provider: pick("GAIDIN_MODEL"),
		modelId: pick("GAIDIN_MODEL_ID"),
		apiKey: pick("ANTHROPIC_API_KEY"),
		ntfyUrl: pick("NTFY_URL"),
		ntfyToken: pick("NTFY_TOKEN"),
		slack: {
			botToken: pick("SLACK_BOT_TOKEN"),
			appToken: pick("SLACK_APP_TOKEN"),
			channelId: pick("SLACK_CHANNEL_ID"),
			userId: pick("SLACK_USER_ID"),
		},
		webUser: pick("GAIDIN_WEB_USER"),
		webPort: pick("GAIDIN_WEB_PORT"),
		sandbox: pick("GAIDIN_SANDBOX"),
		keys: pick("GAIDIN_KEYS"),
		daily: pick("GAIDIN_BUDGET_DAILY"),
		monthly: pick("GAIDIN_BUDGET_MONTHLY"),
		waitHours: pick("GAIDIN_APPROVAL_WAIT_HOURS"),
		tavilyKey: pick("TAVILY_API_KEY"),
		homelabFeeds: pick("GAIDIN_HOMELAB_DATA"),
		kumaUrl: pick("GAIDIN_KUMA_URL"),
	};
}

/** A section of the settings file. */
type Section = { readonly [key: string]: Json };
const EMPTY: Section = {};

/** Reads and checks the settings. `errors` stop the server; `warnings` don't. */
export function loadConfig(options: { file?: string; env?: NodeJS.ProcessEnv; search?: boolean } = {}): Loaded {
	const env = options.env ?? process.env;
	const errors: string[] = [];
	const warnings: string[] = [];
	const file = findConfigFile(options.file, env, options.search ?? true);

	let raw = EMPTY;
	if (file !== undefined) {
		try {
			// JSON.parse gives only JSON values.
			const parsed: Json = JSON.parse(readFileSync(file, "utf8"));
			if (isObject(parsed)) raw = parsed;
			else errors.push(`${file} must hold a JSON object`);
		} catch (error) {
			errors.push(`Can't read ${file}: ${error instanceof Error ? error.message : error}`);
		}
	}
	const base = file === undefined ? process.cwd() : dirname(file);
	const path = (value: string) => (isAbsolute(value) ? value : resolve(base, value));

	for (const key of Object.keys(raw)) {
		if (!TOP_LEVEL.includes(key)) errors.push(`Unknown setting "${key}" in ${file}`);
	}
	const section = (name: string) => {
		const value = raw[name];
		if (value === undefined) return EMPTY;
		if (isObject(value)) return value;
		errors.push(`"${name}" must be an object`);
		return EMPTY;
	};
	/** `value` as `parser` has it, or undefined, with what's wrong among the errors. */
	const read = <T>(where: string, value: Json | undefined, parser: Parser<T>): T | undefined => {
		try {
			return parser(value, where);
		} catch (error) {
			if (!(error instanceof ParseError)) throw error;
			errors.push(error.message);
			return undefined;
		}
	};
	const text = (where: string, value: Json | undefined) => (value === "" ? undefined : read(where, value, optional(string)));
	const e = fromEnv(env);

	// Owner and time
	const owner = e.owner ?? text("owner", raw.owner) ?? "the user";
	const timeZone = e.timeZone ?? text("timeZone", raw.timeZone) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
	try {
		new Intl.DateTimeFormat("en-US", { timeZone });
	} catch {
		errors.push(`timeZone: unknown time zone "${timeZone}"`);
	}

	// Model
	const model = section("model");
	const providerName = e.provider ?? text("model.provider", model.provider) ?? "anthropic";
	const provider = providerName === "faux" ? "faux" : "anthropic";
	if (providerName !== provider) errors.push(`model.provider must be "anthropic" or "faux", not "${providerName}"`);
	const apiKey = e.apiKey ?? text("model.apiKey", model.apiKey);
	if (provider === "anthropic" && apiKey === undefined) errors.push("model.apiKey is missing (or set ANTHROPIC_API_KEY)");
	else if (apiKey !== undefined && !apiKey.startsWith("sk-ant-")) warnings.push("model.apiKey doesn't start with sk-ant-");
	const id = e.modelId ?? text("model.id", model.id) ?? "claude-haiku-5-5";
	let choices = read("model.choices", model.choices, optional(array(string))) ?? DEFAULT_MODELS;
	if (provider === "faux") choices = ["faux-1"];

	// ntfy
	const ntfySection = section("ntfy");
	const ntfyUrl = e.ntfyUrl ?? text("ntfy.url", ntfySection.url);
	const ntfyToken = e.ntfyToken ?? text("ntfy.token", ntfySection.token);
	const ntfyIcon = text("ntfy.icon", ntfySection.icon);
	if (ntfyUrl !== undefined && !TOPIC_URL.test(ntfyUrl)) errors.push(`ntfy.url must be a topic URL, like https://ntfy.sh/<topic>; ${TOPIC_NAME}`);
	if (ntfyIcon !== undefined && !/^https?:\/\/[^/]+\/./.test(ntfyIcon)) errors.push("ntfy.icon must be the URL of a PNG or JPEG");
	if (ntfyUrl !== undefined && ntfyToken === undefined && onNtfySh(ntfyUrl)) {
		warnings.push("ntfy.url is on ntfy.sh without a token: anyone who learns the topic's name can read your reminders and job reports. Reserve the topic and set ntfy.token, or use your own ntfy server with access control");
	}

	// Alerts
	const alertsSection = section("alerts");
	const alertsUrl = text("alerts.url", alertsSection.url)?.replace(/\/+$/, "");
	const alertsToken = text("alerts.token", alertsSection.token);
	if (alertsUrl !== undefined && !TOPIC_URL.test(alertsUrl)) errors.push(`alerts.url must be a topic URL, like https://ntfy.sh/<topic>; ${TOPIC_NAME}`);
	// Following its own topic, gaidin would investigate its own reminders.
	if (alertsUrl !== undefined && alertsUrl === ntfyUrl?.replace(/\/+$/, "")) errors.push("alerts.url must be another topic than ntfy.url");
	if (alertsUrl !== undefined && alertsToken === undefined && onNtfySh(alertsUrl)) {
		warnings.push("alerts.url is on ntfy.sh without a token: anyone who learns the topic's name can send gaidin alerts to investigate, each a model run. Reserve the topic and set alerts.token, or use your own ntfy server with access control");
	}

	// Slack: all four or none
	const slackSection = section("slack");
	const slack = {
		botToken: e.slack.botToken ?? text("slack.botToken", slackSection.botToken),
		appToken: e.slack.appToken ?? text("slack.appToken", slackSection.appToken),
		channelId: e.slack.channelId ?? text("slack.channelId", slackSection.channelId),
		userId: e.slack.userId ?? text("slack.userId", slackSection.userId),
	};
	const slackGiven = Object.entries(slack).filter(([, v]) => v !== undefined);
	if (slackGiven.length > 0 && slackGiven.length < 4) {
		errors.push(`Slack needs botToken, appToken, channelId and userId; missing ${Object.entries(slack).filter(([, v]) => v === undefined).map(([k]) => k).join(", ")}`);
	}
	if (slack.botToken !== undefined && !slack.botToken.startsWith("xoxb-")) errors.push("slack.botToken should start with xoxb-");
	if (slack.appToken !== undefined && !slack.appToken.startsWith("xapp-")) errors.push("slack.appToken should start with xapp-");
	if (slack.channelId !== undefined && !/^[CG][A-Z0-9]+$/.test(slack.channelId)) errors.push("slack.channelId should look like C0123ABCD");
	if (slack.userId !== undefined && !/^[UW][A-Z0-9]+$/.test(slack.userId)) errors.push("slack.userId should look like U0123ABCD (a member ID, not a name)");

	// Web view
	const webSection = section("web");
	const webUser = e.webUser ?? text("web.user", webSection.user);
	const portValue = e.webPort ?? webSection.port ?? 8410;
	const port = Number(portValue);
	if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push(`web.port must be a port number, not ${JSON.stringify(portValue)}`);
	const webUrl = text("web.url", webSection.url)?.replace(/\/+$/, "");
	if (webUrl !== undefined && !/^https?:\/\/[^/]+$/.test(webUrl)) errors.push("web.url must be the web view's address, like https://gaidin.example.ts.net");
	if (ntfyUrl === undefined && (webUser === undefined || webUrl === undefined)) {
		warnings.push("Neither ntfy.url nor web.url: reminders print to the server's output instead of reaching a phone");
	}

	// Sandbox
	const sandboxName = e.sandbox ?? text("sandbox", raw.sandbox) ?? "bwrap";
	const sandbox = sandboxName === "none" ? "none" : "bwrap";
	if (sandboxName !== sandbox) errors.push(`sandbox must be "bwrap" or "none", not "${sandboxName}"`);
	if (sandbox === "none") warnings.push('sandbox is "none": tools run unconfined, with everything the server can reach');

	// Budget
	const budgetSection = section("budget");
	const limit = (name: string, value: Json | undefined, fallback: number) => {
		const number = value === undefined ? fallback : Number(value);
		if (!Number.isFinite(number) || number < 0) {
			errors.push(`budget.${name} must be a dollar amount, 0 for no limit, not ${JSON.stringify(value)}`);
			return fallback;
		}
		return number;
	};
	const budget = { daily: limit("daily", e.daily ?? budgetSection.daily, 5), monthly: limit("monthly", e.monthly ?? budgetSection.monthly, 0) };
	if (budget.daily === 0 && budget.monthly === 0) warnings.push("No budget: nothing limits what scheduled jobs and runs can spend");

	// Approvals
	const approvalSection = section("approvals");
	const waitValue = e.waitHours ?? approvalSection.waitHours ?? 168;
	const waitHours = Number(waitValue);
	// Node's timers stop at about 24 days.
	if (!Number.isFinite(waitHours) || waitHours <= 0 || waitHours > 24 * 24) errors.push(`approvals.waitHours must be between 0 and 576 hours, not ${JSON.stringify(waitValue)}`);

	// Search
	const searchSection = section("search");
	let search: SearchConfig | undefined;
	const searchProvider = text("search.provider", searchSection.provider) ?? (e.tavilyKey === undefined ? undefined : "tavily");
	if (searchProvider !== undefined) {
		if (searchProvider !== "tavily") errors.push(`search.provider must be "tavily", not "${searchProvider}"`);
		const key = e.tavilyKey ?? text("search.apiKey", searchSection.apiKey);
		if (key === undefined) errors.push("search.apiKey is missing (or set TAVILY_API_KEY)");
		else if (!key.startsWith("tvly-")) errors.push("search.apiKey should start with tvly-");
		else if (searchProvider === "tavily") search = { provider: "tavily", apiKey: key };
	}

	// Extensions
	const extensions = section("extensions");
	for (const key of Object.keys(extensions)) {
		if (key !== "homelab") errors.push(`Unknown extension "${key}"`);
	}
	let homelab: HomelabConfig | undefined;
	if (extensions.homelab !== undefined) {
		const h = isObject(extensions.homelab) ? extensions.homelab : (errors.push("extensions.homelab must be an object"), EMPTY);
		const kuma = isObject(h.kuma) ? h.kuma : EMPTY;
		const feeds = e.homelabFeeds ?? text("extensions.homelab.feeds", h.feeds);
		const kumaUrl = e.kumaUrl ?? text("extensions.homelab.kuma.url", kuma.url);
		const page = text("extensions.homelab.kuma.page", kuma.page);
		const logHosts = Object.fromEntries(read("extensions.homelab.logHosts", h.logHosts, optional(dictionary(string))) ?? []);
		if (feeds === undefined) errors.push("extensions.homelab.feeds is missing");
		if (kumaUrl === undefined) errors.push("extensions.homelab.kuma.url is missing");
		if (page === undefined) errors.push("extensions.homelab.kuma.page is missing: the slug of Kuma's public status page");
		homelab = {
			feeds: (feeds ?? "").replace(/\/+$/, ""),
			kuma: { url: (kumaUrl ?? "").replace(/\/+$/, ""), page: page ?? "" },
			logHosts,
		};
		const dashboard = text("extensions.homelab.dashboard", h.dashboard);
		if (dashboard !== undefined) homelab.dashboard = dashboard;
	}

	// A file holding secrets should be readable by its owner and the service only.
	const secretsInFile = [model.apiKey, ntfySection.url, ntfySection.token, slackSection.botToken, slackSection.appToken, searchSection.apiKey, alertsSection.url, alertsSection.token].some((v) => v !== undefined);
	if (file !== undefined && secretsInFile && existsSync(file) && (statSync(file).mode & 0o007) !== 0) {
		warnings.push(`${file} holds secrets and anyone on the machine can read it; chmod o-rwx it`);
	}

	const config: Config = {
		owner,
		timeZone,
		dataDir: path(e.data ?? text("data", raw.data) ?? "data"),
		model: { provider, id: provider === "faux" ? "faux-1" : id, choices },
		sandbox,
		budget,
		approvals: { waitHours: Number.isFinite(waitHours) && waitHours > 0 && waitHours <= 576 ? waitHours : 168 },
		keysDir: path(e.keys ?? text("keys", raw.keys) ?? "/var/lib/gaidin/keys"),
	};
	if (file !== undefined) config.file = file;
	if (apiKey !== undefined) config.model.apiKey = apiKey;
	if (ntfyUrl !== undefined) {
		config.ntfy = { url: ntfyUrl };
		if (ntfyToken !== undefined) config.ntfy.token = ntfyToken;
		if (ntfyIcon !== undefined) config.ntfy.icon = ntfyIcon;
	}
	if (alertsUrl !== undefined) {
		config.alerts = { url: alertsUrl };
		if (alertsToken !== undefined) config.alerts.token = alertsToken;
	}
	const { botToken, appToken, channelId, userId } = slack;
	if (botToken !== undefined && appToken !== undefined && channelId !== undefined && userId !== undefined) config.slack = { botToken, appToken, channelId, userId };
	if (webUser !== undefined) {
		config.web = { user: webUser, port };
		if (webUrl !== undefined) config.web.url = webUrl;
	}
	if (search !== undefined) config.search = search;
	if (homelab !== undefined) config.homelab = homelab;
	return { config, errors, warnings };
}

/** The settings for tests and code that don't read a file: defaults and the environment, with `change` applied. */
export function configFor(change: Partial<Config> = {}, env: NodeJS.ProcessEnv = process.env): Config {
	return { ...loadConfig({ env, search: false }).config, ...change };
}

/** Secret values by name, for redaction. */
export function secretsOf(config: Config) {
	return {
		ANTHROPIC_API_KEY: config.model.apiKey,
		NTFY_URL: config.ntfy?.url,
		NTFY_TOKEN: config.ntfy?.token,
		SLACK_BOT_TOKEN: config.slack?.botToken,
		SLACK_APP_TOKEN: config.slack?.appToken,
		TAVILY_API_KEY: config.search?.apiKey,
		ALERTS_URL: config.alerts?.url,
		ALERTS_TOKEN: config.alerts?.token,
	};
}

/** The settings with secrets shown as their first few characters. */
export function maskedConfig(config: Config): Config {
	const mask = (value: string) => `${value.slice(0, 6)}…`;
	const ntfyMask = (url: string) => url.replace(/[^/]+$/, (topic) => `${topic.slice(0, 4)}…`);
	const masked: Config = { ...config, model: { ...config.model } };
	if (config.model.apiKey !== undefined) masked.model.apiKey = mask(config.model.apiKey);
	if (config.ntfy !== undefined) {
		masked.ntfy = { ...config.ntfy, url: ntfyMask(config.ntfy.url) };
		if (config.ntfy.token !== undefined) masked.ntfy.token = mask(config.ntfy.token);
	}
	if (config.alerts !== undefined) {
		masked.alerts = { url: ntfyMask(config.alerts.url) };
		if (config.alerts.token !== undefined) masked.alerts.token = mask(config.alerts.token);
	}
	if (config.slack !== undefined) masked.slack = { ...config.slack, botToken: mask(config.slack.botToken), appToken: mask(config.slack.appToken) };
	if (config.search !== undefined) masked.search = { ...config.search, apiKey: mask(config.search.apiKey) };
	return masked;
}
