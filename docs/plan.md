# Plan

## Decisions

- gaidin runs alongside Hermes, the existing agent. Nothing moves over from Hermes until gaidin has earned it.
- Its first jobs were reminders and "is the homelab OK" from a phone.
- It runs on its own VM, so the host's nightly backups cover its SQLite file.
- It uses Claude through an API key in its own Console workspace with a spend limit, Haiku 5.5 by default and Sonnet 5.5 where a conversation needs it. Subscription sign-in in a third-party harness is out.
- Everything stays generic enough to release: machine-specific values live in settings or in the homelab extension.
- Pocket Pi isn't a surface. Voice is a speaker in a room for the household, with speech handled outside gaidin ([Design: voice](#design-voice)); there's no push-to-talk in the app.
- Hindsight (retired 2026-09-30) and Dozzle (retired 2026-10-10) aren't part of it.
- No web app, since 2026-10-24: gaidin serves its HTTP API and nothing else. moiraine is no longer served and `web.app` is gone; the API stays as it was, for a client of the owner's own. [Design: the app](#design-the-app) and the items that built it are history.

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
31. Attachments from the app: files sent ahead to `/api/files` and named by the message, images to the model and other files to the agent's sandbox, through `src/files.ts`, which Slack's files go through too; the app shrinks a large image first (protocol 3).
32. Slack mirroring: a message sent from the app to a conversation with a Slack thread is posted there, headed *From the app:*, and then its answer, recorded before it's posted so a restart still posts both ([Surfaces](surfaces.md#slack)).
33. The switch: the app is served at `/`, with the service worker, manifest and icons its own at the paths they had, so installed apps and devices signed up for notifications carry over; the app's old `/app/` addresses redirect, a notification opens the conversation it came from, and the web view and its tests are gone (protocol 4) ([Surfaces](surfaces.md#the-app)).
34. Files between agents: `message_agent` and `hand_off` take up to 10 files from the sender's sandbox, read through its confined file tools, and the receiver gets copies in its `uploads/`, read-only to its commands, with a note of where they are, as for Slack's and the app's files. An approval for either names the files ([Tools](tools.md#other-agents)).
35. The browser's reading tools: profiles named in the settings and given per agent in its roster entry, a Chromium per profile with its own sandbox and its cookies in `<data>/browser/`, and `browser_open`, `browser_snapshot`, `browser_screenshot` and `browser_tabs`, offered only to agents with a profile. Opening a page asks as a fetch does, a page's own navigations to other hosts are stopped, and private addresses are refused for everything a page loads. `setup.sh` installs Chromium with its AppArmor profile (protocol 7) ([Tools](tools.md#browser), [Security](security.md#the-browser)).
36. The browser's acting tools: `browser_click`, `browser_type`, `browser_select`, `browser_back` and `browser_upload`. Acting asks while outside text is in the conversation, naming the element as the snapshot showed it, unless the owner let the agent act on that site in that profile without asking (a new second button, kept in the roster entry and removable on the settings page), and happens only if the page is still what was asked about. Typing into a password field is refused, and uploads ask every time. Downloads land in the agent's read-only `downloads/`, and dialogs are dismissed and reported. Refs now come only from whole-page snapshots, since snapshotting one element renumbered the page's refs (protocol 8) ([Tools](tools.md#browser)).
37. Taking a browser profile over: the app's Browser page lists the profiles and opens one live, a screencast relayed as an event stream of JPEG frames, with the owner's clicks, scrolls and typing sent back as POSTs, on a phone too, and the agents' browser calls on it waiting until the owner is done. `browser_hand_over` asks the owner to take over and waits like `ask_owner`, shown in the dock, pushed and posted in Slack with Take over, Done and Can't (protocol 9) ([Tools](tools.md#taking-a-profile-over)).
38. Slack's channel per agent: a roster entry names its agent's channel, where a top-level message starts a thread with that agent and the agent's reminders, reports, paused jobs, requests and questions go, under its name (`chat:write.customize`, falling back to the app's name with the agent's in front). Messages in other channels are keyed `<channel>:<ts>` in `SlackState`, the default channel's keeping bare ts, and an agent without a channel posts in the default one, named. `gaidin doctor` says whether the app has the scope ([Surfaces](surfaces.md#slack)).
39. Connectors, without OAuth: remote MCP servers added with `gaidin connector`, with a bearer token or none, spoken to in the current revision (2026-07-28) or the earlier ones; their tools given per agent, each set to allow, ask or off, their definitions pinned, their results outside text, and their tokens in `<data>/connectors/vault.json` ([Tools](tools.md#connectors)).
40. Connectors' OAuth: `gaidin connector connect` finds a server's sign-in from its metadata (RFC 9728 and 8414), checked to the connector's host or public https, and sends the owner's browser there with PKCE and the resource parameter; the callback takes only a state gaidin made and the issuer it expects. gaidin's client id is a document it serves at `<web.url>/api/connectors/client.json`, or a public copy named in `connectors.clientId`, else Dynamic Client Registration, else one the owner gives. Grants are refreshed before they expire and once after a refusal ([Tools](tools.md#connectors)).
41. The app's Connectors page: each connector's state, its tools set to allow, ask or off with their cost, new and changed tools marked, signing in in the same tab and back, tokens, refresh and remove; agents given connectors on their settings pages, and a notice and a sidebar count when one needs signing in again (protocol 10) ([Surfaces](surfaces.md#the-app)).
42. Rules, step 1: the owner's allow and ask rules, per agent and tool or family, with argument conditions, an end, and "even after outside text" for allow rules; ask rules reach every tool and override every grant, allow rules skip a guard's question but never a refusal or the floor (loading tools, skills, new jobs, browser uploads). The rule that let a call through is in the timeline. `gaidin rule` manages them ([Security](security.md#your-rules)).
43. Rules, step 2: the app's Rules page lists the rules with remove, the grants that also let calls through (hosts, sites acted on, connector tools set to allow, workspace hours) with where each is changed, and makes rules; an approval card's "make a rule" fills the form in from the request, a URL argument as its host (protocol 11) ([Surfaces](surfaces.md#the-app)).
44. Folder trust, gaidin's side: an `inside` condition on a workspace path, so one allow rule lets an agent's reads, writes and edits in a folder and every folder below it through. The folder goes to the workspace's helper, which refuses a path whose real path, symlinks resolved, isn't inside it; a read the rule let through isn't outside text for that rule; `workspace_run` never goes through on one. `gaidin rule` takes it (protocol 12) ([Security](security.md#your-rules)).
45. Agent colors: a roster entry can name the color the app shows its agent in, one of eight the app draws (`AGENT_COLORS`), set on the settings page and saved with `/api/agents/save`; an agent without one gets a color by its place in the roster (protocol 13) ([Surfaces](surfaces.md#the-app)).
46. Ready to publish: gaidin and moiraine are under the MIT license. Neither history has a key or token, only test values and placeholders. The owner's LAN and tailnet addresses, a Slack channel ID, the Slack workspace's name and a home path are gone from the current files; gaidin's history keeps them and a tailnet name, as the owner chose not to rewrite it.
47. An app-wide event stream: `GET /events?all` has the same checks, headers and ping as `/events` but follows no conversation and sends no snapshot, and carries `approvals_changed` so a page without a conversation follows approvals without polling (protocol 14) ([Surfaces](surfaces.md#the-app)).
48. Activity and conversation events on `/events?all`: `activity_changed` and `conversations_changed`, each with an `agent`, so the app stops polling `/api/agents/activity` and each agent's conversation list. One listener on the Harness's commits notes the conversations of input submissions (any status, which covers a run's start and end wherever it was submitted from) and of entry and conversation records, then finds their agents after a 250 ms window, so each agent hears each event once per window (protocol 15) ([Surfaces](surfaces.md#the-app)).
49. Shared notes per agent: a roster entry's `sharedNotes: false` keeps the shared notes out of that agent's prompt, and its `remember` with `shared`, `update_memory` and `forget` on a shared note are refused, for an agent people other than the owner talk to; the default agent always has them. Set with `gaidin agent set --shared-notes on|off` or `sharedNotes` on `/api/agents/save` (protocol 16) ([Tools](tools.md#memory)). Step 1 of the voice design, with the `family` agent made in the roster.
50. The voice route: `POST /api/voice/turn` takes a bridge's bearer token from `voice.tokens`, which reaches only that route and the agents it lists, and answers with an event stream of `say`, `waiting` and `done`. Each speaker has a rolling thread, origin `voice`, that starts afresh after 5 minutes of quiet; a turn's key makes it land once; what a speaker heard is outside text to the approvals hook, except that cancelling a reminder after speech alone doesn't ask, so the room can stop a timer (protocol 17) ([Surfaces](surfaces.md#voice), [Security](security.md#voice)). Step 2 of the voice design.
51. Reminders on speakers: a reminder or timer set while talking at a speaker is said there (`remind` takes `to`: a speaker, every speaker or the phone), offered to the voice bridges on `GET /api/voice/events` and confirmed on `/api/voice/announced`; one no bridge says within 20 seconds reaches the phone, naming where it was missed (protocol 18) ([Surfaces](surfaces.md#voice), [Tools](tools.md#reminders)). Step 4 of the voice design, gaidin's side.
52. No web app: gaidin no longer serves moiraine's build. `web.app`, the shell and its per-build Content-Security-Policy, and the redirects from `/app/` are gone, so every path that isn't the API is a 404, and every response's policy is `default-src 'none'`. A `web.app` left in the settings is a warning. A connector's sign-in ends on a plain-text page instead of the Connectors page, Slack's hand-over has no Take over link, its connector notice names `gaidin connector connect`, and an ntfy reminder opens nothing when tapped. The routes, their shapes and `PROTOCOL` are unchanged, and `e2e/server.ts` still runs the API on a scripted model for a client's tests ([Surfaces](surfaces.md#the-api)).

## Next

Candidates:

- Owner-written allow and ask-first rules (designed below). Several named agents, the browser and connectors (designed below) are done; trying more connectors with real services is ongoing.
- Release polish (designed below): a setup wizard, Slack app creation from a configuration token, and an installer ([Extending](extending.md#still-specific-to-one-deployment) lists what's left that's specific).
- Voice (designed below): a household speaker and a `family` agent, with timers and reminders it speaks.

Not planned: branching from any message in the web view, since each thread is already a conversation of its own; push-to-talk, since the owner dictates with superwhisper; and projects or image generation in the app.

## Design: voice

For review before any code. A speaker in a room that the owner's household talks to, as they would a smart speaker: it wakes on a word, answers questions, and sets timers and reminders that it speaks when they're due. The speaker belongs to a new `family` agent, not to the owner's own.

### Decided with the owner

- **The speaker is an ESP32-S3 board running a fork of xiaozhi-esp32**, which does the wake word, echo cancellation and Opus audio on the board and speaks xiaozhi's WebSocket protocol. The wake word is one the owner picks, through ESP-SR's English MultiNet when it isn't one of WakeNet's trained phrases. The fork lives outside gaidin.
- **Speech runs beside the speaker, not in gaidin.** A bridge on an always-on machine with a GPU speaks xiaozhi's protocol to the speakers, turns speech into text with whisper.cpp and text into speech with Piper, and talks to gaidin in text. gaidin never handles audio. The bridge is a project of its own, so gaidin's side is a text surface any voice front end could use.
- **A `family` agent** in the roster, on Haiku 5.5, whose standing instructions ask for short, speakable answers with no Markdown. Its tools: reminders, web search, and fetches from search results. No workspaces, homelab, browser, connectors, self-written tools or messaging other agents.
- **Shared notes stay out of its prompt.** Anyone in the room can ask it anything, so a roster entry gains `sharedNotes: false`, and the family agent keeps only its own work notes ("soccer is on Tuesdays"). Its notes are written by whoever speaks, so writes ask as they do after outside text.
- **Speech is outside text.** Anyone in the room, a guest or a television can talk to it. Each spoken turn counts as outside text for the approval hook, so anything that asks after outside text asks the owner, on their phone, never on the speaker. The agent's narrow tools mean it should rarely need to.
- **Timers are reminders.** A timer is a reminder with a short delay delivered to the speaker it was set on, so there's one durable mechanism, and "how long is left on the pasta" is `list_reminders`. The board plays an alarm until someone stops it. Timers kept on the board would survive the bridge or gaidin being down, but need more firmware.
- **Reminders gain a target.** Today a reminder reaches the owner. A family agent's reminder goes to a speaker (the one it was asked on unless told otherwise), every speaker, or the owner's phone as now. Other people's phones aren't a target. Voice doesn't identify the speaker, so "remind me" means the room it was asked in.

### gaidin's side

- **A voice route** on the web server (agreed with the owner, as a change to who the web server answers), `POST /api/voice/turn` with `{ speaker, text, key }`, which answers with the agent's reply as text, streamed as an event stream so the bridge can start speaking the first sentence early. It takes a bearer token named in the settings (`voice.tokens`, one per bridge) instead of the Tailscale login, and only reaches agents a token lists. It refuses everything else on the web server, and the rest of the web server still refuses the token.
- **A conversation per speaker.** Each speaker has a rolling thread with its agent, origin `voice`, which carries on while turns keep coming and starts afresh after 5 minutes of quiet, so follow-ups work and yesterday's talk doesn't pile up. `key` makes a turn sent again land once.
- **Announcements.** `GET /api/voice/events` is a long-lived event stream, with the same token, of things to say: a reminder or timer due on a speaker. A new notice target, `speaker`, sends there. A reminder for a speaker that isn't connected is told to the owner's phone instead, saying which speaker missed it.
- **Notices.** The bridge going away for more than a few minutes is a notice to the owner, as a connector needing sign-in is.

### The bridge's side (outside gaidin)

- Answers the speakers' update check with its own WebSocket address and a per-speaker token, keyed by MAC address.
- Per turn: Opus from the speaker, whisper.cpp, `/api/voice/turn`, Piper on each sentence as it arrives, Opus back.
- Holds an idle connection to each speaker so it can speak first: a firmware change in the fork, since stock xiaozhi opens its socket only when woken.

### Known gaps

- Anyone who can reach a speaker can use the family agent's tools and spend. The spend guard's limits cover cost; the agent's narrow tools cover the rest.
- Traffic between the speaker and the bridge is authenticated by token but not encrypted, as the board speaks plain `ws://` on the LAN.
- A wake word through MultiNet, matching a short word, misses more and wakes falsely more than a WakeNet model trained on a phrase.

### Order of work

1. Done: `sharedNotes: false` (item 49). The `family` agent is made in the roster, not in code, and tried from the CLI with `gaidin ask --agent family`.
2. Done: the voice route, its token, the per-speaker threads and origin `voice` (item 50).
3. Done: the bridge, outside gaidin, with the speaker's echo test replaced by a real turn: end-of-speech on the bridge, whisper.cpp, the voice route, and Piper.
4. Done: reminder targets and the announcement stream (item 51), with the bridge saying them and the firmware change for speaking first outside gaidin.
5. Timers' alarm on the board, and more speakers.

Each step ends with `pnpm check` passing and is a commit of its own.

## Design: release

For review before any code. Today gaidin runs for one person, set up by hand: a settings file written from the example, a VM prepared by `setup.sh` that clones a private repository with a deploy key, and the app built on the owner's machine and copied over. A release lets someone else do it from the documentation alone, in under an hour, on their own VM.

### Proposed, to decide with the owner

- **Publish both repositories**, gaidin and moiraine, on GitHub, under the MIT license as Pi Durable is. Both are licensed (item 46) and neither is public yet. History stays as it is (below).
- **Two repositories still, with the app as a release asset.** Each gaidin release names the protocol it speaks; each moiraine release attaches its build (`dist/client`) as a tarball with its SHA-256, built for one protocol. The installer fetches the newest moiraine build for the installed gaidin's protocol and checks it. The VM still needs no build tools. The owner's own `pnpm ship` stays for deploying straight from a checkout.
- **Upgrade Pi Durable first.** Done: gaidin is on 1.3.0, so a release doesn't start two versions behind; the upgrade is its own commit, tested with a restart in the middle of a run, as [Deploying](deploy.md#upgrading-pi-durable) says.
- **Versions:** gaidin and moiraine start at 0.1.0, tagged, with `gaidin --version`. Each release's notes are its items from the Done list above, which already reads as a changelog.
- **Ubuntu 24.04 and Debian 12** are the installer's targets; other Linux runs from a checkout as now. Node comes from nodejs.org's official tarball for a pinned version, checked against its published SHA-256, and pnpm through Corepack.

### `gaidin setup`

An interactive command that writes the settings file, mode 600, one section at a time, each skippable and each checked as it's entered with what `gaidin doctor` already checks:

1. The owner's name and time zone (the system's, offered).
2. The model: the API key, checked by looking the model up; the default model; daily and monthly limits, with a note on the Console's own limit.
3. The app: the Tailscale login and the tailnet name, read from `tailscale status`, giving `web.user` and `web.url`; `web.app` where the installer put the build.
4. Notifications: an ntfy topic with a long random name it makes, or none (the app's Web Push needs nothing here).
5. Slack (below).
6. Search: a Tavily key, checked.

Run again, it shows each section as it is (secrets shortened) and changes only what's chosen. It never prints a whole secret. It ends with `gaidin doctor`.

### Slack from a configuration token

Slack's Manifest API makes the app from `deploy/slack-manifest.yaml` with an app configuration token (made at api.slack.com/apps, valid 12 hours). It can't install the app or make the Socket Mode token, so setup does what it can and says exactly what's left:

1. The owner pastes a configuration token; setup creates the app (`apps.manifest.create`), with the app's name the owner picks, and prints its settings page.
2. The owner presses Install to Workspace there and pastes the bot token (`xoxb-`), which setup checks with `auth.test`.
3. The owner generates an app-level token with `connections:write` and pastes it (`xapp-`), checked by opening a Socket Mode connection.
4. The owner makes a channel, invites the app, and pastes the channel's ID and their own member ID; setup checks the bot can post there.

The configuration token isn't kept. Without one, setup prints the manual steps from [Surfaces](surfaces.md#setting-up-slack) instead.

### The installer

`deploy/install.sh`, which `setup.sh` becomes: run as root on a fresh VM, after reading it (the documentation says to download and read it, not to pipe it into a shell).

- It takes the repository to install from, the official one by default, cloned over HTTPS when it's public, so no deploy key; a private fork keeps the deploy key path that's there now.
- It installs Node, pnpm, bubblewrap and its AppArmor profile, poppler, the `gaidin` user, unit and command, as `setup.sh` does now, and Chromium only when the settings name browser profiles.
- It fetches the app's build for the installed protocol, checked, into `/var/lib/gaidin/moiraine`.
- On a first install it runs `gaidin setup`, then starts the service; afterwards it's how you update, as now, keeping the settings.

### Before publishing

- **Nothing specific left in the code:** the repository URL in the installer and the README's first lines; the manifest's "Tar Valon" comment is gone (item 46); the homelab extension stays, optional and described as written for one deployment.
- **No secrets in the history:** a scan of every commit of both repositories for keys and tokens, and for the owner's private identifiers (tailnet name, LAN addresses, Slack IDs), with whatever turns up removed or rewritten before the first push to a public remote. The owner decides on anything found. Done (item 46): no keys or tokens; the private identifiers are gone from the current files and kept in the history.
- **A getting-started path** in the README: try it locally with the faux model, then a VM with the installer and `gaidin setup`, then Slack, connectors and the browser as they're wanted.

### Order of work

1. Done: Pi Durable 1.3.0, on a branch, with the restart test.
2. `gaidin setup` without Slack, and `gaidin --version`.
3. Slack from a configuration token.
4. The installer, moiraine's release build and its check, and the getting-started docs, tried on a fresh VM.
5. The history scan and the specific leftovers, done but for the installer's repository URL (step 4); then the owner publishes, or says to.

Each step ends with `pnpm check` passing and is a commit of its own. Publishing is the owner's call and happens last.

## Design: rules

Steps 1 and 2 are done (items 42 and 43). Today what asks is fixed per tool by its guard (the table in [Security](security.md#approvals)), and the only ways to ask less are the grants built into a few tools: a host allowed for good, a site the browser acts on without asking, a workspace for an hour, and a connector tool set to allow. Rules let the owner say it directly, per agent and per tool, either way: "Lan may turn lights on and off without asking", or "always ask before Verin fetches anything from example.com", even where a grant or a tool's setting would let it through.

### What a rule is

- **Effect:** allow (the call goes ahead without asking) or ask (it asks every time, whatever else would let it through).
- **Agent:** one agent, or every agent.
- **Tool:** a tool's name, or a family by its prefix (`home_*` for a connector's tools, `workspace_*`, `browser_*`).
- **Arguments, optional:** conditions on the call's arguments, all of which must hold: equals, one of, starts with, contains, for a URL argument its host, and for a workspace path a folder it's inside. "`home_intent__HassTurnOn` where `name` contains `light`."
- **Until, optional:** a rule can end on its own: in an hour, at the end of the day, on a date. The workspace hour grant is this with a fixed hour.
- **A note:** why the owner made it, shown on the page and in the timeline.

### How a call is decided

1. Refusals win. A call its guard refuses (a profile the agent wasn't given, a password field, a tool that's off or changed since the owner set it) is refused whatever the rules say. A rule can't give an agent something it hasn't been given.
2. An ask rule that matches makes the call ask, every time, with a second button only if its guard offered one. It overrides allow rules and every grant: a host allowed for good, a site acted on without asking, a connector tool set to allow, an hour's workspace grant. It also reaches tools that never ask today, such as `bash` or `remind`.
3. Otherwise, a call its guard would ask about goes ahead when an allow rule matches.
4. Otherwise, as today.

Whichever rule decided a call is written into the conversation with the call, as an approval's outcome is, so the timeline says "allowed by rule: lights for Lan" and the owner can see what each rule has let through.

### Decided with the owner

- **Some calls no allow rule reaches.** Loading or removing self-written tools, writing or removing skills, scheduling a new job, and uploading files from the browser keep asking whatever the rules say: each puts code, instructions or the owner's files somewhere they act later or leave for good. Ask rules still reach them.
- **Allow rules stop after outside text, unless the rule says otherwise.** Today a note write or a message to another agent asks only after outside text, because a page the agent read could be steering it. An allow rule holds only while no outside text is in the conversation, by default; the owner can tick "even after outside text" on a rule. Without the tick, a rule for a connector's write tools stops holding once the agent has read that connector, since its results are outside text too, so for connectors the tick is what makes a rule useful, and the form says so.
- **Rules live in the database, edited on a Rules page** across agents, as connectors are, with `gaidin rule list|add|remove` on the command line. The settings file stays free of them.
- **Made from a request too.** An approval card in the dock gains "make a rule", which opens the form with the agent, the tool and the call's arguments filled in, for the owner to widen or narrow before saving. A rule is never made by a model; there's no tool for it.
- **The existing grants stay as they are** (hosts allowed for good, sites acted on, connector settings, workspace hours), and the Rules page lists them beside the rules, read-only with a link to where each is changed, so one page shows everything that lets a call through without asking. Folding them into rules can come later, if it's worth it.
- **Folder trust** (2026-10-16). An agent writing notes on a workspace asked file by file, and an allow rule on the workspace didn't help: `workspace_read` is outside text, so the first read ended the rule, and `starts-with` compares text the helper reads differently (relative to the first root, absolute in any root, `..`, symlinks). So a condition `inside`, on `path`:
  - The call's path is the folder or inside it, compared as text after resolving `.` and `..`, case-sensitive, a trailing slash ignored. A relative path is relative to the workspace's first root, as the helper reads it. The folder is stored as the owner gives it, relative like `notes/Ideas` or absolute; one that leaves the first root is refused. `..` that leaves the folder and comes back in matches, since the helper also resolves `..` as text, and opens the same file.
  - The helper names its roots in every answer, and gaidin keeps the latest per workspace in memory, asking with a read of the root when it hasn't heard since it started. With the first root known, a relative path and an absolute folder, or the other way round, are compared as the helper reads them, so a rule written `notes/Ideas` covers the absolute paths the helper's answers show the model.
  - When an inside rule lets a call through, the hook memos the rule and its folder on the tool task and the tool sends the folder to the helper as `within`; the helper refuses a path whose real path, symlinks resolved, isn't inside it. A call the owner approved sends none, and a helper request without it works as before. An older helper ignores `within` and names no roots, so until gaidin has heard a workspace's roots no inside rule lets a call through there, and an answer without them forgets them: a helper that names them holds calls to the folder.
  - Outside text still ends the rule, by default, except a `workspace_read` that rule let through: those are the owner's own files. The read's result carries the rule in its details, which only the tool writes and the model never sees, as `web_search` marks its URLs, and the outside-text check skips those results for that rule only. A fetch, a read outside the folder or one the owner approved, a `workspace_run`, the browser's text and a connector's still end it.
  - An inside rule names `workspace_read`, `workspace_write`, `workspace_edit` or `workspace_*`, has one inside condition, and pairs it with `workspace equals <name>`. `workspace_run` never goes through on one, even under `workspace_*`, since a command can touch any file whatever its cwd. Ask rules still win and the floor is unchanged.
  - The app offers "Trust <folder> for <agent>" on a workspace card, the folder being the path's parent, from the request's `ruleArgs` (`path` and `workspace`); the protocol carries `inside` in the rule types.

### Known gaps

- An allow rule with "even after outside text" can be steered: a page or a tool's result can lead the agent to make exactly the calls the rule allows. The form says so beside the tick.
- Argument conditions match what the model wrote, not what the tool does with it: "`name` contains `light`" lets through a device named "light switch for the garage door".
- A family rule (`home_*`) covers tools the connector adds later, though a new connector tool is off until the owner sets it, which still stops it.
- A trusted folder's reads aren't outside text for its rule, so whatever got into the folder is trusted with it: a page summary the owner approved writing there, an approved `workspace_run`'s output, another program's sync. It can steer the agent into exactly what the rule allows, writes and edits in that folder; other tools still count the read as outside text.
- A write replaces a whole file without asking, so a trusted folder's files are only as safe as their history (git or backups). Trust folders of notes and data, not code: a script or config there runs later as the owner.

### Order of work

1. Done: rules in a document, the decision in the approvals hook for every tool, guarded or not, the rule recorded with each call it decided, and `gaidin rule` (item 42). The timeline already says which rule allowed a call; a request an ask rule made names the rule in its summary. Tests with the faux provider: each precedence step, the floor, outside text with and without the tick, expiry, and an agent's rule not reaching another agent.
2. Done: the app's Rules page, with the grants beside the rules, and "make a rule" on approval cards, with e2e tests (item 43). A request carries its short arguments (text, numbers and booleans up to 200 characters) for the form.
3. The timeline and Slack name the rule that decided a call.
4. Folder trust: gaidin's side is done (item 44); the app's "Trust <folder> for <agent>" on a card is next, in its own commit there.

Each step ends with `pnpm check` passing and is a commit of its own.

## Design: connectors

Steps 1 to 3 are done (items 39 to 41). A connector is a remote MCP server the owner adds, such as a mail, calendar, GitHub or notes service's: its tools become tools of the agents the owner grants it to, signed in with OAuth, the tokens held by the server. Where a service has one, a connector beats the browser: a tool call returns compact data rather than a 12,000-token page, there are no CAPTCHAs or redesigns, an OAuth grant can be narrower than a whole signed-in session and is revoked in one place, and an approval names what will happen ("send mail to X") rather than a ref on a page. The browser stays for sites without one.

### What the spec asks for

The current MCP revision, 2026-07-28, changed the protocol a lot: no `initialize` handshake or `Mcp-Session-Id`, every request carrying its protocol version in `_meta`, a `server/discover` call, `subscriptions/listen` in place of the GET stream, and interim `input_required` results in place of server-to-client requests. Most servers in use still speak 2025-06-18 or 2025-11-25, with the handshake and sessions, so the client speaks both: it calls `server/discover`, and on a server that doesn't know it, falls back to `initialize`.

Authorization is OAuth 2.1 with PKCE (S256), the resource parameter (RFC 8707), the server's protected resource metadata (RFC 9728) and its authorization server's metadata (RFC 8414 or OpenID discovery), checking the `iss` in the response (RFC 9207), refresh tokens, and step-up when a call answers `insufficient_scope`. Client registration, in the spec's order: a client id and secret the owner enters for that server, a Client ID Metadata Document (an HTTPS URL that is the client's id and serves its metadata), or Dynamic Client Registration, which 2026-07-28 deprecates but most servers still offer.

### Decided with the owner

- **Our own client, no SDK.** `@modelcontextprotocol/sdk` (1.32.1) brings Express, Hono, CORS, Zod and Ajv for a server gaidin doesn't run. The client side gaidin needs is small: JSON-RPC over POST with a JSON or event-stream answer, `tools/list` and `tools/call`, and the OAuth flow on `fetch` and `node:crypto`, as Web Push was written. It's checked against servers the tests run on loopback, in both protocol generations.
- **Remote servers only, for now.** A local (stdio) server is someone else's code running on the VM; it would need a box like self-written tools get, and most local servers want the network, which a box doesn't have. Left for later.
- **Connectors live in the database, edited from the app**, as the roster is: a name (lowercase, like an agent's id), the server's URL, and how it signs in (OAuth, a static bearer token the owner pastes, or nothing). The settings file holds only what's per deployment (below).
- **Granted per agent**, as workspaces and browser profiles are: an agent's roster entry lists its connectors, and a new agent, the default one included, has none. A connector's tools are offered only to agents given it, and a call from another is refused.
- **Each tool switched by the owner: allow, ask, or off.** A tool's annotations (`readOnlyHint`, `destructiveHint`) are the server's word and only set the default: read-only tools start at allow, everything else at ask, which asks on every call, showing its arguments. What any tool returns is outside text, so note writes and cancels after it ask, as after a page. Off tools aren't offered, which also keeps a 60-tool server from adding 20,000 tokens of definitions to every request; the app shows each connector's cost in tokens.
- **A tool's description is pinned.** A server writes the descriptions the model reads, so a changed one could steer it. gaidin keeps a hash of each tool's name, description and schema when the owner sets it; a tool that's new or changed since comes in off, and the app marks it for review. Only the owner turns it on.
- **Tokens in a file of their own**, `<data>/connectors/vault.json`, mode 600, outside every sandbox and outside `gaidin.sqlite`, so no document, transcript or API answer can carry them. Each is added to the redactor while it's held. The VM's backups hold them, as they hold the browser's cookies.
- **The client's identity.** A Client ID Metadata Document has to be fetched by each authorization server from the public internet, and gaidin is reached only on the tailnet. Built: gaidin serves its document at `<web.url>/api/connectors/client.json` and uses that URL as its client id, which a server that checks the redirect against the client id's host, as Home Assistant's IndieAuth does, accepts without fetching. For one that fetches it, `connectors.clientId` names a copy the owner hosts in public, which `gaidin connector client-document` prints. The redirect URI is gaidin's own callback on the tailnet name, which works because it's the owner's browser that follows it. Without a client id document, Dynamic Client Registration, and failing that, a client id the owner gives for that connector.
- **Addresses.** The connector's URL is the owner's choice, so it may be on the LAN or tailnet, such as an MCP server in the homelab; it must be HTTPS unless it's on loopback or a private address. Every URL gaidin learns from a server (its metadata, its authorization server, a registration or token endpoint) must be HTTPS and public, unless it's on the connector's own host, so a server can't send gaidin's requests into the LAN.

### Shape

- `src/connectors/`: the client (`client.ts`), OAuth (`oauth.ts`), the token file (`tokens.ts`), and one extension per connector, named `connector-<name>`, whose tools are `<name>_<tool>`, cut to Anthropic's 64 characters. The extensions are installed when a connector is added and reinstalled when its tools change, and selected only in the homes of agents given it, as the browser's is.
- A connector's tool list is read when it's connected, again when the server says it changed (`listChanged`, through `subscriptions/listen` or the older notification), and on the owner's refresh, and kept in a document, so a restart offers the same tools without asking the server first.
- A call: the arguments as the model gave them, checked against the tool's schema by Pi Durable; a 60-second timeout the connector can raise; text and image content passed on, structured content as JSON, everything else described; the text cut to 20,000 characters, saying so. Tool calls aren't replay-safe, so one a restart cut off is reported as interrupted.
- A `401` refreshes the token once and tries again; a refused refresh, or `insufficient_scope`, marks the connector as needing the owner, and the call fails saying so. A connector that worked and comes to need the owner is told to the owner once, as budget warnings are (Slack, or else push and ntfy), and counted in the sidebar beside the Connectors page; asking for wider scopes on `insufficient_scope` uses the challenge's scopes at the next `connect`. `input_required` results (a server asking the user something mid-call) aren't answered yet: the call fails, naming what the server asked.
- The OAuth flow starts from the app: the owner presses Connect, gaidin makes the PKCE pair, `state` and the expected issuer, keeps them for 10 minutes, and sends the browser to the authorization server; the callback, `/api/connectors/callback`, behind the Tailscale login like every route, checks `state` and `iss`, redeems the code, and goes back to the connector's page. Nothing in it passes through a model.

### The app

A Connectors page across agents, beside Browser: each connector with its state (connected, needs signing in, unreachable), its tools with allow, ask or off and its token cost, new or changed tools marked, and Connect, Disconnect, Refresh and Remove. Adding one takes a name and a URL, and a token or client id when the server needs one. An agent's settings page gets its connectors beside its workspaces and browser profiles. The protocol version goes up.

### Known gaps

- What an allowed tool does happens without asking. Allow is the owner's call per tool, and read-only defaults are the server's word.
- A tool's result can steer the agent; it counts as outside text, as a page does, but on an allowed write tool that's no check at all.
- Pinning catches a changed description, not a server that behaves differently behind the same one.
- A connector's token can do whatever its grant allows, from the VM, until it's revoked at the service.

### Order of work

1. Done: the client in both protocol generations, connectors with a static token or none, the tools as per-agent extensions with allow, ask and off, pinning, and the guards (item 39). Tests against MCP servers the test runs on loopback, old and new. Until the app's page, `gaidin connector` manages them. Threads and job runs started before a connector was added are offered its tools too, as with self-written tools, and the guard refuses calls from agents not given it.
2. Done: OAuth: discovery, PKCE, the resource parameter, `iss`, the three ways to register, refresh, the callback, and the token file (item 40). Tests against an authorization server the test runs, shaped like Home Assistant's.
3. Done: the app's Connectors page and the agents' grants, with e2e tests (item 41). Signing in sends the page's tab to the service, which sends it back.
4. Trying it with real services: the first connectors are to be decided with the owner. Proton has no official MCP server. The community one looked at (amotivv/protonmail-mcp, last changed 2025-03) only sends, runs over stdio, and needs Proton's SMTP submission, which takes a paid plan and a custom-domain address; reading mail would need Proton Mail Bridge's IMAP. Left for later.

Each step ends with `pnpm check` passing and is a commit of its own.

## Design: several agents

Built: the core (item 27), the web view's part in the app (items 29 and 30), and Slack (item 38). A roster of named agents, each with its own job, standing instructions, model, tools, work notes, sandbox, allowed hosts and workspaces. Agents message each other and hand work on; one can coordinate the rest. Unlike Grok Bot, whose bots share one machine, agents are kept apart: one can't read another's sandbox, notes, jobs or past conversations, or use its grants.

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
3. Done: Slack, a channel per agent (item 38). An agent without a channel posts in the default agent's, named, rather than only being reached from the app and CLI.
4. Done: web view: the switcher, the agents page and the per-agent pages, built in the app (its steps 1 to 3), checked in a browser with the Playwright e2e tests (items 29 and 30).

Each step ends with `pnpm check` passing and is a commit of its own.

## Design: the browser

Built (items 35 to 37). An agent that's been given a browser profile can open pages, read them, click and type, and stay signed in across conversations and restarts. The owner can watch that browser from the app and take it over to sign in, solve a CAPTCHA or confirm something. Today gaidin reads only public pages and APIs through `fetch_url`.

It also makes handoffs easier on purpose. Grok Bot's bots share one computer, so every sign-in reaches every bot. Here a profile is granted like a workspace, so two agents that need the same sign-ins share a profile and nothing else.

### Decided with the owner

- **Profiles, granted per agent.** A profile is a named browser: cookies, storage and sign-ins. The server keeps it in `<data>/browser/<profile>/`, outside every sandbox, so no agent's shell can read its cookies. A roster entry lists the profiles its agent may use, and a new agent has none, nor does the default agent until given one. The alternatives were one profile per agent, which gives no sharing, or one for all agents, which is Grok Bot's model.
- **Acting asks, with a per-host "act without asking".** Page text is outside text, so under today's rule every click and keystroke would ask. Instead, an approval's second button allows acting on that host for good, for that agent and profile, as "always allow" does for fetches. The plan's owner-written rules can widen or narrow it later.
- **No passwords from the model.** `browser_type` refuses a password field. The owner signs in through the take-over view, so a password never passes through the model or the transcript.
- **More memory for the VM.** Raised from 2 GiB to 4 GiB on 2026-10-15, since Chromium with a profile or two open needs several hundred MB more.
- **A new dependency.** `playwright-core` and its Chromium headless shell, both pinned, and subject to the 3-day release age like everything else.
- **Snapshots are capped.** A full snapshot of a busy page is 12,000 to 15,000 tokens (spike results below), so a few would reach compaction. `browser_open` and `browser_snapshot` return at most about 4,000 tokens and say when they cut it short, and `browser_snapshot(profile, ref?)` gives the part under one ref, so the model can look closer at a section it found.

### Spike results

Run on the VM on 2026-10-15 with `playwright-core` 1.64.0 (1.64.1 was a day old) and its `chromium_headless_shell-1248`, as `gaidin` in a transient unit with the service's limits. Everything was removed afterward except the system packages.

- **Chromium's sandbox works, with an AppArmor profile.** Without one, Ubuntu's limit on user namespaces makes the sandbox fail and Playwright won't start it. A profile like `deploy/vm/bwrap.apparmor`, granting `userns` to the headless shell's path, fixes it: the renderers and zygotes ran in their own user and PID namespaces, and every process had a seccomp filter. Playwright passes `--no-sandbox` unless told `chromiumSandbox: true`, so the code has to set it. The profile is unconfined, so the binary it names must live where the service can't write, such as a root-owned directory `setup.sh` installs it into, never under `/var/lib/gaidin`.
- **System packages.** The headless shell needs nine libraries the VM lacked, and the VM had no fonts. Installing them with `--no-install-recommends` added 25 packages, Mesa and LLVM among them (for `libgbm1`): `at-spi2-common fontconfig fonts-liberation libasound2-data libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 libatspi2.0-0t64 libdrm-intel1 libgbm1 libllvm20 libpciaccess0 libx11-xcb1 libxcb-dri3-0 libxcb-present0 libxcb-randr0 libxcb-sync1 libxcb-xfixes0 libxcomposite1 libxdamage1 libxfixes3 libxi6 libxrandr2 libxshmfence1 mesa-libgallium`. They're still installed. The browser download is 278 MB.
- **Memory.** Measured for the whole unit, page cache included, over a Node process of 86 MiB: one profile on a test page added about 70 MiB; two profiles, on GitHub and BBC News, about 475 MiB; a second tab in one of them, on Wikipedia, 160 MiB more, for a peak of 722 MiB. gaidin uses about 100 MiB and the VM has 1.4 GiB available with no swap, so 4 GiB stands.
- **Snapshots.** `page.ariaSnapshot({ mode: "ai" })` gives refs (`[ref=e3]`) and `page.getByRef()` finds them again, both public API now, so the tools needn't copy Playwright MCP. A password field shows as a plain `textbox`, so `browser_type` checks the element's `type` attribute. GitHub's repository page was 52,000 characters and 642 refs; BBC News 45,000 and 502.
- **Persistence.** A cookie and `localStorage` survived closing and reopening a profile.
- **Stopping navigation.** `context.route` sees a click's main-frame navigation before it happens. Aborting it with `aborted` leaves the page as it was; `blockedbyclient` replaces it with Chrome's error page.
- **Take-over.** `Page.startScreencast` sent 30 JPEG frames in 3 seconds of a page that changed 10 times a second, about 11 KiB each at 1280 by 800, around 330 KiB/s. `Input.dispatchMouseEvent` clicked a button, and `Input.dispatchKeyEvent` and `Input.insertText` typed into a field.

### Shape

- Chromium is launched by the server through Playwright when a profile is first used. Each profile in use is its own Chromium with the profile's directory as its user data (`launchPersistentContext`), since one Chromium can't hold two such directories, and it's closed after 15 minutes idle. Opening at most two at once keeps memory within the spike's numbers.
- Chromium runs as the `gaidin` user under the service's systemd limits, not in bubblewrap, since it needs the network, and keeps its own sandbox through an AppArmor profile that `setup.sh` installs (spike results above). It won't run with `--no-sandbox`.
- Downloads go to the calling agent's sandbox under `downloads/`, a new server directory that commands see read-only, as `uploads/` is. A file input takes only paths in the caller's sandbox, read through its file tools, as files in a hand-off are.
- Page text in a tool result is outside text and is redacted like any tool output.

### Tools

One extension, `browser`, on only for agents with a profile:

- `browser_open(profile, url)` loads a page in the profile's tab and returns its title, URL and an accessibility snapshot with a ref for each control, built from Playwright's accessibility tree as Playwright MCP's snapshots are. It's much cheaper than a screenshot.
- `browser_snapshot(profile)` and `browser_screenshot(profile)`. A screenshot comes back as an image in the tool result, which Pi Durable 1.1.0 supports.
- `browser_click(profile, ref)`, `browser_type(profile, ref, text, submit?)`, `browser_select`, `browser_back`, `browser_tabs` and `browser_upload(profile, ref, files)`.
- `browser_hand_over(profile, reason)` asks the owner to take over and waits, durably as `ask_owner` does, until the owner presses Done in the app. It then returns a fresh snapshot.

### Rules

- **Navigation follows `fetch_url`'s rule.** The host must be allowed for good for that agent or be a search result in the conversation; otherwise `browser_open` asks. A navigation that a click or a page's script starts in the main frame is checked the same way: it's stopped, and the model is told to open the URL with `browser_open`, which asks. Subresources such as scripts, images and a site's own API calls aren't checked for their host. A page can already send what it shows to its own servers. A page's own host is allowed, so following links on a site needs no new approval, and a redirect of an allowed navigation goes ahead.
- **Private addresses are refused** for every request a page makes, as `fetch_url` refuses them, so a page can't reach the LAN, the tailnet or gaidin's own port. Added while building step 2.
- **Acting** (click, type, select) asks while outside text is in the conversation, unless the host is allowed for acting without asking (above). The request names the agent, the profile, the host and what it's about to do, and the action happens only if the page is still on that host and the ref still that element. Uploads ask every time, without the second button, since they send the sandbox's files away; that was decided while building step 3.
- **Take-over.** While the owner holds a profile, the agent's browser tools for it wait. The owner's input goes to the browser and never through the model.

### The take-over view

- gaidin starts a CDP screencast (`Page.startScreencast`) of the profile's tab and relays the frames to the app as an event stream at `/api/browser/live?profile=`, behind the same login check; the owner's input comes back as JSON POSTs, behind the Origin check too, and gaidin plays it on the page through Playwright's mouse and keyboard. That replaced the WebSocket first planned, which gaidin's server doesn't have, with no new dependency. No X server or VNC is needed.
- The owner holds the profile while the page is open: until Done, 15 seconds after the last viewer leaves, or 10 minutes without input. The refs from before are dropped when the hold starts and ends.
- moiraine gets a page per profile with the live view, the current URL and which agent last used it. On a phone, a tap is a click and the soft keyboard types. The protocol version goes up.
- A `browser_hand_over` request shows in the dock and is pushed like any other request, and it opens that page.

### Durability and storage

- Sign-ins and site storage survive restarts on disk. Open pages don't. A profile reopens at its last URL, which is recorded in a document. Browser tools aren't replay-safe, so a call cut off by a restart is reported as interrupted, as `bash`'s are.
- Profiles are in the data directory, so the VM's nightly backup holds live session cookies. Treat those backups as secrets.

### Known gaps

- Any agent granted a profile can do anything the signed-in sites allow. Granting a profile is the real decision.
- On a host allowed for acting without asking, a page on that host can steer what the agent does there.
- A page that exploited Chromium would run as `gaidin`, outside bubblewrap, with Chromium's own sandbox as the only layer.

### Order of work

1. Done: a spike on the VM: Playwright's Chromium under the service's systemd limits and AppArmor, memory with two profiles open, and a screencast to a test page (spike results above).
2. Done: profiles in the roster and settings, plus the read tools (open, snapshot, screenshot, tabs) with the navigation rule (item 35). Tests use a site the test serves on loopback, with no network. The app's settings page gives an agent profiles.
3. Done: the acting tools and their approvals, then downloads and file inputs (item 36).
4. Done: hand-over and the take-over view in moiraine, with Playwright e2e tests there, on a phone too (item 37).

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
- `sw.js` keeps its jobs (notifications and the can't-reach-the-server page) and moves to moiraine at the switch, served at the same path and scope, so devices signed up for notifications stay signed up. It cached nothing at first. A notification opens the conversation it came from. Changed with the owner on 2026-10-15: the app is a PWA first, so `sw.js` keeps the shell, the build's files and the API's last answers, and the app each conversation's last transcript, so it opens at once and still shows what it had when gaidin can't be reached, saying so.

### Layout

- The sidebar shows the chosen agent: a switcher with its name at the top, then its home conversation, New thread, and its threads newest first, each labeled with where it began (Slack, the app, a job, or another agent) and loading more as it scrolls. The pages are a compact list at its foot. On a phone the sidebar is a drawer and the conversation takes the screen. Changed with the owner on 2026-10-16: the sidebar is a rail of the agents with System at its foot, beside the agent's column, its pages as tabs above its threads, or System's pages across agents; the column collapses to the rail. The log has a chat client's gutter of time and who wrote each line. moiraine's `design.md` has the details.
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
3. Done: the pages, with the per-agent changes (item 30). With no conversation open, a page asked for the approvals every 5 seconds; the app-wide event stream replaced that (item 47). The web view's `#/<page>` addresses and `#/history/<id>` open the matching page or thread.
4. Done: attachments (item 31). Other files go to the sandbox of the agent whose conversation it is, where Slack's still go to the default agent's until its channel per agent.
5. Done: Slack mirroring (item 32). Every Slack thread is the default agent's until Slack's channel per agent (agents step 3), which will give other agents' threads the same.
6. Done: the switch (item 33). moiraine's `pnpm ship` deploys it ([Deploying](deploy.md#the-app)).

Each step ends with `pnpm check` passing in each repository it touches and is a commit of its own there.
