import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { AssistantEntry, createRegistry, defineExtension, type EntryRecord, Harness, type ModelRef, section } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { createHomelab, type FetchJson } from "./homelab.ts";
import { ntfyNotifier } from "./ntfy.ts";
import { RedactingEnv, type Redactor, redactionExtension, redactorFromEnv } from "./redact.ts";
import { createReminders, type Notify } from "./reminders.ts";
import { timeZone } from "./time.ts";

export const context = BACKGROUND_CONTEXT;

/** The text of an answer entry, if it is one and has any. */
export function assistantText(entry: EntryRecord | undefined): string | undefined {
	if (!AssistantEntry.is(entry)) return undefined;
	const message = entry.model?.[0];
	if (message?.role !== "assistant") return undefined;
	return message.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("") || undefined;
}

export function dataDir(): string {
	return resolve(process.env.GAIDIN_DATA ?? "data");
}

// GAIDIN_MODEL=faux runs a scripted model with no network or key: it calls bash once
// (`sleep`, so there is time to kill the process), then answers with the tool output.
function modelFromEnv(): { models: Models; model: ModelRef } {
	const models = createModels();
	if (process.env.GAIDIN_MODEL === "faux") {
		const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
		const step = (ctx: { messages: readonly { role: string; content?: unknown }[] }) => {
			const last = ctx.messages.at(-1);
			if (last?.role === "toolResult") {
				const text = JSON.stringify(last.content);
				return fauxAssistantMessage(fauxText(`Tool came back: ${text}`));
			}
			return fauxAssistantMessage(
				fauxToolCall("bash", { command: "sleep 4 && date -Is >> slept.log && echo slept" }),
				{ stopReason: "toolUse" },
			);
		};
		faux.setResponses(Array.from({ length: 50 }, () => step));
		models.setProvider(faux.provider);
		return { models, model: { provider: "faux", modelId: "faux-1" } };
	}
	models.setProvider(anthropicProvider()); // reads ANTHROPIC_API_KEY
	return { models, model: { provider: "anthropic", modelId: process.env.GAIDIN_MODEL_ID ?? "claude-haiku-5-5" } };
}

const Persona = defineExtension({
	name: "persona",
	sections: [
		section(
			"preamble",
			() =>
				"You are gaidin, Brad's personal agent. Be brief and direct. " +
				`Each of Brad's messages starts with the local time in brackets; his time zone is ${timeZone}. ` +
				"Use the reminder tools for anything he wants to be reminded of, and read back the time the tool reports.",
			{ tag: false },
		),
	],
});

export type HostOptions = {
	dataDir?: string;
	models?: Models;
	model?: ModelRef;
	notify?: Notify;
	/** Defaults to the credentials in the environment. */
	redactor?: Redactor;
	/** How the homelab tool fetches its feeds; tests replace it. */
	homelabFetch?: FetchJson;
};

export async function openHost(options: HostOptions = {}) {
	const dir = options.dataDir ?? dataDir();
	const sandbox = resolve(dir, "sandbox");
	// Transcripts and tool output live here.
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	mkdirSync(sandbox, { recursive: true });
	const { models, model } = options.models && options.model
		? { models: options.models, model: options.model }
		: modelFromEnv();
	const reminders = createReminders(options.notify ?? ntfyNotifier());
	const redactor = options.redactor ?? redactorFromEnv();
	const registry = createRegistry();
	registry.install(Persona);
	registry.install(CodingTools);
	registry.install(reminders.extension);
	registry.install(createHomelab(options.homelabFetch));
	// Last, so its afterTool sees what every other hook left.
	registry.install(redactionExtension(redactor));
	const harness = await Harness.open(
		await openNodeSqliteStorage(resolve(dir, "gaidin.sqlite")),
		{
			models,
			registry,
			env: ({ cwd }) => new RedactingEnv({ cwd: cwd ?? sandbox, redactor }),
			onReport: (error) => console.error("[report]", error),
		},
		context,
	);
	const root = await harness.root(context, { agent: { model, cwd: sandbox } });
	harness.resume();
	return { harness, root, reminders };
}
