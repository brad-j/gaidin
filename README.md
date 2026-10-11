# gaidin

A personal agent for one person, built on [Pi Durable](https://earendil.com/posts/pi-durable/). You talk to it from Slack, a web page or the command line, and all three share one conversation stored in SQLite. A run, a reminder or a question waiting for your approval survives a crash or a restart and carries on where it stopped.

In the Wheel of Time, a Warder (gaidin) is bonded to one Aes Sedai and always on watch.

It can:

- set reminders that reach your phone as notifications, days ahead, across restarts
- run scheduled jobs: a morning briefing, a check every few hours, a watch that only speaks up when something's wrong, or a follow-up it promised
- remember what you tell it across conversations, in notes you can see and edit
- search the web and read public pages and APIs, asking you before it contacts a new host
- run commands and edit files in a sandbox on its own machine
- work on projects on your other machines (workspaces), asking before each action
- check on a homelab and read its container logs (an extension written for the original deployment)

Slack threads branch the conversation: a reply in a thread sees the channel up to that point and nothing after.

## Quick start

On Linux with Node 22.18 or later, pnpm, and bubblewrap (`bwrap`):

```sh
pnpm install
echo '{ "owner": "Alex", "model": { "apiKey": "<your key>" } }' > gaidin.json && chmod 600 gaidin.json
pnpm doctor                                  # checks the settings and everything gaidin needs
pnpm serve                                   # the agent
pnpm ask "remind me in 10 minutes to check the oven"
pnpm watch                                   # everything the agent does, from any surface
pnpm check                                   # type check and tests
```

`pnpm gaidin --help` lists the commands, and `deploy/config.example.json` shows every section of the settings. `GAIDIN_MODEL=faux pnpm serve` runs a scripted model with no key and no network. Without `web.url` or `ntfy.url`, reminders print to the server's output.

## Documentation

- [Concepts](docs/concepts.md): the durable conversation, forks, and what survives a restart
- [Surfaces](docs/surfaces.md): the CLI, Slack and the web view, and how to set them up
- [Tools](docs/tools.md): every tool, what it can reach, and what asks first
- [Security](docs/security.md): the sandbox, redaction, approvals, and the known gaps
- [Deploying](docs/deploy.md): running it as a service, adding workspaces, and every setting
- [Extending](docs/extending.md): writing tools, and the parts written for one deployment
- [Plan](docs/plan.md): decisions so far and what's next

## Status

Running for one person since October 2026. Pi Durable is pinned at 1.1.0; its API is experimental and changes without notice, so upgrade it deliberately.
