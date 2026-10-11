// Paused jobs in Slack: the report that a job paused after failing is posted to the gaidin channel with a
// button that resumes it. Once pressed, the button gives way to whether it did.
import type { Job, Report } from "./jobs.ts";
import type { SlackAction, SlackApi } from "./slack.ts";

/** Slack's mrkdwn treats these three as markup. */
const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function createSlackJobs(options: {
	api: SlackApi;
	channel: string;
	user: string;
	/** Resumes a paused job. Nothing if it isn't one. */
	resume: (id: number) => Promise<Job | undefined>;
}) {
	const { api, channel, user } = options;
	return {
		async post(report: Report) {
			// A section's text holds at most 3,000 characters.
			const markdown = `*${escape(report.title)}*\n\n${escape(report.text)}`;
			const line = { type: "section", text: { type: "mrkdwn", text: markdown.length > 2900 ? `${markdown.slice(0, 2900)}…` : markdown } };
			const resume = { type: "button", action_id: "gaidin-resume-job", text: { type: "plain_text", text: "Resume" }, value: String(report.taskId) };
			await api("chat.postMessage", { channel, text: `${report.title}: ${report.text}`, blocks: [line, { type: "actions", elements: [resume] }] });
		},
		/** A resume button press. Only the owner's, in the gaidin channel, count. */
		async action(payload: SlackAction) {
			if (payload.user?.id !== user || payload.channel?.id !== channel) return;
			for (const action of payload.actions ?? []) {
				if (action.action_id !== "gaidin-resume-job") continue;
				const resumed = await options.resume(Number(action.value));
				const message = payload.message;
				if (message === undefined) continue;
				const outcome = { type: "context", elements: [{ type: "mrkdwn", text: resumed === undefined ? "Not paused any more" : "Resumed" }] };
				const blocks = [...(message.blocks ?? []).filter((b) => b.type !== "actions"), outcome];
				await api("chat.update", { channel, ts: message.ts, text: message.text ?? "", blocks });
			}
		},
	};
}
