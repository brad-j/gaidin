// Slack for tests: createSlack with a fake Web API that records every call, and a fake connection the test
// sends messages and button presses through.
import type { Host } from "../src/host.ts";
import { createSlack, type SlackAction, type SlackApi, type SlackDownload, type SlackHandlers, type SlackMessage } from "../src/slack/index.ts";

export const CHANNEL = "C1";
export const BRAD = "U1";
export const SETTINGS = { botToken: "xoxb-test", appToken: "xapp-test", channelId: CHANNEL, userId: BRAD };

export type Call = { method: string; body: Record<string, any>; ts?: string };

/** A message from Brad in the gaidin channel, unless `extra` says otherwise. */
export function message(ts: string, text: string, extra: Partial<SlackMessage> = {}): SlackMessage {
	return { type: "message", channel: CHANNEL, user: BRAD, ts, text, ...extra };
}

/** A press of `action_id` with `value`, by Brad in the gaidin channel unless `extra` says otherwise. */
export function press(action_id: string, value: string, extra: Partial<SlackAction> = {}): SlackAction {
	return { type: "block_actions", user: { id: BRAD }, channel: { id: CHANNEL }, actions: [{ action_id, value }], ...extra };
}

/**
 * Slack for `host`, started. Every Web API call but auth.test is in `calls`; each post gets the ts `bot.<n>`. auth.test
 * answers with `scopes`, which have chat:write.customize unless given. `api` replaces the fake Web API, such as one that
 * never answers.
 */
export function fakeSlack(host: Host, options: { api?: SlackApi; download?: SlackDownload; scopes?: string[] } = {}) {
	const calls: Call[] = [];
	let posted = 0;
	const scopes = options.scopes ?? ["channels:history", "groups:history", "chat:write", "chat:write.customize", "files:read"];
	const api: SlackApi = options.api ?? (async (method, body) => {
		if (method === "auth.test") return { scopes };
		const call: Call = { method, body: body as Record<string, any> };
		if (method === "chat.postMessage") call.ts = `bot.${++posted}`;
		calls.push(call);
		return call.ts === undefined ? {} : { ts: call.ts };
	});
	let handlers: SlackHandlers | undefined;
	const slack = createSlack(SETTINGS, host, {
		api,
		download: options.download,
		connect: (given) => {
			handlers = given;
			return { stop() {} };
		},
	});
	slack.start();
	return {
		slack,
		calls,
		/** The answers posted as markdown, as Slack would show them. */
		posts: () => calls.filter((c) => c.body.markdown_text !== undefined).map((c) => (c.body.thread_ts === undefined ? { text: c.body.markdown_text as string, ts: c.ts! } : { text: c.body.markdown_text as string, ts: c.ts!, threadTs: c.body.thread_ts as string })),
		receive: (event: SlackMessage) => handlers!.event(event),
		press: (action: SlackAction) => handlers!.action(action),
	};
}
