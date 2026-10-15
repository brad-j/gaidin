# Surfaces

All three surfaces talk to the same root conversation ([Concepts](concepts.md)), the default agent's. The command line can talk to the other [agents](concepts.md#agents) too. Slack and the web view are optional; each starts only when its settings are present.

## Command line

`gaidin ask`, `gaidin watch` and `gaidin agent` (`src/cli.ts`) talk to the server over the Unix socket in the data directory, so it has to run on the same machine, as a user who can open the socket.

```sh
gaidin ask "what's on my list?"
gaidin ask --id oven-1 "..."    # rerunning the same id reattaches instead of asking twice
gaidin watch                    # follow everything until Ctrl+C
gaidin ask --agent scout "..."  # another agent's home conversation; watch takes --agent too
```

On the VM, `setup.sh`'s `gaidin` command runs as the service's user. `gaidin ask` prints the request id it used, so you can reattach if the connection drops.

`gaidin agent` lists and changes the [agents](concepts.md#agents) until the web view can:

```sh
gaidin agent list
gaidin agent add scout --name Scout --job "Finds things out and reports back"
gaidin agent set scout --workspaces egwene          # the workspaces it may use
gaidin agent set gaidin --can-message scout         # the agents it may message and hand work to
gaidin agent set scout --name Seeker --job "..."    # an id can't change; an empty list clears one
```

## Slack

gaidin answers in one channel, for one Slack user, over Socket Mode, so the server needs no inbound port. It answers every top-level message you post in the channel, in that message's thread; you don't need to mention it. Each thread is a [conversation of its own](concepts.md#threads), and later replies in it continue that conversation. It ignores other people, other channels, bots and edited messages. A thread on a message it never answered gets a note instead of an answer.

Each reminder that fires is posted to the channel as well as pushed, with buttons that snooze it; once pressed, the message says when it'll come back. A job that [paused](tools.md#scheduled-jobs) after failing is posted with a button that resumes it.

Files can come with a message. Images, such as screenshots, go to the model with the text; one over 3.75 MB goes as Slack's 1024-pixel preview. Other files, up to 20 MB, are saved in the sandbox as `uploads/<message ts>-<name>`, and the message tells gaidin where, so it reads text with its file tools and a PDF with `pdftotext`. Commands can read `uploads/` but not write to it ([Security](security.md#the-sandbox)). A file that can't be fetched is noted in the message instead. An image stays in the conversation's context until compaction, so it costs tokens on each later turn in that thread and nowhere else. Files from the app go the same way (`src/files.ts` does it for both), saved in the sandbox of the agent the message is for.

Reports from [scheduled jobs](tools.md#scheduled-jobs) are posted as messages of their own, headed with the job's title; a reply in a report's thread continues that run's conversation. Answers are posted as Markdown, which Slack renders. Answers over 12,000 characters go out as several messages. Questions from [`ask_owner`](tools.md#questions) and requests for [approval](security.md#approvals) arrive as a message with buttons, a button per choice for a question, in the thread when they come from one and in the channel otherwise. Your next message in that thread answers a question in your own words, as does a reply in the thread of a question posted in the channel. A new top-level message starts a new thread, so it doesn't answer a question from the main conversation (the CLI and web view) or skip its waiting approval. The message changes to show the outcome once you answer from either surface.

A Slack thread can go on from the app too. What you send there is posted in the thread, headed *From the app:* and naming any files, followed by the answer, so the thread reads whole in Slack. It's recorded before it's posted, as Slack's own messages are, so one cut off by a restart is posted by the next start, along with its answer.

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

The web view is a console on the root conversation, live from every surface, with pages beside it. The header switches between them (`#/`, `#/history`, `#/schedule`, `#/memory`, `#/skills`, `#/activity` and `#/settings`, so the back button and a reload keep your place) and names the next reminder or scheduled job run. The console:

- The log shows your messages and gaidin's answers, rendered as Markdown, with thinking and tool calls folded to one line each; open one to see its input and output, which streams while it runs. Fired reminders and job reports appear in it too.
- The dock holds pending approvals and questions above the prompt. Approvals have Allow, the wider grant where there is one, and Deny (Alt+Y, Alt+A, Alt+N for the oldest). Questions have a button per choice, and whatever you type at the prompt next is taken as the answer.
- The status line shows whether a run is going, with Esc or Ctrl+C to stop it (from the console's prompt, or with nothing else focused: Esc in another page's text box only leaves that box), the model, thinking level and tools, and the cost of the conversation and today's spend against any limit. When the spend guard has stopped gaidin, it shows a button to allow more today. Stopping a run leaves gaidin a note that you withdrew the request, so it doesn't take it up again with your next message; ask again to have it done.

The pages show the default agent's reminders, jobs and conversations, and the shared notes; the dock, activity and the timeline cover every agent.

On a phone, the views are tabs across the top, scrolling sideways when they don't fit, the log gives its whole width to the text, and the prompt is one line that grows as you type. Only the console has the prompt there; approvals and questions stay docked on every page, and the schedule page's new-reminder and new-job buttons go to the console to ask.

The history page lists Slack threads and job runs, alert investigations included, the most recently active first, with the last answer in each. One opens to its transcript, read-only, drawn as the console draws the main conversation; a thread shows the answer it replies to above it, and a job run labels its prompts "job".

The schedule page lists open reminders and scheduled jobs, soonest first. Each job shows its schedule, gate, runs and last result, and opens to show its instruction and the last reports it sent. Jobs pause, resume and cancel from there, and reminders cancel; cancelling takes a second press. A paused or failing job turns the page's count in the header amber. New reminders and jobs are asked of gaidin at the prompt, so they go through its approvals; the dock stays on every page, and sending from it goes back to the console.

The memory page lists gaidin's [notes](tools.md#memory), newest first, with who wrote each and how much of the 8,000 characters they use. You add, edit and forget notes there without being asked; forgetting takes a second press.

The skills page lists the [skills](tools.md#skills) gaidin can open, and any local ones it couldn't load and why. A skill opens to its files, rendered as documents; links between them stay on the page, so the built-in gaidin skill reads as this documentation. You create local skills there, edit and add their files, and remove a file or a whole skill (with a second press); your changes apply at once. A SKILL.md that doesn't parse, or names another skill, isn't saved, and the page says why.

The activity page shows today's and this month's spend against the limits, with a button to allow more today when the spend guard has stopped gaidin, and what each model and tool has cost since gaidin started. Below that is the timeline: what gaidin did outside its sandbox and who allowed it, newest first, by day, in every conversation, 50 at a time.

The settings page switches the model and thinking level, switches tools on and off, edits the standing instructions, and lists the devices that get [notifications](#notifications), with a button to turn them on for this one, send a test, or remove one. Each change applies from the next request.

Everything else is a slash command; `/help` lists them. `/cancel` cancels a reminder or job and `/pause` and `/resume` pause and resume a job, by the reference Tab completes; `/model`, `/thinking`, `/tool` and `/instructions` change the agent's settings; `/remember` and `/forget` add and delete a note. `/next`, `/memory`, `/timeline`, `/budget`, `/tools` and `/notifications` open the page that shows them. Enter sends, Shift+Enter starts a new line, the up and down arrows recall earlier messages, and Tab completes commands.

It shows no keys or Slack settings, and turning a tool off there is the quickest way to take it away from the model.

### How it's reached

The server listens on `127.0.0.1` at `web.port` (default 8410) and nowhere else. [Tailscale Serve](https://tailscale.com/kb/1312/serve) puts HTTPS in front of it on the machine's tailnet name:

```sh
sudo tailscale serve --bg --yes 8410
```

Serve removes any identity headers a client sends and adds `Tailscale-User-Login` for requests from a person's device. The server answers only the login in `web.user` and returns 403 to everyone else, including tagged devices, which get no identity. POSTs need a JSON body and an `Origin` matching the page, so another site open in your browser can't drive it.

Without `web.user` there's no web view. The page is `web/index.html`, `web/app.ts` and `web/transcript.ts`; Node strips the TypeScript types as it serves them, so there's no build step.

### The API

The page works through an HTTP API under `/api`, and `/events` for a conversation's live events, behind the same checks. `Gets` and `Posts` in `src/web.ts` say what each route takes and answers, and moiraine, the app that will replace the web view ([Plan](plan.md#design-the-app)), is typed from them. A request names an agent with `?agent=` or `agent` in its body, and a conversation with `?conversation=` or `conversation`; without them, it's the default agent and its home conversation. Through it you also start [threads](concepts.md#threads) and continue any conversation, and add, change, archive and restore [agents](concepts.md#agents). The default agent's allowed hosts are kept with the approvals, where its fetches are checked, but the roster routes read and save them as any agent's; `/api/workspaces` lists the workspaces an agent can be given. `/api/version` gives the protocol's version, raised whenever an answer or a body changes shape or a route is added.

### The app

moiraine, the app that will replace the web view ([Plan](plan.md#design-the-app)), is a project of its own, built on the owner's machine. With `web.app` naming the directory of its build, gaidin serves it at `/app/` behind the same checks: its files, and its shell for every other path there, so its addresses survive a reload. Built files have hashed names and are cached; the shell isn't. The shell's inline scripts change with each build, so gaidin reads it as it's asked for and allows each of them in the Content-Security-Policy by its hash, and a new build needs no restart. `gaidin doctor` says when `web.app` has no build in it.

Files go with a message from the app: attached, dropped on the composer or pasted into it. Each is sent ahead of the message to `/api/files`, up to 20 MB, with its name in an `X-Gaidin-File` header that makes the browser ask first, as a JSON body does, and the Origin checked; gaidin keeps it in `<data>/app-uploads` for a day, and the message names it by the id it got. The app makes an image over 3.75 MB smaller before sending it, so it still goes to the model as an image. A message with files isn't taken as the answer to a waiting question.

### As an app

The web view installs as an app: on an iPhone or iPad, Share, then Add to Home Screen; in Chrome or Edge, Install from the address bar or menu. It opens in its own window, without the browser's bars, and keeps clear of the notch and the home bar. Its service worker (`web/sw.js`) shows notifications and, when the server can't be reached, such as from a phone off the tailnet, a page that says so with a button to try again. It caches nothing, so what you see is always the server's.

## Notifications

gaidin tells you about reminders, job reports and spend-limit stops (the last two only without Slack, which gets them otherwise), and about approval requests and questions, which are waiting on you, whatever else is set up. It sends each one every way that's set up:

- Web Push, to every device signed up in the web view, when the settings have `web.url`.
- ntfy, when the settings have `ntfy.url`. Approval requests and questions don't go there.

A notification counts as sent when one way reached someone; when none did, a reminder or report is tried again. With neither set up, they print to the server's output.

### Web Push

Open the web view's settings page and press "turn on here" to sign that device up; the browser asks whether to allow notifications. On an iPhone or iPad this works only in the app on the Home Screen, which is where the request has to come from. The same section lists the signed-up devices, removes one, and sends a test.

A notification shows its text and opens the web view when tapped; it has no buttons. Each is sent to the push service of the device's browser (Apple's, Google's or Mozilla's), which delivers it to the device. It's encrypted to the device (RFC 8291), so the push service sees only its size and timing, and signed with gaidin's own key (VAPID, RFC 8292), so the push service takes notifications for these devices only from gaidin. The key pair is made on first start, in `<data>/push-keys.json`, and `web.url` is the contact address the push services are given. The server has to reach them over HTTPS; `gaidin doctor` checks Apple's and Google's. A device the push service says is gone is dropped.
