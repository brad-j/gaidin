#!/usr/bin/python3 -I
"""gaidin's hands on a workspace: a machine where it works on someone's projects as their user, reached
only through a forced-command SSH key from the gaidin server.

deploy/workspace/install.sh puts this in ~/.local/libexec/gaidin-workspace, outside the projects, so
nothing gaidin runs can change it, and writes its config to ~/.config/gaidin-workspace/config.json:

  roots     directories gaidin can read and write (required)
  readOnly  more directories commands can see, read-only, such as a Node install under the home
  path      directories put first on commands' PATH
  author    the name on commits gaidin makes; the email is the user's own (default "gaidin")

The operation is SSH_ORIGINAL_COMMAND; its request is the first line of stdin, as JSON.

  run    {cwd, command, timeout}  a bash command under bubblewrap. Exit status is the command's.
  read   {path, offset, limit}    a text file's lines, or a directory's entries
  write  {path, content}          create or replace a file
  edit   {path, edits}            replace each oldText, which must occur exactly once

Commands see the roots read-write, with secret files masked and every repo's config and hooks read-only,
submodules' and worktrees' included, the readOnly directories, a scratch home of their own, and the network. Nothing else of the
user's home is there, so no SSH keys or tokens for pushing. The file operations refuse paths outside the
roots, secret files and anything inside .git. Runs share a lock that file operations take alone, so no
command can swap a path for a symlink mid-check.
"""

import fcntl
import json
import os
import re
import signal
import subprocess
import sys
import threading

HOME = os.path.expanduser("~")
CONFIG = os.path.join(HOME, ".config", "gaidin-workspace", "config.json")
STATE = os.path.join(HOME, ".local", "state", "gaidin-workspace")
SCRATCH_HOME = os.path.join(HOME, ".local", "share", "gaidin-workspace", "home")
MAX_OUTPUT = 400 * 1024
MAX_READ = 2 * 1024 * 1024

ROOTS: list = []
READ_ONLY: list = []
EXTRA_PATH: list = []
AUTHOR = "gaidin"

SECRET = re.compile(
    r"^(\.env(\..+)?|\.envrc|\.netrc|\.npmrc|\.pypirc|credentials.*|secrets?\.(json|ya?ml|toml)|id_(rsa|ed25519|ecdsa|dsa)(\.pub)?"
    r"|.*\.(pem|key|p12|pfx|keystore|jks))$",
    re.IGNORECASE,
)
NOT_SECRET = re.compile(r"\.(example|sample|template|dist)$", re.IGNORECASE)
# Not walked when looking for secrets and repos: big, and generated.
SKIP = {"node_modules", ".venv", "venv", "target", "dist", "build", ".cache", "__pycache__", ".pnpm-store", ".next", ".astro"}


class Refused(Exception):
    pass


def load_config():
    global ROOTS, READ_ONLY, EXTRA_PATH, AUTHOR
    with open(CONFIG) as file:
        config = json.load(file)
    real = lambda paths: [os.path.realpath(os.path.expanduser(p)) for p in paths]
    ROOTS = [p for p in real(config["roots"]) if os.path.isdir(p)]
    if not ROOTS:
        raise ValueError(f"{CONFIG} lists no existing roots")
    READ_ONLY = [p for p in real(config.get("readOnly", [])) if os.path.isdir(p)]
    EXTRA_PATH = real(config.get("path", []))
    AUTHOR = config.get("author", AUTHOR)


def is_secret(name: str) -> bool:
    return bool(SECRET.match(name)) and not NOT_SECRET.search(name)


def confine(path: str) -> str:
    """The real path, symlinks resolved, if it's inside a root and not secret or inside .git."""
    absolute = os.path.normpath(path if os.path.isabs(path) else os.path.join(ROOTS[0], path))
    real = os.path.realpath(absolute)
    root = next((r for r in ROOTS if real == r or real.startswith(r + os.sep)), None)
    if root is None:
        raise Refused(f"{path} is outside {', '.join(ROOTS)}")
    parts = os.path.relpath(real, root).split(os.sep)
    if ".git" in parts:
        raise Refused(f"{path} is inside .git; use git through run")
    if any(is_secret(part) for part in parts):
        raise Refused(f"{path} looks like a secret file and is off limits")
    return real


def git_dirs(git: str) -> list:
    """A repository's git directory and the ones inside it: its submodules' (modules/) and worktrees' (worktrees/)."""
    found = [git]
    for kind in ("modules", "worktrees"):
        for directory, dirs, files in os.walk(os.path.join(git, kind)):
            if "HEAD" in files:
                found.append(directory)
            dirs[:] = [d for d in dirs if d not in ("objects", "refs", "logs", "hooks", "info")]
    return found


def walk():
    """Secret files to mask, and git directories, under the roots."""
    secrets, gits = [], []
    for root in ROOTS:
        for directory, dirs, files in os.walk(root):
            if ".git" in dirs:
                gits += git_dirs(os.path.join(directory, ".git"))
            dirs[:] = [d for d in dirs if d not in SKIP and d != ".git"]
            secrets += [os.path.join(directory, f) for f in files if is_secret(f)]
    return secrets, gits


def git_identity() -> dict:
    def get(key):
        result = subprocess.run(["git", "config", "--global", key], capture_output=True, text=True)
        return result.stdout.strip()
    name, email = get("user.name") or os.environ.get("USER", "user"), get("user.email")
    return {
        "GIT_AUTHOR_NAME": AUTHOR, "GIT_AUTHOR_EMAIL": email,
        "GIT_COMMITTER_NAME": name, "GIT_COMMITTER_EMAIL": email,
    }


def bwrap_args(cwd: str) -> list:
    args = ["bwrap", "--unshare-all", "--share-net", "--die-with-parent", "--new-session", "--clearenv"]
    args += ["--ro-bind", "/usr", "/usr", "--ro-bind", "/etc", "/etc", "--ro-bind-try", "/opt", "/opt"]
    for top in ("/bin", "/sbin", "/lib", "/lib64"):
        if os.path.islink(top):
            args += ["--symlink", os.readlink(top), top]
        elif os.path.isdir(top):
            args += ["--ro-bind", top, top]
    # DNS: /etc/resolv.conf often points into systemd-resolved's runtime directory.
    args += ["--ro-bind-try", "/run/systemd/resolve", "/run/systemd/resolve"]
    args += ["--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp"]
    for root in ROOTS:
        args += ["--bind", root, root]
    for path in READ_ONLY:
        args += ["--ro-bind", path, path]
    args += ["--bind", SCRATCH_HOME, SCRATCH_HOME]
    secrets, gits = walk()
    for path in secrets:
        args += ["--ro-bind", "/dev/null", path]
    # Each can run commands the next time the user runs git, and a diff doesn't show them. A missing hooks
    # directory is made first, so a command can't add one.
    for git in gits:
        os.makedirs(os.path.join(git, "hooks"), exist_ok=True)
        for name in ("config", "config.worktree", "hooks"):
            if os.path.exists(os.path.join(git, name)):
                args += ["--ro-bind", os.path.join(git, name), os.path.join(git, name)]
    env = {
        "HOME": SCRATCH_HOME,
        "PATH": ":".join([*EXTRA_PATH, "/usr/local/bin", "/usr/bin", "/bin"]),
        "LANG": "C.UTF-8",
        "TERM": "dumb",
        "npm_config_store_dir": os.path.join(SCRATCH_HOME, "pnpm-store"),
        **git_identity(),
    }
    for key, value in env.items():
        args += ["--setenv", key, value]
    return args + ["--chdir", cwd]


def run(request: dict) -> int:
    cwd = confine(request.get("cwd") or ROOTS[0])
    if not os.path.isdir(cwd):
        raise Refused(f"{cwd} isn't a directory")
    command = request["command"]
    timeout = min(max(int(request.get("timeout", 120)), 1), 1800)
    process = subprocess.Popen(
        [*bwrap_args(cwd), "--", "bash", "-c", command],
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True,
    )

    def stop():
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass

    # gaidin keeps stdin open while it waits; when it goes away, so does the command.
    def watch_stdin():
        # The raw descriptor: a thread blocked in sys.stdin would hold its lock while Python exits.
        while os.read(0, 65536):
            pass
        stop()
    threading.Thread(target=watch_stdin, daemon=True).start()
    timer = threading.Timer(timeout, stop)
    timer.start()
    # Streamed as it comes, so gaidin can show it live; only the tail is kept past the limit.
    sent = 0
    while chunk := process.stdout.read1(65536):
        if sent < MAX_OUTPUT:
            sys.stdout.buffer.write(chunk[: MAX_OUTPUT - sent])
            sys.stdout.buffer.flush()
        sent += len(chunk)
    code = process.wait()
    timed_out = not timer.is_alive()
    timer.cancel()
    if sent > MAX_OUTPUT:
        sys.stdout.write(f"\n[output stopped at {MAX_OUTPUT} of {sent} bytes]\n")
    if timed_out:
        sys.stdout.write(f"\n[stopped after {timeout}s]\n")
        return 124
    return code if code >= 0 else 128 - code


def read(request: dict) -> dict:
    path = confine(request["path"])
    if os.path.isdir(path):
        entries = sorted(os.listdir(path))
        shown = [e + ("/" if os.path.isdir(os.path.join(path, e)) else "") for e in entries if not is_secret(e)]
        return {"ok": True, "path": path, "directory": shown}
    if os.path.getsize(path) > MAX_READ:
        raise Refused(f"{path} is over {MAX_READ} bytes; use run with head, tail or grep")
    with open(path, "rb") as file:
        data = file.read()
    if b"\0" in data[:8192]:
        raise Refused(f"{path} isn't text")
    lines = data.decode(errors="replace").splitlines()
    offset = max(int(request.get("offset", 1)), 1)
    limit = min(max(int(request.get("limit", 2000)), 1), 5000)
    return {"ok": True, "path": path, "totalLines": len(lines), "offset": offset, "text": "\n".join(lines[offset - 1:offset - 1 + limit])}


def write(request: dict) -> dict:
    path = confine(request["path"])
    if os.path.isdir(path):
        raise Refused(f"{path} is a directory")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    existed = os.path.exists(path)
    with open(path, "w", encoding="utf-8") as file:
        file.write(request["content"])
    return {"ok": True, "path": path, "created": not existed, "bytes": len(request["content"].encode())}


def edit(request: dict) -> dict:
    path = confine(request["path"])
    with open(path, encoding="utf-8") as file:
        text = file.read()
    for number, change in enumerate(request["edits"], 1):
        count = text.count(change["oldText"])
        if count != 1:
            raise Refused(f"edit {number}: oldText occurs {count} times in {path}; it must occur exactly once")
    for change in request["edits"]:
        text = text.replace(change["oldText"], change["newText"], 1)
    with open(path, "w", encoding="utf-8") as file:
        file.write(text)
    return {"ok": True, "path": path, "edits": len(request["edits"])}


def read_line() -> str:
    """The request line, read from the raw descriptor so nothing past it is buffered away from run's watcher."""
    data = b""
    while not data.endswith(b"\n"):
        chunk = os.read(0, 1)
        if not chunk:
            break
        data += chunk
    return data.decode()


def main() -> int:
    operation = os.environ.get("SSH_ORIGINAL_COMMAND", "").strip()
    handlers = {"read": read, "write": write, "edit": edit}
    if operation not in (*handlers, "run"):
        print(json.dumps({"ok": False, "error": "operations: run, read, write, edit"}))
        return 2
    os.makedirs(STATE, exist_ok=True)
    os.makedirs(SCRATCH_HOME, exist_ok=True)
    lock = open(os.path.join(STATE, "lock"), "w")
    try:
        load_config()
        request = json.loads(read_line())
        if operation == "run":
            fcntl.flock(lock, fcntl.LOCK_SH)
            code = run(request)
            # Exit now, without waiting on the stdin thread.
            sys.stdout.flush()
            os._exit(code)
        fcntl.flock(lock, fcntl.LOCK_EX)
        print(json.dumps(handlers[operation](request)))
        return 0
    except Refused as refused:
        message = str(refused)
    except (OSError, ValueError, KeyError, TypeError, UnicodeDecodeError) as error:
        message = f"{type(error).__name__}: {error}"
    if operation == "run":
        sys.stdout.write(f"[refused] {message}\n")
        sys.stdout.flush()
        os._exit(126)
    print(json.dumps({"ok": False, "error": message}))
    return 1


if __name__ == "__main__":
    sys.exit(main())
