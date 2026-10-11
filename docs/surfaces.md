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

Files can come with a message. Images, such as screenshots, go to the model with the text; one over 3.75 MB goes as Slack's 1024-pixel preview. Other files, up to 20 MB, are saved in the sandbox as `uploads/<message ts>-<name>`, and the message tells gaidin where, so it reads text with its file tools and a PDF with `pdftotext`. A file that can't be fetched is noted in the message instead. An image stays in the conversation's context until compaction, so it costs tokens on each later turn there; a thread keeps that cost out of the channel's conversation.

Reports from [scheduled jobs](tools.md#scheduled-jobs) are posted as messages of their own, headed with the job's title; a reply in a report's thread continues that run's conversation. Answers are posted as Markdown, which Slack renders. Answers over 12,000 characters go out as several messages. Questions from [`ask_owner`](tools.md#questions) arrive the same way, with a button per choice; a reply in the question's thread answers it in your own words, and so does your next message in that conversation. Requests for [approval](security.md#approvals) arrive as a message with buttons, in the thread when the conversation is a thread's fork, and the message changes to show the outcome once you answer from either surface.

### Setting up Slack

1. At api.slack.com/apps, choose Create New App > From a manifest, pick your workspace, and paste `deploy/slack-manifest.yaml` (choose YAML). It turns on Socket Mode and interactivity and asks for the scopes gaidin needs. An app made before `files:read` was added needs that scope added under OAuth & Permissions and the app reinstalled, or files in messages come back as Slack's sign-in page and are noted as unreadable.
2. Install to Workspace. The Bot User OAuth Token (`xoxb-`) is `SLACK_BOT_TOKEN`.
3. Under Basic Information > App-Level Tokens, generate a token with the `connections:write` scope. That token (`xapp-`) is `SLACK_APP_TOKEN`.
4. Create a channel for gaidin and run `/invite @gaidin` in it. A channel can't share the bot's name. The channel ID, at the bottom of the channel details, is `SLACK_CHANNEL_ID`.
5. Your own member ID (your profile > ⋯ > Copy member ID) is `SLACK_USER_ID`.
6. Optionally, under Basic Information > Display Information, upload a PNG of `assets/logo.svg` as the app icon. The manifest can't set it.

Put the four values in the `slack` section of the settings ([Deploying](deploy.md#settings)). The server refuses to start with only some of them.

Give gaidin its own channel. In a channel shared with another bot, both would answer every message.

## Web view

The web view is a console on the root conversation, live from every surface:

- The horizon along the top shows the next 24 hours: reminders as dots and scheduled job runs as diamonds, with the next one named.
- The log shows your messages and gaidin's answers, rendered as Markdown, with thinking and tool calls folded to one line each; open one to see its input and output, which streams while it runs. Fired reminders and job reports appear in it too.
- The dock holds pending approvals and questions above the prompt. Approvals have Allow, the wider grant where there is one, and Deny (Alt+Y, Alt+A, Alt+N for the oldest). Questions have a button per choice, and whatever you type at the prompt next is taken as the answer.
- The status line shows whether a run is going, with Esc or Ctrl+C to stop it, the model, thinking level and tools, and the cost of the conversation and today's spend against any limit. When the spend guard has stopped gaidin, it shows a button to allow more today.

Everything else is a slash command; `/help` lists them. `/next` lists reminders and jobs and `/cancel` cancels one, `/model`, `/thinking`, `/tools`, `/tool` and `/instructions` change the agent's settings, `/memory`, `/remember` and `/forget` manage gaidin's notes, `/timeline` lists what gaidin did and who allowed it, newest first, and `/budget` shows the spend. Enter sends, Shift+Enter starts a new line, the up and down arrows recall earlier messages, and Tab completes commands.

It shows no keys or Slack settings, and turning a tool off there is the quickest way to take it away from the model.

### How it's reached

The server listens on `127.0.0.1` at `web.port` (default 8410) and nowhere else. [Tailscale Serve](https://tailscale.com/kb/1312/serve) puts HTTPS in front of it on the machine's tailnet name:

```sh
sudo tailscale serve --bg --yes 8410
```

Serve removes any identity headers a client sends and adds `Tailscale-User-Login` for requests from a person's device. The server answers only the login in `web.user` and returns 403 to everyone else, including tagged devices, which get no identity. POSTs need a JSON body and an `Origin` matching the page, so another site open in your browser can't drive it.

Without `web.user` there's no web view. The page is `web/index.html` and `web/app.ts`; Node strips the TypeScript types as it serves the file, so there's no build step.
