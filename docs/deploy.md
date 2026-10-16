# Deploying

gaidin needs Linux, Node 22.18 or later (it runs the TypeScript directly), pnpm, bubblewrap, and an API key for the model. It can run on a workstation, but it's meant to live on a small always-on machine, so reminders fire and Slack gets answered while your desktop is off. It needs no inbound ports: Slack is an outbound connection and the app goes through Tailscale.

## The gaidin command

```sh
gaidin serve                    # run the agent and its surfaces
gaidin ask "MESSAGE"            # send a message and print the run; --id ID reattaches
gaidin watch                    # print everything the agent does, until Ctrl+C
gaidin doctor                   # check the settings and everything the server needs
gaidin doctor --push            # the same, and send a test notification through ntfy
gaidin config                   # print the settings in use, secrets shortened
```

From a checkout, `pnpm gaidin ...` runs it, and `pnpm serve`, `pnpm ask`, `pnpm watch` and `pnpm doctor` are shortcuts. On the VM, `setup.sh` installs `/usr/local/bin/gaidin`, which runs it as the service's user with the service's settings.

`gaidin doctor` doesn't start the server and spends no tokens. It checks the settings, Node, the data directory, that bubblewrap can start a sandbox, that Chromium starts with its sandbox when there are browser profiles, the API key and model (by looking the model up), the ntfy topic, that the push services can be reached, both Slack tokens and whether agents can post under their own names, the search key and its remaining credits, `tailscale serve`, each workspace, and the homelab feeds and log hosts, and says what to fix.

## Running it locally

```sh
pnpm install
cp deploy/config.example.json gaidin.json && chmod 600 gaidin.json   # then edit it
pnpm doctor
pnpm serve
```

`gaidin.json` in the checkout is gitignored. `deploy/gaidin.service` is a systemd user unit for running it this way in the background; edit its paths first. User units stop when you log out unless lingering is on (`loginctl enable-linger`).

## Running it on a VM

`deploy/vm/` sets gaidin up as a system service on Ubuntu 24.04. The original deployment uses a VM with 2 vCPUs and 4 GB of memory. The server itself uses around 120 MB; the [browser](tools.md#browser) adds about 250 MB per open profile on a busy page, and up to two are open at once.

1. Create the VM and install Node (in `/usr/local/bin`) and pnpm.
2. Change the repository URL in `deploy/vm/setup.sh` to your fork.
3. Copy `setup.sh` to the VM and run it as root. The first run creates a read-only deploy key, prints it and stops. Add it to the repository's deploy keys, then run it again.
4. Copy `deploy/config.example.json` to `/etc/gaidin/config.json` and fill it in. `setup.sh` makes it readable by the service only (`root:gaidin`, mode 640).
5. `gaidin doctor`, then run `setup.sh` again to start the service, and check `journalctl -u gaidin`.

`setup.sh` is safe to rerun and is how you update: it pulls, installs dependencies, installs bubblewrap and its AppArmor profile and `poppler-utils` (for PDFs sent in Slack), installs the browser's Chromium when the settings have a `browser` section (below), allows memory overcommit (Oxlint, which checks [self-written tools](tools.md#self-written-tools), reserves 4 GiB of address space per thread), writes the unit and the `gaidin` command, creates the workspace key, restarts the service, and runs `tailscale serve` for the app when Tailscale is logged in. When a change touches `setup.sh` itself, run it twice: the first run still executes the old copy.

On the VM:

| Path | What |
|---|---|
| `/etc/gaidin/config.json` | the settings, with secrets; the sandbox sees `/etc/gaidin` empty |
| `/var/lib/gaidin/app` | the checkout, read-only to the service |
| `/var/lib/gaidin/data` | the [data directory](concepts.md#the-data-directory) |
| `/var/lib/gaidin/keys` | SSH keys for workspaces and container logs, and the workspace list |
| `/var/lib/gaidin/deploy` | the deploy key, hidden from the service |
| `/opt/gaidin/browsers` | the browser's Chromium, which only root can change |

To turn on the [browser](tools.md#browser), add `"browser": { "profiles": ["personal"] }` to the settings and run `setup.sh`. It installs the libraries Chromium needs and a font (about 25 packages with `--no-install-recommends`, Mesa among them), Playwright's Chromium headless shell in `/opt/gaidin/browsers` (about 280 MB), and `deploy/vm/chromium.apparmor`, which lets Chromium keep its own sandbox under Ubuntu's limit on user namespaces. `gaidin doctor` then starts Chromium to check. Give an agent a profile from the app's settings page or with `gaidin agent set ID --profiles personal`.

Back up the VM or the data directory; the SQLite file is the whole of gaidin's state.

## The app

The app, [moiraine](surfaces.md#the-app), is built on your machine and copied to the VM; the VM needs no second checkout or build tools. In moiraine's checkout, beside this one:

```sh
pnpm ship    # GAIDIN_HOST, default ubuntu@gaidin, with passwordless sudo
```

It asks the VM's gaidin which [protocol](surfaces.md#the-api) it speaks and stops unless it's the one the build is for, so deploy gaidin first (push, then `setup.sh`) when both changed. Then it builds and copies the build to `/var/lib/gaidin/moiraine` over Tailscale SSH: built files first, keeping older ones for two weeks so a page loaded before the copy still finds its own, then the shell. gaidin reads the shell as it's asked for, so a new build needs no restart.

Once, add the directory to the settings and restart gaidin, which reads its settings at start:

```json
"web": { "user": "...", "url": "...", "app": "/var/lib/gaidin/moiraine" }
```

## The model and its key

gaidin uses Claude through an API key, by default `claude-haiku-5-5`. Create the key in its own Claude Console workspace with a spend limit, so a runaway loop stops at the limit even if gaidin's own [spend limits](#spend-limits) miss it. A Claude Max plan includes monthly API credit, claimed under Settings > Billing on claude.ai into a linked Console organization; with auto-reload off, requests stop when the month's credit runs out instead of charging. The app switches between the models in `model.choices` per conversation.

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
| `model.choices` | | Haiku, Sonnet and Opus 5.5 | Models the app offers. |
| `model.provider` | `GAIDIN_MODEL` | `anthropic` | `faux` runs a scripted model with no key or network, for testing. |
| `ntfy.url` | `NTFY_URL` | | Full topic URL for [notifications](surfaces.md#notifications) through ntfy. Without it and without `web.url`, reminders print to the server's output. |
| `ntfy.token` | `NTFY_TOKEN` | | Access token, if the topic needs one. |
| `alerts.url` | | | An ntfy topic URL that monitoring pushes alerts to. gaidin follows it and investigates what arrives ([Tools](tools.md#alerts)). A secret, like `ntfy.url`. |
| `alerts.token` | | | Access token, if that topic needs one. |
| `ntfy.icon` | | | URL of a PNG or JPEG the ntfy app shows beside each push. The phone fetches it, so the app's `https://<gaidin's tailnet name>/icon-192.png` works while the phone is on the tailnet. |
| `slack.botToken` | `SLACK_BOT_TOKEN` | | `xoxb-` token. All four Slack values or none. |
| `slack.appToken` | `SLACK_APP_TOKEN` | | `xapp-` token with `connections:write`. |
| `slack.channelId` | `SLACK_CHANNEL_ID` | | The default agent's channel. Other agents' channels are in the roster, set from the app or `gaidin agent set --channel`. |
| `slack.userId` | `SLACK_USER_ID` | | The one Slack user it answers. |
| `web.user` | `GAIDIN_WEB_USER` | | Tailscale login allowed into the app. Without it there's no app. |
| `web.port` | `GAIDIN_WEB_PORT` | `8410` | Loopback port for the app. |
| `web.url` | | | The app's address on the tailnet, such as `https://gaidin.<tailnet>.ts.net`. With it, devices can sign up for [notifications](surfaces.md#notifications) from the app, and tapping an ntfy reminder opens the app and has buttons to snooze it. |
| `web.app` | | | The directory of [moiraine](surfaces.md#the-app)'s build, the app, served at `/` ([The app](#the-app)). Without it there's no app. Relative to the settings file. |
| `sandbox` | `GAIDIN_SANDBOX` | `bwrap` | `none` runs tools without bubblewrap. |
| `search.provider` | | | `tavily`; without it there's no `web_search`. |
| `search.apiKey` | `TAVILY_API_KEY` | | A Tavily key, `tvly-...`. Setting the variable alone also turns search on. |
| `budget.daily` | `GAIDIN_BUDGET_DAILY` | `5` | Dollars a day; 0 is no daily limit. See [Spend limits](#spend-limits). |
| `budget.monthly` | `GAIDIN_BUDGET_MONTHLY` | `0` | Dollars a calendar month; 0 is no monthly limit. |
| `approvals.waitHours` | `GAIDIN_APPROVAL_WAIT_HOURS` | `168` | How long approvals and questions wait, up to 576. |
| `browser.profiles` | | | Names of the [browser](tools.md#browser) profiles agents can be given, such as `["personal"]`: lowercase letters, digits and `-`. Without them there's no browser. |
| `connectors.clientId` | | `<web.url>/api/connectors/client.json` | The https URL of a public copy of gaidin's client id document, for [connector](tools.md#connectors) services on the internet that fetch it. `gaidin connector client-document` prints it. |
| `extensions.homelab` | | off | The [homelab extension](extending.md#the-homelab-extension). |

The secrets are `model.apiKey`, the ntfy URL and token, the two Slack tokens, and `search.apiKey`. Keep the file readable only by you or the service; `gaidin doctor` warns when anyone else can read it.

## Spend limits

gaidin totals what its conversations have cost, from Pi Durable's per-model costs, and counts from the start of each local day and month. When the day's spend reaches `budget.daily`, or the month's reaches `budget.monthly`, it stops making model requests: every run, including the owner's own messages and scheduled jobs, ends unanswered and says why. It tells the owner once, in Slack or by push, and once earlier at 80% of the daily limit. A daily stop lifts at local midnight and a monthly one at the start of the next month. The app's status line shows today's spend against the limit and, while stopped, a button that allows another day's limit; `/budget` shows the same.

The total is read after each model response, so the request that crosses a limit finishes and the stop starts with the next one. Costs come from the model catalog's prices, which are estimates of what the provider bills. Set the Console workspace's own spend limit as well; that one is enforced by the provider.

## Upgrading Pi Durable

`@earendil-works/pi-durable`, `pi-ai` and `chord` are pinned. Their APIs change without notice, so upgrade them together on a branch, run `pnpm check`, and try a restart with a run in progress before deploying.

## Checks

`pnpm check` runs the type checker, Oxlint with the anti-slop rules (`.oxlintrc.json`, warnings counted as failures) and the tests. Tests are exempt from the rules about parsing outside input, since a wrong shape there fails an assertion. The sandbox tests run bubblewrap for real and are skipped where it isn't installed. The Socket Mode client has no automated tests.

The app's browser tests are moiraine's (`pnpm e2e` there). Each starts this checkout's `e2e/server.ts`, gaidin on a scripted model with a fresh data directory, serving the app's build, so they need no key or network.
