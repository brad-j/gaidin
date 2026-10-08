# gaidin

A personal agent built on [Pi Durable](https://earendil.com/posts/pi-durable/). It runs alongside Hermes, not in place of it. A Warder is bonded to one Aes Sedai and always on watch; this is that, for one person.

## Status

Phase 0 spike. `src/host.ts` opens a harness over SQLite with the coding tools in a sandbox directory; `src/cli.ts` submits one prompt and prints tool events and the answer.

```sh
pnpm install
GAIDIN_MODEL=faux pnpm ask job-1 "anything"      # scripted model, no key or network
pnpm ask job-2 "what's in this directory?"         # Claude, key from .env
pnpm check                                        # tsc
```

`pnpm ask` loads `ANTHROPIC_API_KEY` from a gitignored `.env` in this directory, if one exists.

## API key

The Max plan includes monthly API credits for a linked Claude Console organization.

1. On claude.ai, open Settings > Billing and claim the API credit. Link or create a Console organization, signed in with the same email.
2. In the Console (platform.claude.com), create a workspace for gaidin, set a spend limit on it, and create an API key there.
3. Put the key in `.env` here as `ANTHROPIC_API_KEY=...`, mode 600.

Credits don't roll over. With no purchased credits or auto-reload, requests stop when the month's credit runs out instead of charging anything, so leave auto-reload off.

`GAIDIN_DATA` sets the data directory (default `data/`, gitignored). `GAIDIN_MODEL_ID` overrides the Claude model (default `claude-haiku-5-5`). Reusing a request id returns the stored submission instead of asking again.

Verified on 2026-10-08 with the faux model: `kill -9` during a `bash` call, then rerunning the same request id, resumed the run. `bash` is not replay-safe, so it was not rerun; the model was told it "was interrupted and may have partially run" and answered. A third run returned the stored answer without doing any work.

Pinned to `@earendil-works/pi-durable` 1.1.0. The API is experimental and changes without notice, so upgrade deliberately.

## Decisions

- Runs alongside Hermes. Nothing moves over until it has earned it.
- First jobs: reminders, and "is the homelab OK" from a phone.
- Runs on a new VM on `think-1`, so the nightly Proxmox backups cover the SQLite file.
- Models: Claude through an API key in its own Claude Console organization, with a workspace spend limit. Max plans include monthly API credits for this (claimed into a Console organization); subscription OAuth in a third-party harness stays out. Haiku 5.5 by default, Sonnet 5.5 where a conversation needs it.
- Pocket Pi is not a surface. Voice, if wanted, is push-to-talk on the web view with whisper.cpp on the VM.

## Plan

1. Host on the VM: one long-lived process, SQLite storage, one root conversation. Slack bot in its own Tar Valon channel, with each thread a fork of the channel conversation. Reminders as durable timer tasks that push to ntfy.
2. A second surface on the same conversation: a small web view over Tailscale. This is the part Hermes can't do.
3. Approval hook (stored in a memo so a restart doesn't ask twice), read-only homelab tools (Kuma, Beszel, backup snapshot, Dozzle), Hindsight recall and retention, and a remote execution environment on egwene.
4. Self-extension: the agent edits its own extension code, runs the tests, and reloads the registry.

## Rules from the start

- Transcripts and tool output are kept forever, compaction included. An `afterTool` redaction hook goes in before any tool can see credentials. The July Pi audit found secrets in retained session files.
- Homelab tools stay read-only until the approval hook exists.
- Mark a tool `replay: "safe"` only when rerunning it after a crash is harmless.
