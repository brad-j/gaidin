import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { AssistantEntry, createRegistry, defineExtension, type EntryRecord, Harness, type ModelRef, section } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { ApprovalService, approvalExtension } from "./approvals.ts";
import { createBudget } from "./budget.ts";
import { type Config, configFor, secretsOf } from "./config.ts";
import { createHomelab, type HomelabOptions } from "./extensions/homelab/index.ts";
import { createFetch, type FetchOptions } from "./fetch.ts";
import { createHistory } from "./history.ts";
import { createJobs, type Deliver } from "./jobs.ts";
import { createMemory } from "./memory.ts";
import { ntfyNotifier, ntfyReporter } from "./ntfy.ts";
import { type Redactor, redactionExtension, redactorFor } from "./redact.ts";
import { createReminders, type Notify } from "./reminders.ts";
import { findBwrap, SandboxEnv } from "./sandbox.ts";
import { backendFor, type SearchBackend, webSearchTool } from "./search.ts";
import { createSelf } from "./self/index.ts";
import { setTimeZone, timeZone } from "./time.ts";
import { createWorkspaces, readWorkspaces, type Remote, sshRemote, type Workspace } from "./workspaces.ts";

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
function modelFor(config: Config): { models: Models; model: ModelRef } {
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

function persona(owner: string) {
	return defineExtension({
		name: "persona",
		sections: [
			section(
				"preamble",
				() =>
					`You are gaidin, ${owner}'s personal agent. Be brief and direct. ` +
					`Each of ${owner}'s messages starts with the local time in brackets, in the ${timeZone()} time zone. ` +
					`Use the reminder tools for anything ${owner} wants to be reminded of, and read back the time the tool reports. ` +
					`Use schedule_job for work to do later or on a schedule: briefings, regular checks, and watches. ` +
					`When you tell ${owner} you'll check on something later, schedule it, so it happens. ` +
					`When you need a decision only ${owner} can make, ask with ask_owner and wait for the answer rather than guessing. ` +
					`Before saying you don't know something ${owner} may have told you, search past conversations with search_history. ` +
					`When ${owner} asks for the same kind of thing again and load_extension is available, offer to write a tool for it, and write it only once ${owner} says yes. ` +
					"The bash tool runs in a sandbox with no network: curl, package installs and git clone fail there. " +
					"Reach the internet with fetch_url, and web_search when it's available. If a tool fails, say what failed rather than guessing a cause.",
				{ tag: false },
			),
		],
	});
}

export type HostOptions = {
	/** The settings. Default: defaults and the environment, without reading a file. */
	config?: Config;
	/** Replaces the settings' data directory. */
	dataDir?: string;
	models?: Models;
	model?: ModelRef;
	notify?: Notify;
	/** Where scheduled jobs' reports go. Default: ntfy, or the server's output. The server sends them to Slack with `setDeliver`. */
	deliver?: Deliver;
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
};

export async function openHost(options: HostOptions = {}) {
	const config = options.config ?? configFor();
	setTimeZone(config.timeZone);
	const dir = options.dataDir ?? config.dataDir;
	const sandbox = resolve(dir, "sandbox");
	// Transcripts and tool output live here.
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	mkdirSync(sandbox, { recursive: true });
	const chosen = options.models && options.model ? { models: options.models, model: options.model } : modelFor(config);
	const model = chosen.model;
	// The guard refuses the model lookup each request makes once a spend limit is reached.
	const ntfyText = ntfyReporter(config.ntfy);
	let budgetNotify = (text: string) => ntfyText({ title: "budget", text });
	const budget = createBudget({ limits: config.budget, notify: () => budgetNotify, ...(options.spend === undefined ? {} : { spend: options.spend }) });
	const models = budget.guard(chosen.models);
	// A run the guard refused says so, wherever it's reported.
	const explain = (reason: string | undefined) => (reason === "no_model" ? budget.blocked() : undefined);
	const owner = config.owner;
	const push = options.notify ?? ntfyNotifier(config.ntfy, config.web?.url);
	// The server also posts reminders to Slack, with snooze buttons. That's extra: a failure there is logged, not retried.
	let alsoNotify: Notify | undefined;
	const reminders = createReminders(async (reminder) => {
		await push(reminder);
		await alsoNotify?.(reminder).catch((error) => console.error("[reminder] Slack:", error));
	}, owner);
	const redactor = options.redactor ?? redactorFor(secretsOf(config));
	const mode = options.sandbox ?? config.sandbox;
	const bwrap = mode === "bwrap" ? findBwrap() : undefined;
	// Fail closed: without bubblewrap, shell commands would reach everything the server can.
	if (mode === "bwrap" && bwrap === undefined) throw new Error('bwrap isn\'t on PATH. Install bubblewrap, or set "sandbox": "none" to run tools unconfined.');
	// The settings file can hold secrets; nothing in a box can read it.
	const hide = config.file === undefined ? [] : [config.file];

	const registry = createRegistry();
	registry.install(persona(owner));
	registry.install(CodingTools);
	registry.install(reminders.extension);
	registry.install(createMemory(owner));
	let deliver: Deliver = options.deliver ?? ntfyReporter(config.ntfy);
	const jobs = createJobs({ deliver: () => deliver, owner, explain });
	registry.install(jobs.extension);
	if (config.homelab !== undefined) registry.install(createHomelab(config.homelab, owner, config.keysDir, options.homelab));
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
	// Self-written tools only ever run in a box, so without bubblewrap there are none.
	const self = bwrap === undefined ? undefined : createSelf({ dataDir: dir, sandbox, bwrap, hide, registry, approvals: () => approvals!, owner, fetch: options.fetch });
	if (self !== undefined) registry.install(self.extension);
	// The service needs the Harness, which needs the registry; the hook reads it once calls start.
	let approvals: ApprovalService | undefined;
	registry.install(approvalExtension(() => approvals!, owner));
	// Last, so its afterTool sees what every other hook left.
	registry.install(budget.extension);
	registry.install(redactionExtension(redactor));
	await self?.start();

	const harness = await Harness.open(
		await openNodeSqliteStorage(resolve(dir, "gaidin.sqlite")),
		{
			models,
			registry,
			env: ({ cwd }) => new SandboxEnv({ root: sandbox, cwd: cwd ?? sandbox, redactor, bwrap, hide }),
			onReport: (error) => console.error("[report]", error),
		},
		context,
	);
	history.attach(harness);
	approvals = new ApprovalService(harness, { timeoutMs: options.approvalTimeoutMs ?? config.approvals.waitHours * 3_600_000 });
	const root = await harness.root(context, { agent: { model, cwd: sandbox } });
	// After the root exists: the guard's first read would otherwise create it without its agent.
	await budget.attach(harness);
	harness.resume();
	// The tools the web view can switch off: the coding tools, fetch_url (gaidin's only way to the internet), the history tools, the workspace tools
	// and the self-written ones.
	const builtIn = [...(CodingTools.tools ?? []), web.tool, ...(search === undefined ? [] : [search]), ...history.tools, ...workspaces.tools];
	const switchable = () => [...builtIn, ...(self?.tools() ?? [])];
	const setAlsoNotify = (next: Notify) => {
		alsoNotify = next;
	};
	const setDeliver = (next: Deliver) => {
		deliver = next;
	};
	const setBudgetNotify = (next: (text: string) => Promise<void>) => {
		budgetNotify = next;
	};
	return { harness, root, reminders, jobs, setDeliver, setAlsoNotify, budget, setBudgetNotify, explain, switchable, approvals, config, timeline: history.timeline, sandbox };
}
