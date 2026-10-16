import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { AssistantEntry, type Conversation, createRegistry, defineEntry, defineExtension, type EntryRecord, Harness, type ModelRef } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { agentIdOf, createAgents, createRoster, sandboxOf } from "./agents.ts";
import { ApprovalService, approvalExtension } from "./approvals.ts";
import { createBudget } from "./budget.ts";
import { type Config, configFor, secretsOf, SETTINGS_DIR } from "./config.ts";
import { createHomelab, homelabGuards, type HomelabOptions } from "./extensions/homelab/index.ts";
import { createFetch, type FetchOptions } from "./fetch.ts";
import { createHistory } from "./history.ts";
import { createJobs, type Deliver, type Gate, jobOf, Jobs, pauseJob } from "./jobs.ts";
import { createMemory } from "./memory.ts";
import { type Adapter, type Adapters, createNotifications, type Notice, type Notifications } from "./notifications.ts";
import { ntfyAdapter } from "./ntfy.ts";
import { createPush, loadPushKeys, type Push, pushAdapter } from "./push.ts";
import { growingRedactor, type Redactor, redactionExtension } from "./redact.ts";
import { createConnectors, extensionOf } from "./connectors/index.ts";
import { createRules } from "./rules.ts";
import { createReminders, reminderOf, Reminders, removeReminder } from "./reminders.ts";
import { findBwrap, inside, prepareServerDirs, SandboxEnv } from "./sandbox.ts";
import { backendFor, type SearchBackend, searchGuards, webSearchTool } from "./search.ts";
import { createSelf } from "./self/index.ts";
import { createSkills } from "./skills.ts";
import { createThreads } from "./threads.ts";
import { setTimeZone } from "./time.ts";
import { createWorkspaces, readWorkspaces, type Remote, sshRemote, type Workspace } from "./workspaces.ts";
import { createAvatars, createUploads } from "./files.ts";
import { createBrowser } from "./browser/index.ts";
import type { ChromiumOptions } from "./browser/chromium.ts";

export const context = BACKGROUND_CONTEXT;

/** The text of an answer entry, if it is one and has any. */
export function assistantText(entry: EntryRecord | undefined): string | undefined {
	if (!AssistantEntry.is(entry)) return undefined;
	const message = entry.model?.[0];
	if (message?.role !== "assistant") return undefined;
	return message.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("") || undefined;
}

// The faux model runs a script with no network or key: it calls bash once (`sleep`, so there is time
// to kill the process), then answers with the tool output.
type Chosen = { models: Models; model: ModelRef };

function modelFor(config: Config): Chosen {
	if (config.model.provider === "faux") {
		const models = createModels();
		const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
		const step = (ctx: { messages: readonly { role: string; content?: unknown }[] }) => {
			const last = ctx.messages.at(-1);
			if (last?.role === "toolResult") return fauxAssistantMessage(fauxText(`Tool came back: ${JSON.stringify(last.content)}`));
			return fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 4 && date -Is >> slept.log && echo slept" }), { stopReason: "toolUse" });
		};
		faux.setResponses(Array.from({ length: 50 }, () => step));
		models.setProvider(faux.provider);
		return { models, model: { provider: "faux", modelId: "faux-1" } };
	}
	// The key comes from the settings, not from this process's environment.
	const models = createModels({
		authContext: {
			env: async (name) => (name === "ANTHROPIC_API_KEY" ? config.model.apiKey : undefined),
			fileExists: async () => false,
		},
	});
	models.setProvider(anthropicProvider());
	return { models, model: { provider: "anthropic", modelId: config.model.id } };
}

/**
 * When a conversation's history is summarised. Anthropic charges five times as much for every token of a request with over
 * 100,000 tokens of input, and Pi Durable times compaction from the model's context window, which is 1M for Haiku and
 * Sonnet 5.5, so the main conversation would cross that line long before compacting. gaidin gives Pi Durable a smaller
 * window instead (`workingWindow`): a summary starts in the background at about 60,000 tokens, and a request waits for
 * one above 85,000. The summary itself is held to 80% of `reserveTokens`.
 */
const COMPACTION = { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000, backgroundTokens: 25_000 };
const WORKING_WINDOW = 85_000 + COMPACTION.reserveTokens;

/** `models` with each model's context window cut to `tokens`. Only compaction reads the window; requests are unchanged. */
export function workingWindow(models: Models, tokens = WORKING_WINDOW): Models {
	return new Proxy(models, {
		get(target, key) {
			if (key === "getModel") {
				return (provider: string, id: string) => {
					const model = target.getModel(provider, id);
					return model === undefined ? undefined : { ...model, contextWindow: Math.min(model.contextWindow, tokens) };
				};
			}
			// SAFETY: a get trap is only asked for keys of the object it wraps.
			const value = target[key as keyof Models];
			return value instanceof Function ? value.bind(target) : value;
		},
	});
}

/** A run the owner stopped. Its note tells the model the request was withdrawn, so the next message doesn't pick it up again. */
export const RunStopped = defineEntry("gaidin.stopped");

export type HostOptions = {
	/** The settings. Default: defaults and the environment, without reading a file. */
	config?: Config;
	/** Replaces the settings' data directory. */
	dataDir?: string;
	models?: Models;
	model?: ModelRef;
	/** Replace the ways to reach the owner that the settings give; tests pass fakes that record what they're sent. */
	adapters?: Adapters;
	/** Replaces how the spend guard totals spend; tests use it. */
	spend?: (harness: Harness) => Promise<number>;
	/** Default: the secrets in the settings. */
	redactor?: Redactor;
	/** Replaces how the homelab extension reaches its feeds and hosts. */
	homelab?: HomelabOptions;
	/** How fetch_url resolves names and which addresses it refuses; tests replace them. */
	fetch?: FetchOptions;
	/** Replaces the settings' search backend; tests use it. */
	search?: SearchBackend;
	/** Machines gaidin can work on, and how to reach them. Default: the keys directory's `workspaces` file, over ssh. */
	workspaces?: { list: Workspace[]; remote: Remote | undefined };
	/** Replaces the settings' approvals.waitHours, in milliseconds. */
	approvalTimeoutMs?: number;
	/** Replaces the settings' sandbox: "none" runs shell commands without bubblewrap. */
	sandbox?: "bwrap" | "none";
	/** Replaces how Web Push reaches the push services; tests use it. */
	pushFetch?: typeof fetch;
	/** Replaces how connectors reach their servers; tests use it. */
	connectorFetch?: typeof fetch;
	/** Replaces web.url as where connectors' sign-ins come back to; the e2e server, which has no web.url, uses it. */
	connectorAppUrl?: string;
	/** Chromium's arguments, and how long profiles stay open and how many may be; tests use it. */
	chromium?: Pick<ChromiumOptions, "args" | "idleMs" | "maxOpen">;
};

export async function openHost(options: HostOptions = {}) {
	const config = options.config ?? configFor();
	setTimeZone(config.timeZone);
	const dir = options.dataDir ?? config.dataDir;
	const sandbox = resolve(dir, "sandbox");
	// Transcripts and tool output live here.
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	mkdirSync(sandbox, { recursive: true });
	// A symlink a command left in place of these before they were read-only to commands is replaced.
	await prepareServerDirs(sandbox);
	const chosen = options.models && options.model ? { models: options.models, model: options.model } : modelFor(config);
	const model = chosen.model;
	// Web Push needs the app's address, which push services are given as the sender's contact.
	const pushKeys = config.web?.url === undefined ? undefined : loadPushKeys(dir);
	let push: Push | undefined;
	// Made by start(), once the server can give it Slack. Tasks only run from then on, so nothing tells the owner before.
	let notifications: Notifications | undefined;
	const tell = async (notice: Notice) => {
		if (notifications === undefined) throw new Error("Something was to be told to the owner before the host started");
		await notifications.send(notice);
	};
	// The guard refuses the model lookup each request makes once a spend limit is reached.
	const budget = createBudget({ limits: config.budget, notify: (text) => tell({ kind: "budget", text }), spend: options.spend });
	const models = workingWindow(budget.guard(chosen.models));
	// A run the guard refused says so, wherever it's reported.
	const explain = (reason: string | undefined) => (reason === "no_model" ? budget.blocked() : undefined);
	const owner = config.owner;
	const reminders = createReminders((reminder) => tell({ kind: "reminder", reminder }), owner);
	// Connectors' tokens join the settings' secrets as they're given.
	const growing = growingRedactor({ ...secretsOf(config), PUSH_PRIVATE_KEY: pushKeys?.privateKey });
	const redactor = options.redactor ?? growing.redactor;
	const mode = options.sandbox ?? config.sandbox;
	const bwrap = mode === "bwrap" ? findBwrap() : undefined;
	// Fail closed: without bubblewrap, shell commands would reach everything the server can.
	if (mode === "bwrap" && bwrap === undefined) throw new Error('bwrap isn\'t on PATH. Install bubblewrap, or set "sandbox": "none" to run tools unconfined.');
	// The settings file can hold secrets; nothing in a box can read it, or anything else in the settings directory.
	const hide = config.file === undefined ? [SETTINGS_DIR] : [config.file, SETTINGS_DIR];

	const registry = createRegistry();
	// The agents' prompt comes first. A hand-off is a job, made once the jobs exist below.
	const agents = createAgents({ owner, dataDir: dir, handOff: (tx, id, work) => jobs.handOff(tx, id, work), handOffProblem: (read, ctx) => jobs.handOffProblem(read, ctx) });
	registry.install(agents.extension);
	registry.install(CodingTools);
	registry.install(reminders.extension);
	const memory = createMemory(owner);
	registry.install(memory.extension);
	const skills = createSkills(resolve(dir, "skills"), owner);
	registry.install(skills.extension);
	const homelab = config.homelab === undefined ? undefined : createHomelab(config.homelab, owner, config.keysDir, options.homelab);
	// Self-written tools are gates too, once they're loaded.
	let selfGates = (): Gate[] => [];
	const deliver: Deliver = (report) => tell(report.paused ? { kind: "paused", report } : { kind: "report", report });
	const jobs = createJobs({ deliver, owner, explain, gates: () => [...(homelab === undefined ? [] : [homelab.gate]), ...selfGates()] });
	registry.install(jobs.extension);
	if (homelab !== undefined) registry.install(homelab.extension);
	const web = createFetch(options.fetch, owner);
	registry.install(web.extension);
	const searchBackend = options.search ?? backendFor(config.search);
	const search = searchBackend === undefined ? undefined : webSearchTool(searchBackend, owner);
	if (search !== undefined) registry.install(defineExtension({ name: "search", tools: [search] }));
	const workspaces = createWorkspaces({
		workspaces: options.workspaces?.list ?? readWorkspaces(config.keysDir),
		remote: options.workspaces === undefined ? sshRemote(config.keysDir) : options.workspaces.remote,
		redactor,
		owner,
	});
	registry.install(workspaces.extension);
	const history = createHistory(resolve(dir, "history.sqlite"), owner);
	registry.install(history.extension);
	// Profiles are outside every sandbox, so no agent's commands can read their cookies.
	const browser = config.browser === undefined ? undefined : createBrowser({ profiles: config.browser.profiles, dir: resolve(dir, "browser"), dataDir: dir, owner, fetch: options.fetch, chromium: options.chromium, approvals: () => approvals!, read: () => harness });
	if (browser !== undefined) registry.install(browser.extension);
	// Their extensions are installed once the Harness is open and their document can be read.
	const connectors = createConnectors({ dir: resolve(dir, "connectors"), owner, registry, redactor: growing, root: () => root, roster: () => roster, fetch: options.connectorFetch, resolve: options.fetch?.resolve, appUrl: options.connectorAppUrl ?? config.web?.url, clientId: config.connectors?.clientId, tell: (notice) => tell(notice) });
	// Self-written tools only ever run in a box, so without bubblewrap there are none.
	const self = bwrap === undefined ? undefined : createSelf({ dataDir: dir, sandbox, bwrap, hide, registry, approvals: () => approvals!, owner, fetch: options.fetch });
	if (self !== undefined) {
		registry.install(self.extension);
		selfGates = self.gates;
	}
	// The service needs the Harness, which needs the registry; the hook reads it once calls start.
	let approvals: ApprovalService | undefined;
	// Each tool's approval rules, from the module that owns it; read per call, since self-written tools come and go.
	const guards = [...agents.guards, ...memory.guards, ...reminders.guards, ...jobs.guards, ...homelabGuards, ...web.guards, ...searchGuards, ...workspaces.guards, ...history.guards, ...skills.guards, ...(browser?.guards ?? [])];
	registry.install(approvalExtension(() => approvals!, owner, () => [...guards, ...(self?.guards() ?? []), ...connectors.guards()]));
	// Last, so its afterTool sees what every other hook left.
	registry.install(budget.extension);
	registry.install(redactionExtension(redactor));
	await self?.start();

	const harness = await Harness.open(
		await openNodeSqliteStorage(resolve(dir, "gaidin.sqlite")),
		{
			models,
			registry,
			settings: { compaction: COMPACTION },
			// Each agent's tools are confined to its own sandbox; a working directory outside it starts at its top.
			env: async ({ cwd, conversationId, read }) => {
				const root = sandboxOf(dir, await agentIdOf(read, conversationId, context));
				if (!existsSync(root)) {
					mkdirSync(root, { recursive: true });
					await prepareServerDirs(root);
				}
				const within = cwd !== undefined && existsSync(cwd) && inside(realpathSync(cwd), realpathSync(root));
				return new SandboxEnv({ root, cwd: within ? cwd : root, redactor, bwrap, hide });
			},
			onReport: (error) => console.error("[report]", error),
		},
		context,
	);
	history.attach(harness);
	approvals = new ApprovalService(harness, { timeoutMs: options.approvalTimeoutMs ?? config.approvals.waitHours * 3_600_000 });
	if (pushKeys !== undefined) push = createPush({ harness, keys: pushKeys, subject: config.web!.url!, fetch: options.pushFetch });
	// Requests and questions wait on the owner, so the owner hears of each, and of how it ended.
	approvals.onChange((request) => tell({ kind: "request", request }));
	const root = await harness.root(context, { agent: { model, cwd: sandbox } });
	await connectors.load();
	const roster = createRoster({
		harness,
		root,
		dataDir: dir,
		workspaces: () => workspaces.names,
		profiles: () => config.browser?.profiles ?? [],
		slackChannel: config.slack?.channelId,
		connectors: () => connectors.names(),
		connectorExtension: extensionOf,
		selfTools: () => self?.extensions() ?? [],
		archiving: async (tx, agent) => {
			for (const job of (await tx.doc(Jobs)).items.filter((j) => jobOf(j, agent))) await pauseJob(tx, job.taskId, "its agent was archived");
			for (const reminder of (await tx.doc(Reminders)).items.filter((r) => reminderOf(r, agent))) await removeReminder(tx, reminder.taskId, agent);
		},
	});
	await roster.start();
	const threads = createThreads(harness, roster);
	const rules = createRules({ harness, root: () => root, roster: () => roster });

	/** Starts the tasks, with `slack` among the ways to reach the owner when the server has it. */
	async function start(slack?: Adapter) {
		notifications = createNotifications({
			slack: slack ?? options.adapters?.slack,
			push: options.adapters?.push ?? (push === undefined ? undefined : pushAdapter(push)),
			ntfy: options.adapters?.ntfy ?? (config.ntfy === undefined ? undefined : ntfyAdapter(config.ntfy, config.web?.url)),
		});
		// After the root exists: the guard's first read would otherwise create it without its agent.
		await budget.attach(harness);
		harness.resume();
	}

	/**
	 * Stops a run in `conversation`, the root unless given, such as another agent's home. Returns whether there was one;
	 * if so, a note tells the model the owner withdrew its request.
	 */
	async function stop(conversation: Conversation = root): Promise<boolean> {
		// Stopping marks each task it aborts, so a newer marked task means something was running.
		const lastStopped = () => conversation.commit(async (tx) => (await tx.scanTasks({ conversationId: conversation.id, abortRequested: true, order: "descending" }, 1)).items[0]?.id, context);
		const before = await lastStopped();
		await conversation.abort(context);
		if ((await lastStopped()) === before) return false;
		const note = `[${owner} stopped the run above. Treat the request it was working on as withdrawn: don't continue or redo it unless ${owner} asks again.]`;
		await conversation.commit((tx) => tx.appendEntry(RunStopped, conversation.id, { model: [{ role: "user", content: note, timestamp: Date.now() }] }), context);
		return true;
	}

	// The tools the app can switch off: the coding tools, fetch_url (gaidin's only way to the internet), the history tools, the workspace tools
	// and the self-written ones.
	const builtIn = [...(CodingTools.tools ?? []), web.tool, ...(search === undefined ? [] : [search]), ...history.tools, ...workspaces.tools];
	const switchable = () => [...builtIn, ...(self?.tools() ?? [])];
	/** Closes the browser's profiles, then the Harness. */
	async function close() {
		await browser?.close();
		await connectors.close();
		await harness.close(context);
	}

	return { harness, root, agents: roster, workspaces: () => workspaces.names, profiles: () => config.browser?.profiles ?? [], takeOver: browser?.takeOver, connectors, rules, close, uploads: createUploads(join(dir, "app-uploads")), avatars: createAvatars(join(dir, "avatars")), threads, reminders, jobs, budget, explain, switchable, approvals, config, timeline: history.timeline, history: { conversations: history.conversations, conversation: history.conversation, latest: history.latest }, skills, sandbox, push, start, stop };
}

export type Host = Awaited<ReturnType<typeof openHost>>;

/** openHost, then start, for callers with no Slack to give it. */
export async function startHost(options: HostOptions = {}) {
	const host = await openHost(options);
	await host.start();
	return host;
}
