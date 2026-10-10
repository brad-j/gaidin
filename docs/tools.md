# Tools

| Tool | Runs | Reaches | Asks first |
|---|---|---|---|
| `read`, `write`, `edit`, `bash` | in the sandbox | the sandbox directory only, no network | no |
| `remind`, `list_reminders`, `cancel_reminder` | in the server | its ntfy topic | no |
| `fetch_url` | in the server | the public internet only | for a host not allowed for good |
| `workspace_run`, `workspace_read`, `workspace_write`, `workspace_edit` | on a workspace, under bubblewrap | that machine's project roots, and the network | every call |
| `homelab_status` | in the server | the homelab's monitoring feeds | no |
| `container_logs` | in the server, over SSH | Docker logs on two hosts | no |

The last two belong to the [homelab extension](#homelab-extension), written for the original deployment. Every tool's result passes through [redaction](security.md#redaction) before it's stored.

## Coding tools

Pi Durable's `read`, `write`, `edit` and `bash`, confined to the sandbox directory ([Security](security.md#the-sandbox)). A command's output streams to the web view as it runs; output over the limit is saved to a file in `sandbox/.tmp`, and the model is given its path. The shell has no network, so `curl`, package installs and `git clone` fail there. Network access goes through `fetch_url` and the workspace tools.

## Reminders

`remind` takes the text and either `inMinutes` or `at` (ISO 8601 with a UTC offset) and returns the time it set, which the model reads back. `list_reminders` shows the open ones; `cancel_reminder` takes an id. The web view lists and cancels them too.

A reminder is a durable background task ([Concepts](concepts.md#durability)). When it fires, it posts to `NTFY_URL` with the title "gaidin" and records a "Reminder" entry in the conversation, which the web view shows and the model doesn't see. A failed push is retried up to five times with backoff, and the entry records whether it was delivered. Without `NTFY_URL`, reminders print to the server's output.

ntfy.sh topics have no password, so use a long random topic name and treat it as a secret. Subscribe to it in the ntfy app on your phone; the topic field takes the name alone, not the URL.

## fetch_url

A GET of a public web page or API, returned as text. HTML is reduced to the page's main content with headings, lists and links kept; JSON and plain text come back as they are, and other content types are described rather than shown. The result is labelled as coming from the web and not from the owner, so the model treats instructions in a page as content.

- Every address a name resolves to is checked when the connection is made, and again after each redirect. Private, CGNAT (which covers tailnet addresses), loopback, link-local and other reserved ranges are refused, so DNS can't point it at the LAN.
- No cookies or auth headers are sent. Up to five redirects are followed.
- Downloads stop at 2 MB after decompression. The text is cut to 20,000 characters unless the model asks for more, up to 200,000.

A fetch to a host you haven't allowed for good waits for your [approval](security.md#approvals).

## Workspaces

A workspace is another machine where gaidin works on projects as that machine's user. Each tool takes the workspace's name.

- `workspace_run` runs a bash command in a project, with a `cwd` and a `timeout` (default 120 seconds, at most 1,800). Output streams live, and the exit code is reported. Stop ends the command.
- `workspace_read` reads a text file's lines (default 2,000 from `offset`) or lists a directory. Files over 2 MB are refused; use `workspace_run` with `head`, `tail` or `grep`.
- `workspace_write` creates or replaces a file.
- `workspace_edit` replaces each `oldText` with `newText`; each must occur exactly once.

Commands run under bubblewrap on that machine with the project roots writable, secret files hidden, and network on, but without the user's SSH keys or tokens, so `git push` fails and stays with you. Commits made there are authored by gaidin and committed as you. Every call asks first; you can allow a workspace for an hour in one conversation. [Security](security.md#workspaces) has the details and [Deploying](deploy.md#adding-a-workspace) the setup. With no workspaces configured, these tools don't exist.

## Homelab extension

These two tools read one particular homelab and are switched on for the original deployment. [Extending](extending.md#parts-written-for-one-deployment) lists what would need to change to use them elsewhere.

### homelab_status

Reads the feeds behind a homelab dashboard: an Uptime Kuma public status page (`GAIDIN_KUMA_URL`) and JSON snapshots of Beszel host metrics, Docker containers and Proxmox backups (`GAIDIN_HOMELAB_DATA`). None needs a key, and the tool only reads. It lists what needs attention first:

- Kuma monitors that aren't up
- stopped or unhealthy containers, and Docker hosts the collector can't reach
- hosts down in Beszel, disks at 85% (critical at 95%), memory at 90%, temperatures at 80 °C
- a failed backup run, a disabled job, offline or 85%-full backup storage, guests last backed up 26 hours ago (critical at 50)
- snapshots that have gone stale

A feed that's down is reported and the rest are still read. `details: true` adds every monitor, host, container and backup.

### container_logs

Lists the containers on the configured Docker hosts, or returns one container's latest lines (default 200, at most 2,000), oldest first with timestamps, optionally only those newer than `since` (`30m`, `6h`, `2d`). Without `host` it finds the container's host itself.

The server connects over SSH to an account on each host whose key can only run a script that lists containers or prints a container's logs ([Security](security.md#container-logs)). Lines are labelled as other programs' text, terminal colour codes are removed, and values that look like secrets are scrubbed. Without the key (`GAIDIN_LOGS_KEYS`, default `/var/lib/gaidin/keys/docker-logs`) the tool doesn't exist.
