# Surfaces

All three surfaces talk to the same root conversation ([Concepts](concepts.md)). Slack and the web view are optional; each starts only when its settings are present.

## Command line

`gaidin ask` and `gaidin watch` (`src/cli.ts`) talk to the server over the Unix socket in the data directory, so it has to run on the same machine, as a user who can open the socket.

```sh
gaidin ask "what's on my list?"
gaidin ask --id oven-1 "..."    # rerunning the same id reattaches instead of asking twice
gaidin watch                    # follow everything until Ctrl+C
```

On the VM, `setup.sh`'s `gaidin` command runs as the service's user. `gaidin ask` prints the request id it used, so you can reattach if the connection drops.

## Slack

gaidin answers in one channel, for one Slack user, over Socket Mode, so the server needs no inbound port. It answers every top-level message you post in the channel; you don't need to mention it. Replies in a thread go to that thread's [fork](concepts.md#forks). It ignores other people, other channels, bots and edited messages. A thread on a message it never answered gets a note instead of a fork.

Answers are posted as Markdown, which Slack renders. Answers over 12,000 characters go out as several messages. Requests for [approval](security.md#approvals) arrive as a message with buttons, in the thread when the conversation is a thread's fork, and the message changes to show the outcome once you answer from either surface.

### Setting up Slack

1. At api.slack.com/apps, choose Create New App > From a manifest, pick your workspace, and paste `deploy/slack-manifest.yaml` (choose YAML). It turns on Socket Mode and interactivity and asks for the scopes gaidin needs.
2. Install to Workspace. The Bot User OAuth Token (`xoxb-`) is `SLACK_BOT_TOKEN`.
3. Under Basic Information > App-Level Tokens, generate a token with the `connections:write` scope. That token (`xapp-`) is `SLACK_APP_TOKEN`.
4. Create a channel for gaidin and run `/invite @gaidin` in it. A channel can't share the bot's name. The channel ID, at the bottom of the channel details, is `SLACK_CHANNEL_ID`.
5. Your own member ID (your profile > ⋯ > Copy member ID) is `SLACK_USER_ID`.
6. Optionally, under Basic Information > Display Information, upload a PNG of `assets/logo.svg` as the app icon. The manifest can't set it.

Put the four values in the `slack` section of the settings ([Deploying](deploy.md#settings)). The server refuses to start with only some of them.

Give gaidin its own channel. In a channel shared with another bot, both would answer every message.

## Web view

The web view shows the root conversation live and lets you act on it:

- your messages and its answers from every surface, with tool calls you can expand to see their arguments and output while they run
- fired reminders, and the cost so far for this conversation and in total
- a message box, a Stop button, and pending approvals at the top
- open reminders, with Cancel
- the model, thinking level, standing instructions, and switches for the coding tools, `fetch_url` and the workspace tools

It shows no keys or Slack settings, and turning a tool off there is the quickest way to take it away from the model.

### How it's reached

The server listens on `127.0.0.1` at `web.port` (default 8410) and nowhere else. [Tailscale Serve](https://tailscale.com/kb/1312/serve) puts HTTPS in front of it on the machine's tailnet name:

```sh
sudo tailscale serve --bg --yes 8410
```

Serve removes any identity headers a client sends and adds `Tailscale-User-Login` for requests from a person's device. The server answers only the login in `web.user` and returns 403 to everyone else, including tagged devices, which get no identity. POSTs need a JSON body and an `Origin` matching the page, so another site open in your browser can't drive it.

Without `web.user` there's no web view. The page is `web/index.html` and `web/app.ts`; Node strips the TypeScript types as it serves the file, so there's no build step.
