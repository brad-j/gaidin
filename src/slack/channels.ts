// Which Slack channel is which agent's. The settings' slack.channelId is the default agent's, and another agent's roster
// entry can name one of its own; an agent without one has its notices in the default agent's channel, under its name.
//
// Slack's message ts is unique only within a channel, so SlackState keys a message in another agent's channel as
// <channel>:<ts>. The default channel's keep the bare ts they had before there were others, so nothing stored changes.
import { DEFAULT_AGENT, type RosterService } from "../agents.ts";

export function createChannels(home: string, roster: Pick<RosterService, "list">) {
	return {
		/** The default agent's channel, the settings'. */
		home,
		/** The agent `channel` is for, or nothing when it's no agent's or its agent is archived. */
		async agentIn(channel: string | undefined): Promise<string | undefined> {
			if (channel === undefined) return undefined;
			if (channel === home) return DEFAULT_AGENT;
			return (await roster.list()).find((a) => a.id !== DEFAULT_AGENT && a.channel === channel && a.archived === undefined)?.id;
		},
		/** Where `agent`'s notices go: its own channel, or the default agent's when it has none. */
		async channelOf(agent: string | undefined): Promise<string> {
			if (agent === undefined || agent === DEFAULT_AGENT) return home;
			return (await roster.list()).find((a) => a.id === agent)?.channel ?? home;
		},
		/** The name `agent` posts under, or nothing for the default agent, which posts as the app. */
		async nameOf(agent: string | undefined): Promise<string | undefined> {
			if (agent === undefined || agent === DEFAULT_AGENT) return undefined;
			return (await roster.list()).find((a) => a.id === agent)?.name ?? agent;
		},
		/** A message's key in SlackState. */
		key: (channel: string | undefined, ts: string) => (channel === undefined || channel === home ? ts : `${channel}:${ts}`),
		/** The channel and ts a key names. */
		place: (key: string) => {
			const at = key.indexOf(":");
			return at < 0 ? { channel: home, ts: key } : { channel: key.slice(0, at), ts: key.slice(at + 1) };
		},
	};
}

export type Channels = ReturnType<typeof createChannels>;
