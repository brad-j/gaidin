# gaidin

A personal agent built on [Pi Durable](https://earendil.com/posts/pi-durable/). It runs alongside Hermes, not in place of it. A Warder is bonded to one Aes Sedai and always on watch; this is that, for one person.

## Status

Phase 2, running on VM 104 on `think-1`. One server process owns the SQLite file and the agent; clients attach over a Unix socket in the data directory, and a Slack channel and a web view talk to the same conversation. The agent has the coding tools, confined to a sandbox (see [Sandbox](#sandbox)), durable reminders that push to ntfy, a read-only homelab status tool, and `fetch_url` for the public internet.

```sh
pnpm install
pnpm serve                                  # the agent; key and ntfy settings from .env
pnpm ask "remind me in 10 minutes to check the oven"
pnpm ask --id oven-1 "..."                  # rerunning the same id reattaches instead of asking twice
pnpm watch                                  # print everything the agent does, from any client
pnpm check                                  # tsc and tests
```

`pnpm serve` loads a gitignored `.env` in this directory, if one exists:

- `ANTHROPIC_API_KEY`: required unless `GAIDIN_MODEL=faux`.
- `NTFY_URL`: the full topic URL, e.g. `https://ntfy.sh/<topic>`. The topic name is a credential. Without it, reminders print to the server's stderr.
- `NTFY_TOKEN`: optional ntfy access token.
- `GAIDIN_TZ`: time zone for message timestamps and reminder times; defaults to the system's.
- `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_CHANNEL_ID`, `SLACK_USER_ID`: all four or none. See [Slack](#slack).
- `GAIDIN_WEB_USER`: the Tailscale login let into the web view; without it there's no web view. `GAIDIN_WEB_PORT` sets its loopback port (default 8410). See [Web view](#web-view).
- `GAIDIN_SANDBOX=none`: run tools without bubblewrap. Otherwise the server won't start without `bwrap` on PATH.

`deploy/gaidin.service` is a systemd user unit for egwene; install steps are in the file. User units stop at logout unless lingering is enabled.

## Reminders

`src/reminders.ts` gives the model `remind`, `list_reminders` and `cancel_reminder`. Each reminder is a background task owned by the root conversation: it sleeps until its time, then pushes. The fire time is in the task's input, so after a restart it sleeps until the same moment, and a reminder that came due while the server was down fires when it starts. A session document holds the open list. Cancelling removes the reminder from it, and the task checks the list when it wakes. A failed push is retried up to five times with backoff. Delivery is at least once: a crash between the push and its commit sends it again.

The server prefixes each message with the local time rather than putting the time in the system prompt, which keeps the prompt cache valid.

## Slack

`src/slack.ts` puts gaidin in one channel of the Tar Valon workspace, over Socket Mode with no Slack SDK. The channel is the root conversation, the same one `pnpm ask` uses, and gaidin answers top-level messages in the channel. A reply in a thread on one of those messages, or on gaidin's answer, forks the root at that answer: the thread sees the channel up to there, and nothing after. Later replies in the thread continue the fork. Only `SLACK_USER_ID` in `SLACK_CHANNEL_ID` is answered; everything else is ignored.

An event is acked once it's recorded in a session document, which also maps message timestamps to answers and threads to forks. A message still owed an answer when the server stops is answered when it starts again. Posting is at least once, like reminders. Answers go out as `markdown_text`, so Slack renders the model's markdown.

Setup:

1. Create the app from `deploy/slack-manifest.yaml` (api.slack.com/apps > Create New App > From a manifest), then Install to Workspace. The Bot User OAuth Token (`xoxb-`) is `SLACK_BOT_TOKEN`.
2. Basic Information > App-Level Tokens: generate one with the `connections:write` scope. That (`xapp-`) is `SLACK_APP_TOKEN`.
3. Create the channel and `/invite @gaidin`. Its ID, at the bottom of the channel details, is `SLACK_CHANNEL_ID`.
4. Your member ID (profile > ⋯ > Copy member ID) is `SLACK_USER_ID`.
5. Basic Information > Display Information: upload `assets/logo-1024.png` as the app icon. The manifest can't set it.

`test/slack.test.ts` covers forking, redelivery, ignored events and an answer owed across a restart, with a fake Slack. The Socket Mode client is only exercised against the real thing.

## Homelab status

`src/homelab.ts` gives the model `homelab_status`, which reads the feeds behind infra.half.black: Uptime Kuma's public `homelab` status page and the Beszel, Docker and backup snapshots on infra-01 (`http://192.168.3.177:8080/data`). None needs a credential, and the tool only reads. It lists what needs attention first, using the thresholds in the dashboard's `src/attention.ts`; keep the two in step. The dashboard's coverage checks are left out, because they need the homelab repo's inventory. A feed that's down is reported as such, and the others are still read. `details: true` adds every monitor, host, container and backup. `GAIDIN_HOMELAB_DATA` and `GAIDIN_KUMA_URL` override the sources.

## Sandbox

`src/sandbox.ts` confines the tools to the sandbox directory (`data/sandbox`). Shell commands run under bubblewrap: the sandbox is the only writable place, `/usr`, `/etc` and `/opt` are read-only, and nothing else is mounted, so the data directory, the Unix socket and the app's code aren't there. They get their own process tree (the server's `/proc/<pid>/environ` is out of reach), no network, and background processes end with the command. The file tools run in the server process, so each path is resolved through symlinks and refused outside the sandbox; temp files, such as a long command's full output, go in the sandbox's `.tmp`.

No network means the agent can't `curl` anything; `fetch_url` and the homelab tool reach the network from the server side. So that a command can't swap a directory for a symlink between a file tool's check and its use, shell commands share a lock that each file operation takes alone; a long command makes file tools in other conversations wait for it. The unit also makes the app read-only and hides the deploy key from the server itself.

On the VM, `setup.sh` installs bubblewrap and `deploy/vm/bwrap.apparmor`, which lets bwrap create user namespaces under Ubuntu's restriction. `test/sandbox.test.ts` runs the real thing where `bwrap` is installed and skips otherwise.

## Fetching

`src/fetch.ts` gives the model `fetch_url`: a GET of a public web page or API, returned as text (HTML is reduced to its main content, with headings, lists and links kept), labelled as coming from the web and not from Brad. It runs in the server, since the shell has no network. Every address a name resolves to is checked when the connection is made, and again after each redirect, so DNS can't point it at the LAN; private, CGNAT (which covers the tailnet and `*.half.black`), loopback, link-local and other reserved ranges are refused. It sends no cookies or auth headers, downloads stop at 2 MB after decompression, and the text is cut to 20,000 characters unless the model asks for more.

A URL can still carry data out in its path or query; the approval hook is where that gets a check. Switching `fetch_url` off in the web view's settings cuts gaidin off from the internet.

## Web view

`src/web.ts` serves `web/index.html` and `web/app.ts` (types stripped by Node as it's served, so there's no build step) on `127.0.0.1:GAIDIN_WEB_PORT`. On the VM, `tailscale serve` puts it at `https://gaidin.aardvark-dory.ts.net`. Serve strips any identity headers a client sends and adds `Tailscale-User-Login` for a person's device; the server answers only `GAIDIN_WEB_USER`, so tagged and shared devices get a 403. POSTs need a JSON body and a same-origin `Origin`, so another site open in the browser can't drive it.

The page shows the root conversation live from the same event stream as `pnpm watch`: messages from any surface, tool calls with their output, fired reminders, and spend. It sends messages, stops a run, lists and cancels reminders, and sets the model, thinking level, standing instructions, and the coding tools and `fetch_url`. Settings are stored in the conversation, apply from the next request and survive restarts; Slack threads started afterwards inherit them. Credentials and Slack settings aren't on the page.

Anything else on the VM running as `gaidin` can reach the loopback port and send any header, the same as it can reach the Unix socket. The agent's shell can't: it has no network and doesn't see the data directory.

`test/web.test.ts` covers the login check, cross-site posts, a message answered over the event stream, settings and reminders. The page itself has no browser tests.

## API key

The Max plan includes monthly API credits for a linked Claude Console organization.

1. On claude.ai, open Settings > Billing and claim the API credit. Link or create a Console organization, signed in with the same email.
2. In the Console (platform.claude.com), create a workspace for gaidin, set a spend limit on it, and create an API key there.
3. Put the key in `.env` here as `ANTHROPIC_API_KEY=...`, mode 600.

Credits don't roll over. With no purchased credits or auto-reload, requests stop when the month's credit runs out instead of charging anything, so leave auto-reload off.

`GAIDIN_DATA` sets the data directory (default `data/`, gitignored). `GAIDIN_MODEL_ID` overrides the Claude model (default `claude-haiku-5-5`). Reusing a request id returns the stored submission instead of asking again.

Verified on 2026-10-08 with the faux model: `kill -9` of the server during a `bash` call, then restarting it and rerunning the same request id, returned the answer. `bash` is not replay-safe, so it was not rerun; the model was told it "was interrupted and may have partially run" and answered. `test/reminders.test.ts` covers the remind tool end to end, a reminder sleeping across a restart, cancellation and a retried push.

Pinned to `@earendil-works/pi-durable` 1.1.0. The API is experimental and changes without notice, so upgrade deliberately.

## Decisions

- Runs alongside Hermes. Nothing moves over until it has earned it.
- First jobs: reminders, and "is the homelab OK" from a phone.
- Runs on a new VM on `think-1`, so the nightly Proxmox backups cover the SQLite file.
- Models: Claude through an API key in its own Claude Console organization, with a workspace spend limit. Max plans include monthly API credits for this (claimed into a Console organization); subscription OAuth in a third-party harness stays out. Haiku 5.5 by default, Sonnet 5.5 where a conversation needs it.
- Pocket Pi is not a surface. Voice, if wanted, is push-to-talk on the web view with whisper.cpp on the VM.

## Plan

1. One long-lived process, SQLite storage, one root conversation, reminders through ntfy (done). VM 104 on `think-1` is set up by `deploy/vm/setup.sh`, operator notes in the homelab repo's `docs/gaidin.md`. A Slack bot in its own Tar Valon channel, with each thread a fork of the channel conversation (live in `#warder` since 2026-10-10).
2. A second surface on the same conversation: a small web view over Tailscale (written 2026-10-10). This is the part Hermes can't do.
3. Approval hook (stored in a memo so a restart doesn't ask twice), read-only homelab tools (Kuma, Beszel, Docker and backup snapshots done 2026-10-10; container logs, which are text from anywhere, can come now that the sandbox is in), a sandbox for the tools (done 2026-10-10), and a remote execution environment on egwene. Hindsight (retired 2026-09-30) and Dozzle (retired 2026-10-10) are no longer part of the plan.
4. Self-extension: the agent edits its own extension code, runs the tests, and reloads the registry.

## Rules from the start

- Transcripts and tool output are kept forever, compaction included. The July Pi audit found secrets in retained session files, so `src/redact.ts` keeps the credentials in `SECRET_NAMES` out of them: bash children don't inherit them, shell output is redacted as it streams, and an `afterTool` hook redacts every tool's result. It matches the values as they are, so a command that encodes them or sends them somewhere gets past it. The sandbox keeps the shell away from the server's environment and the network, so encoding a value doesn't get it out either. Add a new credential's variable to `SECRET_NAMES`.
- Homelab tools stay read-only until the approval hook exists.
- Mark a tool `replay: "safe"` only when rerunning it after a crash is harmless.
