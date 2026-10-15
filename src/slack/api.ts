// Slack's Web API, file downloads, and the shapes of what Slack sends as gaidin reads them. Calls go through a
// SlackApi and downloads through a SlackDownload, so tests can stand in for Slack with a function each.
import { array, boolean, json, type Json, number, object, optional, parse, string } from "../parse.ts";

/** The fields of a file in a Slack message this uses. */
export type SlackFile = { name?: string; mimetype?: string; size?: number; url_private?: string; thumb_1024?: string };
export const slackFile = object({ name: optional(string), mimetype: optional(string), size: optional(number), url_private: optional(string), thumb_1024: optional(string) });

/** Downloads a Slack file's private URL with the bot token. */
export type SlackDownload = (url: string) => Promise<Buffer>;

/** The fields of a Slack `message` event this uses. */
export type SlackMessage = {
	type: string;
	channel?: string;
	user?: string;
	text?: string;
	ts: string;
	thread_ts?: string;
	subtype?: string;
	bot_id?: string;
	files?: SlackFile[];
};
export const slackMessage = object({
	type: string,
	channel: optional(string),
	user: optional(string),
	text: optional(string),
	ts: string,
	thread_ts: optional(string),
	subtype: optional(string),
	bot_id: optional(string),
	files: optional(array(slackFile)),
});

/** Posts markdown, under `name` when given, and returns the ts of each message it made. */
export type SlackPost = (channel: string, markdown: string, threadTs?: string, name?: string) => Promise<string[]>;

/** A Web API call's body. */
export type SlackBody = { readonly [field: string]: Json | undefined };

/** What chat.postMessage is given here: markdown, or fallback text with blocks. */
export type SlackPostBody = { channel: string; thread_ts?: string; markdown_text?: string; text?: string; blocks?: Json[] };

/** Calls a Slack Web API method with the bot token; throws unless Slack answers ok. `scopes` are the token's, as Slack says with each answer. */
export type SlackApi = (method: string, body: SlackBody) => Promise<{ ts?: string; scopes?: string[] }>;

export function slackApi(botToken: string): SlackApi {
	return async (method, body) => {
		const response = await fetch(`https://slack.com/api/${method}`, {
			method: "POST",
			headers: { Authorization: `Bearer ${botToken}`, "Content-Type": "application/json; charset=utf-8" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(15_000),
		});
		const answer = parse(await response.json(), object({ ok: boolean, error: optional(string), ts: optional(string) }), `Slack's answer to ${method}`);
		if (!answer.ok) throw new Error(`${method}: ${answer.error ?? response.status}`);
		const scopes = response.headers.get("x-oauth-scopes")?.split(",").map((s) => s.trim());
		return scopes === undefined ? answer : { ...answer, scopes };
	};
}

/** The scope that lets the app post under another name, as each agent other than the default one does. */
export const CUSTOMIZE = "chat:write.customize";

/**
 * Posting as an agent: under its name when the app has CUSTOMIZE, otherwise under the app's name with the agent's in
 * front. `check` asks Slack which scopes the app has; until it knows, a post tries the name and falls back when Slack
 * refuses it for want of the scope.
 */
export function slackVoice(api: SlackApi) {
	let customize: boolean | undefined;
	return {
		api,
		async check(): Promise<void> {
			try {
				const { scopes } = await api("auth.test", {});
				if (scopes !== undefined) customize = scopes.includes(CUSTOMIZE);
			} catch {
				// Asked again by the posts themselves.
			}
		},
		/** chat.postMessage under `name`, or the app's own when it's undefined. */
		async postMessage(body: SlackPostBody, name?: string): Promise<{ ts?: string }> {
			if (name === undefined) return api("chat.postMessage", body);
			if (customize !== false) {
				try {
					return await api("chat.postMessage", { ...body, username: name });
				} catch (error) {
					if (!(error instanceof Error && error.message.includes("missing_scope"))) throw error;
					customize = false;
				}
			}
			return api("chat.postMessage", named(body, name));
		},
	};
}

export type SlackVoice = ReturnType<typeof slackVoice>;

/** `body` with `name` in front, for a post under the app's own name. */
function named(body: SlackPostBody, name: string): SlackPostBody {
	const out = { ...body };
	if (body.markdown_text !== undefined) out.markdown_text = `*${name}:* ${body.markdown_text}`;
	if (body.text !== undefined) out.text = `${name}: ${body.text}`;
	if (body.blocks !== undefined) out.blocks = [{ type: "context", elements: [{ type: "mrkdwn", text: `*${name}*` }] }, ...body.blocks];
	return out;
}

export function slackDownload(botToken: string): SlackDownload {
	return async (url) => {
		// The URL comes from the event; the token goes only where Slack keeps files.
		if (!URL.canParse(url) || new URL(url).origin !== "https://files.slack.com") throw new Error(`Files are downloaded only from https://files.slack.com, not ${url}`);
		const response = await fetch(url, { headers: { Authorization: `Bearer ${botToken}` }, signal: AbortSignal.timeout(30_000) });
		if (!response.ok) throw new Error(`Slack answered ${response.status}`);
		// Without the files:read scope, Slack answers with its sign-in page.
		if (response.headers.get("content-type")?.startsWith("text/html")) throw new Error("Slack sent a web page; the app needs the files:read scope");
		return Buffer.from(await response.arrayBuffer());
	};
}

/** chat.postMessage with Slack rendering the markdown. Longer answers go out in several messages. */
export function slackPoster(voice: SlackVoice): SlackPost {
	return async (channel, markdown, threadTs, name) => {
		const posted: string[] = [];
		for (const chunk of chunks(markdown, 12_000)) {
			const { ts } = await voice.postMessage({ channel, markdown_text: chunk, thread_ts: threadTs }, name);
			if (ts === undefined) throw new Error("chat.postMessage: no ts");
			posted.push(ts);
		}
		return posted;
	};
}

function chunks(text: string, size: number): string[] {
	const out: string[] = [];
	let rest = text;
	while (rest.length > size) {
		const cut = rest.lastIndexOf("\n", size);
		const at = cut > size / 2 ? cut : size;
		out.push(rest.slice(0, at));
		rest = rest.slice(at).replace(/^\n/, "");
	}
	out.push(rest);
	return out;
}

/** The fields of a Slack block_actions payload (a button press) this uses. */
export type SlackAction = {
	type: string;
	user?: { id: string };
	channel?: { id: string };
	/** The message the button is on, with its blocks as Slack sent them. */
	message?: { ts: string; text?: string; blocks?: Json[] };
	actions?: { action_id: string; value?: string }[];
};
export const slackAction = object({
	type: string,
	user: optional(object({ id: string })),
	channel: optional(object({ id: string })),
	message: optional(object({ ts: string, text: optional(string), blocks: optional(array(json)) })),
	actions: optional(array(object({ action_id: string, value: optional(string) }))),
});
