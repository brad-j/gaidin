# Security

gaidin has one owner. The model reads text the owner didn't write: web pages, logs, files in projects. Any of it can contain instructions, so assume the model can be steered. The design keeps a steered model away from the server's keys and the local network, and makes anything that reaches outside its own machine wait for the owner.

The transcript is kept forever, compaction included, so anything a tool returns is stored for good.

## Redaction

`src/redact.ts` keeps the server's own secrets (the API key, the ntfy URL and token, and the two Slack tokens) out of tools and the transcript:

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

## Network access

The sandbox has none. The server reaches the network for `fetch_url`, the homelab tools, the workspaces, Slack, ntfy and the model provider. `fetch_url` refuses every private, CGNAT, loopback, link-local and reserved address, checked at connect time and after each redirect ([Tools](tools.md#fetch_url)).

A URL can carry data out in its path or query, which is why a fetch to a new host asks first.

## Approvals

`src/approvals.ts` makes some tool calls wait for the owner. A `beforeTool` hook asks the policy (`defaultPolicy`) whether a call needs approval; if it does, it opens a request and waits for an answer from Slack or the web view.

| Tool | Asks | The second button |
|---|---|---|
| `fetch_url` | for a host not allowed for good | always allow that host |
| `workspace_*` | every call | allow that workspace for an hour, in that conversation only |
| `schedule_job` | every new job | none |
| `remember`, `update_memory` | when the run has read outside text since the owner's last message | none |

Deny, no answer within 30 minutes, or Stop blocks the call, and the model is told which. The request id comes from a memo on the tool task, so after a restart the same call waits on the same request without asking again. Only the configured Slack user's presses in the configured channel count, and the web view only answers its configured login. Requests, always-allowed hosts and hour grants are stored in a session document and survive restarts.

The policy can also see which tools that return outside text (`UNTRUSTED_TOOLS`: `fetch_url`, `container_logs`, `workspace_read`, `workspace_run`) the run has used since the owner's last message; memory writes use that. A tool that changes anything outside the sandbox should go through this policy ([Extending](extending.md#tools-that-reach-outside)).

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

The web view trusts the identity header Tailscale Serve adds, and listens only on loopback so nothing else can supply that header from the network. Anything else on the server running as the service's user can reach the loopback port and the Unix socket, the same access the CLI has. The agent's shell can't: it has no network and doesn't see the data directory.

## Known gaps

- A host you've always allowed for `fetch_url` can still receive data in a URL without asking.
- Redaction and log scrubbing match known values and labelled patterns; they won't catch everything.
- Workspace secret masking goes by file name.
- Anything gaidin writes into a project can run later as you.
- The tools that don't ask (sandbox, reminders, homelab reads) can still be steered: a manipulated model could set reminders or fill the sandbox.
- A note the owner approves, or one written before any outside text was read, goes into every later prompt. The web view shows them all, and deleting one takes it out.
- An approved job runs its instruction later with the tools of an ordinary run. Its own calls to workspaces or new hosts still ask, but the instruction itself isn't checked again.

## Rules

- Mark a tool `replay: "safe"` only when running it again after a crash is harmless.
- Keep a new secret in the settings and add it to `secretsOf`, so it's redacted.
- A tool that reads text from outside labels it as such in its result.
- A tool that changes things outside the sandbox asks first.
