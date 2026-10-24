# gaidin

A personal agent for one person on Pi Durable: one long-lived server, reached from the CLI, Slack and its HTTP API. It serves no web app. This repository is public.

## Commands

- `pnpm install`, then `pnpm check` before every commit: `tsc`, oxlint with the anti-slop rules, and every test. Open a PR only with it passing.
- One test file while working: `node --no-warnings --test test/jobs.test.ts`.
- `GAIDIN_MODEL=faux pnpm serve` runs the server on a scripted model, with no key or network.
- The tests run on Pi Durable's faux provider ([Extending](docs/extending.md#tests)). Don't add a test that needs a key or the network.
- The sandbox and browser tests skip themselves when bubblewrap or Chromium can't start. CI installs both and fails on any skipped test, so treat a skip as a broken setup.

## Where things are

- [docs/plan.md](docs/plan.md) holds the decisions, the numbered Done list, Next and the designs. Read it before starting. A finished feature gets the next Done item, and a changed decision is changed there.
- The rest of `docs/` describes gaidin as it is, and is also gaidin's built-in skill, which it reads to answer the owner. Update the matching doc in the same change as the behavior. A new file in `docs/` is listed in `docs/SKILL.md`; a test checks.
- [docs/extending.md](docs/extending.md) covers the code's layout, extensions, guards and tests. Follow its patterns: durable state in a `defineDoc`, timed work in a `defineTask`, and anything told to the owner unprompted as a notice through `notifications.ts`.
- `Gets`, `Posts` and `StreamEvent` in `src/web.ts` are the API's protocol. A change to their shape raises `PROTOCOL`.

## Rules

- Satisfy the anti-slop lint rules (`tools/oxlint/anti-slop/`) by changing the code. Don't turn a rule off, add an override or add an ignore comment.
- The safety code is `src/sandbox.ts`, `guards.ts`, `approvals.ts`, `rules.ts`, `redact.ts`, `fetch.ts`, `workspaces.ts`, `browser/`, `self/` and `connectors/`. A change that lets through anything these used to stop or ask about says so in the PR description and has a test. Never weaken or delete an existing test of them to make a change pass.
- Pi Durable, pi-ai and chord are pinned and upgraded deliberately. Don't add or upgrade a package as part of a task; say in the PR that one is needed. pnpm resolves only versions at least 3 days old (`minimumReleaseAge: 4320`).
- Nothing about the owner's own setup goes in code, tests or docs: no real names beyond what's there, host names, LAN or tailnet addresses, Slack IDs or home paths. Use `example.com`, `*.test` names and `192.0.2.x`, and call the person "the owner" in docs.
- Commit messages describe the change in a sentence or more of prose, as the history does, with no `feat:`-style prefixes.

## Working through GitHub

- Work on a branch per issue, open the PR with `gh pr create`, and put `Closes #N` in its description. Never push to main, and leave merging to Brad.
- The PR description says what changed, how you checked it, and anything you weren't sure of.

## Mistakes agents have made

Add a line here each time an agent gets something wrong that a line here would have prevented.
