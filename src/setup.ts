// `gaidin setup`: writes the settings file one section at a time, each skippable and checked as it's entered
// with gaidin doctor's own checks. Run again, it shows each section with secrets shortened and changes only
// what's chosen. Nothing is written until the end, so stopping part-way leaves the file as it was. Settings it
// doesn't ask about, such as Slack's for now, the keys directory or the extensions, are kept as they are.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, chmodSync, chownSync, constants, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { type Config, DEFAULT_MODELS, type Loaded, loadConfig, mask, ntfyMask, type Section } from "./config.ts";
import type { Check } from "./doctor.ts";
import { attempt, dictionary, isObject, type Json, number, object, optional, ParseError, parseJson, string } from "./parse.ts";

/** Where questions are asked. `ask` throws Stopped at the end of input. */
export type Terminal = {
	ask: (question: string, secret: boolean) => Promise<string>;
	say: (line: string) => void;
};

/** The owner stopped answering (end of input), so nothing is written. */
export class Stopped extends Error {}

/** This machine on the tailnet, from `tailscale status`. `login` is absent for a tagged machine. */
export type Tailnet = { url: string; login?: string };

/** Everything setup reaches beyond the settings file; tests replace each. */
export type SetupDeps = {
	terminal: Terminal;
	env: NodeJS.ProcessEnv;
	model: (config: Config) => Promise<Check[]>;
	ntfy: (config: Config, push: boolean) => Promise<Check[]>;
	search: (config: Config) => Promise<Check[]>;
	tailscale: () => Tailnet | undefined;
	/** Runs gaidin doctor on the written settings and gives its exit code. */
	doctor: (loaded: Loaded) => Promise<number>;
};

/** Variables that override a setting setup writes (config.ts's fromEnv). */
const OVERRIDES = [
	["GAIDIN_OWNER", "owner"],
	["GAIDIN_TZ", "timeZone"],
	["ANTHROPIC_API_KEY", "model.apiKey"],
	["GAIDIN_MODEL_ID", "model.id"],
	["GAIDIN_BUDGET_DAILY", "budget.daily"],
	["GAIDIN_BUDGET_MONTHLY", "budget.monthly"],
	["GAIDIN_WEB_USER", "web.user"],
	["NTFY_URL", "ntfy.url"],
	["NTFY_TOKEN", "ntfy.token"],
	["TAVILY_API_KEY", "search.apiKey"],
] as const;

const NTFY_SH = "https://ntfy.sh";
const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** `section` with each of `changes` set, or taken out where it's undefined. */
function put(section: Section, changes: ReadonlyMap<string, Json | undefined>): Section {
	const next = new Map(Object.entries(section));
	for (const [key, value] of changes) {
		if (value === undefined) next.delete(key);
		else next.set(key, value);
	}
	return Object.fromEntries(next);
}

const sectionOf = (settings: Section, name: string): Section => {
	const value = settings[name];
	return isObject(value) ? value : {};
};
const textOf = (section: Section, key: string) => attempt(section[key], string);
const numberOf = (section: Section, key: string) => attempt(section[key], number);

/** What a field takes, beyond its question. `check` says what's wrong with an answer, or nothing. */
type Field = { current?: string | undefined; secret?: boolean; required?: boolean; check?: (answer: string) => string | undefined };

/** The questions and answers every section uses. */
class Wizard {
	readonly #deps: SetupDeps;
	readonly #file: string;

	constructor(deps: SetupDeps, file: string) {
		this.#deps = deps;
		this.#file = file;
	}

	say(line: string) {
		this.#deps.terminal.say(line);
	}

	/** The settings as gaidin would read them, without the environment, for checking what was just entered. */
	config(settings: Section): Loaded {
		return loadConfig({ file: this.#file, raw: settings, env: {} });
	}

	/** The answer to a field: Enter keeps `current`, and "-" clears a field that isn't required. */
	async field(question: string, field: Field): Promise<string | undefined> {
		const shown = field.current === undefined ? "" : ` [${field.secret === true ? mask(field.current) : field.current}]`;
		const hint = field.required === true || field.current === undefined ? "" : " (- for none)";
		for (;;) {
			const answer = await this.#deps.terminal.ask(`${question}${shown}${hint}: `, field.secret === true);
			if (answer === "-" && field.required !== true) return undefined;
			const value = answer === "" ? field.current : answer;
			if (value === undefined) {
				if (field.required !== true) return undefined;
				this.say("  This one needs an answer.");
				continue;
			}
			const problem = field.check?.(value);
			if (problem === undefined) return value;
			this.say(`  ${problem}`);
		}
	}

	/** A field that needs an answer. */
	async required(question: string, field: Field): Promise<string> {
		for (;;) {
			const answer = await this.field(question, { ...field, required: true });
			if (answer !== undefined) return answer;
		}
	}

	async yes(question: string, fallback: boolean): Promise<boolean> {
		for (;;) {
			const answer = (await this.#deps.terminal.ask(`${question} ${fallback ? "[Y/n]" : "[y/N]"}: `, false)).toLowerCase();
			if (answer === "") return fallback;
			if (answer === "y" || answer === "yes") return true;
			if (answer === "n" || answer === "no") return false;
		}
	}

	/** For a section that's set up: keep it, change it, or, where `removable`, take it out. */
	async choose(removable: boolean): Promise<"keep" | "change" | "remove"> {
		for (;;) {
			const answer = (await this.#deps.terminal.ask(removable ? "Keep, change or remove it? [K/c/r]: " : "Keep or change it? [K/c]: ", false)).toLowerCase();
			if (answer === "" || answer === "k" || answer === "keep") return "keep";
			if (answer === "c" || answer === "change") return "change";
			if (removable && (answer === "r" || answer === "remove")) return "remove";
		}
	}

	heading(title: string, lines: string[]) {
		this.say("");
		this.say(title);
		for (const line of lines) this.say(`  ${line}`);
	}

	/** Prints `checks`; true when none failed or the owner keeps the answers anyway. */
	async checked(area: string, checks: Promise<Check[]>): Promise<boolean> {
		const results = await checks.catch((error): Check[] => [{ status: "fail", area, detail: message(error) }]);
		for (const check of results) this.say(`  ${check.status}  ${check.detail}`);
		if (results.every((check) => check.status !== "fail")) return true;
		return !(await this.yes("Enter it again?", true));
	}

	/** The settings' warnings about `prefix`, such as an ntfy.sh topic without a token. */
	warnings(settings: Section, prefix: string) {
		for (const warning of this.config(settings).warnings) if (warning.startsWith(prefix)) this.say(`  warning: ${warning}`);
	}

	get deps() {
		return this.#deps;
	}
}

const validZone = (zone: string) => {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: zone });
		return undefined;
	} catch {
		return `There's no time zone "${zone}"; use a name like America/New_York.`;
	}
};
const dollars = (text: string) => (/^\d+(\.\d+)?$/.test(text) ? undefined : "A dollar amount, like 5 or 2.50; 0 is no limit.");

async function you(settings: Section, w: Wizard): Promise<Section> {
	const owner = textOf(settings, "owner");
	const zone = textOf(settings, "timeZone");
	const set = owner !== undefined || zone !== undefined;
	w.heading("You", set ? [`owner: ${owner ?? "not set"}`, `timeZone: ${zone ?? "the system's"}`] : []);
	if (set && (await w.choose(false)) === "keep") return settings;
	const name = await w.required("Your name, as gaidin calls you", { current: owner });
	const timeZone = await w.required("Your time zone", { current: zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone, check: validZone });
	return put(settings, new Map([["owner", name], ["timeZone", timeZone]]));
}

async function model(settings: Section, w: Wizard): Promise<Section> {
	let modelSection = sectionOf(settings, "model");
	const budget = sectionOf(settings, "budget");
	const key = textOf(modelSection, "apiKey");
	const id = textOf(modelSection, "id");
	const daily = numberOf(budget, "daily");
	const monthly = numberOf(budget, "monthly");
	if (textOf(modelSection, "provider") === "faux") {
		w.heading("The model", ["the faux model: scripted answers, no key; take model.provider out of the settings for a real one"]);
		return settings;
	}
	const set = key !== undefined;
	w.heading("The model", set ? [`apiKey: ${mask(key)}`, `id: ${id ?? DEFAULT_MODELS[0]}`, `budget: $${daily ?? 5} a day, ${monthly ? `$${monthly}` : "no limit"} a month`] : []);
	if (set && (await w.choose(false)) === "keep") return settings;

	if (!set) w.say("gaidin uses Claude through an Anthropic API key. Make one in a Console workspace of its own with a spend limit (console.anthropic.com).");
	for (;;) {
		const apiKey = await w.required("API key", { current: key, secret: true, check: (k) => (k.startsWith("sk-ant-") ? undefined : "An Anthropic API key starts with sk-ant-.") });
		const modelId = await w.required(`Model new conversations start with (${DEFAULT_MODELS.join(", ")})`, { current: id ?? DEFAULT_MODELS[0] });
		modelSection = put(modelSection, new Map([["apiKey", apiKey], ["id", modelId]]));
		if (await w.checked("model", w.deps.model(w.config(put(settings, new Map([["model", modelSection]]))).config))) break;
	}

	w.say("gaidin stops making model requests when a day's or a month's spend reaches its limit. Set the Console workspace's own limit too, which Anthropic enforces.");
	const day = await w.required("Daily limit in dollars, 0 for none", { current: String(daily ?? 5), check: dollars });
	const month = await w.required("Monthly limit in dollars, 0 for none", { current: String(monthly ?? 0), check: dollars });
	const limits = put(budget, new Map([["daily", Number(day)], ["monthly", Number(month)]]));
	return put(settings, new Map([["model", modelSection], ["budget", limits]]));
}

async function api(settings: Section, w: Wizard): Promise<Section> {
	const web = sectionOf(settings, "web");
	const user = textOf(web, "user");
	const url = textOf(web, "url");
	const set = user !== undefined;
	w.heading("The API", set ? [`user: ${user}`, `url: ${url ?? "not set"}`] : []);
	w.say("gaidin's HTTP API, reached through Tailscale, is for a client of your own and voice bridges; its address also lets devices sign up for Web Push and connectors sign in.");
	const tailnet = w.deps.tailscale();
	if (set) {
		const choice = await w.choose(true);
		if (choice === "keep") return settings;
		if (choice === "remove") return put(settings, new Map([["web", undefined]]));
	} else if (!(await w.yes("Set it up?", tailnet !== undefined))) return settings;

	w.say(tailnet === undefined ? "Tailscale isn't logged in here, so enter its values yourself." : `On the tailnet, this machine is ${tailnet.url}.`);
	const login = await w.required("The Tailscale login let in, such as you@example.com", { current: user ?? tailnet?.login });
	const address = await w.field("The API's address", {
		current: url ?? tailnet?.url,
		check: (a) => (/^https?:\/\/[^/]+\/?$/.test(a) ? undefined : "An address like https://gaidin.example.ts.net, with no path."),
	});
	const port = numberOf(web, "port") ?? 8410;
	w.say(`Tailscale serve has to proxy to port ${port}: sudo tailscale serve --bg --yes ${port}. On the VM, install.sh does it.`);
	return put(settings, new Map([["web", put(web, new Map([["user", login], ["url", address?.replace(/\/$/, "")]]))]]));
}

async function notifications(settings: Section, w: Wizard): Promise<Section> {
	let ntfy = sectionOf(settings, "ntfy");
	const url = textOf(ntfy, "url");
	const token = textOf(ntfy, "token");
	const set = url !== undefined;
	w.heading("Notifications through ntfy", set ? [`url: ${ntfyMask(url)}`, `token: ${token === undefined ? "none" : mask(token)}`] : []);
	w.say("Reminders, job reports and requests for approval reach your phone through an ntfy topic, whose long random name keeps it private.");
	if (set) {
		const choice = await w.choose(true);
		if (choice === "keep") return settings;
		if (choice === "remove") return put(settings, new Map([["ntfy", undefined]]));
	} else if (!(await w.yes("Set it up?", true))) return settings;

	for (;;) {
		const server = await w.required("ntfy server", {
			current: url?.replace(/\/[^/]+\/?$/, "") ?? NTFY_SH,
			check: (s) => (/^https?:\/\/[^/\s]+(\/[^/\s]+)*\/?$/.test(s) ? undefined : "A server's address, like https://ntfy.sh."),
		});
		const topic = url !== undefined && !(await w.yes("Make a new topic name?", false)) ? url.replace(/^.*\//, "") : `gaidin-${randomBytes(18).toString("base64url")}`;
		const secret = await w.field("Access token, if the topic needs one", { current: token, secret: true });
		const topicUrl = `${server.replace(/\/$/, "")}/${topic}`;
		ntfy = put(ntfy, new Map([["url", topicUrl], ["token", secret]]));
		const next = put(settings, new Map([["ntfy", ntfy]]));
		w.warnings(next, "ntfy.url");
		if (topicUrl !== url) w.say(`Subscribe to this topic in the ntfy app (setup shows it only now): ${topicUrl}`);
		if (!(await w.checked("ntfy", w.deps.ntfy(w.config(next).config, false)))) continue;
		if (await w.yes("Send a test notification?", true)) await w.checked("ntfy", w.deps.ntfy(w.config(next).config, true));
		return next;
	}
}

async function search(settings: Section, w: Wizard): Promise<Section> {
	const section = sectionOf(settings, "search");
	const key = textOf(section, "apiKey");
	const set = key !== undefined;
	w.heading("Web search", set ? [`provider: ${textOf(section, "provider") ?? "tavily"}`, `apiKey: ${mask(key)}`] : []);
	w.say("web_search uses a Tavily API key (tavily.com). Without one, gaidin reads only pages it's given or finds by fetching.");
	if (set) {
		const choice = await w.choose(true);
		if (choice === "keep") return settings;
		if (choice === "remove") return put(settings, new Map([["search", undefined]]));
	} else if (!(await w.yes("Set it up?", true))) return settings;

	for (;;) {
		const apiKey = await w.required("Tavily API key", { current: key, secret: true, check: (k) => (k.startsWith("tvly-") ? undefined : "A Tavily key starts with tvly-.") });
		const next = put(settings, new Map([["search", put(section, new Map([["provider", "tavily"], ["apiKey", apiKey]]))]]));
		if (await w.checked("search", w.deps.search(w.config(next).config))) return next;
	}
}

const SECTIONS = [you, model, api, notifications, search];

/** Writes `settings` in place of `file` in one step, keeping an existing file's mode and owner; a new one is the owner's alone. */
function writeSettings(file: string, settings: Section) {
	const temp = join(dirname(file), `.${basename(file)}.${process.pid}.tmp`);
	writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600, flag: "wx" });
	if (existsSync(file)) {
		const old = statSync(file);
		chmodSync(temp, old.mode & 0o777);
		if (process.getuid?.() === 0) chownSync(temp, old.uid, old.gid);
	}
	renameSync(temp, file);
}

/** Runs the questions and writes `file`; gives the exit code. */
export async function setup(file: string, deps: SetupDeps): Promise<number> {
	const say = (line: string) => deps.terminal.say(line);
	let settings: Section = {};
	const exists = existsSync(file);
	if (exists) {
		try {
			// JSON.parse gives only JSON values.
			const parsed: Json = JSON.parse(readFileSync(file, "utf8"));
			if (!isObject(parsed)) throw new Error("it doesn't hold a JSON object");
			settings = parsed;
		} catch (error) {
			say(`Can't read ${file}: ${message(error)}. Fix or move it, then run setup again.`);
			return 1;
		}
	}
	try {
		accessSync(dirname(file), constants.W_OK);
	} catch {
		say(`Can't write to ${dirname(file)}, where the settings go. Run setup as a user who can.`);
		return 1;
	}
	say(exists ? `Settings: ${file}` : `Settings: ${file}, a new file`);
	say("Enter keeps what's in brackets. Nothing is written until the end.");
	const overridden = OVERRIDES.filter(([name]) => (deps.env[name] ?? "") !== "");
	if (overridden.length > 0) say(`These variables override what you enter: ${overridden.map(([name, setting]) => `${name} (${setting})`).join(", ")}.`);

	const before = JSON.stringify(settings);
	const wizard = new Wizard(deps, file);
	try {
		for (const section of SECTIONS) settings = await section(settings, wizard);
	} catch (error) {
		if (!(error instanceof Stopped)) throw error;
		say("");
		say("Stopped; nothing written.");
		return 1;
	}
	say("");
	if (JSON.stringify(settings) === before) say("Nothing changed.");
	else {
		writeSettings(file, settings);
		say(`Wrote ${file}. Checking everything with gaidin doctor:`);
	}
	say("");
	return deps.doctor(loadConfig({ file }));
}

const tailscaleStatus = object({
	Self: object({ DNSName: string, UserID: optional(number) }),
	User: optional(dictionary(object({ LoginName: string }))),
});

/** This machine's address on the tailnet and the login it belongs to, or nothing without a logged-in Tailscale. */
export function readTailscale(): Tailnet | undefined {
	const result = spawnSync("tailscale", ["status", "--json"], { encoding: "utf8", timeout: 10_000 });
	if (result.status !== 0) return undefined;
	try {
		const status = parseJson(result.stdout, tailscaleStatus, "tailscale status");
		const host = status.Self.DNSName.replace(/\.$/, "");
		if (host === "") return undefined;
		const tailnet: Tailnet = { url: `https://${host}` };
		const login = status.Self.UserID === undefined ? undefined : status.User?.get(String(status.Self.UserID))?.LoginName;
		if (login !== undefined && login !== "tagged-devices") tailnet.login = login;
		return tailnet;
	} catch (error) {
		if (error instanceof ParseError) return undefined;
		throw error;
	}
}

/** Questions on the terminal, with secrets not echoed. Lines piped in are answered in order. */
export function consoleTerminal(): Terminal {
	let muted = false;
	const output = new Writable({
		write(chunk, _encoding, done) {
			if (!muted) process.stdout.write(chunk);
			done();
		},
	});
	const tty = process.stdin.isTTY === true;
	const lines = createInterface({ input: process.stdin, output, terminal: tty });
	lines.on("SIGINT", () => {
		process.stdout.write("\nStopped; nothing written.\n");
		process.exit(130);
	});
	const answers = lines[Symbol.asyncIterator]();
	return {
		say: (line) => process.stdout.write(`${line}\n`),
		ask: async (question, secret) => {
			if (secret && tty) {
				process.stdout.write(question);
				muted = true;
			} else {
				lines.setPrompt(question);
				lines.prompt();
			}
			try {
				const next = await answers.next();
				if (next.done === true) throw new Stopped();
				return next.value.trim();
			} finally {
				if (muted) process.stdout.write("\n");
				muted = false;
			}
		},
	};
}
