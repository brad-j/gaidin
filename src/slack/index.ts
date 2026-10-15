// Slack: one channel where the owner talks to gaidin (conversation.ts) and where gaidin posts what it tells
// the owner, with buttons (notifications.ts), over Socket Mode (socket.ts) and the Web API (api.ts).
//
// Only the owner's messages and button presses in the gaidin channel count. That's checked here, once, before
// either part sees them.
import type { SlackConfig } from "../config.ts";
import { context, type Host } from "../host.ts";
import { resumeJob } from "../jobs.ts";
import { type SlackAction, type SlackApi, slackApi, type SlackDownload, slackDownload, type SlackMessage, slackPoster } from "./api.ts";
import { createSlackConversation } from "./conversation.ts";
import { createSlackNotifications } from "./notifications.ts";
import { socketMode } from "./socket.ts";

export { recordPosted, SlackState } from "./conversation.ts";
export type { SlackAction, SlackApi, SlackDownload, SlackMessage } from "./api.ts";

/** What a connection hands on: each message event, and each button press. */
export type SlackHandlers = { event: (event: SlackMessage) => Promise<void>; action: (action: SlackAction) => Promise<void> };
/** Opens a connection that hands Slack's events to `handlers` until it's stopped. */
export type SlackConnect = (handlers: SlackHandlers) => { stop(): void };

/**
 * Slack for `host`, from its settings. `ports` replace how it reaches Slack: the Web API, file downloads and the
 * Socket Mode connection; tests use them.
 */
export function createSlack(settings: SlackConfig, host: Host, ports: { api?: SlackApi; download?: SlackDownload; connect?: SlackConnect; retryDelayMs?: number } = {}) {
	const { harness, root, threads, approvals, explain, sandbox, reminders } = host;
	const channel = settings.channelId;
	const api = ports.api ?? slackApi(settings.botToken);
	const conversation = createSlackConversation({
		harness,
		root,
		threads,
		post: slackPoster(api),
		channel,
		explain,
		approvals,
		files: { download: ports.download ?? slackDownload(settings.botToken), sandbox },
		retryDelayMs: ports.retryDelayMs,
	});
	const notifications = createSlackNotifications({
		harness,
		root,
		approvals,
		api,
		channel,
		snooze: (id, minutes) => root.commit((tx) => reminders.snooze(tx, id, minutes), context),
		resume: (id) => root.commit((tx) => resumeJob(tx, id), context),
	});
	const fromOwner = (user: string | undefined, at: string | undefined) => user === settings.userId && at === channel;
	const connect = ports.connect ?? ((handlers) => socketMode(settings.appToken, handlers));
	let connection: { stop(): void } | undefined;

	return {
		/** The way notifications reach the owner in Slack; the host's start takes it. */
		adapter: notifications.adapter,
		/** Posts a message sent from the app in its conversation's Slack thread, if it has one, and then its answer. */
		mirror: conversation.mirror,
		/** Answers messages and asks requests left from before a restart, and connects. */
		start() {
			void conversation.recover();
			notifications.recover().catch((error) => console.error("[slack] approvals:", error));
			connection = connect({
				event: async (event) => (fromOwner(event.user, event.channel) ? conversation.receive(event) : undefined),
				action: async (action) => (fromOwner(action.user?.id, action.channel?.id) ? notifications.action(action) : undefined),
			});
		},
		stop() {
			connection?.stop();
		},
	};
}
