# Security

gaidin has one owner. The model reads text the owner didn't write: web pages, logs, files in projects. Any of it can contain instructions, so assume the model can be steered. The design keeps a steered model away from the server's keys and the local network, and makes anything that reaches outside its own machine wait for the owner.

The transcript is kept forever, compaction included, so anything a tool returns is stored for good.

## Redaction

`src/redact.ts` keeps the server's own secrets (the API key, the ntfy URL and token, the two Slack tokens, the search key and the Web Push private key) out of tools and the transcript:

- Shell commands can't read the settings file and don't inherit those values' environment variables.
- Shell output is redacted as it streams, holding back a few characters so a value split across two chunks is still caught. The live output, the stored result and the partial result saved after a crash are all clean.
- An `afterTool` hook redacts every tool's final result, so a file tool reading `/proc/self/environ` gets `[redacted NAME]` too.
- The bare ntfy topic name is redacted as well as its URL. Values under 8 characters aren't matched.

It matches the values as they are, so an encoded copy would get through. The sandbox is what prevents that: the shell can't see the server's environment or reach the network. A new secret needs adding to `secretsOf` in `config.ts`, and its variable to `SECRET_NAMES`.

## The sandbox

`src/sandbox.ts` confines the agent's own coding tools to the sandbox directory.

Shell commands run under bubblewrap. The sandbox is the only writable directory; `/usr`, `/etc` and `/opt` are read-only, and nothing else is mounted, so the data directory, the SQLite file, the Unix socket and the app's code aren't there. Commands get their own process tree, which hides the server's `/proc/<pid>/environ`, and no network, which keeps them off the web view's loopback port and the LAN. Background processes end with the command.

The file tools run inside the server, so each path is resolved through its symlinks and refused if it lands outside the sandbox. Commands share a lock that each file operation takes alone, and nothing in the sandbox outlives its command, so no command can swap a directory for a symlink between a file tool's check and its use. A long command makes file tools in other conversations wait for it.

The server won't start without `bwrap` on PATH unless `GAIDIN_SANDBOX=none` is set, which runs commands unconfined. On Ubuntu 24.04, bubblewrap needs `deploy/vm/bwrap.apparmor` to create user namespaces.

The VM's systemd unit adds a layer around the server itself: the app checkout is read-only, the deploy key's directory is hidden, and only the gaidin home is writable.

## Self-written tools

Tools gaidin writes for itself ([Tools](tools.md#self-written-tools)) never run in the server process, where they could read the settings and send the keys anywhere. `src/self/` runs each extension in its own bubblewrap box: no network, its own process tree, no environment variables, the settings file covered, nothing writable but its own `/tmp`, and nothing of the app's mounted but `src/self/` and the extension's approved copy, read-only. The server reads only JSON messages from it, on a channel of their own. The checks before approval run in the same kind of box, with the app's `node_modules` added read-only.

The draft is copied out of the sandbox through the sandbox's own file operations, so a symlink can't pull in a file from outside. The approved copy lives outside the sandbox, so gaidin can't change running code without asking again.

## Network access

The sandbox has none. The server reaches the network for `fetch_url`, the homelab tools, the workspaces, Slack, ntfy, the push services and the model provider. `fetch_url` refuses every private, CGNAT, loopback, link-local and reserved address, checked at connect time and after each redirect ([Tools](tools.md#fetch_url)).

A URL can carry data out in its path or query, which is why a fetch to a new host asks first. Redirects are followed only on the same host, so an open redirect on a host you've allowed can't carry a URL on to one you haven't.

## Approvals

`src/approvals.ts` makes some tool calls wait for the owner. A `beforeTool` hook asks the policy (`defaultPolicy`) whether a call needs approval; if it does, it opens a request and waits for an answer from Slack or the web view.

| Tool | Asks | The second button |
|---|---|---|
| `fetch_url` | for a host not allowed for good | always allow that host |
| `workspace_*` | every call | allow that workspace for an hour, in that conversation only |
| `schedule_job` | every new job | none |
| `remember`, `update_memory` | when the run has read outside text since the owner's last message | none |

A request shows all of what it allows. What doesn't fit its one line goes under "all of it" in the web view, and up to about 2,600 characters of it in Slack, which says where it's cut: a long command or job instruction in full, the content a workspace write puts in a file, each edit's old and new text, and a self-written extension's diff. A note is shown as it will be stored, with its spaces collapsed. A request waits up to `approvals.waitHours` (7 days by default); the run is stored meanwhile and costs nothing. Deny, no answer in time, Stop, or a new message from the owner in that conversation blocks the call, and the model is told which. A new message closes the request as skipped, so the owner never has to answer an old request before saying something else. The request id comes from a memo on the tool task, so after a restart the same call waits on the same request without asking again. Only the configured Slack user's presses in the configured channel count, and the web view only answers its configured login. Requests, always-allowed hosts and hour grants are stored in a session document and survive restarts.

Before the policy is asked, the hook checks whether the call can succeed at all, and blocks it with the reason if not, so the owner is never asked to allow something that would fail: a job with a schedule it can't keep, a gate that doesn't exist or no room for another, a note that wouldn't fit or a note id that doesn't exist, and a workspace that isn't in the settings. These checks (`Refusal` in `approvals.ts`, one per area) run again after an approval, because the answer can come days later: an approval allows a call, but not one that has become impossible since, such as a job approved after another took the last of the 20 places. If a check throws, the call is blocked.

Each request's outcome (allowed once or always, denied, answered, no answer in time, stopped, skipped) and where it was given is also written into its conversation as an entry the model doesn't see. The web view's `/timeline` lists these outcomes with the tool calls, job reports and reminders around them, from the transcript index ([Tools](tools.md#past-conversations)), so the record outlives the request, which is dropped a week after it's decided. The timeline leaves out the sandbox's coding tools and the tools that only read gaidin's own state.

The policy can also see which tools that return outside text (`UNTRUSTED_TOOLS`: `fetch_url`, `web_search`, `container_logs`, `workspace_read`, `workspace_run`) the run has used since the owner's last message, plus self-written tools and, in a job run a [gate](tools.md#gates) woke, what the gate found; memory writes use that. A tool that changes anything outside the sandbox should go through this policy ([Extending](extending.md#tools-that-reach-outside)).

## Workspaces

A workspace runs commands as a real user on another machine, so it's the widest access gaidin has. The layers:

- The machine authorizes gaidin's key with `restrict,from="<gaidin's address>",command="~/.local/libexec/gaidin-workspace"`: only from gaidin, no shell, PTY or forwarding, and only the helper.
- The helper is installed outside the project roots, so nothing gaidin runs can change it. It accepts four operations and checks every path.
- Commands run under bubblewrap with the configured roots writable and the network on. Secret files (`.env*`, `.envrc`, `.netrc`, `.npmrc`, `credentials*`, `*.pem`, `*.key`, SSH keys and similar, matched by name) are masked. Every repository's `.git/config` and `.git/hooks` are read-only, since a change to either runs code the next time the user runs git and a diff wouldn't show it. Tools under the home, like a Node install, are mounted read-only. The rest of the home isn't there, so no SSH keys or tokens.
- The file operations refuse paths outside the roots, secret files and anything inside `.git`, after resolving symlinks, under the same kind of lock as the sandbox.
- Every call needs approval.

What gaidin changes in a project can still run later as the user: a script in `package.json`, a test, an alias in tracked files. Approvals and `git diff` are the check on that. Secret files are recognised by name only.

## Container logs

The homelab extension's `container_logs` reads Docker logs through a dedicated account on each host. Its key works only from gaidin's address, can't open a shell or forward ports, and runs a root script that lists containers or prints logs for a container that exists, rejecting any other argument. Its only sudo right is that script. The key lives outside the sandbox. Secret-looking values (`password=`, tokens, bearer headers, passwords in URLs, JWTs) are scrubbed from the output, which is a heuristic and misses unlabelled secrets.

## The web view and the socket

The web view trusts the identity header Tailscale Serve adds, and listens only on loopback so nothing else can supply that header from the network. A site open in the owner's browser can make requests with that identity too, so a post must be JSON from the page's own origin, and every response forbids framing (`frame-ancestors 'none'`), so another site can't put the page under its own and trick a click onto Allow. Its Content-Security-Policy runs only the page's own script, a second layer behind the Markdown renderer, which builds elements and never HTML. Anything else on the server running as the service's user can reach the loopback port and the Unix socket, the same access the CLI has. The agent's shell can't: it has no network and doesn't see the data directory.

## Known gaps

- A host you've always allowed for `fetch_url` can still receive data in a URL without asking, and a `web_search` query reaches the search backend without asking.
- Redaction and log scrubbing match known values and labelled patterns; they won't catch everything.
- Workspace secret masking goes by file name.
- Anything gaidin writes into a project can run later as you.
- The tools that don't ask (sandbox, reminders, homelab reads) can still be steered: a manipulated model could set reminders or fill the sandbox. Any steered run also spends money, which the [spend limits](deploy.md#spend-limits) cap.
- A note the owner approves, or one written before any outside text was read, goes into every later prompt. The web view shows them all, and deleting one takes it out.
- A self-written tool's fetch to a host you've always allowed can carry data in its URL without asking, as `fetch_url` can.
- A job's gate runs without asking at every check. The homelab gate only reads the monitoring feeds; a self-written gate fetches only from hosts you've allowed for good, with whatever arguments the approved job gave it.
- Alert text comes from monitoring systems, and the run that investigates it has only read-only tools, so it can't write notes, set reminders or jobs, use a workspace or load tools. Its `fetch_url` calls still ask for a new host.
- An approved job runs its instruction later with the tools of an ordinary run. Its own calls to workspaces or new hosts still ask, but the instruction itself isn't checked again.
- A job's runs see its last three reports, which can repeat text an earlier run read from outside. They're labelled as gaidin's own earlier answers, not instructions.

## Rules

- Mark a tool `replay: "safe"` only when running it again after a crash is harmless.
- Keep a new secret in the settings and add it to `secretsOf`, so it's redacted.
- A tool that reads text from outside labels it as such in its result.
- A tool that changes things outside the sandbox asks first.
