# Security

gaidin has one owner. The model reads text the owner didn't write: web pages, logs, files in projects. Any of it can contain instructions, so assume the model can be steered. The design keeps a steered model away from the server's keys and the local network, and makes anything that reaches outside its own machine wait for the owner.

The transcript is kept forever, compaction included, so anything a tool returns is stored for good.

## Redaction

`src/redact.ts` keeps the server's own secrets (the API key, the ntfy URL and token, the two Slack tokens, the search key and the Web Push private key) out of tools and the transcript:

- Shell commands can't read the settings file, or anything else in `/etc/gaidin`, such as an editor's backup of it, and don't inherit those values' environment variables.
- Shell output is redacted as it streams, holding back a few characters so a value split across two chunks is still caught. The live output, the stored result and the partial result saved after a crash are all clean.
- An `afterTool` hook redacts every tool's final result, so a file tool reading `/proc/self/environ` gets `[redacted NAME]` too.
- The bare ntfy topic name is redacted as well as its URL. Values under 8 characters aren't matched.

It matches the values as they are, so an encoded copy would get through. The sandbox is what prevents that: the shell can't see the server's environment or reach the network. A new secret needs adding to `secretsOf` in `config.ts`, and its variable to `SECRET_NAMES`.

## The sandbox

`src/sandbox.ts` confines the agent's own coding tools to the sandbox directory.

Shell commands run under bubblewrap. The sandbox is the only writable directory; `/usr`, `/etc` and `/opt` are read-only, and nothing else is mounted, so the data directory, the SQLite file, the Unix socket and the app's code aren't there. Commands get their own process tree, which hides the server's `/proc/<pid>/environ`, and no network, which keeps them off the app's loopback port and the LAN. Background processes end with the command.

Three directories in the sandbox are written by the server while commands run: `.tmp`, where a long command's full output goes, `uploads`, where files sent in Slack, from the app or by another agent go, and `downloads`, where the browser's downloads go. Commands see them read-only, so none can swap one for a symlink that would carry the server's writes outside the sandbox, and before each command the server replaces anything left in their place with a real directory. A file in a Slack message is downloaded with the bot token, so the server sends it only to `https://files.slack.com`, whatever URL the event names.

The file tools run inside the server, so each path is resolved through its symlinks and refused if it lands outside the sandbox. Commands share a lock that each file operation takes alone, and nothing in the sandbox outlives its command, so no command can swap a directory for a symlink between a file tool's check and its use. A long command makes file tools in other conversations wait for it.

The server won't start without `bwrap` on PATH unless `GAIDIN_SANDBOX=none` is set, which runs commands unconfined. On Ubuntu 24.04, bubblewrap needs `deploy/vm/bwrap.apparmor` to create user namespaces.

The VM's systemd unit adds a layer around the server itself: the app checkout is read-only, the deploy key's directory is hidden, and only the gaidin home is writable.

## Self-written tools

Tools gaidin writes for itself ([Tools](tools.md#self-written-tools)) never run in the server process, where they could read the settings and send the keys anywhere. `src/self/` runs each extension in its own bubblewrap box: no network, its own process tree, no environment variables, the settings file and `/etc/gaidin` covered, nothing writable but its own `/tmp`, and nothing of the app's mounted but `src/self/` and the extension's approved copy, read-only. The server reads only JSON messages from it, on a channel of their own. The checks before approval run in the same kind of box, with the app's `node_modules` added read-only.

The draft is copied out of the sandbox through the sandbox's own file operations, so a symlink can't pull in a file from outside. The approved copy lives outside the sandbox, so gaidin can't change running code without asking again.

## Skills

A [skill](tools.md#skills) is instructions gaidin follows when a request matches it, so it's trusted as much as the system prompt. Skills come only from the app's `docs/` and from `skills/` in the data directory. The sandbox can't see either. The owner changes local skills from the app; gaidin's only way to change one is `write_skill` or `remove_skill`, which always ask the owner first and show the lines added and removed, whatever the conversation has read. The built-in skill can't be changed by either. A write goes only to a plain file inside the skill's directory: the path is checked part by part, and nothing on the way may be a link. `read_skill` opens only the files a skill had when the list was last read, each checked again on every read so that one swapped for a link out of the skill is refused. A skill's text isn't outside text, so reading one doesn't make memory writes ask.

## Agents

[Agents](concepts.md#agents) share one server process, so what keeps them apart is the server's rules, which a steered model can't change:

- Each agent's coding tools are confined to its own sandbox, with a lock of its own. Under bubblewrap a command sees only that directory, so no agent's shell can read another's files; the default agent's sandbox doesn't contain the others'. The file tools resolve every path and refuse one outside the agent's sandbox.
- Work notes, reminders, jobs and past conversations are filtered by the calling conversation's agent, which the server records when it creates the conversation and the model can't name or change.
- Hosts allowed for good, workspaces, browser profiles, connectors and self-written tools are granted per agent. "Always allow" grants the host to the agent that asked. A workspace, browser profile, connector or self-written tool an agent wasn't given is refused before anyone is asked.
- `message_agent` and `hand_off` reach only the agents the sender's roster entry lists; anything else is refused. The receiver's conversation starts with a marker the approvals hook treats as outside text, so its note writes and cancels ask, and the answer that comes back is outside text to the sender. Either call asks while outside text is in the sender's context, so a page can't pass work to an agent allowed more than the one that read it, and the request names any files it carries. Files are read through the sender's file tools, so only its own sandbox's can go, and land read-only in the receiver's `uploads/`; nothing else of either sandbox is shared. A chain stops at three.

What they share: the shared notes, which reach every agent's prompt; a browser profile's sign-ins, among the agents given it; the skills; the spend limits; and the server's own access, such as Slack and the push services. Approval requests name the agent they come from.

## Network access

The sandbox has none. The server reaches the network for `fetch_url`, the browser, the homelab tools, the workspaces, Slack, ntfy, the push services and the model provider. `fetch_url` refuses every private, CGNAT, loopback, link-local and reserved address, checked at connect time and after each redirect ([Tools](tools.md#fetch_url)).

A URL can carry data out in its path or query, which is why a fetch to a new host asks first. A URL `web_search` returned in the same conversation doesn't ask: the backend chose it, and the model couldn't put anything in it. The guard reads those URLs from the search results' details, which only `web_search` writes and the model never sees, not from their text, so a URL a snippet mentions still asks. Links in a fetched page ask too, since a page can list many and tell the model which to pick. Redirects are followed only on the same host, so an open redirect on a host you've allowed can't carry a URL on to one you haven't.

## Approvals

`src/approvals.ts` makes some tool calls wait for the owner. Each tool's rules are its guard (`src/guards.ts`), declared by the module that owns the tool. A `beforeTool` hook asks the call's guard whether it needs approval; if it does, it opens a request and waits for an answer from Slack or the app. A call whose arguments its guard can't read asks too, showing all of them.

| Tool | Asks | The second button |
|---|---|---|
| `fetch_url` | for a host not allowed for good for the agent, unless `web_search` returned the URL in that conversation | always allow that host, for that agent |
| `browser_open` | for a host not allowed for good for the agent, unless `web_search` returned the URL in that conversation; refused for a profile the agent wasn't given | always allow that host, for that agent |
| `browser_click`, `browser_type`, `browser_select` | while outside text is in the conversation's context, unless the agent acts on that site in that profile without asking; typing into a password field is refused | act on that site without asking, for that agent and profile |
| `browser_upload` | every call, naming the files | none |
| `browser_hand_over` | it is the request: Done or Can't | none |
| a connector's tool | every call when you set it to ask; never when it's allow; refused when it's off, new or changed since you set it, or for an agent not given the connector | none |
| `workspace_*` | every call | allow that workspace for an hour, in that conversation only |
| `schedule_job` | every new job | none |
| `remember`, `update_memory` | while outside text is in the conversation's context | none |
| `forget`, `cancel_job`, `cancel_reminder` | while outside text is in the conversation's context, naming the note, job or reminder | none |
| `message_agent`, `hand_off` | while outside text is in the conversation's context; refused for an agent the roster entry doesn't list | none |
| `load_extension`, `remove_extension` | every call, from inside the tool; loading shows the diff | none |
| a self-written tool's fetch | from inside the tool, for a host not allowed for good for the calling agent, a redirect's included | always allow that host, for that agent |

A request shows all of what it allows. What doesn't fit its one line goes under "all of it" in the app, and up to about 2,600 characters of it in Slack, which says where it's cut: a long command or job instruction in full, the content a workspace write puts in a file, each edit's old and new text, and a self-written extension's diff. A note is shown as it will be stored, with its spaces collapsed. A request waits up to `approvals.waitHours` (7 days by default); the run is stored meanwhile and costs nothing. Deny, no answer in time, Stop, or a new message from the owner in that conversation blocks the call, and the model is told which. A new message closes the request as skipped, so the owner never has to answer an old request before saying something else. The request id comes from a memo on the tool task, so after a restart the same call waits on the same request without asking again. Only the configured Slack user's presses in an agent's channel count, and the app only answers its configured login. Requests, always-allowed hosts and hour grants are stored in a session document and survive restarts.

Before the guard is asked, the hook checks whether the call can succeed at all, and blocks it with the reason if not, so the owner is never asked to allow something that would fail: a job with a schedule it can't keep, a gate that doesn't exist or no room for another, a note that wouldn't fit or a note id that doesn't exist, and a workspace that isn't in the settings. These checks (each guard's `refuse`) run again after an approval, because the answer can come days later: an approval allows a call, but not one that has become impossible since, such as a job approved after another took the last of the 20 places. If a check throws, the call is blocked.

Each request's outcome (allowed once or always, denied, answered, no answer in time, stopped, skipped) and where it was given is also written into its conversation as an entry the model doesn't see. The app's `/timeline` lists these outcomes with the tool calls, job reports and reminders around them, from the transcript index ([Tools](tools.md#past-conversations)), so the record outlives the request, which is dropped a week after it's decided. The timeline leaves out the sandbox's coding tools and the tools that only read gaidin's own state.

A guard can also see which tools that return outside text (those whose guards say `outside`: `fetch_url`, `web_search`, the browser's tools, every connector's tools, `container_logs`, `workspace_read`, `workspace_run`, every self-written tool, `search_history` and `read_history`, whose past answers can repeat any of those, and `message_agent`, whose answer is another agent's) have results in the conversation's context, whether another agent started the conversation, and, in a job run a [gate](tools.md#gates) woke, what the gate found; the memory, cancel and messaging tools use that. A built-in tool counts even when it's switched off or not set up, since its past results can still be in the context. It's the whole context, not just the current run: text the model has read can steer it for as long as it's there, whatever the owner says in between. If the context can't be read, that counts as outside text too. A tool that changes anything outside the sandbox should have a guard ([Extending](extending.md#tools-that-reach-outside)).

## Workspaces

A workspace runs commands as a real user on another machine, so it's the widest access gaidin has. The layers:

- The machine authorizes gaidin's key with `restrict,from="<gaidin's address>",command="~/.local/libexec/gaidin-workspace"`: only from gaidin, no shell, PTY or forwarding, and only the helper.
- The helper is installed outside the project roots, so nothing gaidin runs can change it. It accepts four operations and checks every path. Both the installer and the helper refuse a root that holds `~/.ssh`, the helper's own directory or its config, since a command could then give gaidin a shell or loosen its own limits.
- Commands run under bubblewrap with the configured roots writable and the network on. Secret files (`.env*`, `.envrc`, `.netrc`, `.npmrc`, `credentials*`, `*.pem`, `*.key`, SSH keys and similar, matched by name) are masked. Every repository's git config and hooks are read-only, its submodules' and worktrees' included, since a change to either runs code the next time the user runs git and a diff wouldn't show it. A repository without a hooks directory gets an empty one, so a command can't add it. A repository a command creates isn't protected; nothing in it runs unless the user runs git there. Tools under the home, like a Node install, are mounted read-only. The rest of the home isn't there, so no SSH keys or tokens.
- The file operations refuse paths outside the roots, secret files and anything inside `.git`, after resolving symlinks, under the same kind of lock as the sandbox.
- Every call needs approval.

What gaidin changes in a project can still run later as the user: a script in `package.json`, a test, an alias in tracked files. Approvals and `git diff` are the check on that. Secret files are recognised by name only.

## The browser

A browser profile holds live sign-ins, so the browser is checked in these layers:

- Its directory, `<data>/browser/<profile>/`, is outside every sandbox, so no agent's commands can read its cookies. The VM's nightly backup holds them, though, so treat those backups as secrets.
- Only agents whose roster entry lists a profile can use it; a call with another is refused, and an agent without one isn't offered the tools.
- Chromium keeps its own sandbox, with the renderers in their own user and PID namespaces under seccomp; it's never started with `--no-sandbox`. It runs as the service's user under the unit's limits rather than in bubblewrap, since it needs the network. On Ubuntu 24.04 its sandbox needs `deploy/vm/chromium.apparmor`, which `setup.sh` installs with Chromium in `/opt/gaidin/browsers`, a directory only root can change, because that profile lets the binary it names make user namespaces. `gaidin doctor` starts Chromium to check.
- Opening a page asks as a fetch does. Every request a page makes is routed through the server first: one to a private, CGNAT, loopback, link-local or reserved address is refused, so a page can't reach your LAN, your tailnet or gaidin's own port, and a navigation of the page itself to a host that isn't its own or allowed for good is stopped. Routing turns off Chromium's HTTP cache.
- What a page shows is outside text, labelled as from the web and redacted like any result, so note writes and cancels after it ask, and so do clicks, typing and choosing, until you let the agent act on a site without asking. That's per agent, profile and site, and removable on the settings page.
- An approved action happens only if the page is still on the site and the ref still the element the request named, since an answer can come days later and another conversation can use the profile meanwhile.
- The model never types a password: `browser_type` refuses a field whose type or autocomplete says password, before anyone is asked and again before typing. A page that needs signing in is yours to sign in to, by taking the profile over in the app.
- Taking over goes through the app's own checks: the Tailscale login; for the live view, which takes the profile over as it opens, a refusal of any request a browser marks as made by another site (`Sec-Fetch-Site`); and for your input and navigation, a JSON POST from the app's origin. Your input goes to the page and isn't stored or shown to a model. While you hold a profile its pages go anywhere public, since they're yours, and every agent's call on it waits; when you let go, the refs from before are dropped and the pages are held to no host until an agent's call sets them again, so nothing you opened lets an agent act there without asking.
- An upload sends files from the agent's own sandbox only, read through its file tools, and asks every time, naming them. A download lands in the agent's `downloads/`, which its commands see read-only, so none can swap it for a symlink that carries the server's write elsewhere.

## Connectors

A [connector](tools.md#connectors) is a remote service's MCP server, so what its tools do happens at that service with whatever its token allows:

- Its tools go only to agents whose roster entry lists it, and its extension is selected only in their homes; a call from any other agent is refused.
- You set each tool to allow, ask or off. The server's read-only hint only sets the default, and only for a tool you haven't set.
- The tools' descriptions are the server's text, which reaches the model, so each is pinned by a hash of its definition; one that's new or changed since you set it is off until you set it again.
- What a tool returns is outside text, so note writes and cancels after it ask.
- Its tokens, a pasted one or OAuth's access and refresh tokens, are kept in `<data>/connectors/vault.json` (mode 600, in a directory only the server can enter), outside every sandbox and the database, and redacted from tool output. The VM's backups hold them.
- The connector's own URL is your choice, so it may be on the LAN. Every other URL a server names, its metadata, authorization server and endpoints, must be on the connector's own host or https on a public address, so a server can't send gaidin's requests into your LAN. An authorization server's metadata must name the issuer it was looked up as, and offer PKCE with S256.
- Signing in is in your browser, never through a model. gaidin keeps each sign-in's PKCE verifier, state and expected issuer for 10 minutes; the callback, behind the Tailscale login like every route, takes only a state gaidin made, once, and refuses an answer from another issuer.

## Container logs

The homelab extension's `container_logs` reads Docker logs through a dedicated account on each host. Its key works only from gaidin's address, can't open a shell or forward ports, and runs a root script that lists containers or prints logs for a container that exists, rejecting any other argument. Its only sudo right is that script. The key lives outside the sandbox. Secret-looking values (`password=`, tokens, bearer headers, passwords in URLs, JWTs) are scrubbed from the output, which is a heuristic and misses unlabelled secrets.

## The app and the socket

The app trusts the identity header Tailscale Serve adds, and listens only on loopback so nothing else can supply that header from the network. A site open in the owner's browser can make requests with that identity too, so a post must be JSON from the page's own origin, and every response forbids framing (`frame-ancestors 'none'`), so another site can't put the page under its own and trick a click onto Allow. Its Content-Security-Policy runs only the page's own script, a second layer behind the Markdown renderer, which builds elements and never HTML. Anything else on the server running as the service's user can reach the loopback port and the Unix socket, the same access the CLI has. The agent's shell can't: it has no network and doesn't see the data directory.

## Known gaps

- A host you've always allowed for `fetch_url` can still receive data in a URL without asking, and a `web_search` query reaches the search backend without asking.
- A fetch of a URL `web_search` returned doesn't ask. An injected snippet can steer which result the model fetches, so a few bits of the conversation could leave through that choice.
- Redaction and log scrubbing match known values and labelled patterns; they won't catch everything.
- Workspace secret masking goes by file name.
- Anything gaidin writes into a project can run later as you.
- The tools that don't ask (sandbox, reminders, homelab reads) can still be steered: a manipulated model could set reminders or fill the sandbox. Any steered run also spends money, which the [spend limits](deploy.md#spend-limits) cap.
- A note the owner approves, or one written before any outside text was read, goes into every later prompt. Once compaction summarises a conversation, its summary can carry what a page said, and note writes stop asking until outside text is read again. The app shows them all, and deleting one takes it out.
- A self-written tool's fetch to a host you've always allowed can carry data in its URL without asking, as `fetch_url` can.
- A job's gate runs without asking at every check. The homelab gate only reads the monitoring feeds; a self-written gate fetches only from hosts you've allowed for good, with whatever arguments the approved job gave it.
- Alert text comes from monitoring systems, and the run that investigates it has only read-only tools, so it can't write notes, set reminders or jobs, use a workspace or load tools. Its `fetch_url` calls still ask for a new host. Whoever can post to the alert topic can start investigations, each a model run, and shape what the report says, so on ntfy.sh the topic should need a token (`alerts.token`); the settings warn when it doesn't. The same goes for reading the reminder topic, which carries reminders and job reports.
- An approved job runs its instruction later with the tools of an ordinary run. Its own calls to workspaces or new hosts still ask, but the instruction itself isn't checked again.
- A job's runs see its last three reports, which can repeat text an earlier run read from outside. They're labelled as gaidin's own earlier answers, not instructions.
- Agents are kept apart by the server's rules, not by separate processes or users: a flaw in those rules, or `GAIDIN_SANDBOX=none`, which runs every agent's commands unconfined, would let one reach another's files.
- A shared note reaches every agent's prompt. One written after compaction has summarised outside text away doesn't ask, as with any note, and then reaches all of them.
- An agent given a browser profile can read anything the profile is signed in to, and with your approval of each action, or none on a site it may act on without asking, do what those sites allow. Giving an agent a profile is the real decision.
- On a site an agent acts on without asking, a page there can steer what it clicks and types there, including typing text from the conversation into a form.
- A file the browser downloads is read with the sandbox's file tools, which don't count as outside text. The page that offered it already does, until compaction summarises it away.
- A password field is recognised by its `type` and `autocomplete` attributes; a page that hides one behind a plain text field isn't caught.
- The live view's frames show whatever the signed-in page shows, to any device with your Tailscale login, as the conversations do.
- A sign-in you make while taking a profile over is then usable by every agent given that profile, which is the point of it, and by nothing else.
- A page can send what it shows, or what's in its own storage, to its own servers, and its scripts and images go to any public host; only its own navigations are checked. A page on a host you've allowed for good can steer what the agent reads there.
- The browser's address check resolves a name itself, before Chromium does, so a second DNS answer could still point Chromium at a private address. WebSockets aren't routed and aren't checked.
- A page that exploited Chromium would run as gaidin's user, outside bubblewrap, with Chromium's own sandbox the only layer between it and gaidin's data.
- A connector tool set to allow does what it does without asking, and a server's read-only hint is only its word. A tool's result can steer the agent, and on an allowed tool that writes, nothing checks what it's steered to do.
- Pinning catches a changed description, not a server that behaves differently behind the same one.
- A connector's token can do whatever the service's grant allows, from the VM, until you revoke it at the service.
- An agent's existing threads and job runs keep the tool selection they started with, so a connector added later is offered there too, to every agent; the guard refuses its calls from agents not given it.
- An agent that may message another can ask it for anything that agent's tools do without asking, such as fetching from a host allowed for that agent alone, as long as no outside text is in the asker's context.

## Rules

- Mark a tool `replay: "safe"` only when running it again after a crash is harmless.
- Keep a new secret in the settings and add it to `secretsOf`, so it's redacted.
- Parse input from outside the process with `parse.ts` where it comes in. A line from a self-written tool's box is outside input: the tool's own code can write to that channel.
- A tool that reads text from outside labels it as such in its result.
- A tool that changes things outside the sandbox asks first.
