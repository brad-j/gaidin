// Notifications in Slack (notifications.ts): reminders with snooze buttons, job reports, a paused job with a
// Resume button, budget warnings, and requests for approval and questions with their buttons. Each goes to the
// channel of the agent it's from (channels.ts), under its name; budget warnings to the default agent's. A request is
// asked in the thread when its conversation is a thread's, and its message shows the outcome once it's decided
// anywhere; a reply in a report's thread continues that run's conversation. Presses on these buttons come back
// through `action`; index.ts hands it only the owner's, in the agents' channels. Messages the owner writes are
// conversation.ts's.
import type { Conversation, Harness } from "@earendil-works/pi-durable";
import type { ApprovalRequest, ApprovalService, Decision } from "../approvals.ts";
import { context } from "../host.ts";
import type { Job, Report } from "../jobs.ts";
import type { Adapter } from "../notifications.ts";
import { integer, isObject, type Json, literal, object, optional, parseJson, string } from "../parse.ts";
import type { Reminder } from "../reminders.ts";
import { formatTime } from "../time.ts";
import { type SlackAction, slackPoster, type SlackVoice } from "./api.ts";
import type { Channels } from "./channels.ts";
import { recordPosted, SlackState } from "./conversation.ts";

/** What an approval or answer button carries, as blocksFor writes it. */
const buttonValue = object({ id: string, decision: optional(literal<Decision>("once", "always", "deny")), answer: optional(string) });
const APPROVAL_ACTIONS = /^gaidin-(approve-|deny$|answer-)/;

const SNOOZES = [
	["Snooze 10 min", 10],
	["Snooze 1 h", 60],
] as const;

/** Slack's mrkdwn treats these three as markup. */
function escape(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const OUTCOME = {
	approved: "Allowed",
	denied: "Denied",
	answered: "Answered",
	expired: "No answer in time",
	cancelled: "No longer needed: the run stopped",
	superseded: "Skipped: you sent a new message instead",
} satisfies Record<Exclude<ApprovalRequest["status"], "pending">, string>;

/** A Slack message's fallback text and its blocks. */
type Message = { text: string; blocks: Json[] };

function questionBlocks(request: ApprovalRequest): Message {
	const question = escape(request.summary);
	if (request.status !== "pending") {
		const outcome = request.status === "answered" ? `Answered: ${escape(request.answer ?? "")}` : OUTCOME[request.status];
		return { text: `gaidin asked: ${request.summary}`, blocks: [{ type: "section", text: { type: "mrkdwn", text: `gaidin asked: ${question}\n*${outcome}*` } }] };
	}
	const blocks: Json[] = [
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

/** A hand-over: what the agent needs, a link to the profile's page in the app when there's one, and Done and Can't. */
function handOverBlocks(request: ApprovalRequest, app: string | undefined): Message {
	const profile = request.profile ?? "";
	const head = `gaidin asks you to take over browser profile *${escape(profile)}*: ${escape(request.summary)}`;
	if (request.status !== "pending") {
		const outcome = request.status === "approved" ? "Done" : request.status === "denied" ? "You couldn't" : OUTCOME[request.status];
		const where = request.by === undefined ? "" : ` in ${request.by === "slack" ? "Slack" : "the app"}`;
		return { text: `gaidin asked you to take over ${profile}: ${request.summary}`, blocks: [{ type: "section", text: { type: "mrkdwn", text: `${head}\n*${outcome}${where}.*` } }] };
	}
	const value = (decision: Decision) => JSON.stringify({ id: request.id, decision });
	const buttons: Json[] = [];
	if (app !== undefined) buttons.push({ type: "button", action_id: "gaidin-handover-open", style: "primary", text: { type: "plain_text", text: "Take over" }, url: `${app}/browser/${encodeURIComponent(profile)}` });
	buttons.push(
		{ type: "button", action_id: "gaidin-approve-once", text: { type: "plain_text", text: "Done" }, value: value("once") },
		{ type: "button", action_id: "gaidin-deny", style: "danger", text: { type: "plain_text", text: "Can't" }, value: value("deny") },
	);
	return {
		text: `gaidin asks you to take over ${profile}: ${request.summary}`,
		blocks: [
			{ type: "section", text: { type: "mrkdwn", text: `${head}\n_Its browser calls wait while you're there. Waits until ${formatTime(request.expiresAt)}._` } },
			{ type: "actions", block_id: "gaidin-approval", elements: buttons },
		],
	};
}

/** `app`: the app's address, for a hand-over's link. */
export function blocksFor(request: ApprovalRequest, app?: string): Message {
	if (request.kind === "question") return questionBlocks(request);
	if (request.kind === "handover") return handOverBlocks(request, app);
	const what = `\`${escape(request.summary)}\``;
	if (request.status !== "pending") {
		const how = request.decision === "always" && request.always !== undefined ? request.always.done : request.decision === "once" ? "Allowed once" : OUTCOME[request.status];
		const outcome = `${how}${request.by ? ` in ${request.by === "slack" ? "Slack" : "the app"}` : ""}`;
		const text = `gaidin asked to ${request.summary}. ${outcome}.`;
		return { text, blocks: [{ type: "section", text: { type: "mrkdwn", text: `gaidin asked to ${what}\n*${outcome}.*` } }] };
	}
	const value = (decision: Decision) => JSON.stringify({ id: request.id, decision });
	const buttons: Json[] = [
		{ type: "button", action_id: "gaidin-approve-once", style: "primary", text: { type: "plain_text", text: "Allow once" }, value: value("once") },
	];
	if (request.always !== undefined) {
		buttons.push({ type: "button", action_id: "gaidin-approve-always", text: { type: "plain_text", text: request.always.label.slice(0, 75) }, value: value("always") });
	}
	buttons.push({ type: "button", action_id: "gaidin-deny", style: "danger", text: { type: "plain_text", text: "Deny" }, value: value("deny") });
	// A section holds 3000 characters, so a long detail is cut and the app has the rest.
	const detail = request.detail === undefined ? [] : [{
		type: "section",
		text: { type: "mrkdwn", text: request.detail.length > 2600 ? `\`\`\`${escape(request.detail.slice(0, 2600))}\`\`\`\n_Cut here; the app shows all of it._` : `\`\`\`${escape(request.detail)}\`\`\`` },
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

/** A fired reminder, with snooze buttons, or once snoozed, when it comes back. */
function reminderBlocks(text: string, buttons: { id: number } | { until: number }): Json[] {
	const line = { type: "section", text: { type: "mrkdwn", text: `:alarm_clock: ${escape(text)}` } };
	if ("until" in buttons) return [line, { type: "context", elements: [{ type: "mrkdwn", text: `Snoozed until ${formatTime(buttons.until)}` }] }];
	const elements = SNOOZES.map(([label, minutes]) => ({
		type: "button",
		action_id: `gaidin-snooze-${minutes}`,
		text: { type: "plain_text", text: label },
		value: JSON.stringify({ id: buttons.id, minutes }),
	}));
	return [line, { type: "actions", elements }];
}

/** A job that paused, with a button that resumes it. */
function pausedBlocks(report: Report): Json[] {
	// A section's text holds at most 3,000 characters.
	const markdown = `*${escape(report.title)}*\n\n${escape(report.text)}`;
	const line = { type: "section", text: { type: "mrkdwn", text: markdown.length > 2900 ? `${markdown.slice(0, 2900)}…` : markdown } };
	const resume = { type: "button", action_id: "gaidin-resume-job", text: { type: "plain_text", text: "Resume" }, value: String(report.taskId) };
	return [line, { type: "actions", elements: [resume] }];
}

export function createSlackNotifications(options: {
	harness: Harness;
	root: Conversation;
	approvals: ApprovalService;
	voice: SlackVoice;
	channels: Channels;
	/** Sets a fired reminder again, `minutes` from now. Nothing if it isn't one. */
	snooze: (id: number, minutes: number) => Promise<Reminder | undefined>;
	/** Resumes a paused job. Nothing if it isn't one. */
	resume: (id: number) => Promise<Job | undefined>;
	/** The app's address, which a hand-over links to. */
	app?: string;
}) {
	const { harness, root, approvals, voice, channels } = options;
	const { api } = voice;
	const post = slackPoster(voice);

	/** The thread a conversation lives in, if it's a thread's: its channel and ts. */
	async function threadOf(conversationId: number): Promise<{ channel: string; ts: string } | undefined> {
		const threads = (await harness.snapshot(SlackState, context))?.threads ?? {};
		const key = Object.entries(threads).find(([, id]) => id === conversationId)?.[0];
		return key === undefined ? undefined : channels.place(key);
	}

	/** Asks in the conversation's thread, or else the agent's channel, under the agent's name. */
	async function ask(request: ApprovalRequest) {
		const thread = await threadOf(request.conversationId);
		const channel = thread?.channel ?? (await channels.channelOf(request.agent));
		const { ts } = await voice.postMessage({ channel, ...blocksFor(request, options.app), thread_ts: thread?.ts }, await channels.nameOf(request.agent));
		if (ts === undefined) return;
		if (channel === channels.home) await approvals.note(request.id, { slackTs: ts });
		else await approvals.note(request.id, { slackTs: ts, slackChannel: channel });
	}

	async function show(request: ApprovalRequest) {
		// The ts is stored after posting, so read it back rather than trusting the event's copy.
		const stored = (await approvals.state()).requests[request.id];
		if (stored?.slackTs === undefined) return;
		await api("chat.update", { channel: stored.slackChannel ?? channels.home, ts: stored.slackTs, ...blocksFor(request, options.app) });
	}

	const adapter: Adapter = {
		async send(notice) {
			switch (notice.kind) {
				case "reminder": {
					const { reminder } = notice;
					const channel = await channels.channelOf(reminder.agent);
					await voice.postMessage({ channel, text: reminder.text, blocks: reminderBlocks(reminder.text, { id: reminder.taskId }) }, await channels.nameOf(reminder.agent));
					return true;
				}
				case "report": {
					// A thread on the report continues that run's conversation.
					const { report } = notice;
					const channel = await channels.channelOf(report.agent);
					const posted = await post(channel, `*${report.title}*\n\n${report.text}`, undefined, await channels.nameOf(report.agent));
					if (report.answer !== undefined) await recordPosted(root, posted.map((ts) => channels.key(channel, ts)), report.answer, report.conversationId);
					return true;
				}
				case "paused": {
					const { report } = notice;
					const channel = await channels.channelOf(report.agent);
					await voice.postMessage({ channel, text: `${report.title}: ${report.text}`, blocks: pausedBlocks(report) }, await channels.nameOf(report.agent));
					return true;
				}
				case "budget":
					await post(channels.home, notice.text);
					return true;
				case "request":
					if (notice.request.status === "pending") await ask(notice.request);
					else await show(notice.request);
					return true;
			}
		},
	};

	/** A press on an approval, question, snooze or Resume button. */
	/** `channelOf`: the channel the pressed message is in. */
	async function press(action: { action_id: string; value?: string }, message: SlackAction["message"], channelOf: string) {
		if (APPROVAL_ACTIONS.test(action.action_id)) {
			const parsed = parseJson(action.value ?? "", buttonValue, "the button's value");
			let decided;
			if (action.action_id.startsWith("gaidin-answer-") && parsed.answer !== undefined) {
				decided = await approvals.answer(parsed.id, parsed.answer, "slack");
			} else if (parsed.decision !== undefined) {
				decided = await approvals.decide(parsed.id, parsed.decision, "slack");
			} else return;
			// Already decided elsewhere: refresh the message so its buttons go away.
			if (decided === undefined) {
				const current = (await approvals.state()).requests[parsed.id];
				if (current !== undefined) await show(current);
			}
		} else if (action.action_id.startsWith("gaidin-snooze-")) {
			const { id, minutes } = parseJson(action.value ?? "", object({ id: integer, minutes: integer }), "the snooze button's value");
			const snoozed = await options.snooze(id, minutes);
			if (snoozed !== undefined && message !== undefined) {
				await api("chat.update", { channel: channelOf, ts: message.ts, text: snoozed.text, blocks: reminderBlocks(snoozed.text, { until: snoozed.at }) });
			}
		} else if (action.action_id === "gaidin-resume-job") {
			const resumed = await options.resume(Number(action.value));
			if (message === undefined) return;
			const outcome = { type: "context", elements: [{ type: "mrkdwn", text: resumed === undefined ? "Not paused any more" : "Resumed" }] };
			const blocks = [...(message.blocks ?? []).filter((b) => !isObject(b) || b.type !== "actions"), outcome];
			await api("chat.update", { channel: channelOf, ts: message.ts, text: message.text ?? "", blocks });
		}
	}

	return {
		adapter,
		/** A button press. */
		async action(payload: SlackAction) {
			for (const action of payload.actions ?? []) await press(action, payload.message, payload.channel?.id ?? channels.home);
		},
		/** Asks for requests that came up while Slack was unreachable. */
		async recover() {
			for (const request of await approvals.pending()) {
				if (request.slackTs === undefined) await ask(request);
			}
		},
	};
}
