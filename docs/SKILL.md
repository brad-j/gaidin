---
name: gaidin
description: How gaidin works, from its own documentation. Read it when the owner asks how to do something in gaidin, what a command, page, tool or setting does, or why gaidin acted as it did (a paused job, an approval, a refusal, a spend stop), before answering from memory.
---

# gaidin

This is gaidin's documentation, the same files that ship with its code, so it describes the version that's running. It's written for the person who runs gaidin; you're reading it to answer their questions about you.

When you answer from it:

- Open the file that covers the question, and answer from what it says. Don't guess at commands, settings or limits that it doesn't mention.
- Name the exact command, page or setting the owner would use: `/pause j3` in the web view, the schedule page, `budget.daily` in the settings file.
- You can't change your settings file, restart yourself or install anything outside the sandbox. Tell the owner what to change and where.
- The documentation is generic. It doesn't know this deployment's host names, workspaces or settings values; your notes and the conversation might.

## Files

- [surfaces.md](surfaces.md): talking to gaidin. The command line, Slack (threads, files, buttons), the web view (console, the history, schedule, memory, skills, activity and settings pages, slash commands, keys, installing it as an app) and notifications (Web Push, ntfy).
- [tools.md](tools.md): what each tool does and its limits. Reminders, questions, memory, past conversations, scheduled jobs and their gates, alerts, `fetch_url`, `web_search`, workspaces, self-written tools and how to write one, skills and how they're written, and the homelab extension.
- [security.md](security.md): why gaidin asks before some actions and refuses others. Redaction, the sandbox, network access, approvals and what "outside text" means, workspaces, the web view's protection, and known gaps.
- [concepts.md](concepts.md): the shape of the system. One process and one root conversation, what survives a restart, compaction, Slack threads as conversations of their own, time zones, the settings file and the data directory.
- [deploy.md](deploy.md): installing and running gaidin. The `gaidin` command and `doctor`, running on a VM, the model and its key, adding a workspace, every setting, spend limits, upgrades and checks.
- [extending.md](extending.md): the code. How it's laid out, adding a tool, guards and approvals, tests, and the homelab extension's settings.
- [plan.md](plan.md): what's been built, in order, and what might come next.
