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

## Next

11. Search past conversations. Notes hold what gaidin needs every time; search finds the rest, such as "what did we decide about the NAS last week", in any conversation, Slack thread or job run.

Candidates after that:

- Branching from any message in the web view, and a timeline of what gaidin did and who approved it.
- Release polish: a setup wizard, Slack app creation from a configuration token, and an installer ([Extending](extending.md#still-specific-to-one-deployment) lists what's left that's specific).
- Push-to-talk in the web view. That would need more memory on the VM.

### Search

Pi Durable keeps every entry, including the ones compaction summarized away, but it has no text search. Node's own SQLite has FTS5, so search needs no new dependency.

- An index in its own file, `<data>/search.sqlite`, filled from Pi Durable's entry scans rather than its tables, so a change to its schema can't break it. It catches up from the last entry it saw at start and after each run, and can be deleted and rebuilt.
- What's indexed: the owner's messages and gaidin's answers, with their conversation, time and surface. Not tool output, which is long, mostly outside text, and already redacted but still noise.
- `search_history(query)` returns matching messages with their time and where they were, newest first, and a way to read the messages around one. It makes no model calls.
- One sentence in the instructions: before saying it doesn't know something the owner may have mentioned, search.
- It's switchable in the web view. A result is the owner's own words and gaidin's, so it doesn't count as outside text.
