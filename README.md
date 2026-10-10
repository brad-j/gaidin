# gaidin

A personal agent for one person, built on [Pi Durable](https://earendil.com/posts/pi-durable/). You talk to it from Slack, a web page or the command line, and all three share one conversation stored in SQLite. A run, a reminder or a question waiting for your approval survives a crash or a restart and carries on where it stopped.

In the Wheel of Time, a Warder (gaidin) is bonded to one Aes Sedai and always on watch.

It can:

- set reminders that push to your phone through ntfy, days ahead, across restarts
- read public web pages and APIs, asking you before it contacts a new host
- run commands and edit files in a sandbox on its own machine
- work on projects on your other machines (workspaces), asking before each action
- check on a homelab and read its container logs (an extension written for the original deployment)

Slack threads branch the conversation: a reply in a thread sees the channel up to that point and nothing after.

## Quick start

On Linux with Node 22.18 or later, pnpm, and bubblewrap (`bwrap`):

```sh
pnpm install
printf 'ANTHROPIC_API_KEY=%s\n' "<your key>" > .env
pnpm serve                                   # the agent; reads .env
pnpm ask "remind me in 10 minutes to check the oven"
pnpm watch                                   # everything the agent does, from any surface
pnpm check                                   # type check and tests
```

`GAIDIN_MODEL=faux pnpm serve` runs a scripted model with no key and no network. Without `NTFY_URL`, reminders print to the server's output.

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
