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
# The settings: readable by the service, not by other users. The sandbox can't read them either
# (src/sandbox.ts hides the file from commands).
install -d -m 750 -o root -g gaidin /etc/gaidin
[ ! -f /etc/gaidin/config.json ] || { chown root:gaidin /etc/gaidin/config.json; chmod 640 /etc/gaidin/config.json; }

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

# The key gaidin reaches workspaces with (src/workspaces.ts, deploy/vm/add-workspace.sh).
install -d -o gaidin -g gaidin -m 700 "$home/keys"
[ -f "$home/keys/workspace" ] || sudo -u gaidin ssh-keygen -q -t ed25519 -N "" -C "gaidin workspace" -f "$home/keys/workspace"

# The tools' sandbox (src/sandbox.ts). The server won't start without bwrap.
command -v bwrap >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y -qq bubblewrap >/dev/null
# pdftotext, for PDFs sent in Slack (src/slack.ts).
command -v pdftotext >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y -qq poppler-utils >/dev/null
install -m 644 "$app/deploy/vm/bwrap.apparmor" /etc/apparmor.d/bwrap
apparmor_parser -r /etc/apparmor.d/bwrap

# Oxlint, which checks self-written tools (src/self/), reserves 4 GiB of address space per thread for its
# JavaScript plugins. The default overcommit rule refuses a reservation larger than memory and swap, which
# this VM has less of, so allow it. Only the part Oxlint fills is ever used.
echo "vm.overcommit_memory = 1" > /etc/sysctl.d/90-gaidin-overcommit.conf
sysctl -q -p /etc/sysctl.d/90-gaidin-overcommit.conf

# `gaidin ...` on this VM runs as the service does: as gaidin, with its settings.
cat > /usr/local/bin/gaidin <<'EOF'
#!/bin/sh
# The directory change happens as gaidin; other users can't enter its home.
exec sudo -u gaidin sh -c 'cd /var/lib/gaidin/app && exec env GAIDIN_CONFIG=/etc/gaidin/config.json /usr/local/bin/node --no-warnings src/main.ts "$@"' gaidin "$@"
EOF
chmod 755 /usr/local/bin/gaidin

install -m 644 "$app/deploy/vm/gaidin.service" /etc/systemd/system/gaidin.service
systemctl daemon-reload
systemctl enable gaidin.service
if [ -f /etc/gaidin/config.json ]; then
	systemctl restart gaidin.service
else
	echo "Not started: copy deploy/config.example.json to /etc/gaidin/config.json (root:gaidin, 640),"
	echo "fill it in, check it with 'gaidin doctor', then rerun this script"
fi

# The web view: HTTPS on the tailnet name, proxied to the loopback port the server listens on when
# GAIDIN_WEB_USER is set. tailscale serve adds the Tailscale-User-Login header the server checks, and
# keeps this setting across restarts.
if tailscale status >/dev/null 2>&1; then
	tailscale serve --bg --yes 8410 >/dev/null
else
	echo "Web view not served: log in to Tailscale, then rerun"
fi
