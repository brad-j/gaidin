# Plan

## Decisions

- gaidin runs alongside Hermes, the existing agent. Nothing moves over from Hermes until gaidin has earned it.
- Its first jobs were reminders and "is the homelab OK" from a phone.
- It runs on its own VM, so the host's nightly backups cover its SQLite file.
- It uses Claude through an API key in its own Console workspace with a spend limit, Haiku 5.5 by default and Sonnet 5.5 where a conversation needs it. Subscription sign-in in a third-party harness is out.
- Everything stays generic enough to release: machine-specific values live in settings or in the homelab extension.
- Pocket Pi isn't a surface. Voice, if it comes, is push-to-talk in the web view with whisper.cpp on the VM.
- Hindsight (retired 2026-09-30) and Dozzle (retired 2026-10-10) aren't part of it.

## Done

1. One long-lived process, SQLite storage, one root conversation, reminders through ntfy, on its own VM.
2. Slack, with threads as forks, and the web view over Tailscale, both on the same conversation.
3. Redaction, the sandbox, `fetch_url`, the approval hook, read-only homelab tools, container logs, and workspaces, with egwene the first.
4. The foundation for features and a release: one settings file checked at start, the `gaidin` command with `doctor`, the owner's name as a setting, and the homelab tools as an optional extension.
5. Scheduled jobs: briefings, repeating checks, watches that report only when something needs attention, and follow-ups gaidin sets for itself, each run in its own conversation.
6. Memory: notes in every system prompt, kept by gaidin and editable in the web view, with writes after outside text asking first.
7. A spend guard: daily and monthly limits that stop model requests and tell the owner, with a way to allow more from the web view.
8. Longer waits: approvals and `ask_owner` questions wait days, answered from Slack or the web view, and a new message skips a waiting approval.
9. Web search through a configurable backend, Tavily first.
10. Self-extension: gaidin writes tools for itself, which pass a type check, their tests, lint rules and a review before the owner approves them, and run in a box of their own ([Tools](tools.md#self-written-tools)).
11. Search over past conversations: the owner's messages and gaidin's answers in every conversation, thread and job run, in an index of its own ([Tools](tools.md#past-conversations)).
12. A timeline in the web view of what gaidin did and who allowed it, from approval outcomes recorded in the transcript ([Security](security.md#approvals)).
13. Files in Slack messages: images go to the model, other files to the sandbox.
14. Snoozing a reminder from its push, its Slack message or the web view.
15. Alerts: gaidin follows the homelab's alert topic and investigates what arrives, with read-only tools ([Tools](tools.md#alerts)).
16. Package versions wait 3 days before pnpm installs them (`minimumReleaseAge: 4320`, up from pnpm's default of 1 day), Pi Durable included.
17. A job's runs see its last 3 delivered reports and how many quiet runs followed, and a watch is told to repeat a finding only when it has got worse ([Tools](tools.md#scheduled-jobs)).
18. Failure streaks: a run that didn't finish delays the next by 15 minutes doubled per failure, up to 4 hours, and the job pauses after 5 in a row; the owner hears about the first failure and the pause, and resumes it from Slack or the web view ([Tools](tools.md#scheduled-jobs)). Deliveries that fail every retry don't count, so a Slack or ntfy outage doesn't pause every job.
19. Gates: a check before each run, without the model, that wakes it only for something new: the homelab extension's, or a self-written tool's that fetches only from hosts allowed for good. A job without a gate repeats at most every 6 hours; with one, every 15 minutes ([Tools](tools.md#gates)).
20. Refusals: a call that can't succeed (a job that can't be made, a note that won't fit, an unknown workspace) is blocked with the reason instead of being put to the owner, and checked again after an approval, which can come days later ([Security](security.md#approvals)).
21. The web view as an app: it installs on a phone or computer, keeps clear of the notch, shows a page when the server can't be reached, and gets notifications by Web Push (reminders, reports, and approval requests and questions), with encryption and signing written on `node:crypto`. ntfy stays as a second way ([Surfaces](surfaces.md#notifications)).
22. Pages beside the web view's console: a schedule page for reminders and jobs, where a job opens to its instruction and last reports and pauses, resumes or cancels ([Surfaces](surfaces.md#web-view)).
23. Skills: guides gaidin opens when a request calls for one, listed in every system prompt and read with `read_skill`. The documentation is the built-in `gaidin` skill, so gaidin can answer questions about itself; local skills live in the data directory, and the web view has a page for them ([Tools](tools.md#skills)).
24. The web view controls the rest: a memory page to add, edit and forget notes; a settings page for the model, thinking, tools, standing instructions and notification devices; an activity page with spend against the limits, cost by model and the timeline; and writing skills, by the owner on the skills page and by gaidin with `write_skill` and `remove_skill`, which always ask, each change a commit ([Surfaces](surfaces.md#web-view), [Tools](tools.md#skills)).
25. A history page for Slack threads and job runs; compaction from about 60,000 tokens, so requests stay under the 100,000-token price tier ([Concepts](concepts.md#compaction)); and Esc stops a run only from the console.
26. Slack threads as separate conversations: each top-level message starts one with the root's settings and is answered in its thread, so the channel no longer shares the root conversation with the CLI and web view ([Concepts](concepts.md#threads)).
27. Several named agents, the core: a roster in the database with the current gaidin as the default agent, each agent with its own home conversation, sandbox, work notes beside the shared notes, reminders, jobs, past conversations, allowed hosts, workspaces and self-written tools; `message_agent` and `hand_off` between agents an entry allows; and `gaidin ask --agent` and `gaidin agent` on the command line ([Concepts](concepts.md#agents), [Security](security.md#agents)). Slack and the web view still talk to the default agent.
28. The app's server side: threads start and continue through the web server's API as well as Slack, in a module both use (`src/threads.ts`), and a message to a job run or a conversation another agent started forks it at its last answer. Every route takes an agent and, where it applies, a conversation; the roster is listed, saved, archived and restored there, and `/api/version` gives the protocol's version ([Concepts](concepts.md#threads), [Surfaces](surfaces.md#the-api)).
29. The app's skeleton: moiraine, served by gaidin at `/app/` beside the web view from the directory `web.app` names, with each agent's home conversation and threads in a sidebar, any of them continued there, a new thread started from it, and the dock showing every agent's requests ([Surfaces](surfaces.md#the-app)).
30. The app's pages: each agent's schedule, memory (shared and work notes), skills and settings (its roster entry, model, tools, instructions, hosts, workspaces, who it may message, and notification devices), and across agents an agents page that makes, archives and restores them and an activity page with spend and the timeline, which names each item's agent. `/api/workspaces` lists the workspaces, and the roster routes read and save the default agent's hosts, which the approvals keep (protocol 2).

## Next

Candidates:

- Several named agents, designed below: Slack's channel per agent, then the app (designed below), which replaces the web view and holds the agents' pages. Then connectors (MCP servers with OAuth, tokens held by the server, granted per agent), a persistent browser with a take-over view, and owner-written allow and ask-first rules, in that order.
- Release polish: a setup wizard, Slack app creation from a configuration token, and an installer ([Extending](extending.md#still-specific-to-one-deployment) lists what's left that's specific).

Not planned: branching from any message in the web view, since each thread is already a conversation of its own; push-to-talk, since the owner dictates with superwhisper; and projects or image generation in the app.

## Design: several agents

The core is built (item 27); Slack and the web view are next. A roster of named agents, each with its own job, standing instructions, model, tools, work notes, sandbox, allowed hosts and workspaces. Agents message each other and hand work on; one can coordinate the rest. Unlike Grok Bot, whose bots share one machine, agents are kept apart: one can't read another's sandbox, notes, jobs or past conversations, or use its grants.

Decided with the owner:

- Slack has a channel per agent, all on the one Slack app.
- Memory has shared notes about the owner, which every agent sees, and work notes per agent. Both ask as notes do today: a write asks while outside text is in the conversation's context, and a message from another agent counts as outside text.
- The current gaidin becomes the default agent and keeps everything it has.
- The roster lives in the database and is edited from the web view, not the settings file.

It needs nothing new from Pi Durable 1.1.0: prompt sections and the sandbox factory are told which conversation they serve, and `conversationCreated` runs whenever a conversation is created or forked.

### Data model

An agent is a home conversation plus a roster entry. The home conversation's `AgentDoc` holds the model, thinking level, tool switches and standing instructions, as the root's does today, so the settings code works unchanged once it's pointed at the right conversation. The roster entry holds the rest.

| Document | Scope | Holds |
|---|---|---|
| `gaidin.agents` (new) | session | the roster: per agent an id (a lowercase name like a workspace's, fixed), a display name, a one-line job other agents and the owner see, its home conversation, its Slack channel, the hosts it may fetch from without asking, the workspaces it may use, the agents it may message, and whether it's archived |
| `gaidin.agent-of` (new) | conversation, latest only, copied on fork | which agent a conversation belongs to |
| `gaidin.work-notes` (new) | session family keyed by agent id | that agent's work notes, up to 4,000 characters |
| `gaidin.memory` | session, unchanged | the shared notes, up to 8,000 characters |
| `gaidin.jobs`, `gaidin.reminders` | session | each item gains `agent` |
| `gaidin.approvals` | session | each request gains `agent`; `fetchHosts` stays the default agent's, and other agents' always-allowed hosts are in their roster entries |

A conversation without `gaidin.agent-of`, and an item without `agent`, belongs to the default agent, so nothing stored today needs rewriting. Forks (threads on a report, a job's run) carry the binding with them; a new conversation gets one in the commit that creates it.

New agents' sandboxes are `<data>/agents/<id>/sandbox`, outside the default agent's `<data>/sandbox`, which stays where it is. The sandbox factory picks the root from the conversation's binding, and each root has its own lock. Slack uploads go into the receiving agent's sandbox.

### What each agent sees and can do

- Its system prompt opens with its name and job ("You are Scout, one of Brad's agents. Your job: ...") and lists the other agents it may message, with their jobs. The default agent's preamble stays as it is.
- Notes: the shared notes, then its own work notes. `remember` writes a work note unless asked for a shared one. Note ids in the prompt and tools read `s12` (shared) or `w4` (work); the stored numbers don't change. Writing, changing or forgetting either kind asks as notes do today, after outside text. A shared note reaches every agent, so a bad one left by a write after compaction (the gap in [Security](security.md#known-gaps)) would reach them all; the memory page shows who wrote each note, and deleting it takes it out of every prompt.
- Reminders and jobs: it lists, cancels and is told about only its own. A job runs as the agent that made it, with that agent's tools, sandbox and grants. The limit of 20 jobs stays a total across agents.
- `search_history` and `read_history` find only its own conversations. The history index gains an agent column and is rebuilt from the transcript at start, as it already can be.
- Fetches: hosts the owner always allowed for that agent, plus search results in the same conversation as today. "Always allow" adds the host for that agent only.
- Workspaces: only those in its roster entry, refused otherwise; every call still asks. The default agent has all of them.
- Tools: the settings page switches built-in tools per agent, as today. A self-written tool is on only for the agent that loaded it until the owner switches it on for another; the approvals hook refuses a call from an agent it isn't on for, so a tool that appears before the agent's tool list is updated still can't run there. Its fetches use the calling agent's allowed hosts.
- Skills are shared. `write_skill` and `remove_skill` still always ask.
- Spend limits stay a total across agents. The activity page shows cost per agent.

### Messaging and handing off

Two tools, available to an agent only when its roster entry lets it message someone:

- `message_agent(agent, text)` asks another agent something and waits for the answer, as `ask_owner` waits for the owner. A durable task starts a new conversation for the receiver, bound to it and with its home settings, submits the text, and returns the answer as the tool's result. It survives restarts, and the request id comes from the call's task, so a rerun doesn't send twice.
- `hand_off(agent, task)` gives work to another agent and doesn't wait. The receiver's conversation is started the same way, and its answer reaches the owner as a report in the receiver's channel. The sender gets back the agent's name and a reference it can mention.

Rules:

- An agent can message only the agents its roster entry lists; a call to any other is refused, not asked. A coordinator is an agent whose list holds every agent, with instructions to match; nothing else sets it apart. The default agent starts with an empty list.
- A message from another agent is outside text to the receiver, since the sender may have been steered. Its conversation starts with a marker that the approvals hook treats like a gate's findings, so the receiver's note writes and cancels ask. The answer that comes back is outside text to the sender (the tools' guards say `outside`).
- Either tool asks the owner while outside text is in the sender's context. Without that, a page the sender read could pass work to an agent with wider grants, such as one allowed to fetch from a host this one isn't.
- A chain stops at 3 messages, and an agent can't message one already in the chain.
- These conversations appear on the history page labeled with both agents ("Scout, from gaidin").

### Approvals

Requests carry the agent and show its name: "Scout asks to fetch ..." in Slack and the web view's dock. Guards get the agent in their situation, so hosts, workspace grants and refusals are that agent's. The hour-long workspace grant stays per conversation. `ask_owner` questions name the agent the same way.

### Slack

- The roster entry holds the agent's channel. The settings' `slack.channelId` stays the default agent's channel, so nothing in the settings file changes.
- A top-level message in an agent's channel starts a thread conversation bound to that agent, with its home settings. Messages from the owner in any roster channel count; other channels, users and bots are ignored, as now.
- Reminders, reports, paused jobs, approval requests and questions go to the owning agent's channel, in the thread when they come from one.
- `SlackState` stays one document. Slack's message ts is unique only within a channel, so other channels' keys are `<channel>:<ts>`; the default channel keeps bare ts, so existing entries still match. A pending message records its channel.
- Each agent posts under its own name, with `chat:write.customize` added to `deploy/slack-manifest.yaml`. An app made before then needs the scope added under OAuth & Permissions and the app reinstalled; until it is, posts fail with `missing_scope` and go out again under the app's name with the agent's name in front, and `gaidin doctor` says so. The default agent posts as gaidin, as now.
- Setting up an agent's channel: create it, `/invite @gaidin`, and put its ID in the agent's roster entry. An agent with no channel is reached from the web view and CLI.

### Web view

Built in the app ([Design: the app](#design-the-app)), whose URLs replace the hash routes below; the rest stands.

- The header gets an agent switcher. The default agent keeps today's routes (`#/`, `#/settings`, ...); another agent's pages are under `#/a/<id>/`. The console, settings, memory, schedule and history pages show the chosen agent. Activity and the timeline show every agent, with a column for which.
- The dock shows every pending request, each labeled with its agent, whichever agent is shown.
- A new agents page (`#/agents`) lists the roster and creates and archives agents. The settings page gains the roster entry's fields: name, job, channel, hosts (with remove), workspaces and who it may message.
- The memory page shows shared notes and the agent's work notes in two sections.
- The protocol takes `?agent=<id>` on GETs and `/events`, and an optional `agent` in POST bodies, defaulting to the default agent. New routes: `/api/agents`, `/api/agents/save`, `/api/agents/archive`.
- Archiving pauses the agent's jobs, cancels its reminders and keeps its conversations and sandbox; it can be restored. The default agent can't be archived. Deleting an agent's files is left to the owner.

### CLI

`gaidin ask --agent <id>` and `gaidin watch --agent <id>`, with the socket message gaining an optional `agent`; without one, the default agent, as today. Until the web view's agents page exists, `gaidin agent list`, `gaidin agent add <id> --name <name> --job <text>` and `gaidin agent set <id> --channel <id>` edit the roster over the socket, so Slack can be tried first.

### Migration

On first start the server writes a roster with the default agent: id `gaidin`, the root as its home, no channel of its own (the settings' channel applies), and every workspace. `gaidin.sqlite` is otherwise untouched: the new documents start empty and missing `agent` fields mean the default agent. The existing notes become the shared notes. `history.sqlite` is rebuilt with the agent column. The settings file doesn't change.

Going back to an older build ignores the new documents and fields, but would run other agents' jobs and reminders as gaidin, so cancel them first.

### Order of work

1. Commit item 26 (Slack threads as conversations), which is in progress.
2. Done: the roster, bindings, prompts, sandboxes, memory split, per-agent approvals, jobs and reminders, history, messaging and hand-off, and the CLI. Tests with the faux provider cover isolation: one agent's tools can't reach another's sandbox, notes, jobs, history or hosts.
3. Slack: a channel per agent.
4. Web view: the switcher, the agents page and the per-agent pages, built in the app (its steps 1 to 3), checked in a browser with the Playwright e2e tests.

Each step ends with `pnpm check` passing and is a commit of its own.

## Design: the app

For review before any code. The web view becomes an app, moiraine (in the Wheel of Time, the Aes Sedai bonded to her Warder): each agent's conversations in a sidebar, with its home conversation pinned and its threads below, beside the pages the web view has now. It's a project of its own beside gaidin, written in TanStack Start as a client of gaidin's HTTP API, installs as a PWA as the web view does, and can be wrapped as a native app later without changes to the server.

Decided with the owner:

- Each agent's home conversation stays pinned at the top of its list. New thread starts a thread with that agent, as a top-level message in Slack does: the home conversation's settings and the agent's memory, none of its history.
- Any thread continues from the app, whether it began in Slack, in the app or as a job run. A message sent from the app to a Slack thread is posted to that thread too, with the answer.
- No voice, projects or image generation.
- The app's look and names are gaidin's own and follow the owner's UI defaults; it borrows nothing from other assistants' apps.
- Step 4 of the agents design (the agent switcher and per-agent pages) is built in the app, not the current web view.
- The app is its own repository, `moiraine`, beside gaidin's checkout. It's built on the owner's machine and copied to the server.

### Shape

- moiraine is TanStack Start in SPA mode, with React, TanStack Router (file routes, typed params and search), Query, Form and Virtual. No server functions or SSR: gaidin is the server, and its HTTP API stays the one interface, so a native client would use the same one.
- Its build, `dist/client`, is a directory of static files. gaidin serves them from the directory in `web.app` beside the API on the same origin, behind the same Tailscale login check, Origin check and CSP. Built files have hashed names and can be cached; the page itself isn't. Any path that isn't the API or a file gets the shell, `_shell.html`, so the router's URLs survive a reload. The shell has small inline scripts (scroll restoration and the router's start-up state, as of Start 1.168), which change with each build, so gaidin reads the shell each time it serves it and adds each one's hash to `script-src`, which otherwise stays `'self'`. A new build needs no restart.
- moiraine depends on gaidin as `link:../gaidin` and imports `Gets`, `Posts` and `StreamEvent` from `src/web.ts` with `import type`, so a changed answer still fails `tsc` on both sides. Types are erased in the build, so none of gaidin's code ships in it. Each GET is a query keyed by its agent and conversation, and events from the stream invalidate the queries they affect. A conversation's transcript is kept by moiraine's copy of the reducer in `web/transcript.ts`, tested against the e2e server's event stream; gaidin's copy and `test/transcript.test.ts` go at the switch.
- `/api/version` answers with the protocol's version, a number gaidin raises when an answer or body changes shape. moiraine's build records the version it was typed against and says so when the server's differs, since the two are deployed separately.
- moiraine's `pnpm dev` runs Vite's dev server, proxying `/api` and `/events` to a local gaidin and adding `Tailscale-User-Login` with `web.user`, for development only. Its Playwright tests start gaidin's e2e server from the sibling checkout.
- `sw.js` keeps its jobs (notifications and the can't-reach-the-server page) and moves to moiraine at the switch, served at the same path and scope, so devices signed up for notifications stay signed up. It still caches nothing. A notification opens the conversation it came from.

### Layout

- The sidebar shows the chosen agent: a switcher with its name at the top, then its home conversation, New thread, and its threads newest first, each labeled with where it began (Slack, the app, a job, or another agent) and loading more as it scrolls. The pages are a compact list at its foot. On a phone the sidebar is a drawer and the conversation takes the screen.
- A conversation is drawn as the console is now: the log with thinking and tool calls folded, the dock, the prompt with slash commands, and the status line. The dock shows every agent's pending requests, each labeled with its agent.
- URLs: `/<agent>` for the home conversation, `/<agent>/t/<id>` for a thread, `/<agent>/schedule`, `/memory`, `/skills` and `/settings` for that agent's pages, and `/agents` and `/activity` across agents. Old hash links such as `#/schedule` go to the default agent's page.
- The pages keep what the web view's pages do, with the per-agent changes from the agents design: memory in shared and work sections, the roster entry's fields on settings, and an agents page that creates and archives agents.

### Server changes

- Threads without Slack. Starting a thread (a new conversation bound to the agent, with its home settings copied) and continuing one (a job run or another agent's message forks at its last answer, as a Slack reply on a report does) move out of `src/slack/conversation.ts` into a module both surfaces use. Slack keeps its message bookkeeping and posting. A thread records where it began, for the sidebar's labels.
- The protocol, beyond the agents design's `?agent=` and `agent` in bodies:
  - `/events?conversation=<id>` streams any conversation, not only the root's.
  - `/api/message` and `/api/abort` take an optional `conversation`, defaulting to the agent's home. A message that forks says the new conversation's id, and the app moves to it.
  - `/api/threads/start` takes an agent and a first message and answers with the new thread's id.
  - `/api/conversations` lists an agent's threads with where each began, and `/api/conversation` drops its read-only rule.
- Attachments. `/api/files` takes a file's bytes, up to 20 MB, with a custom header that forces a CORS preflight as a JSON body does, and the Origin check. Images go to the model with the message, as from Slack; the app shrinks one over 3.75 MB before sending it. Other files are saved in the agent's sandbox under `uploads/`, as Slack's are. The code that does this for Slack is shared.
- Slack mirroring. A message sent from the app to a conversation with a Slack thread is posted in that thread, marked as sent from the app, followed by the answer. It's recorded as pending before it's posted, as Slack's own messages are, so a restart still posts it.

### Deploying

moiraine's deploy script builds on the owner's machine and copies the build over Tailscale SSH to `/var/lib/gaidin/moiraine` on the VM, which `web.app` names. The VM needs no second checkout, deploy key or build dependencies. When the protocol changes, gaidin is deployed first. `gaidin doctor` says when `web.app` is set and the directory is missing or built against another protocol version.

### Order of work

1. Done: the shared thread module, the protocol for any conversation and agent, and the agents routes, with tests using the faux provider (item 28). `web.app`, the CSP hashes and the shell for every path come with step 2, when there's a build to serve.
2. Done: moiraine's skeleton, served by gaidin at `/app/` beside the web view: the sidebar, a conversation, the dock and the prompt, with the console's Playwright e2e tests copied over and run against the app (item 29). New thread is `/<agent>/new`. The web view's tests stay in gaidin until the switch.
3. Done: the pages, with the per-agent changes (item 30). With no conversation open, a page asks for the approvals every 5 seconds rather than following an event stream. The web view's `#/<page>` addresses and `#/history/<id>` open the matching page or thread.
4. Attachments.
5. Slack mirroring. It needs Slack's channel per agent (agents step 3) only for agents other than the default.
6. The switch: the app moves to `/`, `sw.js` moves to moiraine, `web/` is removed, and Surfaces describes the app.

Each step ends with `pnpm check` passing in each repository it touches and is a commit of its own there.
