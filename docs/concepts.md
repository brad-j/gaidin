# Concepts

## One process, one conversation

`gaidin serve` (`src/server.ts`) is the only process that opens the SQLite file. It runs the agent and serves every surface: the Unix socket the CLI uses, Slack over Socket Mode, and the app. Pi Durable allows one process per storage, so nothing else may open the file while the server runs.

Everything you say from the CLI or the app goes to the root conversation, so both see the same history, live in `gaidin watch` too. Slack is the exception: each thread there is a [conversation of its own](#threads). The root is the default agent's home; other [agents](#agents) have homes of their own, which `gaidin ask --agent` talks to.

## Durability

Pi Durable stores the conversation as entries (your messages, the model's answers, tool results) and runs everything as tasks that save a checkpoint after each step. The server can be killed at any point and resumes from the last checkpoint when it starts. In practice:

- A run that was generating or waiting on a tool picks up again. A tool marked replay-safe is run again; one that isn't, such as `bash`, isn't rerun, and the model is told it was interrupted and may have partly run.
- A reminder is a background task that sleeps until its time. After a restart it sleeps until the same moment, and one that came due while the server was down fires as soon as it starts.
- A scheduled job works the same way. A run interrupted by a restart picks up its own conversation again, and its report isn't sent twice except in the moment between sending and recording it.
- A Slack message is recorded before Slack is told it arrived. One still owed an answer when the server stopped is answered when it starts.
- A request for approval, or a question to the owner, keeps its id across a restart, so the same tool call waits on the same request instead of asking twice. A run can wait days for an answer this way.

Delivery of reminder pushes and Slack posts is at least once: a crash between sending and recording that it was sent sends it again.

Every message carries a request id, and submitting the same id again returns the stored submission instead of asking twice. `gaidin ask --id <id>` uses this to reattach to a run after the CLI or the server went away.

## Compaction

Every request sends the conversation so far, so a long conversation makes every step slower and dearer, and Anthropic charges five times as much for every token of a request with over 100,000 tokens of input. Pi Durable's compaction summarises older messages and sends the summary in their place; the messages themselves stay in storage and in the [history index](tools.md#past-conversations). It times compaction from the model's context window, 1M tokens for Haiku and Sonnet 5.5, so `src/host.ts` gives it a smaller one: a summary starts in the background once a conversation reaches about 60,000 tokens and keeps the last 20,000 or so as they are, and a request waits for one above 85,000. A conversation that was already past that, as the main one can be after an upgrade, is summarised before its next answer. The log shows a "summary" line where it happened, which opens to what the model reads instead.

## Threads

A thread is a conversation of its own, started by a top-level message in the Slack channel or through the web server's [API](surfaces.md#the-api). A Slack thread is answered in the message's thread, and later replies there continue it. A thread starts with its agent's home settings (model, thinking, tools and standing instructions) as they are at that moment, and none of its history, so it costs only its own messages. The agent's memory, reminders and jobs are shared with it, and `search_history` finds what was said elsewhere. A change to the settings in the app applies to the home conversation and to threads started after it. Each thread records where it began, Slack or the API.

A reply in the Slack thread of something gaidin posted on its own, such as a job's report, forks that run's conversation at the report: the thread sees the run up to there and continues on its own. Answers posted in the channel before threads were separate work the same way, forking the root conversation at that answer. Through the API, a message to a job run or to a conversation another agent started forks it the same way, at its last answer, and goes to the fork; a message to a thread or a home conversation continues it.

## Agents

gaidin can run several named agents, each doing one kind of work for you. The original gaidin is the default agent; you add others with `gaidin agent add` ([Surfaces](surfaces.md#command-line)). Each agent has:

- a name and a one-line job, which its system prompt opens with
- a home conversation, whose settings are its model, thinking level, tools and standing instructions; a new agent starts with the default agent's model, thinking and built-in tools, and no instructions
- its own sandbox, `<data>/agents/<id>/sandbox` (the default agent's stays `<data>/sandbox`)
- its own work notes, beside the shared notes about you that every agent sees ([Tools](tools.md#memory))
- its own reminders, jobs and past conversations, which no other agent can list, cancel or search
- the hosts it fetches from without asking, the workspaces it may use (all for the default agent, none for a new one), the [browser profiles](tools.md#browser) it may use (none until given) and the sites it acts on there without asking, and the agents it may message

They share the skills, the self-written tools you switch on for them, and the spend limits. Every conversation belongs to one agent: a thread or job run is the agent's whose conversation it came from, and one from before agents existed is the default agent's. An agent reaches another only with `message_agent` and `hand_off`, and only those its entry lists ([Tools](tools.md#other-agents)). The roster is stored in the SQLite file, with the rest of gaidin's state; the settings file doesn't list agents.

Slack and the app talk to the default agent for now; the web server's [API](surfaces.md#the-api) reaches every agent. An agent's id is fixed once made; its name, job and grants can change.

Archiving an agent, from the API, pauses its jobs and cancels its reminders, and it can't be talked to; its conversations, notes and sandbox stay. Restoring it leaves its jobs paused, for you to resume. The default agent can't be archived.

## Time

The server puts the local time in brackets at the start of each message, for example `[Sat 2026-10-10 13:29 GMT-4]`. Keeping the time out of the system prompt keeps the provider's prompt cache valid between messages. `GAIDIN_TZ` sets the time zone.

## Settings

The model, thinking level, standing instructions and which tools are switched on belong to the conversation. The app changes them; they apply from the next request and survive restarts.

## The data directory

`GAIDIN_DATA` (default `data/`) holds:

- `gaidin.sqlite`: the conversation, tasks and documents, kept forever, compaction included
- `gaidin.sock`: the socket the CLI talks to
- `sandbox/`: the only directory the default agent's own tools can touch
- `agents/<id>/sandbox/`: the same for each other [agent](#agents)
- `skills/`: local [skills](tools.md#skills), one directory each, in a Git repository that keeps every change
- `browser/<profile>/`: each [browser profile](tools.md#browser)'s cookies and site storage, outside every sandbox

Back up the SQLite file to back up gaidin. Copy it while the server is stopped, or snapshot the whole machine.
