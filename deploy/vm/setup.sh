#!/bin/sh
# Sets up gaidin on its VM (Ubuntu 24.04, Node and pnpm already in /usr/local/bin). Run as root;
# safe to rerun. The first run prints a deploy key to add to github.com/brad-j/gaidin (read-only),
# then stops; the next run clones, installs and enables the service.
set -eu

home=/var/lib/gaidin
app=$home/app
deploy=$home/deploy

id gaidin >/dev/null 2>&1 || useradd --system --home-dir "$home" --create-home --shell /usr/sbin/nologin gaidin
install -d -m 700 -o gaidin -g gaidin "$home" "$home/data" "$deploy"
# systemd reads the env file as root; the agent's tools run as gaidin and can't open it.
install -d -m 700 -o root -g root /etc/gaidin

# Read-only GitHub deploy key, used only by this checkout.
if [ ! -f "$deploy/github" ]; then
	sudo -u gaidin ssh-keygen -q -t ed25519 -N "" -C "gaidin vm (read-only)" -f "$deploy/github"
fi
# GitHub's host keys from its API over TLS, rather than trusting the first connection.
curl -fsSL https://api.github.com/meta \
	| python3 -c 'import json,sys; [print("github.com", k) for k in json.load(sys.stdin)["ssh_keys"]]' \
	> "$deploy/known_hosts"
chown gaidin:gaidin "$deploy/known_hosts"
ssh_command="ssh -i $deploy/github -o IdentitiesOnly=yes -o UserKnownHostsFile=$deploy/known_hosts"

if [ ! -d "$app/.git" ]; then
	if ! sudo -u gaidin env GIT_SSH_COMMAND="$ssh_command" git ls-remote git@github.com:brad-j/gaidin.git >/dev/null 2>&1; then
		echo "Add this read-only deploy key to github.com/brad-j/gaidin, then rerun:"
		cat "$deploy/github.pub"
		exit 2
	fi
	sudo -u gaidin env GIT_SSH_COMMAND="$ssh_command" git clone -q git@github.com:brad-j/gaidin.git "$app"
	sudo -u gaidin git -C "$app" config core.sshCommand "$ssh_command"
fi

sudo -u gaidin git -C "$app" pull -q --ff-only
(cd "$app" && sudo -u gaidin env HOME="$home" pnpm install -s --frozen-lockfile --prod)

install -m 644 "$app/deploy/vm/gaidin.service" /etc/systemd/system/gaidin.service
systemctl daemon-reload
systemctl enable gaidin.service
if [ -f /etc/gaidin/env ]; then
	systemctl restart gaidin.service
else
	echo "Not started: put ANTHROPIC_API_KEY and NTFY_URL in /etc/gaidin/env (root, 600), then: systemctl start gaidin"
fi

# The web view: HTTPS on the tailnet name, proxied to the loopback port the server listens on when
# GAIDIN_WEB_USER is set. tailscale serve adds the Tailscale-User-Login header the server checks, and
# keeps this setting across restarts.
if tailscale status >/dev/null 2>&1; then
	tailscale serve --bg --yes 8410 >/dev/null
else
	echo "Web view not served: log in to Tailscale, then rerun"
fi
