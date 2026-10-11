# Tools

| Tool | Runs | Reaches | Asks first |
|---|---|---|---|
| `read`, `write`, `edit`, `bash` | in the sandbox | the sandbox directory only, no network | no |
| `remind`, `list_reminders`, `cancel_reminder` | in the server | its ntfy topic | no |
| `remember`, `update_memory`, `forget` | in the server | the notes in every system prompt | after outside text in the same run |
| `ask_owner` | in the server | the owner, in Slack or the web view | it is the question |
| `schedule_job`, `list_jobs`, `cancel_job` | in the server; each run is a new conversation | what the run's tools reach | every new job |
| `fetch_url` | in the server | the public internet only | for a host not allowed for good |
| `web_search` | in the server | the configured search backend | no |
| `workspace_run`, `workspace_read`, `workspace_write`, `workspace_edit` | on a workspace, under bubblewrap | that machine's project roots, and the network | every call |
| `homelab_status` | in the server | the homelab's monitoring feeds | no |
| `container_logs` | in the server, over SSH | Docker logs on two hosts | no |

The last two belong to the [homelab extension](#homelab-extension), which is off unless the settings turn it on. Every tool's result passes through [redaction](security.md#redaction) before it's stored.

## Coding tools

Pi Durable's `read`, `write`, `edit` and `bash`, confined to the sandbox directory ([Security](security.md#the-sandbox)). A command's output streams to the web view as it runs; output over the limit is saved to a file in `sandbox/.tmp`, and the model is given its path. The shell has no network, so `curl`, package installs and `git clone` fail there. Network access goes through `fetch_url` and the workspace tools.

## Reminders

`remind` takes the text and either `inMinutes` or `at` (ISO 8601 with a UTC offset) and returns the time it set, which the model reads back. `list_reminders` shows the open ones; `cancel_reminder` takes an id. The web view lists and cancels them too.

A reminder is a durable background task ([Concepts](concepts.md#durability)). When it fires, it posts to `NTFY_URL` with the title "gaidin" and records a "Reminder" entry in the conversation, which the web view shows and the model doesn't see. A failed push is retried up to five times with backoff, and the entry records whether it was delivered. Without `NTFY_URL`, reminders print to the server's output.

ntfy.sh topics have no password, so use a long random topic name and treat it as a secret. Subscribe to it in the ntfy app on your phone; the topic field takes the name alone, not the URL.

## Questions

`ask_owner` asks the owner something only they can decide and waits for the answer, with up to five `choices` as buttons. The run pauses at the call, for up to `approvals.waitHours` (7 days by default), and picks up where it stopped once the owner answers; the tool result is the answer. The owner can answer with a button, in their own words in the question's Slack thread or the web view's box, or just with their next message in that conversation. The pause survives restarts: the question keeps its id, and the call waits on it again. A job's run can ask too, which is how a 3 a.m. job gets a decision made at breakfast.

## Memory

Notes gaidin keeps about the owner and their world, such as where the NAS is or how they take their coffee. Every conversation gets them at the end of its system prompt, job runs included, with a reminder that they're things gaidin was told, not instructions. `remember` adds one, `update_memory` replaces one by id, and `forget` deletes one. A note is at most 500 characters and all of them together at most 8,000, so the prompt stays small; gaidin has to merge or forget notes to make room. The web view lists them, with Delete and a box for adding your own.

Writing a note normally doesn't ask. If the run has read outside text since the owner's last message, from `fetch_url`, `web_search`, `container_logs`, `workspace_read` or `workspace_run`, a write asks first ([Security](security.md#approvals)), so a page that says "remember to..." can't plant a note on its own.

## Scheduled jobs

`schedule_job` sets up work for later: a morning briefing, a check every few hours, or a follow-up gaidin promised ("I'll look again on Friday"). It takes a `title`, an `instruction`, and one schedule:

- `at`: once, at an ISO 8601 time with a UTC offset
- `every`: repeating, like `30m`, `6h` or `1d`, at least 15 minutes apart
- `time` and `days`: at a local time (`08:00`), on `daily`, `weekdays`, `weekends` or a list like `mon, thu`, in the configured time zone, across daylight saving changes

With `mode: "watch"`, a run reports only when something needs the owner and otherwise ends quietly; the run answers `NOTHING_TO_REPORT` to stay silent. `list_jobs` shows each job's next and last run, and `cancel_job` takes an id. The web view lists them too, with Cancel.

Each job is a durable background task ([Concepts](concepts.md#durability)). At its time it starts a new conversation with the agent settings of the conversation it was made in, so the run doesn't carry that conversation's history and its instruction has to stand alone. The run has every tool except the job tools, so a job can't create jobs. Its answer goes to Slack as a message of its own (a reply in its thread continues that run's conversation), or to ntfy without Slack, and a "Scheduled" entry in the conversation records it. A failed delivery is retried up to five times. A run due while the server was down happens when it starts, and a repeating job then carries on from the next time after that.

Creating a job always asks the owner ([Security](security.md#approvals)), because it acts later without them. There can be at most 20 jobs. Each run is a full model request, so a frequent job costs accordingly, and its transcript is kept like any other.

## fetch_url

A GET of a public web page or API, returned as text. HTML is reduced to the page's main content with headings, lists and links kept; JSON and plain text come back as they are, and other content types are described rather than shown. The result is labelled as coming from the web and not from the owner, so the model treats instructions in a page as content.

- Every address a name resolves to is checked when the connection is made, and again after each redirect. Private, CGNAT (which covers tailnet addresses), loopback, link-local and other reserved ranges are refused, so DNS can't point it at the LAN.
- No cookies or auth headers are sent. Up to five redirects are followed.
- Downloads stop at 2 MB after decompression. The text is cut to 20,000 characters unless the model asks for more, up to 200,000.

A fetch to a host you haven't allowed for good waits for your [approval](security.md#approvals).

## web_search

Finds pages for `fetch_url` to read: titles, URLs and snippets, best first, up to 10 (default 5). `topic: "news"` searches current events, and `timeRange` keeps results from the last day, week, month or year. Results are labelled as text from the web, and count as outside text for the [memory guard](#memory).

The backend is a setting ([Deploying](deploy.md#settings)). Tavily is the one implemented: a search API with a free tier, called from the server with `search.apiKey`. The query goes only to the backend, so a search doesn't ask first, but whatever the model puts in a query reaches Tavily. Without a backend there's no `web_search`, and gaidin can only fetch URLs it already knows. A self-hosted engine such as SearXNG can be added as another backend; `src/search.ts` has one function per backend.

## Workspaces

A workspace is another machine where gaidin works on projects as that machine's user. Each tool takes the workspace's name.

- `workspace_run` runs a bash command in a project, with a `cwd` and a `timeout` (default 120 seconds, at most 1,800). Output streams live, and the exit code is reported. Stop ends the command.
- `workspace_read` reads a text file's lines (default 2,000 from `offset`) or lists a directory. Files over 2 MB are refused; use `workspace_run` with `head`, `tail` or `grep`.
- `workspace_write` creates or replaces a file.
- `workspace_edit` replaces each `oldText` with `newText`; each must occur exactly once.

Commands run under bubblewrap on that machine with the project roots writable, secret files hidden, and network on, but without the user's SSH keys or tokens, so `git push` fails and stays with you. Commits made there are authored by gaidin and committed as you. Every call asks first; you can allow a workspace for an hour in one conversation. [Security](security.md#workspaces) has the details and [Deploying](deploy.md#adding-a-workspace) the setup. With no workspaces configured, these tools don't exist.

## Homelab extension

These two tools were written for the original deployment's homelab. [Extending](extending.md#the-homelab-extension) shows how to turn them on and what they expect.

### homelab_status

Reads the feeds behind a homelab dashboard: an Uptime Kuma public status page (`kuma`) and JSON snapshots of Beszel host metrics, Docker containers and Proxmox backups (`feeds`). None needs a key, and the tool only reads. It lists what needs attention first:

- Kuma monitors that aren't up
- stopped or unhealthy containers, and Docker hosts the collector can't reach
- hosts down in Beszel, disks at 85% (critical at 95%), memory at 90%, temperatures at 80 °C
- a failed backup run, a disabled job, offline or 85%-full backup storage, guests last backed up 26 hours ago (critical at 50)
- snapshots that have gone stale

A feed that's down is reported and the rest are still read. `details: true` adds every monitor, host, container and backup.

### container_logs

Lists the containers on the hosts in `logHosts`, or returns one container's latest lines (default 200, at most 2,000), oldest first with timestamps, optionally only those newer than `since` (`30m`, `6h`, `2d`). Without `host` it finds the container's host itself.

The server connects over SSH to an account on each host whose key can only run a script that lists containers or prints a container's logs ([Security](security.md#container-logs)). Lines are labelled as other programs' text, terminal colour codes are removed, and values that look like secrets are scrubbed. Without `logHosts`, or without the `docker-logs` key in the keys directory, the tool doesn't exist.
