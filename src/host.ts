import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";

export const context = BACKGROUND_CONTEXT;

const dataDir = resolve(process.env.GAIDIN_DATA ?? "data");
const sandbox = resolve(dataDir, "sandbox");

// GAIDIN_MODEL=faux runs a scripted model with no network or key: it calls bash once
// (`sleep`, so there is time to kill the process), then answers with the tool output.
function chooseModel() {
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

export async function openHost() {
	mkdirSync(sandbox, { recursive: true });
	const { models, model } = chooseModel();
	const registry = createRegistry();
	registry.install(CodingTools);
	const harness = await Harness.open(
		await openNodeSqliteStorage(resolve(dataDir, "gaidin.sqlite")),
		{ models, registry, env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? sandbox }) },
		context,
	);
	const root = await harness.root(context, { agent: { model, cwd: sandbox } });
	harness.resume();
	return { harness, root };
}
