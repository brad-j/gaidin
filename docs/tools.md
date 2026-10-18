# Tools

Every [agent](concepts.md#agents) has these tools, and each works on that agent's own sandbox, work notes, reminders, jobs and past conversations, and its own allowed hosts and workspaces.

| Tool | Runs | Reaches | Asks first |
|---|---|---|---|
| `read`, `write`, `edit`, `bash` | in the sandbox | the sandbox directory only, no network | no |
| `remind`, `list_reminders`, `cancel_reminder` | in the server | the owner's [notifications](surfaces.md#notifications) | cancelling, while outside text other than [speech](surfaces.md#voice) is in the conversation |
| `remember`, `update_memory`, `forget` | in the server | the shared notes in every agent's prompt, and the agent's own work notes | while outside text is in the conversation |
| `search_history`, `read_history` | in the server | its index of past messages | no |
| `read_skill` | in the server | the [skills](#skills), read-only | no |
| `write_skill`, `remove_skill` | in the server | local [skills](#skills) | every call |
| `ask_owner` | in the server | the owner, in Slack or the app | it is the question |
| `message_agent`, `hand_off` | in the server; each starts a conversation of the other agent's | another agent, which uses its own tools | refused unless the agent's roster entry lists the other; asks while outside text is in the conversation |
| `schedule_job`, `list_jobs`, `cancel_job` | in the server; each run is a new conversation | what the run's tools reach | every new job; cancelling, while outside text is in the conversation |
| alert investigations | in the server; each is a job run | read-only tools only | for a host not allowed for good |
| `fetch_url` | in the server | the public internet only | for a host not allowed for good, unless `web_search` returned the URL |
| `web_search` | in the server | the configured search backend | no |
| `browser_open`, `browser_snapshot`, `browser_screenshot`, `browser_tabs`, `browser_back` | in the server, in a Chromium per profile | the public internet, signed in to sites | opening a page, for a host not allowed for good, unless `web_search` returned the URL; refused for a profile the agent wasn't given |
| `browser_click`, `browser_type`, `browser_select` | the same | what the signed-in sites allow | while outside text is in the conversation, unless the agent may act on that site without asking; typing into a password field is refused |
| `browser_upload` | the same | sends files from the agent's sandbox to a site | every call |
| `browser_hand_over` | in the server | the owner, in the app | it is the request |
| `load_extension`, `remove_extension` | in the server | the sandbox's `extensions/`, the owner | every load and removal |
| tools gaidin wrote | in a box of their own | their fetches, through the server | for a host not allowed for good |
| `workspace_run`, `workspace_read`, `workspace_write`, `workspace_edit` | on a workspace, under bubblewrap | that machine's project roots, and the network | every call |
| a connector's tools, `<connector>_<tool>` | on the connector's server | what that service's grant allows | as you set each tool: allow, ask (every call) or off; refused for a connector the agent wasn't given |
| `homelab_status` | in the server | the homelab's monitoring feeds | no |
| `container_logs` | in the server, over SSH | Docker logs on two hosts | no |

The last two belong to the [homelab extension](#homelab-extension), which is off unless the settings turn it on. Every tool's result passes through [redaction](security.md#redaction) before it's stored.

## Coding tools

Pi Durable's `read`, `write`, `edit` and `bash`, confined to the sandbox directory ([Security](security.md#the-sandbox)). A command's output streams to the app as it runs; output over the limit is saved to a file in `sandbox/.tmp`, and the model is given its path. The shell has no network, so `curl`, package installs and `git clone` fail there. Network access goes through `fetch_url` and the workspace tools.

## Reminders

`remind` takes the text and either `inMinutes` or `at` (ISO 8601 with a UTC offset) and returns the time it set, which the model reads back. `list_reminders` shows the open ones; `cancel_reminder` takes an id. Both see only the reminders their agent set. The app lists and cancels them too.

A reminder is a durable background task ([Concepts](concepts.md#durability)). When it fires, it's sent as a [notification](surfaces.md#notifications) titled "gaidin" and recorded as a "Reminder" entry in the conversation, which the app shows and the model doesn't see. When no way of notifying reached anyone, it's retried up to five times with backoff, and the entry records whether it was delivered.

A reminder can be snoozed for 10 minutes or an hour from wherever it shows up: its ntfy push, its message in Slack (with Slack set up, each one is posted to the channel too), and its row in the app. A snooze sets the reminder again from now, in the conversation it came from. The push's buttons need `web.url` in the settings, and the phone's ntfy app calls the app itself, so they work while the phone is on the tailnet; on iOS they show when you long-press the notification. With `web.url`, tapping the push opens the app.

With ntfy, use a long random topic name and treat it as a secret: on ntfy.sh, anyone who knows a topic's name can read and post to it unless the topic is reserved and needs a token (`ntfy.token`). `gaidin doctor` and `gaidin serve` warn about a topic on ntfy.sh without one, for reminders and for [alerts](#alerts). Subscribe to it in the ntfy app on your phone; the topic field takes the name alone, not the URL.

## Questions

`ask_owner` asks the owner something only they can decide and waits for the answer, with up to five `choices` as buttons. The run pauses at the call, for up to `approvals.waitHours` (7 days by default), and picks up where it stopped once the owner answers; the tool result is the answer. The owner can answer with a button, in their own words in the question's Slack thread or at the app's prompt, or just with their next message in that conversation. The pause survives restarts: the question keeps its id, and the call waits on it again. A job's run can ask too, which is how a 3 a.m. job gets a decision made at breakfast.

## Other agents

An agent whose roster entry lists other agents can reach them ([Concepts](concepts.md#agents)). Its system prompt names each one with its job.

- `message_agent(agent, text, files?)` asks another agent something and waits for its answer, which comes back as the tool's result. The other agent answers in a new conversation of its own, with its own settings and tools, and doesn't see the asker's conversation. The wait survives restarts like `ask_owner`'s.
- `hand_off(agent, title, task, files?)` gives another agent work and doesn't wait. The work runs at once as a one-off [job](#scheduled-jobs) of the receiving agent's, and its answer reaches the owner as a report titled with `title` and the sender's name, not the sender.

`files` lists up to 10 files in the sender's sandbox, up to 20 MB each. The receiver gets copies in its sandbox's `uploads/`, which its commands see read-only, and its message ends with where each one is, as for a file sent from Slack or the app. They're copied when the call runs, so later changes on either side don't reach the other. A path outside the sender's sandbox, a directory or a missing file fails the call, and nothing is sent or handed.

A call to an agent the entry doesn't list, or one that's archived, is refused with the agents it can reach. Either tool asks the owner while outside text is in the conversation, since a page could otherwise pass work to an agent with wider grants. What one agent sends another is outside text to the receiver, and the answer that comes back is outside text to the sender ([Security](security.md#agents)). A chain of messages and hand-offs stops at three, and an agent already in a chain can't be asked again within it.

## Memory

Notes the agents keep, such as where the NAS is or how the owner takes their coffee. There are two kinds:

- Shared notes are about the owner and their world. Every agent gets them in its system prompt. `remember` with `shared` set writes one. They're named `s1`, `s2` and so on, and all of them together are at most 8,000 characters.
- Work notes are one agent's own, about its own work, and only it sees them. `remember` without `shared` writes one. They're named `w1`, `w2` and so on, numbered per agent, and an agent's are at most 4,000 characters.

Every conversation gets the shared notes and then its agent's work notes at the end of its system prompt, job runs included, with a reminder that they're things the agent was told, not instructions. `update_memory` replaces a note by id and `forget` deletes one; a bare number means a shared note, as notes were named before agents. A note is at most 500 characters, and an agent has to merge or forget notes to make room. The app's memory page lists the shared notes, and you add, edit and forget them there; `/remember` and `/forget` do the same from the console.

An agent whose shared notes are off (`gaidin agent set ID --shared-notes off`, or `sharedNotes` on `/api/agents/save`), for one that people other than the owner talk to, gets only its own work notes in its prompt, and `remember` with `shared`, `update_memory` and `forget` on a shared note are refused, not asked. The default agent always has them.

Writing a note of either kind normally doesn't ask. While the conversation's context holds outside text, from `fetch_url`, `web_search`, `container_logs`, `workspace_read`, `workspace_run`, a self-written tool, past answers from `search_history` or `read_history`, a message from another agent, or speech at a [speaker](surfaces.md#voice), a write asks first ([Security](security.md#approvals)), so a page that says "remember to..." can't plant a note on its own, even after the owner has said something else. In the main conversation that lasts until compaction summarises the page away.

## Skills

Guides for particular tasks, which gaidin opens only when a request calls for one, so a long one costs nothing until it's used. A skill is a directory with a `SKILL.md`: front matter with a `name` (lowercase letters, digits and hyphens, up to 64) and a one-line `description` of what it's for and when to use it, then Markdown, as [agentskills.io](https://agentskills.io/specification) describes. It can point to other text files in its directory, such as `references/backups.md`.

Every system prompt lists the skills by name and description. `read_skill(name)` opens a skill's `SKILL.md` and lists its files, and `read_skill(name, file)` opens one of them. It reads only the files the skill had when the list was last read, and refuses one that has since become a link out of it.

- The built-in skill, `gaidin`, is this documentation: `docs/`, with `docs/SKILL.md` as its index. It ships with the code, so it describes the running version, and gaidin reads it to answer questions about itself.
- Local skills are directories in `skills/` in the [data directory](concepts.md#the-data-directory), such as `<data>/skills/homelab/SKILL.md`. A skill without a valid `SKILL.md`, or with a name already taken, isn't loaded, and the skills page says why.

You write local skills on the app's skills page, and your changes apply at once. gaidin writes them with `write_skill(name, file?, text)`, which creates a skill from its `SKILL.md` or replaces one of its files with `text`, and removes them with `remove_skill(name, file?)`; removing `SKILL.md` removes the whole skill. Both always ask you first, showing the lines added and removed, since a skill is instructions gaidin will follow ([Security](security.md#skills)). gaidin offers to write a skill when you ask it to keep a way of doing something, or when it has worked out a procedure it will need again.

A skill's file is a path of up to three parts, none hidden, ending `.md`, `.txt`, `.json`, `.yaml`, `.csv`, `.sh`, `.ts`, `.js` or `.py`, and at most 200 KB. A new skill starts with its `SKILL.md`, whose `name` must be the skill's. The built-in skill can't be changed this way. Every change is a commit in `skills/`'s own Git repository, by `owner` or `gaidin`, so the history is kept, and the list is read again after each one. A change made on disk by hand shows after the server restarts.

## Past conversations

`search_history(query)` finds the owner's messages and the agent's answers in every past conversation of the agent's own: its main one, Slack threads, job runs and conversations other agents started with it. It doesn't find another agent's. Every word has to appear, and word endings don't matter. It returns up to 10 matches, newest first, each with its time, where it was and a number; `read_history(id)` shows the messages around one, in order. gaidin searches before saying it doesn't know something the owner may have told it.

Pi Durable keeps every message, including the ones compaction summarized away, but can't search them, so `src/history.ts` keeps a full-text index in `<data>/history.sqlite`, using SQLite's FTS5. It follows the transcript as messages are stored and catches up at start, so deleting the file only makes it rebuild. Tool output isn't indexed, and neither are gaidin's internal conversations, such as the reviewer's for [self-written tools](#self-written-tools). A fact that only appeared in a fetched page or a command's output is found only if gaidin repeated it in an answer. The search makes no model calls.

The same index holds the app's [timeline](surfaces.md#web-view): tool calls and whether they worked, approval outcomes, job reports and reminders, from every indexed conversation.

## Scheduled jobs

`schedule_job` sets up work for later: a morning briefing, a check every few hours, or a follow-up gaidin promised ("I'll look again on Friday"). It takes a `title`, an `instruction`, and one schedule:

- `at`: once, at an ISO 8601 time with a UTC offset
- `every`: repeating, like `6h` or `1d`, at least 6 hours apart, or 15 minutes with a [gate](#gates)
- `time` and `days`: at a local time (`08:00`), on `daily`, `weekdays`, `weekends` or a list like `mon, thu`, in the configured time zone, across daylight saving changes

With `mode: "watch"`, a run reports only when something needs the owner and otherwise ends quietly; the run answers `NOTHING_TO_REPORT` to stay silent. `list_jobs` shows each job's next and last run, and `cancel_job` takes an id; both see only their agent's jobs. A job belongs to the agent that scheduled it, and its runs are that agent's, with its sandbox and grants. The app lists them too, with Cancel.

Each job is a durable background task ([Concepts](concepts.md#durability)). At its time it starts a new conversation with the agent settings of the conversation it was made in, so the run doesn't carry that conversation's history and its instruction has to stand alone. It does get the job's last three reports, each cut to 800 characters, and how many runs since had nothing to report, and a watch is told not to report again what those covered unless it has got worse. A report counts once it's delivered. The run has every tool except the job tools, so a job can't create jobs. Its answer goes to Slack as a message of its own (a reply in its thread continues that run's conversation), or as a [notification](surfaces.md#notifications) without Slack, and a "Scheduled" entry in the conversation records it. A failed delivery is retried up to five times. A run due while the server was down happens when it starts, and a repeating job then carries on from the next time after that.

A run that fails (the model errors, the run breaks off, or its gate fails) delays the next one by at least 15 minutes, doubled for each failure in a row up to 4 hours. You're told about the first failure in a row, not the ones after it. After five in a row the job pauses: its runs are skipped until you resume it, from the button on the message saying it paused in Slack or with `/resume` in the app, and it then runs at its next scheduled time. `/pause` pauses a job by hand. A run the [spend limits](deploy.md#spend-limits) stopped, one you stopped, and a report that couldn't be delivered don't count as failures, so an outage of Slack or ntfy doesn't pause every job. An answer, or a gate check that finds nothing new, ends the streak. `list_jobs` shows a job's failures and whether it's paused.

Creating a job always asks the owner ([Security](security.md#approvals)), because it acts later without them, and the request shows its gate. There can be at most 20 jobs. Each run is a full model request, so a frequent job costs accordingly, and its transcript is kept like any other.

### Gates

A gate is a check that runs before each of a job's runs, in the server and without the model, and decides whether the run happens. `schedule_job` takes it as `gate: { name, args }`. It answers whether to wake the run, what it found, and a topic: what the findings are about, without numbers that drift. The run wakes only when the topic differs from the one the gate found the last time it woke a run that answered and reached you; the run's prompt starts with what the gate found. When the gate finds nothing, it forgets the topic, so the same problem coming back is new. A check that ends without a run costs no model request, which is why a gated job can run every 15 minutes and a job without one at most every 6 hours, 4 times a day. `list_jobs` shows how many checks found nothing new. A gate that throws, answers something else or takes over 30 seconds fails the run.

- `homelab`, with the [homelab extension](#homelab-extension) on, checks what `homelab_status` lists as needing attention, and wakes the run when there's anything. `args: { severity: "critical" }` counts only critical items. Its topic is each item's severity and what it's about, so a disk going from 87% to 88% isn't new, and one going from warning to critical is.
- A [self-written tool](#self-written-tools) is a gate when it answers JSON: `{"wake": true or false, "data": what it found, "topic": what that is about}`. `data` can be any JSON; `topic` defaults to `data`. It runs in its box as usual, but a gate has no one to ask, so its fetches reach only hosts you've allowed for good, and any other fails the check. While the tool is switched off in the app, the check fails.

What a gate found counts as outside text, so in a run it woke, writing a note asks first ([Security](security.md#approvals)).

## Alerts

With `alerts.url` in the settings, gaidin follows an ntfy topic that monitoring already pushes to, such as Uptime Kuma, the NAS, Proxmox, Beszel or failing systemd units, and investigates what arrives (`src/alerts.ts`). It only connects out to ntfy, so nothing new listens on the server and the senders don't change.

Alerts that arrive within a minute of each other become one investigation: a one-off [watch job](#scheduled-jobs) titled after the first alert. Its run gets the alerts as data and only read-only tools: `homelab_status`, `container_logs`, `fetch_url` (which still asks before a new host), `web_search`, `search_history` and `read_history`, whichever are set up. It reports what's wrong, the likely cause and what to do, to Slack, or to the reminder topic without Slack, and stays quiet when nothing needs the owner, such as when every alert is a recovery. A reply in the report's thread continues the investigation, and the timeline lists it.

The last alert handed to an investigation is stored, so after a restart gaidin reads the topic on from there; ntfy.sh keeps messages for 12 hours. Each investigation is a model run, so a burst of alerts costs money; the [spend limits](deploy.md#spend-limits) cap it. `alerts.url` can't be the reminder topic, or gaidin would investigate its own reminders.

## fetch_url

A GET of a public web page or API, returned as text. HTML is reduced to the page's main content with headings, lists and links kept; JSON and plain text come back as they are, and other content types are described rather than shown. The result is labelled as coming from the web and not from the owner, so the model treats instructions in a page as content.

- Every address a name resolves to is checked when the connection is made, and again after each redirect. Private, CGNAT (which covers tailnet addresses), loopback, link-local and other reserved ranges are refused, and so are the IPv6 forms that carry an IPv4 address (IPv4-mapped, IPv4-compatible, NAT64 and 6to4), so DNS can't point it at the LAN.
- No cookies or auth headers are sent. Up to five redirects on the same host are followed. A redirect to another host isn't: the result says where it points, and fetching that is a new call, which asks for a host not allowed for good. A self-written tool's fetch asks for each new host a redirect leads to, and a gate's fails on one not allowed for good.
- Downloads stop at 2 MB after decompression. A server that stays quiet for 15 seconds is given up on, and so is a fetch that takes more than a minute in all, redirects included. The text is cut to 20,000 characters unless the model asks for more, up to 200,000.

A fetch to a host you haven't allowed for good waits for your [approval](security.md#approvals), unless `web_search` returned that exact URL earlier in the same conversation. Hosts are allowed for good per agent: "always allow" on one agent's request lets that agent fetch from the host, not the others. Only the URL counts, not others on its host; one with a query or path added still asks, and so does a link read in a page or a snippet. A result's URLs stop counting once compaction summarises it away.

## web_search

Finds pages for `fetch_url` to read: titles, URLs and snippets, best first, up to 10 (default 5). `topic: "news"` searches current events, and `timeRange` keeps results from the last day, week, month or year. Results are labelled as text from the web, and count as outside text for the [memory guard](#memory). Each result also records its URLs where the model can't write, so `fetch_url` reads one without asking ([fetch_url](#fetch_url)).

The backend is a setting ([Deploying](deploy.md#settings)). Tavily is the one implemented: a search API with a free tier, called from the server with `search.apiKey`. The query goes only to the backend, so a search doesn't ask first, but whatever the model puts in a query reaches Tavily. Without a backend there's no `web_search`, and gaidin can only fetch URLs it already knows. A self-hosted engine such as SearXNG can be added as another backend; `src/search.ts` has one function per backend.

## Browser

A Chromium that stays signed in to sites, for agents you've given a browser profile. The settings name the profiles (`browser.profiles`, [Deploying](deploy.md#settings)), and each agent's roster entry lists the ones it may use: none for a new agent or the default agent until you give it one, on the app's settings page or with `gaidin agent set ID --profiles NAME`. Agents given the same profile share its sign-ins and nothing else. An agent with no profile isn't offered the browser's tools, and a call with a profile it wasn't given is refused.

- `browser_open` loads a page in the profile's current tab and returns its title, its URL and an accessibility snapshot: the page's text, links and controls, each with a ref such as `e12`. It waits for the page to load, up to 30 seconds, and a few seconds more for it to settle.
- `browser_snapshot` gives the current page's snapshot again, or with a `ref` only the part under that element, in full. A snapshot is cut at about 4,000 tokens (16,000 characters), and the result says so; a busy page's whole snapshot is three or four times that.
- `browser_screenshot` returns a JPEG of the page at 1280 by 800, as an image the model sees. A snapshot is cheaper; a screenshot shows layout and images.
- `browser_tabs` lists the profile's tabs, and with `select` or `close` switches to or closes one. A tab a page opens becomes the current one.
- `browser_click`, `browser_type` and `browser_select` act on an element by its ref in the page's latest snapshot: click it, type into it (replacing what's there, and pressing Enter with `submit`), or choose options in a select box by value or label. Each returns the page as the action left it.
- `browser_back` goes back a page in the current tab.
- `browser_upload` puts up to 10 files from the agent's sandbox, up to 20 MB each, in a file field; they go to the site when the page sends its form.
- `browser_hand_over` asks you to take the profile over, for a sign-in, a CAPTCHA or something only you should confirm, and waits like `ask_owner`, for days if need be, until you press Done or Can't. Then it returns the page as you left it.

Opening a page asks as `fetch_url` does: unless the host is allowed for good for that agent, or `web_search` returned that exact URL in the conversation, it waits for your [approval](security.md#approvals), whose second button allows the host for good for the agent, for its fetches too. A page's own navigations, from a link it follows or its script, go ahead on its own host and to hosts allowed for good; any other is stopped, the page stays as it was, and the next result names the URL so the model can open it with `browser_open`, which asks. A redirect of an allowed navigation goes ahead. Private, LAN, tailnet and loopback addresses are refused as `fetch_url` refuses them, for a page and for everything a page loads ([Security](security.md#the-browser)). What a page shows is outside text and is labelled as coming from the web.

Clicking, typing and choosing ask while outside text is in the conversation, which after reading any page it is, so in practice each one asks, naming the element as the snapshot showed it and the site: `click button "Delete" [ref=e12] on mail.example.com in browser profile personal`. The approval's second button lets that agent act on that site in that profile without asking from then on; the app's settings page lists those sites under "acts on", where you remove them. An answer can come days later, so the action happens only if the page is still on that site and the ref is still that element; otherwise the model is told the page changed and takes a new snapshot. `browser_type` refuses a password field, whatever's been allowed. `browser_upload` asks every time, naming the files, even on a site the agent acts on without asking, since it sends your files away. `browser_back` doesn't ask: the page it goes back to was allowed when it was opened.

A download a page starts is saved in the agent's sandbox under `downloads/`, which its commands see read-only, as `<id>-<name>`, up to 20 MB; the action's result says where, after waiting up to a minute for it. A page's dialogs are dismissed (a confirm answers cancel) and the result says what they said; leaving a page goes ahead.

Each profile is its own Chromium, started when a tool first uses it and closed after 15 minutes unused; at most two are open at once, and the least recently used idle one closes to make room. A profile's directory, `<data>/browser/<profile>/`, keeps its cookies and site storage, so sign-ins outlast closing and restarts. Open pages don't: a profile that opens again goes back to the last page it was on, and the refs of the pages before are gone. The browser's tools aren't rerun after a restart; a call a restart cut off is reported as interrupted.

### Taking a profile over

Signing in is yours to do: the model never types a password. The app's Browser page lists the profiles, with the page each was left on and the agent there, and opens one to take it over: its current tab, live, with an address bar, Back, and Done. Your clicks, scrolls and typing go straight to that page and never through a model or the transcript. On a phone a tap is a click, a drag scrolls, and the Keyboard button opens the phone's keyboard. A tab the page opens, such as a sign-in window, is followed. While you have a profile it goes wherever you take it, private addresses aside, and every agent's browser call on it waits.

You have it until you press Done, leave the page for 15 seconds (switching apps on a phone and back is fine), or give it no input for 10 minutes. Done also finishes any hand-over of that profile. Afterwards the refs of every snapshot from before are dropped, so an agent looks again before acting; downloads you start there aren't kept.

A hand-over shows in the app's dock with Take over, Done and Can't, is pushed to your devices, opening the profile's page when tapped, and is posted in Slack with the same buttons, Take over linking to the app when `web.url` is set. A new message from you in that conversation skips it, as it skips an approval.

## Connectors

A connector is a remote MCP server you add, such as a mail, calendar or notes service's: its tools become tools of the agents you give it to. It's for services that offer one; the [browser](#browser) is for sites that don't.

You add and manage them on the app's [Connectors page](surfaces.md#the-app), or from the command line, with a name and the server's URL. A server that signs in with OAuth is connected with `connector connect`, which prints an address to open in a browser; one that takes a token you paste gets it on standard input:

```sh
gaidin connector add home http://192.168.0.105/api/mcp           # then:
gaidin connector connect home                                    # open the address it prints, sign in
gaidin connector add mail https://mcp.example.com/mcp --token    # or paste a token, then Enter
gaidin connector show mail                                       # its tools and how each is set
gaidin connector tool mail send_mail ask                         # allow, ask or off
gaidin agent set scout --connectors mail                         # which agents get its tools
```

`connector refresh` reads its tools again, `connector token` changes or removes its token, and `connector remove` removes it, its token and every agent's grant. A connector's URL is https, or http to loopback or a private address, such as a server in your homelab.

Each tool is named `<connector>_<tool>` for the model and set to one of:

- allow: runs without asking. Tools the server marks read-only start here.
- ask: asks you on every call, showing its arguments. Every other tool starts here.
- off: not offered, so it costs nothing in each request either. `gaidin connector list` says about how many tokens a connector's tools add to each request.

A tool's description is the server's own text, which the model reads, so gaidin pins it: a hash of its name, description, schema and the server's hints, as you last set it. When the server adds a tool, or changes one, the tool is off until you set it again, which accepts it as it is then; `connector show` marks it new or changed. The tools of a connector you've just added take their defaults, since adding it is when you look at them. A server can mark a tool's schema in a way gaidin can't honor (an `x-mcp-header` in the wrong place); such a tool is listed as unusable and never offered.

What a tool returns is outside text, labelled as from that connector, cut to 20,000 characters, with its images kept. A call waits up to 60 seconds. A server that asks for more input in the middle of a call isn't answered yet; the call fails naming what it asked. When the server refuses the token, a signed-in connector refreshes it and tries once more; if that's refused too, or a pasted token is, the connector is marked as needing you, and its tools say so until you sign it in again or give it a token that works.

Signing in follows the MCP spec's OAuth: gaidin finds the service's sign-in from the server's metadata, sends your browser there with PKCE, and takes the answer at `<web.url>/api/connectors/callback`, so it needs `web.url` and a browser that reaches both the service and gaidin's app. The sign-in must finish within 10 minutes. gaidin identifies itself with a client id document, `<web.url>/api/connectors/client.json`. A service that checks the address it sends you back to against the client id's host, as Home Assistant does, takes that without fetching it. One on the internet that fetches the document can't reach your tailnet, so put a copy (`gaidin connector client-document` prints it) at a public https address and name it in `connectors.clientId` ([Deploying](deploy.md#settings)). A service that registers clients instead gets gaidin registered, and for one that does neither, give the client id you registered with it: `connector connect NAME --client-id ID`. Access tokens are refreshed a minute before they expire.

The tokens are kept in `<data>/connectors/vault.json`, readable only by the server, never in the database or a transcript, and redacted from tool output. gaidin speaks both the current MCP revision, 2026-07-28, and the earlier ones (2025-03-26 to 2025-11-25) that most servers still use, finding out which with the first request.

## Workspaces

A workspace is another machine where gaidin works on projects as that machine's user. Each tool takes the workspace's name.

- `workspace_run` runs a bash command in a project, with a `cwd` and a `timeout` (default 120 seconds, at most 1,800). Output streams live, and the exit code is reported. Stop ends the command.
- `workspace_read` reads a text file's lines (default 2,000 from `offset`) or lists a directory. Files over 2 MB are refused; use `workspace_run` with `head`, `tail` or `grep`.
- `workspace_write` creates or replaces a file.
- `workspace_edit` replaces each `oldText` with `newText`; each must occur exactly once.

Commands run under bubblewrap on that machine with the project roots writable, secret files hidden, and network on, but without the user's SSH keys or tokens, so `git push` fails and stays with you. Commits made there are authored by gaidin and committed as you. An agent can use only the workspaces its roster entry gives it, every one for the default agent and none for a new agent; a call to another is refused. Every call asks first; you can allow a workspace for an hour in one conversation, or trust a folder for an agent's reads, writes and edits with a [rule](security.md#your-rules). [Security](security.md#workspaces) has the details and [Deploying](deploy.md#adding-a-workspace) the setup. With no workspaces configured, these tools don't exist.

## Self-written tools

gaidin can write tools for itself. It drafts an extension in the sandbox, in `extensions/<name>/`: `index.ts` exports `tools`, and `test.ts` tests them with `node:test`. A tool has a name, a description, a JSON Schema for its arguments and an `execute` function that returns the result text. Its only way out is a `fetch(url)` it's handed, which goes through the server under `fetch_url`'s rules and asks before a host the owner hasn't allowed for good. An extension imports only Node's built-ins, its own files and the `Tool` type from `"gaidin"` (`src/self/api.ts`).

`load_extension(name)` checks the draft before the owner sees it:

- The type check: TypeScript in strict mode, failing on unused variables and parameters and on unreachable code.
- The extension's own tests.
- Oxlint, with its default rules and ten of the anti-slop rules (`src/self/oxlintrc.json`), warnings counted as failures.
- No imports from outside, no comment that turns a check off, `.ts` files only, at most 200 KB.
- A second model run that reviews the diff against a short guide: the least code that does the job, nothing nobody asked for, no helper used once, no comment that restates the code, no tool that duplicates another. gaidin fixes what it objects to, or loads anyway with `keep` and its reason, and the owner sees both.

The approval request shows the lines added and removed, with the diff under "all of it" in the app and up to about 2,600 characters of it in Slack. Once approved, the copy that was checked goes to `<data>/extensions/<name>`, a Git repository the sandbox can't see, and its tools are in use from the next step, with no restart. Editing the draft afterwards changes nothing until it's approved again. `remove_extension(name)` takes the tools away after approval; the repository keeps the history. At start the server loads every approved extension again.

An extension belongs to the agent that loaded it, which drafts it in its own sandbox. Other agents aren't offered its tools, and a call from one is refused, until the owner switches it on for them (`gaidin agent` can't yet; the app will). Only its agent can update or remove it. Its fetches ask by the calling agent's allowed hosts.

Each extension runs in one Node process under bubblewrap ([Security](security.md#self-written-tools)). A call that takes over a minute is stopped and the process starts again on the next call. Self-written tools can be switched off in the app, and their results count as outside text. A tool can also be a scheduled job's [gate](#gates). Without bubblewrap there are no self-written tools.

### Writing a tool

`load_extension` tells gaidin to read this section before it drafts, so a draft passes the checks the first time instead of learning each rule from a failure.

Most of the checks are about data from outside, which is where a tool goes wrong: `JSON.parse` returns `any`, and the shortcuts for reading it are what the lint rules refuse. Read only the fields the tool uses, check each one as it comes in, and build a value of a named type from them. This passes every check:

```ts
type Current = { temperature: number; code: number };

/** The fields the tool reads from Open-Meteo's answer, checked as they come in. */
function readCurrent(answer: Fetched): Current {
	if (answer.status !== 200) throw new Error(`Open-Meteo answered ${answer.status}`);
	const data: unknown = JSON.parse(answer.text);
	if (typeof data !== "object" || data === null || !("current" in data)) throw new Error("The answer has no current conditions");
	const current = data.current;
	if (typeof current !== "object" || current === null || !("temperature_2m" in current) || !("weather_code" in current)) {
		throw new Error("The current conditions are missing a field");
	}
	const temperature = current.temperature_2m;
	const code = current.weather_code;
	if (typeof temperature !== "number" || typeof code !== "number") throw new Error("A current condition isn't a number");
	return { temperature, code };
}
```

An `in` check lets TypeScript read the property, and a `typeof` check gives it its type. For a list, check `Array.isArray(value)` and check the items you use; before taking `list[0]`, check the list isn't empty. `Fetched` and `ToolApi` are types from `"gaidin"`, beside `Tool`.

What the lint rules refuse, and what to write instead:

| Refused | Instead |
|---|---|
| `Record<string, unknown>`, `{ [key: string]: unknown }`, or a dictionary of `any` or `object` | `unknown` and `in` checks as above, or a named type with the fields the tool uses |
| `x as Forecast` with no comment | the checks above. An `as` passes lint with a `// SAFETY:` comment just before it saying why it holds, but the reviewer objects to one on outside data |
| `x as unknown as Forecast` | the checks above |
| `Reflect.get(obj, "key")`, `Reflect.apply` | `"key" in obj` and then `obj.key`; call functions directly |
| `{ ...(unit ? { unit } : {}) }` | build the object, then `if (unit) result.unit = unit;` |
| an explicit anonymous type on a value or return, like `function f(): { temp: number }` | leave the type to inference, use `satisfies`, or name the type (`type Current = ...`) |
| a name containing "shape" | a name for what it is: `Forecast`, `readCurrent` |
| `vi.mock`, `jest.mock` | hand the tool a fake: `execute(args, { fetch: async (url) => ({ url, status: 200, contentType: "application/json", text }) })` |

The type check fails on an unused variable, import or parameter, and on unreachable code. A comment that turns any check off is refused before the checks run.

The reviewer asks for the least code that works. Check only the fields the tool reads, not the whole answer; don't write a type and a check that repeat each other; and test the failure path as well as the answer: bad data, and a status other than 200.

## Homelab extension

These two tools were written for the original deployment's homelab. [Extending](extending.md#the-homelab-extension) shows how to turn them on and what they expect.

### homelab_status

Reads the feeds behind a homelab dashboard: an Uptime Kuma public status page (`kuma`) and JSON snapshots of Beszel host metrics, Docker containers and Proxmox backups (`feeds`). None needs a key, and the tool only reads. It lists what needs attention first:

- Kuma monitors that aren't up
- stopped or unhealthy containers, and Docker hosts the collector can't reach
- hosts down in Beszel, disks at 85% (critical at 95%), memory at 90%, temperatures at 80 °C
- a failed backup run, a disabled job, offline or 85%-full backup storage, guests last backed up 26 hours ago (critical at 50)
- snapshots that have gone stale

A feed that's down is reported and the rest are still read. `details: true` adds every monitor, host, container and backup. The same checks are a scheduled job's `homelab` [gate](#gates).

### container_logs

Lists the containers on the hosts in `logHosts`, or returns one container's latest lines (default 200, at most 2,000), oldest first with timestamps, optionally only those newer than `since` (`30m`, `6h`, `2d`). Without `host` it finds the container's host itself.

The server connects over SSH to an account on each host whose key can only run a script that lists containers or prints a container's logs ([Security](security.md#container-logs)). Lines are labelled as other programs' text, terminal colour codes are removed, and values that look like secrets are scrubbed. Without `logHosts`, or without the `docker-logs` key in the keys directory, the tool doesn't exist.
