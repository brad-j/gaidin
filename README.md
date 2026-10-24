# gaidin

A personal agent for one person, built on [Pi Durable](https://earendil.com/posts/pi-durable/). You talk to it from the command line or a web page, which share one conversation stored in SQLite, or from Slack, where each thread is a conversation of its own. A run, a reminder or a question waiting for your approval survives a crash or a restart and carries on where it stopped.

In the Wheel of Time, a Warder (gaidin) is bonded to one Aes Sedai and always on watch.

It can:

- set reminders that reach your phone as notifications, days ahead, across restarts
- run scheduled jobs: a morning briefing, a check every few hours, a watch that only speaks up when something's wrong, or a follow-up it promised
- remember what you tell it across conversations, in notes you can see and edit
- search the web and read public pages and APIs, asking you before it contacts a new host that wasn't a search result
- run commands and edit files in a sandbox on its own machine
- work on projects on your other machines (workspaces), asking before each action
- check on a homelab and read its container logs (an extension written for the original deployment)
- run several named agents, each with its own job, notes, sandbox and grants, that ask each other things and hand work on

Each message you post in the Slack channel starts a thread, answered there, with gaidin's settings and memory but not the main conversation's history.

## Quick start

On Linux with Node 22.18 or later, pnpm, and bubblewrap (`bwrap`):

```sh
pnpm install
echo '{ "owner": "Alex", "model": { "apiKey": "<your key>" } }' > gaidin.json && chmod 600 gaidin.json
pnpm doctor                                  # checks the settings and everything gaidin needs
pnpm serve                                   # the agent
pnpm ask "remind me in 10 minutes to check the oven"
pnpm watch                                   # everything the agent does, from any surface
pnpm check                                   # type check, lint and tests
```

`pnpm gaidin --help` lists the commands, and `deploy/config.example.json` shows every section of the settings. `GAIDIN_MODEL=faux pnpm serve` runs a scripted model with no key and no network. Without `web.url` or `ntfy.url`, reminders print to the server's output.

## Try it locally

To see gaidin work before you have a key, run it on the scripted model. It needs no key, no network and no settings file, but still needs Node 22.18 or later, pnpm and bubblewrap, because the script runs a command in the sandbox.

In a checkout of this repository:

```sh
pnpm install
GAIDIN_MODEL=faux pnpm serve        # leave this running
```

In a second terminal, in the same checkout:

```sh
pnpm ask "hello"
```

Whatever you ask, the faux model answers the same way: it runs one `bash` command in the sandbox (a short `sleep`, then it appends a timestamp to `data/sandbox/slept.log` in the checkout and prints `slept`, so each ask adds a line) and replies `Tool came back:` with that output. The server prints a warning that reminders go to its output, since no `web.url` or `ntfy.url` is set; that's expected. Stop the server with Ctrl-C. For a real model, follow the Quick start.

## Documentation

- [Concepts](docs/concepts.md): the durable conversation, threads, agents, and what survives a restart
- [Surfaces](docs/surfaces.md): the CLI, Slack and the HTTP API, and how to set them up
- [Tools](docs/tools.md): every tool, what it can reach, and what asks first
- [Security](docs/security.md): the sandbox, redaction, approvals, and the known gaps
- [Deploying](docs/deploy.md): running it as a service, adding workspaces, and every setting
- [Extending](docs/extending.md): writing tools, and the parts written for one deployment
- [Plan](docs/plan.md): decisions so far and what's next

## Status

Running for one person since October 2026. Pi Durable is pinned at 1.3.0; its API is experimental and changes without notice, so upgrade it deliberately.

## License

MIT, in [LICENSE](LICENSE).
