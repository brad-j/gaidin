# Surfaces

All three surfaces talk to the same root conversation ([Concepts](concepts.md)), the default agent's. The command line can talk to the other [agents](concepts.md#agents) too. Slack and the app are optional; each starts only when its settings are present.

## Command line

`gaidin ask`, `gaidin watch` and `gaidin agent` (`src/cli.ts`) talk to the server over the Unix socket in the data directory, so it has to run on the same machine, as a user who can open the socket.

```sh
gaidin ask "what's on my list?"
gaidin ask --id oven-1 "..."    # rerunning the same id reattaches instead of asking twice
gaidin watch                    # follow everything until Ctrl+C
gaidin ask --agent scout "..."  # another agent's home conversation; watch takes --agent too
```

On the VM, `setup.sh`'s `gaidin` command runs as the service's user. `gaidin ask` prints the request id it used, so you can reattach if the connection drops.

`gaidin agent` lists and changes the [agents](concepts.md#agents) as the app's agents page does:

```sh
gaidin agent list
gaidin agent add scout --name Scout --job "Finds things out and reports back"
gaidin agent set scout --workspaces egwene          # the workspaces it may use
gaidin agent set scout --profiles personal          # the browser profiles it may use
gaidin agent set scout --connectors mail            # the connectors whose tools it gets
gaidin agent set gaidin --can-message scout         # the agents it may message and hand work to
gaidin agent set scout --name Seeker --job "..."    # an id can't change; an empty list clears one
```

`gaidin connector` adds and manages [connectors](tools.md#connectors): `list`, `show NAME`, `add NAME URL [--token]`, `connect NAME [--client-id ID]` (sign in with OAuth: it prints the address to open), `token NAME [--token]`, `tool NAME TOOL allow|ask|off`, `refresh NAME`, `remove NAME`, and `client-document`, which prints gaidin's client id document. A token is read from standard input, so it isn't in your shell's history.

## Slack

gaidin answers one Slack user, over Socket Mode, so the server needs no inbound port. Each [agent](concepts.md#agents) can have a channel of its own: the settings' `slack.channelId` is the default agent's, and another agent's is set on its settings page or with `gaidin agent set ID --channel C0123ABCD`. Every top-level message you post in an agent's channel is answered by that agent, in that message's thread; you don't need to mention it. Each thread is a [conversation of its own](concepts.md#threads) with that agent, and later replies in it continue that conversation. It ignores other people, channels that aren't an agent's (an archived agent's included), bots and edited messages. A thread on a message it never answered gets a note instead of an answer.

Each agent posts under its own name; the default agent posts as the app. That needs the app's `chat:write.customize` scope. An app made before the manifest had it posts as itself with the agent's name in front, until you add the scope under OAuth & Permissions and reinstall the app; `gaidin doctor` says which it is. An agent without a channel of its own posts its reminders, reports and requests in the default agent's channel, under its name.

Each reminder that fires is posted to its agent's channel as well as pushed, with buttons that snooze it; once pressed, the message says when it'll come back. A job that [paused](tools.md#scheduled-jobs) after failing is posted with a button that resumes it.

Files can come with a message. Images, such as screenshots, go to the model with the text; one over 3.75 MB goes as Slack's 1024-pixel preview. Other files, up to 20 MB, are saved in the sandbox of the agent whose channel it is, as `uploads/<message ts>-<name>`, and the message tells gaidin where, so it reads text with its file tools and a PDF with `pdftotext`. Commands can read `uploads/` but not write to it ([Security](security.md#the-sandbox)). A file that can't be fetched is noted in the message instead. An image stays in the conversation's context until compaction, so it costs tokens on each later turn in that thread and nowhere else. Files from the app go the same way (`src/files.ts` does it for both).

Reports from [scheduled jobs](tools.md#scheduled-jobs) are posted as messages of their own, headed with the job's title; a reply in a report's thread continues that run's conversation. Answers are posted as Markdown, which Slack renders. Answers over 12,000 characters go out as several messages. Questions from [`ask_owner`](tools.md#questions) and requests for [approval](security.md#approvals) arrive as a message with buttons, a button per choice for a question, in the thread when they come from one and in the agent's channel otherwise. Spend-limit warnings go to the default agent's channel. Your next message in that thread answers a question in your own words, as does a reply in the thread of a question posted in the channel. A new top-level message starts a new thread, so it doesn't answer a question from the main conversation (the CLI and the app) or skip its waiting approval. The message changes to show the outcome once you answer from either surface.

A Slack thread can go on from the app too. What you send there is posted in the thread, headed *From the app:* and naming any files, followed by the answer, so the thread reads whole in Slack. It's recorded before it's posted, as Slack's own messages are, so one cut off by a restart is posted by the next start, along with its answer.

### Setting up Slack

1. At api.slack.com/apps, choose Create New App > From a manifest, pick your workspace, and paste `deploy/slack-manifest.yaml` (choose YAML). It turns on Socket Mode and interactivity and asks for the scopes gaidin needs. An app made before `files:read` was added needs that scope added under OAuth & Permissions and the app reinstalled, or files in messages come back as Slack's sign-in page and are noted as unreadable.
2. Install to Workspace. The Bot User OAuth Token (`xoxb-`) is `SLACK_BOT_TOKEN`.
3. Under Basic Information > App-Level Tokens, generate a token with the `connections:write` scope. That token (`xapp-`) is `SLACK_APP_TOKEN`.
4. Create a channel for gaidin and run `/invite @gaidin` in it. A channel can't share the bot's name. The channel ID, at the bottom of the channel details, is `SLACK_CHANNEL_ID`, the default agent's channel. For another agent, create a channel, invite the app the same way, and put its ID in the agent's settings; two agents can't share one.
5. Your own member ID (your profile > ⋯ > Copy member ID) is `SLACK_USER_ID`.
6. Optionally, under Basic Information > Display Information, upload a PNG of `assets/logo.svg` as the app icon. The manifest can't set it.

Put the four values in the `slack` section of the settings ([Deploying](deploy.md#settings)). The server refuses to start with only some of them.

Give gaidin its own channels. In a channel shared with another bot, both would answer every message.

## The app

The app is moiraine, a project of its own beside gaidin, served by gaidin at `/` on its tailnet name. Its sidebar shows one agent at a time, chosen at its top: the agent's home conversation, New thread, and its threads, job runs and conversations other agents started, the most recently active first, each labeled with where it began (Slack, the app, a job run, or another agent). Below them are the agent's pages (Schedule, Memory, Skills, Settings) and the pages across agents (Agents, Activity). On a phone the sidebar slides in over the conversation. Its addresses are `/<agent>` for the home conversation, `/<agent>/t/<id>` for a thread, `/<agent>/new` for a thread about to start, `/<agent>/schedule`, `/memory`, `/skills` and `/settings`, and `/agents` and `/activity`; the back button and a reload keep your place.

A conversation:

- The log shows your messages and the agent's answers, rendered as Markdown, with thinking and tool calls folded to one line each, and two or more of them in a row folded together; open one to see its input and output, which streams while it runs. Fired reminders and job reports appear in it too, with buttons that snooze a reminder.
- The dock holds every agent's pending approvals and questions above the prompt, each naming its agent and linking to where it came from. Approvals have Allow once, the wider grant where there is one, and Deny (Alt+Y, Alt+A, Alt+N for the oldest). Questions have a button per choice, and whatever you type at the prompt of the conversation that asked is taken as the answer.
- The prompt takes text and files: attach them, drop them on it or paste them in. The status line under it shows whether a run is going, with Esc or Ctrl+C to stop it, the model, thinking level and tools, and the cost of the conversation and today's spend against any limit. When the spend guard has stopped gaidin, it shows a button to allow more today. Stopping a run leaves the agent a note that you withdrew the request, so it doesn't take it up again with your next message; ask again to have it done.
- A new thread has the agent's home settings and memory and none of its home conversation's history. A message to a job run or to a conversation another agent started goes to a thread forked from it, which shows the answer it replies to. A message to a thread that began in Slack is posted there too ([Slack](#slack)).

The schedule page lists the agent's open reminders and scheduled jobs, soonest first. Each job shows its schedule, gate, runs and last result, and opens to show its instruction and the last reports it sent. Jobs pause, resume and cancel from there, and reminders cancel; cancelling takes a second press. A paused or failing job turns the page's count in the sidebar amber. New reminders and jobs are asked of the agent in its home conversation, so they go through its approvals.

The memory page lists the shared [notes](tools.md#memory) about you, which every agent sees, and the agent's own work notes, newest first, with who wrote each and how much of its limit they use. You add, edit and forget notes there without being asked; forgetting takes a second press.

The skills page lists the [skills](tools.md#skills) every agent can open, and any local ones it couldn't load and why. A skill opens to its files, rendered as documents; links between them stay on the page, so the built-in gaidin skill reads as this documentation. You create local skills there, edit and add their files, and remove a file or a whole skill (with a second press); your changes apply at once. A SKILL.md that doesn't parse, or names another skill, isn't saved, and the page says why.

The settings page edits the agent's roster entry (name, job, Slack channel), switches its model and thinking level, switches tools on and off, edits its standing instructions, and sets what it may reach: the hosts it fetches from without asking (with remove), its workspaces, its [browser profiles](tools.md#browser) and the sites it acts on there without asking (with remove), and the agents it may message. It also lists the devices that get [notifications](#notifications), with a button to turn them on for this one, send a test, or remove one. Model, tools and instructions apply from the agent's next request and to its new threads.

The Connectors page lists the [connectors](tools.md#connectors): each with its state (connected, needs signing in, can't be reached), its MCP revision, how it signs in, about how many tokens its tools add to each request, and which agents have it. Each tool has allow, ask and off; one that's new or changed since you set it is marked and off until you choose. Sign in sends the page to the service and comes back to it; token, refresh and remove (with a second press) are beside it, and add takes a name, the server's address and a token if the service gave you one. The sidebar's count beside it is the connectors that need signing in or have tools to look at, and a connector that worked and needs signing in again is also sent to you, in Slack or as a push. Agents get connectors on their settings pages.

The Browser page, shown when the settings name [browser profiles](tools.md#browser), lists them with the page each was left on and by which agent, and opens one to [take it over](tools.md#taking-a-profile-over): its current tab live, an address bar, Back, Done, and on a phone a Keyboard button. A hand-over waiting on you shows in the dock with Take over, Done and Can't. Its address is `/browser/<profile>`, which an agent can't take as its id.

The agents page lists the roster, with archived agents apart, makes a new agent, and archives and restores them; the default agent can't be archived. The activity page shows today's and this month's spend against the limits, with a button to allow more today when the spend guard has stopped gaidin, and what each model and tool has cost since gaidin started. Below that is the timeline: what the agents did outside their sandboxes and who allowed it, newest first, by day, each with its agent, 50 at a time.

Everything else is a slash command; `/help` lists them. `/cancel` cancels a reminder or job and `/pause` and `/resume` pause and resume a job, by the reference Tab completes; `/model`, `/thinking`, `/tool` and `/instructions` change the agent's settings, in its home conversation; `/remember` and `/forget` add and delete a shared note. `/next`, `/memory`, `/skills`, `/settings`, `/tools`, `/notifications`, `/timeline`, `/budget` and `/agents` open the page that shows them. Enter sends, Shift+Enter starts a new line, the up and down arrows recall earlier messages, and Tab completes commands. The web view's old addresses (`#/schedule`, `#/history/<id>`, `/app/...`) open the matching page or conversation.

It shows no keys or Slack tokens, and turning a tool off there is the quickest way to take it away from the model.

### How it's reached

The server listens on `127.0.0.1` at `web.port` (default 8410) and nowhere else. [Tailscale Serve](https://tailscale.com/kb/1312/serve) puts HTTPS in front of it on the machine's tailnet name:

```sh
sudo tailscale serve --bg --yes 8410
```

Serve removes any identity headers a client sends and adds `Tailscale-User-Login` for requests from a person's device. The server answers only the login in `web.user` and returns 403 to everyone else, including tagged devices, which get no identity. POSTs need a JSON body, or a file's `X-Gaidin-File` header, and an `Origin` matching the page, so another site open in your browser can't drive it.

Without `web.user` there's no app. With it, `web.app` names the directory of moiraine's build, and gaidin serves it: its files, and its shell for every path that isn't the API or one of them, so the app's addresses survive a reload. Built files have hashed names and are cached; the shell isn't. The shell's inline scripts change with each build, so gaidin reads it as it's asked for and allows each of them in the Content-Security-Policy by its hash, and a new build needs no restart. moiraine's `pnpm ship` builds it and copies it to the VM ([Deploying](deploy.md#the-app)). `gaidin doctor` says when `web.app` isn't set or has no build in it.

### The API

The app works through an HTTP API under `/api`, and `/events` for a conversation's live events, behind the same checks. `Gets` and `Posts` in `src/web.ts` say what each route takes and answers, and moiraine is typed from them. A request names an agent with `?agent=` or `agent` in its body, and a conversation with `?conversation=` or `conversation`; without them, it's the default agent and its home conversation. Through it you also start [threads](concepts.md#threads) and continue any conversation, and add, change, archive and restore [agents](concepts.md#agents). The default agent's allowed hosts are kept with the approvals, where its fetches are checked, but the roster routes read and save them as any agent's; `/api/workspaces` lists the workspaces an agent can be given, and `/api/profiles` the browser profiles. `/api/browser/live?profile=` streams a profile's tab as JPEG frames on an event stream, taking it over while it's open, and `/api/browser/input`, `/go` and `/release` send your input, navigate and let go. `/api/version` gives the protocol's version, raised whenever an answer or a body changes shape or a route is added, and moiraine's build won't go to a gaidin that speaks another.

Files go with a message: each is sent ahead of it to `/api/files`, up to 20 MB, with its name in an `X-Gaidin-File` header that makes the browser ask first, as a JSON body does, and the Origin checked; gaidin keeps it in `<data>/app-uploads` for a day, and the message names it by the id it got. Images go to the model and other files to the agent's sandbox, as Slack's do. The app makes an image over 3.75 MB smaller before sending it, so it still goes to the model as an image. A message with files isn't taken as the answer to a waiting question.

### Installing it

The app installs: on an iPhone or iPad, Share, then Add to Home Screen; in Chrome or Edge, Install from the address bar or menu. It opens in its own window, without the browser's bars, and keeps clear of the notch and the home bar. Its service worker (`/sw.js`, where the web view had it, so devices signed up then stay signed up) shows notifications, opens the conversation one came from when it's tapped, and, when the server can't be reached, such as from a phone off the tailnet, answers with a page that says so with a button to try again. It caches nothing, so what you see is always the server's.

## Notifications

gaidin tells you about reminders, job reports and spend-limit stops (the last two only without Slack, which gets them otherwise), and about approval requests and questions, which are waiting on you, whatever else is set up. It sends each one every way that's set up:

- Web Push, to every device signed up in the app, when the settings have `web.url`. A hand-over's notification opens the profile's page in the app.
- ntfy, when the settings have `ntfy.url`. Approval requests and questions don't go there.

A notification counts as sent when one way reached someone; when none did, a reminder or report is tried again. With neither set up, they print to the server's output.

### Web Push

Open the app's settings page and press "turn on here" to sign that device up; the browser asks whether to allow notifications. On an iPhone or iPad this works only in the app on the Home Screen, which is where the request has to come from. The same section lists the signed-up devices, removes one, and sends a test.

A notification shows its text and opens the conversation it came from when tapped; it has no buttons. Each is sent to the push service of the device's browser (Apple's, Google's or Mozilla's), which delivers it to the device. It's encrypted to the device (RFC 8291), so the push service sees only its size and timing, and signed with gaidin's own key (VAPID, RFC 8292), so the push service takes notifications for these devices only from gaidin. The key pair is made on first start, in `<data>/push-keys.json`, and `web.url` is the contact address the push services are given. The server has to reach them over HTTPS; `gaidin doctor` checks Apple's and Google's. A device the push service says is gone is dropped.
