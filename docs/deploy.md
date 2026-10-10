# Deploying

gaidin needs Linux, Node 22.18 or later (it runs the TypeScript directly), pnpm, bubblewrap, and an API key for the model. It can run on a workstation, but it's meant to live on a small always-on machine, so reminders fire and Slack gets answered while your desktop is off.

## Running it locally

```sh
pnpm install
pnpm serve
```

`pnpm serve` reads a gitignored `.env` in the repository, if there is one, with the [settings](#settings) below. `deploy/gaidin.service` is a systemd user unit for running it this way in the background; it points at a specific Node install, so edit `ExecStart` first. User units stop when you log out unless lingering is on (`loginctl enable-linger`).

## Running it on a VM

`deploy/vm/` sets gaidin up as a system service on Ubuntu 24.04. The original deployment uses a VM with 2 vCPUs and 2 GB of memory; the server itself uses around 120 MB.

1. Create the VM and install Node (in `/usr/local/bin`) and pnpm.
2. Change the repository URL in `deploy/vm/setup.sh` to your fork.
3. Copy `setup.sh` to the VM and run it as root. The first run creates a read-only deploy key, prints it and stops. Add it to the repository's deploy keys, then run it again.
4. Put the [settings](#settings) in `/etc/gaidin/env` (owned by root, mode 600). The service doesn't start without this file.
5. `systemctl start gaidin`, then check `journalctl -u gaidin`.

`setup.sh` is safe to rerun and is how you update: it pulls, installs dependencies, installs bubblewrap and its AppArmor profile, writes the unit, creates the workspace key, restarts the service, and runs `tailscale serve` for the web view when Tailscale is logged in. When a change touches `setup.sh` itself, run it twice: the first run still executes the old copy.

On the VM:

| Path | What |
|---|---|
| `/var/lib/gaidin/app` | the checkout, read-only to the service |
| `/var/lib/gaidin/data` | the [data directory](concepts.md#the-data-directory) |
| `/var/lib/gaidin/keys` | SSH keys for workspaces and container logs, and the workspace list |
| `/var/lib/gaidin/deploy` | the deploy key, hidden from the service |
| `/etc/gaidin/env` | settings and secrets |

The service runs as the `gaidin` system user. To talk to it on the VM:

```sh
sudo -u gaidin sh -c 'cd /var/lib/gaidin/app && GAIDIN_DATA=/var/lib/gaidin/data node --no-warnings src/cli.ts "hello"'
```

Back up the VM or the data directory; the SQLite file is the whole of gaidin's state.

## The model and its key

gaidin uses Claude through an API key, by default `claude-haiku-5-5`. Create the key in its own Claude Console workspace with a spend limit, so a runaway loop stops at the limit. A Claude Max plan includes monthly API credit, claimed under Settings > Billing on claude.ai into a linked Console organization; with auto-reload off, requests stop when the month's credit runs out instead of charging. The web view switches between Haiku, Sonnet and Opus per conversation.

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

All settings come from the environment: `.env` locally, `/etc/gaidin/env` on the VM.

| Variable | Default | |
|---|---|---|
| `ANTHROPIC_API_KEY` | | Required unless `GAIDIN_MODEL=faux`. |
| `GAIDIN_MODEL_ID` | `claude-haiku-5-5` | The model new conversations start with. |
| `GAIDIN_MODEL` | | `faux` runs a scripted model with no key or network, for testing. |
| `GAIDIN_DATA` | `data` | The data directory. |
| `GAIDIN_TZ` | the system's | Time zone for message stamps and reminders. |
| `NTFY_URL` | | Full ntfy topic URL for reminders. Without it they print to the server's output. |
| `NTFY_TOKEN` | | ntfy access token, if the topic needs one. |
| `SLACK_BOT_TOKEN` | | `xoxb-` token. All four `SLACK_*` or none. |
| `SLACK_APP_TOKEN` | | `xapp-` token with `connections:write`. |
| `SLACK_CHANNEL_ID` | | The one channel gaidin answers in. |
| `SLACK_USER_ID` | | The one Slack user it answers. |
| `GAIDIN_WEB_USER` | | Tailscale login allowed into the web view. Without it there's no web view. |
| `GAIDIN_WEB_PORT` | `8410` | Loopback port for the web view. |
| `GAIDIN_SANDBOX` | | `none` runs tools without bubblewrap. |
| `GAIDIN_KEYS` | `/var/lib/gaidin/keys` | Where the workspace key and list live. |
| `GAIDIN_LOGS_KEYS` | `/var/lib/gaidin/keys` | Where the container logs key lives. |
| `GAIDIN_HOMELAB_DATA` | the original deployment's | URL of the homelab snapshot feeds. |
| `GAIDIN_KUMA_URL` | the original deployment's | Uptime Kuma base URL. |

## Upgrading Pi Durable

`@earendil-works/pi-durable`, `pi-ai` and `chord` are pinned. Their APIs change without notice, so upgrade them together on a branch, run `pnpm check`, and try a restart with a run in progress before deploying.

## Checks

`pnpm check` runs the type checker and the tests. The sandbox tests run bubblewrap for real and are skipped where it isn't installed. The Socket Mode client and the web page itself have no automated tests.
