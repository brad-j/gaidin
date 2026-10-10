# Deploying

gaidin needs Linux, Node 22.18 or later (it runs the TypeScript directly), pnpm, bubblewrap, and an API key for the model. It can run on a workstation, but it's meant to live on a small always-on machine, so reminders fire and Slack gets answered while your desktop is off. It needs no inbound ports: Slack is an outbound connection and the web view goes through Tailscale.

## The gaidin command

```sh
gaidin serve                    # run the agent and its surfaces
gaidin ask "MESSAGE"            # send a message and print the run; --id ID reattaches
gaidin watch                    # print everything the agent does, until Ctrl+C
gaidin doctor                   # check the settings and everything the server needs
gaidin doctor --push            # the same, and send a test notification
gaidin config                   # print the settings in use, secrets shortened
```

From a checkout, `pnpm gaidin ...` runs it, and `pnpm serve`, `pnpm ask`, `pnpm watch` and `pnpm doctor` are shortcuts. On the VM, `setup.sh` installs `/usr/local/bin/gaidin`, which runs it as the service's user with the service's settings.

`gaidin doctor` doesn't start the server and spends no tokens. It checks the settings, Node, the data directory, that bubblewrap can start a sandbox, the API key and model (by looking the model up), the ntfy topic, both Slack tokens, `tailscale serve`, each workspace, and the homelab feeds and log hosts, and says what to fix.

## Running it locally

```sh
pnpm install
cp deploy/config.example.json gaidin.json && chmod 600 gaidin.json   # then edit it
pnpm doctor
pnpm serve
```

`gaidin.json` in the checkout is gitignored. `deploy/gaidin.service` is a systemd user unit for running it this way in the background; edit its paths first. User units stop when you log out unless lingering is on (`loginctl enable-linger`).

## Running it on a VM

`deploy/vm/` sets gaidin up as a system service on Ubuntu 24.04. The original deployment uses a VM with 2 vCPUs and 2 GB of memory; the server itself uses around 120 MB.

1. Create the VM and install Node (in `/usr/local/bin`) and pnpm.
2. Change the repository URL in `deploy/vm/setup.sh` to your fork.
3. Copy `setup.sh` to the VM and run it as root. The first run creates a read-only deploy key, prints it and stops. Add it to the repository's deploy keys, then run it again.
4. Copy `deploy/config.example.json` to `/etc/gaidin/config.json` and fill it in. `setup.sh` makes it readable by the service only (`root:gaidin`, mode 640).
5. `gaidin doctor`, then run `setup.sh` again to start the service, and check `journalctl -u gaidin`.

`setup.sh` is safe to rerun and is how you update: it pulls, installs dependencies, installs bubblewrap and its AppArmor profile, writes the unit and the `gaidin` command, creates the workspace key, restarts the service, and runs `tailscale serve` for the web view when Tailscale is logged in. When a change touches `setup.sh` itself, run it twice: the first run still executes the old copy.

On the VM:

| Path | What |
|---|---|
| `/etc/gaidin/config.json` | the settings, with secrets; the sandbox can't read it |
| `/var/lib/gaidin/app` | the checkout, read-only to the service |
| `/var/lib/gaidin/data` | the [data directory](concepts.md#the-data-directory) |
| `/var/lib/gaidin/keys` | SSH keys for workspaces and container logs, and the workspace list |
| `/var/lib/gaidin/deploy` | the deploy key, hidden from the service |

Back up the VM or the data directory; the SQLite file is the whole of gaidin's state.

## The model and its key

gaidin uses Claude through an API key, by default `claude-haiku-5-5`. Create the key in its own Claude Console workspace with a spend limit, so a runaway loop stops at the limit even if gaidin's own [spend limits](#spend-limits) miss it. A Claude Max plan includes monthly API credit, claimed under Settings > Billing on claude.ai into a linked Console organization; with auto-reload off, requests stop when the month's credit runs out instead of charging. The web view switches between the models in `model.choices` per conversation.

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
| `model.choices` | | Haiku, Sonnet and Opus 5.5 | Models the web view offers. |
| `model.provider` | `GAIDIN_MODEL` | `anthropic` | `faux` runs a scripted model with no key or network, for testing. |
| `ntfy.url` | `NTFY_URL` | | Full topic URL for reminders. Without it they print to the server's output. |
| `ntfy.token` | `NTFY_TOKEN` | | Access token, if the topic needs one. |
| `slack.botToken` | `SLACK_BOT_TOKEN` | | `xoxb-` token. All four Slack values or none. |
| `slack.appToken` | `SLACK_APP_TOKEN` | | `xapp-` token with `connections:write`. |
| `slack.channelId` | `SLACK_CHANNEL_ID` | | The one channel gaidin answers in. |
| `slack.userId` | `SLACK_USER_ID` | | The one Slack user it answers. |
| `web.user` | `GAIDIN_WEB_USER` | | Tailscale login allowed into the web view. Without it there's no web view. |
| `web.port` | `GAIDIN_WEB_PORT` | `8410` | Loopback port for the web view. |
| `sandbox` | `GAIDIN_SANDBOX` | `bwrap` | `none` runs tools without bubblewrap. |
| `budget.daily` | `GAIDIN_BUDGET_DAILY` | `5` | Dollars a day; 0 is no daily limit. See [Spend limits](#spend-limits). |
| `budget.monthly` | `GAIDIN_BUDGET_MONTHLY` | `0` | Dollars a calendar month; 0 is no monthly limit. |
| `extensions.homelab` | | off | The [homelab extension](extending.md#the-homelab-extension). |

The secrets are `model.apiKey`, the ntfy URL and token, and the two Slack tokens. Keep the file readable only by you or the service; `gaidin doctor` warns when anyone else can read it.

## Spend limits

gaidin totals what its conversations have cost, from Pi Durable's per-model costs, and counts from the start of each local day and month. When the day's spend reaches `budget.daily`, or the month's reaches `budget.monthly`, it stops making model requests: every run, including the owner's own messages and scheduled jobs, ends unanswered and says why. It tells the owner once, in Slack or by push, and once earlier at 80% of the daily limit. A daily stop lifts at local midnight and a monthly one at the start of the next month. The web view's header shows today's spend against the limit and, while stopped, an "Allow more today" button that adds another day's limit.

The total is read after each model response, so the request that crosses a limit finishes and the stop starts with the next one. Costs come from the model catalog's prices, which are estimates of what the provider bills. Set the Console workspace's own spend limit as well; that one is enforced by the provider.

## Upgrading Pi Durable

`@earendil-works/pi-durable`, `pi-ai` and `chord` are pinned. Their APIs change without notice, so upgrade them together on a branch, run `pnpm check`, and try a restart with a run in progress before deploying.

## Checks

`pnpm check` runs the type checker and the tests. The sandbox tests run bubblewrap for real and are skipped where it isn't installed. The Socket Mode client and the web page itself have no automated tests.
