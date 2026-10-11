// Reminders in Slack: each one that fires is posted to the gaidin channel with buttons that snooze it, like
// the buttons on its push. Once pressed, the message shows when it'll come back.
import { integer, object, parseJson } from "./parse.ts";
import type { Reminder } from "./reminders.ts";
import type { SlackAction, SlackApi } from "./slack.ts";
import { formatTime } from "./time.ts";

const SNOOZES = [
	["Snooze 10 min", 10],
	["Snooze 1 h", 60],
] as const;

/** Slack's mrkdwn treats these three as markup. */
const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function blocks(text: string, buttons: { id: number } | { until: number }) {
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

export function createSlackReminders(options: {
	api: SlackApi;
	channel: string;
	user: string;
	/** Sets a fired reminder again, `minutes` from now. Nothing if it isn't one. */
	snooze: (id: number, minutes: number) => Promise<Reminder | undefined>;
}) {
	const { api, channel, user } = options;
	return {
		async post(reminder: Reminder) {
			await api("chat.postMessage", { channel, text: reminder.text, blocks: blocks(reminder.text, { id: reminder.taskId }) });
		},
		/** A snooze button press. Only the owner's, in the gaidin channel, count. */
		async action(payload: SlackAction) {
			if (payload.user?.id !== user || payload.channel?.id !== channel) return;
			for (const action of payload.actions ?? []) {
				if (!action.action_id.startsWith("gaidin-snooze-")) continue;
				const { id, minutes } = parseJson(action.value ?? "", object({ id: integer, minutes: integer }), "the snooze button's value");
				const snoozed = await options.snooze(id, minutes);
				if (snoozed !== undefined && payload.message?.ts !== undefined) {
					await api("chat.update", { channel, ts: payload.message.ts, text: snoozed.text, blocks: blocks(snoozed.text, { until: snoozed.at }) });
				}
			}
		},
	};
}
