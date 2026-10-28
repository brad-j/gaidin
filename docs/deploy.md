# Deploying

gaidin needs Linux, Node 22.18 or later (it runs the TypeScript directly), pnpm, bubblewrap, and an API key for the model. It can run on a workstation, but it's meant to live on a small always-on machine, so reminders fire and Slack gets answered while your desktop is off. It needs no inbound ports: Slack is an outbound connection and the API goes through Tailscale.

## The gaidin command

```sh
gaidin setup                    # write the settings a section at a time, checking each
gaidin serve                    # run the agent and its surfaces
gaidin ask "MESSAGE"            # send a message and print the run; --id ID reattaches
gaidin watch                    # print everything the agent does, until Ctrl+C
gaidin doctor                   # check the settings and everything the server needs
gaidin doctor --push            # the same, and send a test notification through ntfy
gaidin config                   # print the settings in use, secrets shortened
gaidin version                  # print the version and the API protocol; --version does the same
```

From a checkout, `pnpm gaidin ...` runs it, and `pnpm serve`, `pnpm ask`, `pnpm watch` and `pnpm doctor` are shortcuts. On the VM, `install.sh` installs `/usr/local/bin/gaidin`, which runs it as the service's user with the service's settings.

`gaidin doctor` doesn't start the server and spends no tokens. It checks the settings, Node, the data directory, that bubblewrap can start a sandbox, that Chromium starts with its sandbox when there are browser profiles, the API key and model (by looking the model up), the ntfy topic, that the push services can be reached, both Slack tokens and whether agents can post under their own names, the search key and its remaining credits, `tailscale serve`, each workspace, and the homelab feeds and log hosts, and says what to fix.

`gaidin setup` writes the settings file it would read, or `./gaidin.json` when there's none, asking a section at a time: your name and time zone, the model's key and default model with the spend limits, the API's Tailscale login and address (read from `tailscale status` when it's logged in), an ntfy topic with a long random name it makes, and a Tavily key for search. Each section can be skipped, and each is checked as it's entered with the checks `gaidin doctor` uses; a failed check asks again or keeps the answer. Run again, it shows each section with secrets shortened and changes only the sections you choose, keeping everything it doesn't ask about, Slack's settings among them. It doesn't echo secrets as you type and never prints one whole, except the ntfy topic it makes, shown once so you can subscribe to it. Nothing is written until the end. A new file is readable only by you, and a rewritten one keeps its mode and owner. It ends by running `gaidin doctor`. It has to be able to write the file's directory. On the VM, run it as root (`sudo gaidin setup`): it works on a copy as the service's user, so its checks see what the service will, and installs the copy as `/etc/gaidin/config.json` at the end, restarting the service if it's running and doctor found nothing wrong.

## Running it locally

```sh
pnpm install
pnpm gaidin setup     # writes gaidin.json, then runs gaidin doctor
pnpm serve
```

`gaidin.json` in the checkout is gitignored, and `deploy/config.example.json` shows every section, for writing it by hand. `deploy/gaidin.service` is a systemd user unit for running it this way in the background; edit its paths first. User units stop when you log out unless lingering is on (`loginctl enable-linger`).

## Running it on a VM

`deploy/install.sh` sets gaidin up as a system service on Ubuntu 24.04 or Debian 12, on x86-64. The original deployment uses a VM with 2 vCPUs and 4 GB of memory. The server itself uses around 120 MB; the [browser](tools.md#browser) adds about 250 MB per open profile on a busy page, and up to two are open at once.

1. Create the VM. Install Tailscale on it and log in (`tailscale up`), so the API can be served; without it, gaidin still runs, reached only through Slack and on the VM itself.
2. Download the installer and read it before you run it:
   ```sh
   curl -fsSLO https://raw.githubusercontent.com/brad-j/gaidin/main/deploy/install.sh
   less install.sh
   sudo sh install.sh
   ```
3. The first run ends with `gaidin setup`, which asks for the settings, checks them with `gaidin doctor`, and starts the service when nothing failed. Check it with `journalctl -u gaidin`.

To install from a fork, add `--repo` with its URL. An https URL is cloned as it is; an SSH URL such as `git@github.com:you/gaidin.git`, for a private fork, gets a read-only deploy key: the first run prints it and stops, and once it's in the repository's deploy keys, the next run carries on. Later runs pull from the checkout's own remote.

`install.sh` is safe to rerun and is how you update: `sudo sh /var/lib/gaidin/app/deploy/install.sh`. It installs the packages it needs (git, curl, bubblewrap and `poppler-utils`, for PDFs sent in Slack) when they're missing, and Node from nodejs.org at the version it pins, checked against its SHA-256, with pnpm through Corepack. It pulls, and runs the new copy of itself if the pull changed it. It installs the dependencies, the AppArmor profile bubblewrap needs on Ubuntu, and the browser's Chromium when the settings have a `browser` section (below). It allows memory overcommit (Oxlint, which checks [self-written tools](tools.md#self-written-tools), reserves 4 GiB of address space per thread), writes the unit and the `gaidin` command, creates the workspace key, runs `tailscale serve` for the API when Tailscale is logged in, and restarts the service, keeping the settings. A VM set up by the old `deploy/vm/setup.sh` updates the same way; its Node in `/usr/local/bin` is left in place and no longer used.

On the VM:

| Path | What |
|---|---|
| `/etc/gaidin/config.json` | the settings, with secrets; the sandbox sees `/etc/gaidin` empty |
| `/var/lib/gaidin/app` | the checkout, read-only to the service |
| `/var/lib/gaidin/data` | the [data directory](concepts.md#the-data-directory) |
| `/var/lib/gaidin/keys` | SSH keys for workspaces and container logs, and the workspace list |
| `/var/lib/gaidin/deploy` | the deploy key, hidden from the service |
| `/opt/gaidin/node` | the Node `install.sh` pins, which only root can change |
| `/opt/gaidin/browsers` | the browser's Chromium, which only root can change |

To turn on the [browser](tools.md#browser), add `"browser": { "profiles": ["personal"] }` to the settings and run `install.sh`. It installs the libraries Chromium needs and a font (about 25 packages with `--no-install-recommends`, Mesa among them), Playwright's Chromium headless shell in `/opt/gaidin/browsers` (about 280 MB), and on Ubuntu `deploy/vm/chromium.apparmor`, which lets Chromium keep its own sandbox under Ubuntu's limit on user namespaces. `gaidin doctor` then starts Chromium to check. Give an agent a profile with `gaidin agent set ID --profiles personal`.

Back up the VM or the data directory; the SQLite file is the whole of gaidin's state.

## The model and its key

gaidin uses Claude through an API key, by default `claude-haiku-5-5`. Create the key in its own Claude Console workspace with a spend limit, so a runaway loop stops at the limit even if gaidin's own [spend limits](#spend-limits) miss it. A Claude Max plan includes monthly API credit, claimed under Settings > Billing on claude.ai into a linked Console organization; with auto-reload off, requests stop when the month's credit runs out instead of charging. `POST /api/settings` switches a conversation between the models in `model.choices`.

## Adding a workspace

A workspace needs bubblewrap, python3 and an SSH server that gaidin can reach.

1. On the gaidin server, print its workspace key: `sudo cat /var/lib/gaidin/keys/workspace.pub`.
2. On the machine, as the user gaidin should work as, run the installer from a checkout of this repository, naming the directories gaidin may use:
   ```sh
   deploy/workspace/install.sh --key "<the key>" --from <gaidin's address> ~/projects
   ```
   It installs the helper in `~/.local/libexec`, writes `~/.config/gaidin-workspace/config.json`, and adds the restricted key line to `~/.ssh/authorized_keys`. Fetching the key with `ssh` inside the command avoids a line break slipping in when you paste it.
3. Let gaidin's address reach port 22, for example `sudo ufw allow from <gaidin's address> to any port 22 proto tcp`.
4. On the gaidin server: `sudo sh /var/lib/gaidin/app/deploy/vm/add-workspace.sh NAME USER@HOST`. It pins the machine's host key, prints its fingerprint, tests a read and restarts gaidin. Compare the fingerprint with the machine's own (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`).

To update the helper after pulling, rerun the installer on the machine with the same key, address and roots, or copy it over: `install -m 755 deploy/workspace/gaidin-workspace.py ~/.local/libexec/gaidin-workspace`. Until a workspace's helper is updated, folder-trust rules let nothing through there and its calls ask as before.

The workspace list is `/var/lib/gaidin/keys/workspaces`, one `name user@host` per line. The address has to stay the same, so reserve it in DHCP. To remove a workspace, delete its line there and its key line in the machine's `authorized_keys`.

## Settings

The settings file is JSON: the first of `--config`, `GAIDIN_CONFIG`, `./gaidin.json` and `/etc/gaidin/config.json` that exists. Relative paths in it are relative to the file. Environment variables override it, which suits containers and systemd. `gaidin serve` won't start with a mistake in the settings, such as an unknown key, a token of the wrong kind or only some of Slack's four values; `gaidin doctor` and `gaidin config` show the same errors.

| Setting | Variable | Default | |
|---|---|---|---|
| `owner` | `GAIDIN_OWNER` | `the user` | What gaidin calls you, in its prompt and tool descriptions. |
| `timeZone` | `GAIDIN_TZ` | the system's | For message stamps and reminders. |
| `data` | `GAIDIN_DATA` | `data` | The data directory. |
| `keys` | `GAIDIN_KEYS` | `/var/lib/gaidin/keys` | SSH keys for workspaces and container logs, and the workspace list. |
| `model.apiKey` | `ANTHROPIC_API_KEY` | | Required unless the provider is `faux`. |
| `model.id` | `GAIDIN_MODEL_ID` | `claude-haiku-5-5` | The model new conversations start with. |
| `model.choices` | | Haiku, Sonnet and Opus 5.5 | Models a conversation can switch to. |
| `model.provider` | `GAIDIN_MODEL` | `anthropic` | `faux` runs a scripted model with no key or network, for testing. |
| `ntfy.url` | `NTFY_URL` | | Full topic URL for [notifications](surfaces.md#notifications) through ntfy. Without it and without `web.url`, reminders print to the server's output. |
| `ntfy.token` | `NTFY_TOKEN` | | Access token, if the topic needs one. |
| `alerts.url` | | | An ntfy topic URL that monitoring pushes alerts to. gaidin follows it and investigates what arrives ([Tools](tools.md#alerts)). A secret, like `ntfy.url`. |
| `alerts.token` | | | Access token, if that topic needs one. |
| `ntfy.icon` | | | URL of a PNG or JPEG the ntfy app shows beside each push. The phone fetches it, so it has to be somewhere the phone can reach. |
| `slack.botToken` | `SLACK_BOT_TOKEN` | | `xoxb-` token. All four Slack values or none. |
| `slack.appToken` | `SLACK_APP_TOKEN` | | `xapp-` token with `connections:write`. |
| `slack.channelId` | `SLACK_CHANNEL_ID` | | The default agent's channel. Other agents' channels are in the roster, set with `gaidin agent set --channel`. |
| `slack.userId` | `SLACK_USER_ID` | | The one Slack user it answers. |
| `web.user` | `GAIDIN_WEB_USER` | | Tailscale login allowed into the [API](surfaces.md#the-api). Without it there's no API. |
| `web.port` | `GAIDIN_WEB_PORT` | `8410` | Loopback port for the API. |
| `web.url` | | | The API's address on the tailnet, such as `https://gaidin.<tailnet>.ts.net`. With it, devices can sign up for [Web Push](surfaces.md#web-push), ntfy reminders have buttons to snooze them, and connectors can sign in with OAuth. |
| `sandbox` | `GAIDIN_SANDBOX` | `bwrap` | `none` runs tools without bubblewrap. |
| `search.provider` | | | `tavily`; without it there's no `web_search`. |
| `search.apiKey` | `TAVILY_API_KEY` | | A Tavily key, `tvly-...`. Setting the variable alone also turns search on. |
| `budget.daily` | `GAIDIN_BUDGET_DAILY` | `5` | Dollars a day; 0 is no daily limit. See [Spend limits](#spend-limits). |
| `budget.monthly` | `GAIDIN_BUDGET_MONTHLY` | `0` | Dollars a calendar month; 0 is no monthly limit. |
| `approvals.waitHours` | `GAIDIN_APPROVAL_WAIT_HOURS` | `168` | How long approvals and questions wait, up to 576. |
| `browser.profiles` | | | Names of the [browser](tools.md#browser) profiles agents can be given, such as `["personal"]`: lowercase letters, digits and `-`. Without them there's no browser. |
| `connectors.clientId` | | `<web.url>/api/connectors/client.json` | The https URL of a public copy of gaidin's client id document, for [connector](tools.md#connectors) services on the internet that fetch it. `gaidin connector client-document` prints it. |
| `voice.tokens` | | | The [voice](surfaces.md#voice) bridges: each `{ "name": "...", "token": "...", "agents": ["..."] }`, with a token of at least 32 characters (`openssl rand -base64 32`) and the agents it may talk to, the first the default. Needs `web.user`, since the route is on the API's server. |
| `extensions.homelab` | | off | The [homelab extension](extending.md#the-homelab-extension). |

The secrets are `model.apiKey`, the ntfy URL and token, the two Slack tokens, and `search.apiKey`. Keep the file readable only by you or the service; `gaidin doctor` warns when anyone else can read it.

## Spend limits

gaidin totals what its conversations have cost, from Pi Durable's per-model costs, and counts from the start of each local day and month. When the day's spend reaches `budget.daily`, or the month's reaches `budget.monthly`, it stops making model requests: every run, including the owner's own messages and scheduled jobs, ends unanswered and says why. It tells the owner once, in Slack or by push, and once earlier at 80% of the daily limit. A daily stop lifts at local midnight and a monthly one at the start of the next month. `GET /api/budget` gives today's spend against the limit, and while stopped, `POST /api/budget/allow` allows another day's limit.

The total is read after each model response, so the request that crosses a limit finishes and the stop starts with the next one. Costs come from the model catalog's prices, which are estimates of what the provider bills. Set the Console workspace's own spend limit as well; that one is enforced by the provider.

## Upgrading Pi Durable

`@earendil-works/pi-durable`, `pi-ai` and `chord` are pinned. Their APIs change without notice, so upgrade them together on a branch, run `pnpm check`, and try a restart with a run in progress before deploying.

## Checks

`pnpm check` runs the type checker, Oxlint with the anti-slop rules (`.oxlintrc.json`, warnings counted as failures) and the tests. Tests are exempt from the rules about parsing outside input, since a wrong shape there fails an assertion. The sandbox tests run bubblewrap for real and are skipped where it isn't installed. The Socket Mode client has no automated tests.

`e2e/server.ts` runs the API on a scripted model with a fresh data directory, for a client's tests, so they need no key or network. It lets in the login given as its first argument and prints its port.
