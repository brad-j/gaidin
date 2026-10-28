#!/bin/sh
# Adds or updates a workspace on the gaidin VM and restarts gaidin. Run as root:
#   sh /var/lib/gaidin/app/deploy/vm/add-workspace.sh NAME USER@HOST
# The machine needs deploy/workspace/install.sh run first, with the key deploy/install.sh made
# (/var/lib/gaidin/keys/workspace.pub). Compare the fingerprint this prints with the machine's own:
#   ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
set -eu

name=${1:?usage: add-workspace.sh NAME USER@HOST}
target=${2:?usage: add-workspace.sh NAME USER@HOST}
case "$name" in *[!a-z0-9-]*|-*|"") echo "names are lowercase letters, digits and dashes" >&2; exit 2 ;; esac
host=${target#*@}
keys=/var/lib/gaidin/keys

# Pin the host key as seen from here; a workspace whose key changes stops working until this is rerun.
scanned=$(ssh-keyscan -T 5 -t ed25519 "$host" 2>/dev/null)
[ -n "$scanned" ] || { echo "no SSH answer from $host; is port 22 open to this VM?" >&2; exit 1; }
touch "$keys/workspaces_known_hosts" "$keys/workspaces"
grep -v "^$host " "$keys/workspaces_known_hosts" > "$keys/workspaces_known_hosts.new" || true
printf '%s\n' "$scanned" >> "$keys/workspaces_known_hosts.new"
mv "$keys/workspaces_known_hosts.new" "$keys/workspaces_known_hosts"
grep -v "^$name " "$keys/workspaces" > "$keys/workspaces.new" || true
printf '%s %s\n' "$name" "$target" >> "$keys/workspaces.new"
mv "$keys/workspaces.new" "$keys/workspaces"
chown gaidin:gaidin "$keys/workspaces" "$keys/workspaces_known_hosts"
chmod 600 "$keys/workspaces" "$keys/workspaces_known_hosts"
printf '%s\n' "$scanned" | ssh-keygen -lf -

sudo -u gaidin ssh -F /dev/null -T -i "$keys/workspace" -o IdentitiesOnly=yes -o BatchMode=yes \
	-o StrictHostKeyChecking=yes -o UserKnownHostsFile="$keys/workspaces_known_hosts" "$target" read <<'EOF'
{"path": "."}
EOF
echo
systemctl restart gaidin
echo "workspace $name added; gaidin restarted"
