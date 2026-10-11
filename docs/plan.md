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

## Next

10. Self-extension: gaidin writes new tools for itself, checks them, asks the owner, and starts using them without a restart. The design below is a proposal until the owner approves it.

### Self-extension

Self-written tools never run in the server process. In there they could read the settings file and send the API key and tokens anywhere, and a diff review would be the only thing stopping them. They run in a box instead, so the worst a bad one can do is fail.

What it is:

- gaidin drafts an extension in the sandbox, in `extensions/<name>/`, with its normal file tools: `index.ts` exporting its tools, and `test.ts`. A tool is a name, a description, a JSON Schema for its arguments and an `execute` function. Node's built-ins and a `fetch` passed in are all an extension gets. It can't install packages.
- `load_extension(name)` runs the checks below, then asks the owner with the diff since the last approved version. On approval the server copies the draft to `<data>/extensions/<name>/`, which the sandbox can't see, commits it there, and installs the extension in the registry under its name. Pi Durable swaps it in place: a call already running finishes on the old code and the next one uses the new. The copy is what runs, so editing the draft afterwards changes nothing until it's approved again.
- Each loaded extension runs in one Node child process under the same bubblewrap box as `bash`: no network, no settings, no data directory, its own approved copy read-only. The server talks to it over JSON lines on stdin and stdout. A call has a time limit, and a child that crashes or hangs is restarted on the next call.
- The extension's `fetch` goes through the server under `fetch_url`'s rules: private addresses are refused, and a host the owner hasn't approved waits for approval.
- Its tools are offered like any other, are switchable in the web view, aren't replay-safe, and can't reuse a built-in tool's name. Results pass through redaction.
- `remove_extension(name)` uninstalls it after approval, and its history stays in `<data>/extensions/`. At start the server installs every approved extension at its last approved commit. Without bubblewrap, self-extension is off.
- Not in the first version: hooks, prompt sections and background tasks, which only work in-process, and secrets, which come when a tool needs one, given to that extension alone.

Clean code, checked before the owner is asked:

- The type check (`tsc --strict` with `noUnusedLocals`, `noUnusedParameters` and `allowUnreachableCode: false`) and the extension's own tests pass in the box. Every tool has a test.
- An extension imports nothing but Node's built-ins (`node:` modules) and its own files. The server checks this itself rather than trusting the draft.
- Oxlint runs the anti-slop rules that fit a tool: `no-chained-type-assertions`, `no-conditional-empty-object-spread`, `no-known-value-widening`, `no-module-mocking`, `no-reflect-apply`, `no-reflect-get`, `no-shape-in-symbol-names`, `no-unsafe-dictionary-type`, `no-widen-then-assert` and `require-safety-comment-for-type-assertion`. The other five are off: a tool takes its arguments as an object and checks outside values with `typeof`, which `no-object-parameters`, `no-runtime-typeof` and the three `unknown` rules forbid.
- The checks run on the server, which installs only regular dependencies, so `typescript` and `@types/node` move there from the development ones, and `oxlint` and `@oxlint/plugins` are added.
- A short style guide is part of the prompt while gaidin works on an extension. It asks for the least code that does the job, no options nobody asked for, no wrappers or helpers used once, no comments that restate the code, and no tool that duplicates an existing one.
- A second model call reviews the diff against the guide and names any bloat. gaidin fixes what it finds, or the approval request shows the objection next to the diff.
- The approval request shows the lines added and removed. A change that makes an extension smaller is as welcome as one that adds to it.

Candidates after that:

- Branching from any message in the web view, and a timeline of what gaidin did and who approved it.
- Release polish: a setup wizard, Slack app creation from a configuration token, and an installer ([Extending](extending.md#still-specific-to-one-deployment) lists what's left that's specific).
- Push-to-talk in the web view. That would need more memory on the VM.
