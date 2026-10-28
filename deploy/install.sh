#!/bin/sh
# Installs gaidin as a system service on Ubuntu 24.04 or Debian 12 (x86-64), and updates it when run again, keeping
# the settings. Run as root:
#   sh install.sh [--repo URL]
# URL is the repository to install from, this one by default. An https URL is cloned as it is. An SSH URL
# (git@github.com:you/gaidin.git), for a private fork, is cloned with a read-only deploy key: the first run prints the
# key and stops, and the next run clones once it's added. Later runs pull from the checkout's own remote.
set -eu

repo=https://github.com/brad-j/gaidin.git
while [ $# -gt 0 ]; do
	case $1 in
	--repo) repo=${2:?--repo needs a URL}; shift 2 ;;
	*) echo "usage: install.sh [--repo URL]" >&2; exit 2 ;;
	esac
done

[ "$(id -u)" = 0 ] || { echo "Run install.sh as root." >&2; exit 1; }
# The browser's libraries, which Ubuntu 24.04 renamed for its 64-bit time change.
case $(. /etc/os-release && echo "$ID $VERSION_ID") in
"ubuntu 24.04") browser_libs="libatk1.0-0t64 libatk-bridge2.0-0t64 libatspi2.0-0t64 libasound2t64" ;;
"debian 12") browser_libs="libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 libasound2" ;;
*) echo "install.sh supports Ubuntu 24.04 and Debian 12. Elsewhere, run gaidin from a checkout (docs/deploy.md)." >&2; exit 1 ;;
esac
[ "$(uname -m)" = x86_64 ] || { echo "install.sh supports x86-64 only." >&2; exit 1; }

home=/var/lib/gaidin
app=$home/app
deploy=$home/deploy
node=/opt/gaidin/node/bin/node

# Installs the packages that aren't installed yet, updating the package lists once, only when something is missing.
apt_install() {
	missing=
	for package in "$@"; do
		dpkg-query -W -f '${Status}' "$package" 2>/dev/null | grep -q 'install ok installed' || missing="$missing $package"
	done
	if [ -n "$missing" ]; then
		[ -n "${updated-}" ] || { apt-get update -qq; updated=1; }
		DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends $missing >/dev/null
	fi
}

# Runs a command as the service's user, with Node on PATH and pnpm through Corepack without asking.
as_gaidin() {
	runuser -u gaidin -- env HOME="$home" PATH="/opt/gaidin/node/bin:/usr/sbin:/usr/bin:/sbin:/bin" COREPACK_ENABLE_DOWNLOAD_PROMPT=0 "$@"
}

# git and curl to fetch, xz for Node's tarball, bubblewrap for the tools' sandbox (src/sandbox.ts; the server won't
# start without it), and pdftotext for PDFs sent in Slack (src/slack/conversation.ts).
apt_install ca-certificates curl git xz-utils bubblewrap poppler-utils

# Node from nodejs.org's tarball, checked against the SHA-256 pinned here, in a directory only root can change. pnpm
# comes through Corepack, at the version package.json names.
node_version=v24.22.1
node_sha256=6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6
node_dir=/opt/gaidin/node-$node_version-linux-x64
install -d -m 755 /opt/gaidin
if [ ! -d "$node_dir" ]; then
	unpack=$(mktemp -d /opt/gaidin/.node.XXXXXX)
	curl -fsSL -o "$unpack/node.tar.xz" "https://nodejs.org/dist/$node_version/node-$node_version-linux-x64.tar.xz"
	echo "$node_sha256  $unpack/node.tar.xz" | sha256sum -c --quiet - || { rm -rf "$unpack"; echo "Node's tarball doesn't match its SHA-256." >&2; exit 1; }
	tar -xJf "$unpack/node.tar.xz" -C "$unpack" --no-same-owner
	mv "$unpack/node-$node_version-linux-x64" "$node_dir"
	rm -rf "$unpack"
fi
ln -sfn "$node_dir" /opt/gaidin/node

id gaidin >/dev/null 2>&1 || useradd --system --home-dir "$home" --create-home --shell /usr/sbin/nologin gaidin
install -d -m 700 -o gaidin -g gaidin "$home" "$home/data" "$deploy"
# The settings: readable by the service, not by other users. The sandbox can't read them either
# (src/sandbox.ts hides the file from commands).
install -d -m 750 -o root -g gaidin /etc/gaidin
[ ! -f /etc/gaidin/config.json ] || { chown root:gaidin /etc/gaidin/config.json; chmod 640 /etc/gaidin/config.json; }

if [ ! -d "$app/.git" ]; then
	case $repo in
	https://*) as_gaidin git clone -q "$repo" "$app" ;;
	*)
		# A read-only deploy key, used only by this checkout, and GitHub's host keys from its API over TLS, rather
		# than trusting the first connection. The service can't read the key (gaidin.service).
		[ -f "$deploy/github" ] || as_gaidin ssh-keygen -q -t ed25519 -N "" -C "gaidin (read-only)" -f "$deploy/github"
		curl -fsSL https://api.github.com/meta \
			| "$node" -e 'for (const key of JSON.parse(require("node:fs").readFileSync(0, "utf8")).ssh_keys) console.log("github.com", key)' \
			> "$deploy/known_hosts"
		chown gaidin:gaidin "$deploy/known_hosts"
		ssh_command="ssh -i $deploy/github -o IdentitiesOnly=yes -o UserKnownHostsFile=$deploy/known_hosts"
		if ! as_gaidin env GIT_SSH_COMMAND="$ssh_command" git ls-remote "$repo" >/dev/null 2>&1; then
			echo "Add this read-only deploy key to $repo, then run install.sh again:"
			cat "$deploy/github.pub"
			exit 2
		fi
		as_gaidin env GIT_SSH_COMMAND="$ssh_command" git clone -q "$repo" "$app"
		as_gaidin git -C "$app" config core.sshCommand "$ssh_command"
		;;
	esac
fi

as_gaidin git -C "$app" pull -q --ff-only
# A newer installer came with the pull: run that one instead, so a change to this script takes effect in one run.
if [ -z "${GAIDIN_INSTALL_PULLED-}" ] && ! cmp -s "$0" "$app/deploy/install.sh"; then
	GAIDIN_INSTALL_PULLED=1 exec sh "$app/deploy/install.sh" --repo "$repo"
fi
(cd "$app" && as_gaidin corepack pnpm install -s --frozen-lockfile --prod)

# The key gaidin reaches workspaces with (src/workspaces.ts, deploy/vm/add-workspace.sh).
install -d -o gaidin -g gaidin -m 700 "$home/keys"
[ -f "$home/keys/workspace" ] || as_gaidin ssh-keygen -q -t ed25519 -N "" -C "gaidin workspace" -f "$home/keys/workspace"

# Ubuntu 24.04 confines unprivileged user namespaces, which the sandbox and Chromium need, unless an AppArmor profile
# lets them through. Debian 12 doesn't confine them, and its AppArmor can't read these profiles.
confined_userns() { [ -e /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]; }
if confined_userns; then
	install -m 644 "$app/deploy/vm/bwrap.apparmor" /etc/apparmor.d/bwrap
	apparmor_parser -r /etc/apparmor.d/bwrap
fi

# The browser (src/browser/), when the settings give it profiles: Playwright's Chromium headless shell in a directory only
# root can change, the libraries it needs and a font, and the AppArmor profile that lets it keep its own sandbox. The unit
# and the gaidin command point Playwright at the directory.
browsers=/opt/gaidin/browsers
if [ -f /etc/gaidin/config.json ] && "$node" -e 'process.exit("browser" in JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")) ? 0 : 1)' /etc/gaidin/config.json; then
	apt_install $browser_libs libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 fontconfig fonts-liberation
	install -d -m 755 "$browsers"
	PLAYWRIGHT_BROWSERS_PATH="$browsers" "$node" "$app/node_modules/playwright-core/cli.js" install --only-shell --no-progress chromium >/dev/null
	if confined_userns; then
		install -m 644 "$app/deploy/vm/chromium.apparmor" /etc/apparmor.d/gaidin-chromium
		apparmor_parser -r /etc/apparmor.d/gaidin-chromium
	fi
fi

# Oxlint, which checks self-written tools (src/self/), reserves 4 GiB of address space per thread for its
# JavaScript plugins. The default overcommit rule refuses a reservation larger than memory and swap, which
# a small VM has less of, so allow it. Only the part Oxlint fills is ever used.
echo "vm.overcommit_memory = 1" > /etc/sysctl.d/90-gaidin-overcommit.conf
sysctl -q -p /etc/sysctl.d/90-gaidin-overcommit.conf

# `gaidin ...` on this machine runs as the service does: as gaidin, with its settings.
cat > /usr/local/bin/gaidin <<'EOF'
#!/bin/sh
# `gaidin ...` runs as the service does: as gaidin, with its settings. Installed by deploy/install.sh.
settings=/etc/gaidin/config.json

# Runs gaidin as the service's user with the settings file SETTINGS: gaidin_as SETTINGS ARGS...
# The directory change happens as gaidin; other users can't enter its home.
gaidin_as() {
	if [ "$(id -u)" = 0 ]; then set -- runuser -u gaidin -- "$@"; else set -- sudo -u gaidin "$@"; fi
	"$@"
}
run() {
	gaidin_as sh -c 'cd /var/lib/gaidin/app && exec env GAIDIN_CONFIG="$0" PLAYWRIGHT_BROWSERS_PATH=/opt/gaidin/browsers /opt/gaidin/node/bin/node --no-warnings src/main.ts "$@"' "$@"
}

if [ "${1-}" != setup ]; then
	run "$settings" "$@"
	exit
fi

# The settings are root's, and the service only reads them. So setup edits a copy as gaidin, in a directory the
# service can't see (its /tmp is its own), and the copy replaces the settings when setup has written it. A first
# copy holds the server's paths, which setup keeps.
[ "$(id -u)" = 0 ] || { echo "gaidin setup changes $settings, so run it as root: sudo gaidin setup" >&2; exit 1; }
shift
copy=$(mktemp -d /tmp/gaidin-setup.XXXXXX) || exit 1
trap 'rm -rf "$copy"' EXIT
trap 'exit 130' INT HUP TERM
chown gaidin:gaidin "$copy"
if [ -f "$settings" ]; then
	install -m 600 -o gaidin -g gaidin "$settings" "$copy/config.json"
else
	(umask 077 && printf '{\n  "data": "/var/lib/gaidin/data",\n  "keys": "/var/lib/gaidin/keys"\n}\n' > "$copy/config.json")
	chown gaidin:gaidin "$copy/config.json"
fi
before=$(cksum < "$copy/config.json")
echo "Setup works on a copy, which replaces $settings when it's written."
run "$copy/config.json" setup "$@"
status=$?
[ "$(cksum < "$copy/config.json")" != "$before" ] || exit "$status"
install -m 640 -o root -g gaidin "$copy/config.json" "$settings.new"
mv "$settings.new" "$settings"
echo "Installed the settings as $settings."
if [ "$status" != 0 ]; then
	echo "gaidin isn't restarted, since doctor found a problem. Fix it, then: systemctl restart gaidin"
elif systemctl -q is-active gaidin.service; then
	systemctl restart gaidin.service
	echo "Restarted gaidin with them."
fi
exit "$status"
EOF
chmod 755 /usr/local/bin/gaidin

install -m 644 "$app/deploy/vm/gaidin.service" /etc/systemd/system/gaidin.service
systemctl daemon-reload
systemctl enable -q gaidin.service

# The API: HTTPS on the tailnet name, proxied to the loopback port the server listens on when
# GAIDIN_WEB_USER is set. tailscale serve adds the Tailscale-User-Login header the server checks, and
# keeps this setting across restarts. It comes before setup, whose checks include it.
if command -v tailscale >/dev/null && tailscale status >/dev/null 2>&1; then
	tailscale serve --bg --yes 8410 >/dev/null
else
	echo "API not served: install Tailscale and log in (tailscale up), then run install.sh again"
fi

if [ -f /etc/gaidin/config.json ]; then
	systemctl restart gaidin.service
elif [ -t 0 ] && [ -t 1 ]; then
	echo "No settings yet, so gaidin setup asks for them."
	if /usr/local/bin/gaidin setup; then
		systemctl start gaidin.service
		echo "Started gaidin. Check it with journalctl -u gaidin."
	else
		echo "Not started. Finish the settings with 'gaidin setup', then: systemctl start gaidin"
	fi
else
	echo "Not started: write the settings with 'gaidin setup' as root, then: systemctl start gaidin"
fi
