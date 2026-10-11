// Approval requests and questions in Slack: a message with buttons in the gaidin channel, in the thread
// when the conversation is a thread's fork, updated with the outcome once it's decided anywhere. A
// question is answered with a button or a reply in its thread (src/slack.ts hands those over).
import type { Harness } from "@earendil-works/pi-durable";
import type { ApprovalRequest, ApprovalService, Decision } from "./approvals.ts";
import { context } from "./host.ts";
import type { SlackAction, SlackApi } from "./slack.ts";
import { SlackState } from "./slack.ts";
import { formatTime } from "./time.ts";

const DECISIONS: readonly Decision[] = ["once", "always", "deny"];

/** Slack's mrkdwn treats these three as markup. */
function escape(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const OUTCOME: Record<Exclude<ApprovalRequest["status"], "pending">, string> = {
	approved: "Allowed",
	denied: "Denied",
	answered: "Answered",
	expired: "No answer in time",
	cancelled: "No longer needed: the run stopped",
	superseded: "Skipped: you sent a new message instead",
};

function questionBlocks(request: ApprovalRequest): { text: string; blocks: unknown[] } {
	const question = escape(request.summary);
	if (request.status !== "pending") {
		const outcome = request.status === "answered" ? `Answered: ${escape(request.answer ?? "")}` : OUTCOME[request.status];
		return { text: `gaidin asked: ${request.summary}`, blocks: [{ type: "section", text: { type: "mrkdwn", text: `gaidin asked: ${question}\n*${outcome}*` } }] };
	}
	const blocks: unknown[] = [
		{ type: "section", text: { type: "mrkdwn", text: `*gaidin asks:* ${question}` } },
	];
	if (request.choices !== undefined && request.choices.length > 0) {
		blocks.push({
			type: "actions",
			block_id: "gaidin-question",
			elements: request.choices.map((choice, i) => ({
				type: "button",
				action_id: `gaidin-answer-${i}`,
				text: { type: "plain_text", text: choice },
				value: JSON.stringify({ id: request.id, answer: choice }),
			})),
		});
	}
	blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `Reply in this thread to answer in your own words. Waits until ${formatTime(request.expiresAt)}.` }] });
	return { text: `gaidin asks: ${request.summary}`, blocks };
}

export function blocksFor(request: ApprovalRequest): { text: string; blocks: unknown[] } {
	if (request.kind === "question") return questionBlocks(request);
	const what = `\`${escape(request.summary)}\``;
	if (request.status !== "pending") {
		const how = request.decision === "always" && request.always !== undefined ? request.always.done : request.decision === "once" ? "Allowed once" : OUTCOME[request.status];
		const outcome = `${how}${request.by ? ` in ${request.by === "slack" ? "Slack" : "the web view"}` : ""}`;
		const text = `gaidin asked to ${request.summary}. ${outcome}.`;
		return { text, blocks: [{ type: "section", text: { type: "mrkdwn", text: `gaidin asked to ${what}\n*${outcome}.*` } }] };
	}
	const value = (decision: Decision) => JSON.stringify({ id: request.id, decision });
	const buttons: unknown[] = [
		{ type: "button", action_id: "gaidin-approve-once", style: "primary", text: { type: "plain_text", text: "Allow once" }, value: value("once") },
	];
	if (request.always !== undefined) {
		buttons.push({ type: "button", action_id: "gaidin-approve-always", text: { type: "plain_text", text: request.always.label.slice(0, 75) }, value: value("always") });
	}
	buttons.push({ type: "button", action_id: "gaidin-deny", style: "danger", text: { type: "plain_text", text: "Deny" }, value: value("deny") });
	// A section holds 3000 characters, so a long detail is cut and the web view has the rest.
	const detail = request.detail === undefined ? [] : [{
		type: "section",
		text: { type: "mrkdwn", text: request.detail.length > 2600 ? `\`\`\`${escape(request.detail.slice(0, 2600))}\`\`\`\n_Cut here; the web view shows all of it._` : `\`\`\`${escape(request.detail)}\`\`\`` },
	}];
	return {
		text: `gaidin wants to ${request.summary}`,
		blocks: [
			{ type: "section", text: { type: "mrkdwn", text: `gaidin wants to ${what}\n_Waits until ${formatTime(request.expiresAt)}._` } },
			...detail,
			{ type: "actions", block_id: "gaidin-approval", elements: buttons },
		],
	};
}

export function createSlackApprovals(options: { harness: Harness; approvals: ApprovalService; api: SlackApi; channel: string; user: string }) {
	const { harness, approvals, api, channel, user } = options;

	/** The thread a conversation lives in, if it's a thread's fork. */
	async function threadOf(conversationId: number): Promise<string | undefined> {
		const threads = (await harness.snapshot(SlackState, context))?.threads ?? {};
		return Object.entries(threads).find(([, id]) => id === conversationId)?.[0];
	}

	async function ask(request: ApprovalRequest) {
		const thread = await threadOf(request.conversationId);
		const { ts } = await api("chat.postMessage", { channel, ...blocksFor(request), ...(thread === undefined ? {} : { thread_ts: thread }) });
		if (ts !== undefined) await approvals.note(request.id, { slackTs: ts });
	}

	async function show(request: ApprovalRequest) {
		// The ts is stored after posting, so read it back rather than trusting the event's copy.
		const ts = (await approvals.state()).requests[request.id]?.slackTs;
		if (ts === undefined) return;
		await api("chat.update", { channel, ts, ...blocksFor(request) });
	}

	approvals.onChange((request) => (request.status === "pending" ? ask(request) : show(request)));

	return {
		/** A button press. Only the owner's, in the gaidin channel, count. */
		async action(payload: SlackAction) {
			if (payload.user?.id !== user || payload.channel?.id !== channel) return;
			for (const action of payload.actions ?? []) {
				if (!action.action_id.startsWith("gaidin-")) continue;
				let parsed: { id?: unknown; decision?: unknown; answer?: unknown };
				try {
					parsed = JSON.parse(action.value ?? "");
				} catch {
					continue;
				}
				if (typeof parsed.id !== "string") continue;
				let decided;
				if (action.action_id.startsWith("gaidin-answer-") && typeof parsed.answer === "string") {
					decided = await approvals.answer(parsed.id, parsed.answer, "slack");
				} else if (DECISIONS.includes(parsed.decision as Decision)) {
					decided = await approvals.decide(parsed.id, parsed.decision as Decision, "slack");
				} else continue;
				// Already decided elsewhere: refresh the message so its buttons go away.
				if (decided === undefined) {
					const current = (await approvals.state()).requests[parsed.id];
					if (current !== undefined) await show(current);
				}
			}
		},
		/** Asks for requests that came up while Slack was unreachable, and closes stale ones. */
		async recover() {
			for (const request of await approvals.pending()) {
				if (request.slackTs === undefined) await ask(request);
			}
		},
	};
}
