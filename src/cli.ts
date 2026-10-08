// Usage: node src/cli.ts <request-id> "<prompt>"
// Rerunning with the same request id after a crash reattaches to the same submission.
import { AssistantEntry, watchEvents } from "@earendil-works/pi-durable";
import { context, openHost } from "./host.ts";

const [requestId, prompt] = process.argv.slice(2);
if (!requestId || !prompt) {
	console.error('usage: node src/cli.ts <request-id> "<prompt>"');
	process.exit(2);
}

const { harness, root } = await openHost();
const events = await watchEvents(harness, root.id, context);
events.start(async (batch) => {
	for (const event of batch) {
		if (event.type === "tool_execution_start") console.log(`[tool] ${event.toolName} ${JSON.stringify(event.args)}`);
		if (event.type === "tool_execution_end") console.log(`[tool] ${event.toolName} done`);
		if (event.type === "task_failed") console.log(`[task failed] ${event.kind}: ${event.message}`);
	}
});

const submission = await root.submit({ type: "input", content: prompt, requestId }, context);
const settled = await submission.wait(context);
if (settled.status === "done" && settled.type === "input") {
	const entry = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
	const message = entry?.model?.[0];
	const text = message?.role === "assistant"
		? message.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("")
		: "";
	console.log(`[answer] ${text}`);
} else {
	console.log(`[unanswered] ${JSON.stringify(settled)}`);
}
await events.stop();
await harness.close(context);
