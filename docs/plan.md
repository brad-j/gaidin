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

## Next

Jobs, from what NanoClaw does with scheduled tasks, in this order:

1. Package versions wait 3 days before pnpm installs them (`minimumReleaseAge: 4320`, up from pnpm's default of 1 day), Pi Durable included.
2. A job's runs see its last 3 reports and how many quiet runs followed. A watch repeats a finding only when it's new or worse.
3. Failure streaks: a run that didn't finish, a failed gate, or a delivery that failed every retry. The next run waits 15 minutes doubled per failure, up to 4 hours; the owner hears about the first failure and about the pause after 5 in a row. Only the owner resumes a job, from the web view or Slack. Runs stopped by the spend limit don't count.
4. Gates: a check in the server that decides whether a run wakes the model, from the homelab extension (`collectAttention`) or a self-written tool that only reaches hosts allowed for good. A gate that wakes with the same findings as last time doesn't wake it again. A job without a gate runs at most 4 times a day (`every` at least 6 hours); with one, every 15 minutes. Existing jobs keep their schedules.
5. The approval policy can refuse a call that can't succeed rather than ask (`schedule_job` with 20 jobs or an unknown gate, `load_extension` with self-written tools off, an unknown workspace), and checks again for a refusal after the owner approves. A job run whose gate or tools are gone counts as a failure.

Other candidates:

- Release polish: a setup wizard, Slack app creation from a configuration token, and an installer ([Extending](extending.md#still-specific-to-one-deployment) lists what's left that's specific).

Not planned: branching from any message in the web view, since Slack threads already branch, and push-to-talk, since the owner dictates with superwhisper.
