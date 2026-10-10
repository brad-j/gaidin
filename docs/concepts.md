# Concepts

## One process, one conversation

`gaidin serve` (`src/server.ts`) is the only process that opens the SQLite file. It runs the agent and serves every surface: the Unix socket the CLI uses, Slack over Socket Mode, and the web view. Pi Durable allows one process per storage, so nothing else may open the file while the server runs.

Everything you say from any surface goes to the root conversation, so the CLI, the Slack channel and the web view all see the same history. A message sent from Slack shows up live in the web view and in `gaidin watch`.

## Durability

Pi Durable stores the conversation as entries (your messages, the model's answers, tool results) and runs everything as tasks that save a checkpoint after each step. The server can be killed at any point and resumes from the last checkpoint when it starts. In practice:

- A run that was generating or waiting on a tool picks up again. A tool marked replay-safe is run again; one that isn't, such as `bash`, isn't rerun, and the model is told it was interrupted and may have partly run.
- A reminder is a background task that sleeps until its time. After a restart it sleeps until the same moment, and one that came due while the server was down fires as soon as it starts.
- A Slack message is recorded before Slack is told it arrived. One still owed an answer when the server stopped is answered when it starts.
- A request for approval keeps its id across a restart, so the same tool call waits on the same request instead of asking twice.

Delivery of reminder pushes and Slack posts is at least once: a crash between sending and recording that it was sent sends it again.

Every message carries a request id, and submitting the same id again returns the stored submission instead of asking twice. `gaidin ask --id <id>` uses this to reattach to a run after the CLI or the server went away.

## Forks

A reply in a Slack thread forks the root conversation at the answer the thread hangs off. The fork starts with the root's history up to that answer and continues on its own: the thread sees nothing said in the channel afterwards, and the channel never sees the thread. Later replies in the same thread continue the same fork. A fork starts with the agent settings the root had at that point.

## Time

The server puts the local time in brackets at the start of each message, for example `[Sat 2026-10-10 13:29 GMT-4]`. Keeping the time out of the system prompt keeps the provider's prompt cache valid between messages. `GAIDIN_TZ` sets the time zone.

## Settings

The model, thinking level, standing instructions and which tools are switched on belong to the conversation. The web view changes them; they apply from the next request and survive restarts.

## The data directory

`GAIDIN_DATA` (default `data/`) holds:

- `gaidin.sqlite`: the conversation, tasks and documents, kept forever, compaction included
- `gaidin.sock`: the socket the CLI talks to
- `sandbox/`: the only directory the agent's own tools can touch

Back up the SQLite file to back up gaidin. Copy it while the server is stopped, or snapshot the whole machine.
