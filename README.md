# gaidin

A personal agent built on [Pi Durable](https://earendil.com/posts/pi-durable/). It runs alongside Hermes, not in place of it. A Warder is bonded to one Aes Sedai and always on watch; this is that, for one person.

## Status

Phase 1, running on VM 104 on `think-1`. One server process owns the SQLite file and the agent; clients attach over a Unix socket in the data directory, and a Slack channel talks to the same conversation. The agent has the coding tools in a sandbox directory and durable reminders that push to ntfy.

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

`test/slack.test.ts` covers forking, redelivery, ignored events and an answer owed across a restart, with a fake Slack. The Socket Mode client is only exercised against the real thing.

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
2. A second surface on the same conversation: a small web view over Tailscale. This is the part Hermes can't do.
3. Approval hook (stored in a memo so a restart doesn't ask twice), read-only homelab tools (Kuma, Beszel, backup snapshot, Dozzle), Hindsight recall and retention, and a remote execution environment on egwene.
4. Self-extension: the agent edits its own extension code, runs the tests, and reloads the registry.

## Rules from the start

- Transcripts and tool output are kept forever, compaction included. An `afterTool` redaction hook goes in before any tool can see credentials. The July Pi audit found secrets in retained session files.
- Homelab tools stay read-only until the approval hook exists.
- Mark a tool `replay: "safe"` only when rerunning it after a crash is harmless.
