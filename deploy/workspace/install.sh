#!/bin/sh
# Makes this machine a gaidin workspace for the user who runs it. Safe to rerun.
#
#   install.sh --key "<gaidin's public key>" --from <gaidin's address> ROOT...
#
# ROOTs are the directories gaidin may read and write. The key comes from the gaidin server:
#   ssh <gaidin> sudo cat /var/lib/gaidin/keys/workspace.pub
# It's added to ~/.ssh/authorized_keys so that it only works from that address, can't open a shell or
# forward anything, and only runs ~/.local/libexec/gaidin-workspace. Needs bwrap and python3.
set -eu

key=""
from=""
author="gaidin"
while [ $# -gt 0 ]; do
	case "$1" in
	--key) key=$2; shift 2 ;;
	--from) from=$2; shift 2 ;;
	--author) author=$2; shift 2 ;;
	--) shift; break ;;
	-*) echo "unknown option $1" >&2; exit 2 ;;
	*) break ;;
	esac
done
if [ -z "$key" ] || [ -z "$from" ] || [ $# -eq 0 ]; then
	echo 'usage: install.sh --key "<public key>" --from <address> ROOT...' >&2
	exit 2
fi
case "$key" in ssh-ed25519\ *|ssh-rsa\ *|ecdsa-*) ;; *) echo "--key doesn't look like a public key" >&2; exit 2 ;; esac
command -v bwrap >/dev/null || { echo "bwrap isn't installed" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 isn't installed" >&2; exit 1; }

here=$(cd "$(dirname "$0")" && pwd)
helper="$HOME/.local/libexec/gaidin-workspace"
install -d -m 755 "$HOME/.local/libexec"
install -m 755 "$here/gaidin-workspace.py" "$helper"

# Tools that live under the home aren't visible to commands unless listed, read-only.
config_dir="$HOME/.config/gaidin-workspace"
install -d -m 700 "$config_dir"
python3 -I - "$config_dir/config.json" "$author" "$@" <<'EOF'
import json, os, shutil, sys
target, author, *roots = sys.argv[1:]
home = os.path.expanduser("~")
roots = [os.path.realpath(r) for r in roots]
for root in roots:
    if not os.path.isdir(root):
        sys.exit(f"{root} isn't a directory")
read_only, path = [], []
for tool in ("node", "pnpm", "npm", "uv", "cargo", "go", "deno", "bun"):
    found = shutil.which(tool)
    if not found:
        continue
    real = os.path.realpath(found)
    if not real.startswith(home + os.sep) or any(real.startswith(r + os.sep) for r in roots):
        continue
    bin_dir = os.path.dirname(found)
    prefix = os.path.dirname(os.path.dirname(real))
    if prefix not in read_only:
        read_only.append(prefix)
    if bin_dir not in path:
        path.append(bin_dir)
with open(target, "w") as file:
    json.dump({"roots": roots, "readOnly": read_only, "path": path, "author": author}, file, indent=2)
print(json.dumps({"roots": roots, "readOnly": read_only, "path": path}, indent=2))
EOF

ssh_dir="$HOME/.ssh"
install -d -m 700 "$ssh_dir"
touch "$ssh_dir/authorized_keys"
chmod 600 "$ssh_dir/authorized_keys"
line="restrict,from=\"$from\",command=\"$helper\" $key"
body=$(printf '%s' "$key" | cut -d' ' -f2)
# Replace an earlier line for the same key, then add this one.
grep -v -F "$body" "$ssh_dir/authorized_keys" > "$ssh_dir/authorized_keys.new" || true
printf '%s\n' "$line" >> "$ssh_dir/authorized_keys.new"
chmod 600 "$ssh_dir/authorized_keys.new"
mv "$ssh_dir/authorized_keys.new" "$ssh_dir/authorized_keys"

echo "Installed. gaidin can reach this machine once sshd accepts connections from $from;"
echo "with ufw, for example: sudo ufw allow from $from to any port 22 proto tcp"
