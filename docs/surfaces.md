# Surfaces

All three surfaces talk to the same root conversation ([Concepts](concepts.md)), the default agent's. The command line can talk to the other [agents](concepts.md#agents) too. Slack and the [API](#the-api) are optional; each starts only when its settings are present.

## Command line

`gaidin ask`, `gaidin watch` and `gaidin agent` (`src/cli.ts`) talk to the server over the Unix socket in the data directory, so it has to run on the same machine, as a user who can open the socket.

```sh
gaidin ask "what's on my list?"
gaidin ask --id oven-1 "..."    # rerunning the same id reattaches instead of asking twice
gaidin watch                    # follow everything until Ctrl+C
gaidin ask --agent scout "..."  # another agent's home conversation; watch takes --agent too
```

On the VM, `install.sh`'s `gaidin` command runs as the service's user. `gaidin ask` prints the request id it used, so you can reattach if the connection drops.

`gaidin agent` lists and changes the [agents](concepts.md#agents):

```sh
gaidin agent list
gaidin agent add scout --name Scout --job "Finds things out and reports back"
gaidin agent set scout --workspaces egwene          # the workspaces it may use
gaidin agent set scout --profiles personal          # the browser profiles it may use
gaidin agent set scout --connectors mail            # the connectors whose tools it gets
gaidin agent set gaidin --can-message scout         # the agents it may message and hand work to
gaidin agent set scout --shared-notes off           # keep the shared notes out of its prompt and tools
gaidin agent set scout --name Seeker --job "..."    # an id can't change; an empty list clears one
```

`gaidin rule` lists, adds and removes your [rules](security.md#your-rules) about what asks:

```sh
gaidin rule add allow home_intent__HassTurnOn --agent lan --when "name contains light" --even-after-outside --note "lights"
gaidin rule add ask fetch_url --agent verin --when "url host example.com"
gaidin rule add allow workspace_* --agent lan --for 2h
gaidin rule add allow workspace_* --agent min --when "workspace equals egwene" --when "path inside notes/Ideas"
gaidin rule list
gaidin rule remove r2
```

`--when` takes an argument, `equals`, `one-of` (values split by commas), `starts-with`, `contains`, `host` or `inside`, and a value; give it more than once for conditions that must all hold. `path inside FOLDER` trusts a workspace folder and everything below it for reads, writes and edits, never runs, and needs `workspace equals NAME` beside it ([Security](security.md#your-rules)). `--for` ends the rule after `30m`, `2h` or `1d`.

`gaidin connector` adds and manages [connectors](tools.md#connectors): `list`, `show NAME`, `add NAME URL [--token]`, `connect NAME [--client-id ID]` (sign in with OAuth: it prints the address to open), `token NAME [--token]`, `tool NAME TOOL allow|ask|off`, `refresh NAME`, `remove NAME`, and `client-document`, which prints gaidin's client id document. A token is read from standard input, so it isn't in your shell's history.

## Slack

gaidin answers one Slack user, over Socket Mode, so the server needs no inbound port. Each [agent](concepts.md#agents) can have a channel of its own: the settings' `slack.channelId` is the default agent's, and another agent's is set with `gaidin agent set ID --channel C0123ABCD`. Every top-level message you post in an agent's channel is answered by that agent, in that message's thread; you don't need to mention it. Each thread is a [conversation of its own](concepts.md#threads) with that agent, and later replies in it continue that conversation. It ignores other people, channels that aren't an agent's (an archived agent's included), bots and edited messages. A thread on a message it never answered gets a note instead of an answer.

Each agent posts under its own name; the default agent posts as the app. That needs the app's `chat:write.customize` scope. An app made before the manifest had it posts as itself with the agent's name in front, until you add the scope under OAuth & Permissions and reinstall the app; `gaidin doctor` says which it is. An agent without a channel of its own posts its reminders, reports and requests in the default agent's channel, under its name.

Each reminder that fires is posted to its agent's channel as well as pushed, with buttons that snooze it; once pressed, the message says when it'll come back. A job that [paused](tools.md#scheduled-jobs) after failing is posted with a button that resumes it.

Files can come with a message. Images, such as screenshots, go to the model with the text; one over 3.75 MB goes as Slack's 1024-pixel preview. Other files, up to 20 MB, are saved in the sandbox of the agent whose channel it is, as `uploads/<message ts>-<name>`, and the message tells gaidin where, so it reads text with its file tools and a PDF with `pdftotext`. Commands can read `uploads/` but not write to it ([Security](security.md#the-sandbox)). A file that can't be fetched is noted in the message instead. An image stays in the conversation's context until compaction, so it costs tokens on each later turn in that thread and nowhere else. Files sent through the API go the same way (`src/files.ts` does it for both).

Reports from [scheduled jobs](tools.md#scheduled-jobs) are posted as messages of their own, headed with the job's title; a reply in a report's thread continues that run's conversation. Answers are posted as Markdown, which Slack renders. Answers over 12,000 characters go out as several messages. Questions from [`ask_owner`](tools.md#questions) and requests for [approval](security.md#approvals) arrive as a message with buttons, a button per choice for a question, in the thread when they come from one and in the agent's channel otherwise. Spend-limit warnings go to the default agent's channel. Your next message in that thread answers a question in your own words, as does a reply in the thread of a question posted in the channel. A new top-level message starts a new thread, so it doesn't answer a question from the main conversation (the CLI and the API) or skip its waiting approval. The message changes to show the outcome once you answer from either surface.

A Slack thread can go on through the API too. What you send there is posted in the thread, headed *From the app:* and naming any files, followed by the answer, so the thread reads whole in Slack. It's recorded before it's posted, as Slack's own messages are, so one cut off by a restart is posted by the next start, along with its answer.

### Setting up Slack

1. At api.slack.com/apps, choose Create New App > From a manifest, pick your workspace, and paste `deploy/slack-manifest.yaml` (choose YAML). It turns on Socket Mode and interactivity and asks for the scopes gaidin needs. An app made before `files:read` was added needs that scope added under OAuth & Permissions and the app reinstalled, or files in messages come back as Slack's sign-in page and are noted as unreadable.
2. Install to Workspace. The Bot User OAuth Token (`xoxb-`) is `SLACK_BOT_TOKEN`.
3. Under Basic Information > App-Level Tokens, generate a token with the `connections:write` scope. That token (`xapp-`) is `SLACK_APP_TOKEN`.
4. Create a channel for gaidin and run `/invite @gaidin` in it. A channel can't share the bot's name. The channel ID, at the bottom of the channel details, is `SLACK_CHANNEL_ID`, the default agent's channel. For another agent, create a channel, invite the app the same way, and put its ID in the agent's settings; two agents can't share one.
5. Your own member ID (your profile > ⋯ > Copy member ID) is `SLACK_USER_ID`.
6. Optionally, under Basic Information > Display Information, upload a PNG of `assets/logo.svg` as the app icon. The manifest can't set it.

Put the four values in the `slack` section of the settings ([Deploying](deploy.md#settings)). The server refuses to start with only some of them.

Give gaidin its own channels. In a channel shared with another bot, both would answer every message.

## The API

Without `web.user` there's no API. With it, gaidin serves an HTTP API for a client of your own or a script, and nothing else: it has no web app, and every path that isn't the API is a 404. Slack, the command line and notifications cover what the owner does day to day; the API also reaches what they don't, such as editing skills or taking a [browser profile](tools.md#taking-a-profile-over) over, for a client that shows it.

### How it's reached

The server listens on `127.0.0.1` at `web.port` (default 8410) and nowhere else. [Tailscale Serve](https://tailscale.com/kb/1312/serve) puts HTTPS in front of it on the machine's tailnet name:

```sh
sudo tailscale serve --bg --yes 8410
```

Serve removes any identity headers a client sends and adds `Tailscale-User-Login` for requests from a person's device. The server answers only the login in `web.user` and returns 403 to everyone else, including tagged devices, which get no identity. POSTs need a JSON body, or a file's `X-Gaidin-File` header, and an `Origin` matching the host, if there's one, so another site open in your browser can't drive it.

### Routes

The API is under `/api`, with `/events` for a conversation's live events and `/events?all` for a client's own, which follows no conversation, sends no snapshot and carries `approvals_changed` when a request for approval opens or closes, `activity_changed` with an `agent` when one of that agent's runs starts or ends, and `conversations_changed` with an `agent` when it gets a conversation or one of its conversations a message, behind the same checks. Each of the last two comes at most once per agent in a quarter of a second, and means only that `/api/agents/activity` or `/api/conversations` may have changed. `Gets` and `Posts` in `src/web.ts` say what each route takes and answers; a client in TypeScript can import them with `import type`. A request names an agent with `?agent=` or `agent` in its body, and a conversation with `?conversation=` or `conversation`; without them, it's the default agent and its home conversation. Through it you also start [threads](concepts.md#threads) and continue any conversation, and add, change, archive and restore [agents](concepts.md#agents). The default agent's allowed hosts are kept with the approvals, where its fetches are checked, but the roster routes read and save them as any agent's; `/api/workspaces` lists the workspaces an agent can be given, and `/api/profiles` the browser profiles. `/api/browser/live?profile=` streams a profile's tab as JPEG frames on an event stream, taking it over while it's open, and `/api/browser/input`, `/go` and `/release` send your input, navigate and let go. `/api/version` gives the protocol's version, raised whenever an answer or a body changes shape or a route is added, so a client can tell when it was built for another.

Files go with a message: each is sent ahead of it to `/api/files`, up to 20 MB, with its name in an `X-Gaidin-File` header that makes a browser ask first, as a JSON body does, and the Origin checked; gaidin keeps it in `<data>/app-uploads` for a day, and the message names it by the id it got. Images up to 3.75 MB go to the model and other files, larger images among them, to the agent's sandbox, as Slack's do. A message with files isn't taken as the answer to a waiting question.

## Voice

A voice front end, such as a bridge between speakers in the house and gaidin, talks to an agent in text through one route on the API's server, `POST /api/voice/turn`. The bridge turns what a speaker heard into text and posts `{ "speaker": "kitchen", "text": "...", "key": "..." }`, with `agent` too when its token reaches more than one; gaidin never handles audio. `speaker` is the bridge's name for it (lowercase letters, digits and -), and `key` names the turn, so a turn sent again, after a dropped connection say, lands once and hears the same answer.

The answer is an event stream: a `say` event with `text` for each of the run's messages as it ends, the answer last, so the bridge can start speaking early; `waiting` with the request's `summary` when the run stops to ask you, which reaches your phone or Slack as any request does, never the speaker; and `done` with the run's `status` and the `conversation`, after which the stream closes.

Each speaker has a rolling thread with its agent, origin `voice`, which carries on while turns keep coming and starts afresh after 5 minutes without one, so a follow-up works and yesterday's talk doesn't pile up. What a speaker heard reaches the agent marked as spoken, with the speaker's name.

A bridge proves itself with a bearer token from `voice.tokens` ([Deploying](deploy.md#settings)), not your Tailscale login, and the token reaches that route and the agents it lists, nothing else ([Security](security.md#voice)). A bridge also follows `GET /api/voice/events`, an event stream of things due on its speakers: an `announce` event with an `id`, the `speaker` (or `*` for every speaker), the `text`, `kind` `reminder` and the `agent`. It says the text there and posts `{ "id": "...", "delivered": true }` to `/api/voice/announced`, or `false` when it can't. A reminder set while talking at a speaker is said on that speaker unless the agent sends it elsewhere ([Tools](tools.md#reminders)); if no bridge says it within 20 seconds, it reaches your phone with the place it should have been heard.

Give the agent behind a speaker its shared notes off (`gaidin agent set ID --shared-notes off`) and only the tools it needs, since anyone in the room can talk to it.

## Notifications

gaidin tells you about reminders, job reports and spend-limit stops (the last two only without Slack, which gets them otherwise), and about approval requests and questions, which are waiting on you, whatever else is set up. It sends each one every way that's set up:

- Web Push, to every device signed up through the API, when the settings have `web.url`.
- ntfy, when the settings have `ntfy.url`. Approval requests and questions don't go there.

A notification counts as sent when one way reached someone; when none did, a reminder or report is tried again. With neither set up, they print to the server's output.

### Web Push

A device signs up with `POST /api/push/subscribe`, from a page whose service worker subscribes with the key `GET /api/push` gives. gaidin serves no such page or service worker, so this takes a client of your own. `/api/push/unsubscribe` removes a device and `/api/push/test` sends a test.

A notification carries its title, text and the client path of what it's about (`url`), for the client's service worker to show and open; it has no buttons. Each is sent to the push service of the device's browser (Apple's, Google's or Mozilla's), which delivers it to the device. It's encrypted to the device (RFC 8291), so the push service sees only its size and timing, and signed with gaidin's own key (VAPID, RFC 8292), so the push service takes notifications for these devices only from gaidin. The key pair is made on first start, in `<data>/push-keys.json`, and `web.url` is the contact address the push services are given. The server has to reach them over HTTPS; `gaidin doctor` checks Apple's and Google's. A device the push service says is gone is dropped.
