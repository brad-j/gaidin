// gaidin's settings: one JSON file, with environment variables on top. The file is the first of
// --config, GAIDIN_CONFIG, ./gaidin.json and /etc/gaidin/config.json that exists; without one, the
// defaults and the environment are used. Relative paths in the file are relative to the file.
// docs/deploy.md lists every setting.
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

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

export type Config = {
	/** The file the settings came from, if any. */
	file?: string;
	/** What gaidin calls the person it works for. */
	owner: string;
	timeZone: string;
	dataDir: string;
	model: { provider: "anthropic" | "faux"; id: string; apiKey?: string; choices: string[] };
	ntfy?: { url: string; token?: string };
	slack?: { botToken: string; appToken: string; channelId: string; userId: string };
	web?: { user: string; port: number };
	sandbox: "bwrap" | "none";
	/** SSH keys for workspaces and container logs, and the workspace list. */
	keysDir: string;
	homelab?: HomelabConfig;
};

export type Loaded = { config: Config; errors: string[]; warnings: string[] };

const DEFAULT_MODELS = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"];
const TOP_LEVEL = ["owner", "timeZone", "data", "model", "ntfy", "slack", "web", "sandbox", "keys", "extensions"];

/** The settings file to use: `explicit`, GAIDIN_CONFIG, or the first default location that exists. */
export function findConfigFile(explicit?: string, env: NodeJS.ProcessEnv = process.env, search = true): string | undefined {
	const named = explicit ?? env.GAIDIN_CONFIG;
	if (named) return resolve(named);
	if (!search) return undefined;
	return [resolve("gaidin.json"), "/etc/gaidin/config.json"].find((path) => existsSync(path));
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
		homelabFeeds: pick("GAIDIN_HOMELAB_DATA"),
		kumaUrl: pick("GAIDIN_KUMA_URL"),
	};
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** Reads and checks the settings. `errors` stop the server; `warnings` don't. */
export function loadConfig(options: { file?: string; env?: NodeJS.ProcessEnv; search?: boolean } = {}): Loaded {
	const env = options.env ?? process.env;
	const errors: string[] = [];
	const warnings: string[] = [];
	const file = findConfigFile(options.file, env, options.search ?? true);

	let raw: Json = {};
	if (file !== undefined) {
		try {
			const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
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
	const section = (name: string): Json => {
		const value = raw[name];
		if (value === undefined) return {};
		if (isObject(value)) return value;
		errors.push(`"${name}" must be an object`);
		return {};
	};
	const text = (where: string, value: unknown): string | undefined => {
		if (value === undefined || value === null || value === "") return undefined;
		if (typeof value === "string") return value;
		errors.push(`${where} must be a string`);
		return undefined;
	};
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
	const provider = e.provider ?? text("model.provider", model.provider) ?? "anthropic";
	if (provider !== "anthropic" && provider !== "faux") errors.push(`model.provider must be "anthropic" or "faux", not "${provider}"`);
	const apiKey = e.apiKey ?? text("model.apiKey", model.apiKey);
	if (provider === "anthropic" && apiKey === undefined) errors.push("model.apiKey is missing (or set ANTHROPIC_API_KEY)");
	else if (apiKey !== undefined && !apiKey.startsWith("sk-ant-")) warnings.push("model.apiKey doesn't start with sk-ant-");
	const id = e.modelId ?? text("model.id", model.id) ?? "claude-haiku-5-5";
	let choices = DEFAULT_MODELS;
	if (model.choices !== undefined) {
		if (Array.isArray(model.choices) && model.choices.every((c) => typeof c === "string")) choices = model.choices as string[];
		else errors.push("model.choices must be a list of model ids");
	}
	if (provider === "faux") choices = ["faux-1"];

	// ntfy
	const ntfySection = section("ntfy");
	const ntfyUrl = e.ntfyUrl ?? text("ntfy.url", ntfySection.url);
	const ntfyToken = e.ntfyToken ?? text("ntfy.token", ntfySection.token);
	if (ntfyUrl !== undefined && !/^https?:\/\/[^/]+\/[^/]+/.test(ntfyUrl)) errors.push("ntfy.url must be a topic URL, like https://ntfy.sh/<topic>");
	if (ntfyUrl === undefined) warnings.push("No ntfy.url: reminders print to the server's output instead of pushing");

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

	// Sandbox
	const sandbox = e.sandbox ?? text("sandbox", raw.sandbox) ?? "bwrap";
	if (sandbox !== "bwrap" && sandbox !== "none") errors.push(`sandbox must be "bwrap" or "none", not "${sandbox}"`);
	if (sandbox === "none") warnings.push('sandbox is "none": tools run unconfined, with everything the server can reach');

	// Extensions
	const extensions = section("extensions");
	for (const key of Object.keys(extensions)) {
		if (key !== "homelab") errors.push(`Unknown extension "${key}"`);
	}
	let homelab: HomelabConfig | undefined;
	if (extensions.homelab !== undefined) {
		const h = isObject(extensions.homelab) ? extensions.homelab : (errors.push('extensions.homelab must be an object'), {} as Json);
		const kuma = isObject(h.kuma) ? h.kuma : {};
		const feeds = e.homelabFeeds ?? text("extensions.homelab.feeds", h.feeds);
		const kumaUrl = e.kumaUrl ?? text("extensions.homelab.kuma.url", kuma.url);
		const logHosts: Record<string, string> = {};
		if (h.logHosts !== undefined) {
			if (isObject(h.logHosts) && Object.values(h.logHosts).every((v) => typeof v === "string")) Object.assign(logHosts, h.logHosts);
			else errors.push("extensions.homelab.logHosts must map host names to addresses");
		}
		if (feeds === undefined) errors.push("extensions.homelab.feeds is missing");
		if (kumaUrl === undefined) errors.push("extensions.homelab.kuma.url is missing");
		if (typeof kuma.page !== "string" || kuma.page === "") errors.push("extensions.homelab.kuma.page is missing: the slug of Kuma's public status page");
		homelab = {
			feeds: (feeds ?? "").replace(/\/+$/, ""),
			kuma: { url: (kumaUrl ?? "").replace(/\/+$/, ""), page: text("extensions.homelab.kuma.page", kuma.page) ?? "" },
			...(typeof h.dashboard === "string" ? { dashboard: h.dashboard } : {}),
			logHosts,
		};
	}

	// A file holding secrets should be readable by its owner and the service only.
	const secretsInFile = [model.apiKey, ntfySection.url, ntfySection.token, slackSection.botToken, slackSection.appToken].some((v) => v !== undefined);
	if (file !== undefined && secretsInFile && existsSync(file) && (statSync(file).mode & 0o007) !== 0) {
		warnings.push(`${file} holds secrets and anyone on the machine can read it; chmod o-rwx it`);
	}

	const config: Config = {
		...(file === undefined ? {} : { file }),
		owner,
		timeZone,
		dataDir: path(e.data ?? text("data", raw.data) ?? "data"),
		model: { provider: provider as Config["model"]["provider"], id: provider === "faux" ? "faux-1" : id, ...(apiKey === undefined ? {} : { apiKey }), choices },
		...(ntfyUrl === undefined ? {} : { ntfy: { url: ntfyUrl, ...(ntfyToken === undefined ? {} : { token: ntfyToken }) } }),
		...(slackGiven.length === 4 ? { slack: slack as NonNullable<Config["slack"]> } : {}),
		...(webUser === undefined ? {} : { web: { user: webUser, port } }),
		sandbox: sandbox as Config["sandbox"],
		keysDir: path(e.keys ?? text("keys", raw.keys) ?? "/var/lib/gaidin/keys"),
		...(homelab === undefined ? {} : { homelab }),
	};
	return { config, errors, warnings };
}

/** The settings for tests and code that don't read a file: defaults and the environment, with `change` applied. */
export function configFor(change: Partial<Config> = {}, env: NodeJS.ProcessEnv = process.env): Config {
	return { ...loadConfig({ env, search: false }).config, ...change };
}

/** Secret values by name, for redaction. */
export function secretsOf(config: Config): Record<string, string | undefined> {
	return {
		ANTHROPIC_API_KEY: config.model.apiKey,
		NTFY_URL: config.ntfy?.url,
		NTFY_TOKEN: config.ntfy?.token,
		SLACK_BOT_TOKEN: config.slack?.botToken,
		SLACK_APP_TOKEN: config.slack?.appToken,
	};
}

/** The settings with secrets shown as their first few characters. */
export function maskedConfig(config: Config): Config {
	const mask = (value: string | undefined) => (value === undefined ? undefined : `${value.slice(0, 6)}…`);
	const ntfyMask = (url: string) => url.replace(/[^/]+$/, (topic) => `${topic.slice(0, 4)}…`);
	return {
		...config,
		model: { ...config.model, ...(config.model.apiKey === undefined ? {} : { apiKey: mask(config.model.apiKey)! }) },
		...(config.ntfy === undefined ? {} : { ntfy: { url: ntfyMask(config.ntfy.url), ...(config.ntfy.token === undefined ? {} : { token: mask(config.ntfy.token)! }) } }),
		...(config.slack === undefined ? {} : { slack: { ...config.slack, botToken: mask(config.slack.botToken)!, appToken: mask(config.slack.appToken)! } }),
	};
}
