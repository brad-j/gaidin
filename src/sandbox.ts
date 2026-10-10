// The tools' environment. Everything they touch stays inside one directory, the sandbox:
//
// - Shell commands run under bubblewrap: only the sandbox is writable, /usr, /etc and /opt are
//   read-only, and the rest of the file system isn't there, including the data directory with the
//   SQLite file and the Unix socket, and the app's own code. They get their own process tree, so the
//   server's /proc/<pid>/environ is out of reach, and no network, so the web view's loopback port
//   and anything outside are too. Background processes die with the command.
// - The file tools run in the server process, so every path they use is resolved through symlinks
//   and refused if it lands outside the sandbox. Temp files, such as a long command's full output,
//   go in the sandbox's .tmp so the model can still read them.
//
// A shell command could swap a directory for a symlink between a file tool's check and its use. Shell
// commands share one lock and file operations take it alone, and nothing in the sandbox outlives its
// command, so nothing can change the sandbox in that gap. Redaction (redact.ts) still applies on top.
import { AsyncLocalStorage } from "node:async_hooks";
import { realpathSync, statSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readlink, realpath } from "node:fs/promises";
import { basename, delimiter, dirname, join, sep } from "node:path";
import type { Context } from "@earendil-works/chord";
import { err, ExecutionError, FileError, ok, type Result, type ShellExecOptions, type WatchChange, type WatchTarget } from "@earendil-works/pi-durable/env";
import { RedactingEnv, type Redactor } from "./redact.ts";

/** bubblewrap on PATH, or undefined. */
export function findBwrap(path = process.env.PATH ?? ""): string | undefined {
	for (const dir of path.split(delimiter)) {
		const candidate = join(dir, "bwrap");
		try {
			if (statSync(candidate).isFile()) return candidate;
		} catch {}
	}
	return undefined;
}

/** bwrap's arguments for a command run in `cwd`, with `root` the only writable place. */
export async function bwrapArgs(root: string, cwd: string): Promise<string[]> {
	const args = ["--unshare-all", "--die-with-parent", "--new-session", "--ro-bind", "/usr", "/usr"];
	// Merged-/usr systems make these symlinks into /usr; keep them as they are on the host.
	for (const top of ["/bin", "/sbin", "/lib", "/lib64"]) {
		const info = await lstat(top).catch(() => undefined);
		if (info?.isSymbolicLink()) args.push("--symlink", await readlink(top), top);
		else if (info?.isDirectory()) args.push("--ro-bind", top, top);
	}
	// The tmpfs comes before the sandbox's bind, so a sandbox under /tmp (as in tests) still shows.
	args.push("--ro-bind", "/etc", "/etc", "--ro-bind-try", "/opt", "/opt", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp");
	args.push("--bind", root, root, "--chdir", cwd, "--setenv", "HOME", root);
	return args;
}

/**
 * A readers-writer lock, first come first served, so a stream of commands can't starve a file operation.
 * Reentrant: the base class's file methods call each other, and a nested call runs under the holder's lock.
 */
class SandboxLock {
	#shared = 0;
	#exclusive = false;
	readonly #waiting: { exclusive: boolean; resolve: () => void }[] = [];
	readonly #held = new AsyncLocalStorage<"shared" | "exclusive">();

	async run<T>(exclusive: boolean, task: () => Promise<T>): Promise<T> {
		const held = this.#held.getStore();
		if (held === "exclusive" || (held === "shared" && !exclusive)) return task();
		if (held === "shared") throw new Error("A file operation inside a shell command would wait for itself");
		if (this.#waiting.length === 0 && this.#free(exclusive)) this.#take(exclusive);
		else await new Promise<void>((resolve) => this.#waiting.push({ exclusive, resolve }));
		try {
			return await this.#held.run(exclusive ? "exclusive" : "shared", task);
		} finally {
			if (exclusive) this.#exclusive = false;
			else this.#shared -= 1;
			while (this.#waiting.length > 0 && this.#free(this.#waiting[0]!.exclusive)) {
				const next = this.#waiting.shift()!;
				this.#take(next.exclusive);
				next.resolve();
			}
		}
	}

	#free(exclusive: boolean): boolean {
		return !this.#exclusive && (!exclusive || this.#shared === 0);
	}

	#take(exclusive: boolean) {
		if (exclusive) this.#exclusive = true;
		else this.#shared += 1;
	}
}

/** One per process: environments are made per tool call, and every conversation shares the sandbox. */
const lock = new SandboxLock();

function inside(path: string, root: string): boolean {
	return path === root || path.startsWith(root + sep);
}

type FileResult<T> = Promise<Result<T, FileError>>;

export class SandboxEnv extends RedactingEnv {
	/** The sandbox directory, with symlinks resolved. */
	readonly root: string;
	readonly #bwrap: string | undefined;

	/** Without `bwrap`, shell commands run unconfined; only tests and local runs that ask for it do that. */
	constructor(options: { root: string; cwd?: string; redactor: Redactor; bwrap: string | undefined }) {
		const root = realpathSync(options.root);
		const cwd = options.cwd === undefined ? root : realpathSync(options.cwd);
		if (!inside(cwd, root)) throw new Error(`The working directory ${options.cwd} is outside the sandbox ${root}`);
		super({ cwd, redactor: options.redactor });
		this.root = root;
		this.#bwrap = options.bwrap;
	}

	/** The real path of `path`, following every symlink that exists so far, if it's inside the sandbox. */
	async #confine(path: string, context: Context): FileResult<string> {
		const absolute = await super.absolutePath(path, context);
		if (!absolute.ok) return absolute;
		let existing = absolute.value;
		const missing: string[] = [];
		for (;;) {
			try {
				existing = await realpath(existing);
				break;
			} catch {
				const parent = dirname(existing);
				if (parent === existing) break;
				missing.unshift(basename(existing));
				existing = parent;
			}
		}
		const real = join(existing, ...missing);
		if (inside(real, this.root)) return ok(real);
		return err(new FileError("permission_denied", `${path} is outside the sandbox (${this.root}); tools can only use files there`, path));
	}

	#at<T>(path: string, context: Context, run: (real: string) => FileResult<T>): FileResult<T> {
		return lock.run(true, async () => {
			const real = await this.#confine(path, context);
			return real.ok ? run(real.value) : real;
		});
	}

	override async exec(command: string | readonly string[], options: ShellExecOptions | undefined, context: Context): ReturnType<RedactingEnv["exec"]> {
		return lock.run(false, async () => {
			const cwd = await this.#confine(options?.cwd ?? this.cwd, context);
			if (!cwd.ok) return err(new ExecutionError("spawn_error", cwd.error.message));
			if (this.#bwrap === undefined) return super.exec(command, { ...options, cwd: cwd.value }, context);
			const inner = typeof command === "string" ? ["bash", "-c", command] : [...command];
			const argv = [this.#bwrap, ...(await bwrapArgs(this.root, cwd.value)), "--", ...inner];
			return super.exec(argv, { ...options, cwd: cwd.value }, context);
		});
	}

	override async createTempDir(prefix: string | undefined, _context: Context): FileResult<string> {
		try {
			const base = join(this.root, ".tmp");
			await mkdir(base, { recursive: true });
			return ok(await mkdtemp(join(base, prefix ?? "tmp-")));
		} catch (error) {
			return err(new FileError("unknown", `Couldn't create a temp directory: ${error instanceof Error ? error.message : error}`));
		}
	}

	override readTextFile(path: string, context: Context) {
		return this.#at(path, context, (p) => super.readTextFile(p, context));
	}
	override openTextLineReader(path: string, context: Context) {
		return this.#at(path, context, (p) => super.openTextLineReader(p, context));
	}
	override readTextLines(path: string, options: { maxLines?: number } | undefined, context: Context) {
		return this.#at(path, context, (p) => super.readTextLines(p, options, context));
	}
	override readBinaryFile(path: string, context: Context) {
		return this.#at(path, context, (p) => super.readBinaryFile(p, context));
	}
	override openBinaryReader(path: string, options: { noFollow?: boolean } | undefined, context: Context) {
		return this.#at(path, context, (p) => super.openBinaryReader(p, options, context));
	}
	override writeFile(path: string, content: string | Uint8Array, context: Context) {
		return this.#at(path, context, (p) => super.writeFile(p, content, context));
	}
	override appendFile(path: string, content: string | Uint8Array, context: Context) {
		return this.#at(path, context, (p) => super.appendFile(p, content, context));
	}
	override truncateFile(path: string, size: number, context: Context) {
		return this.#at(path, context, (p) => super.truncateFile(p, size, context));
	}
	override flushFile(path: string, context: Context) {
		return this.#at(path, context, (p) => super.flushFile(p, context));
	}
	override renameFile(source: string, destination: string, context: Context) {
		return lock.run(true, async () => {
			const from = await this.#confine(source, context);
			if (!from.ok) return from;
			const to = await this.#confine(destination, context);
			return to.ok ? super.renameFile(from.value, to.value, context) : to;
		});
	}
	override fileInfo(path: string, context: Context) {
		return this.#at(path, context, (p) => super.fileInfo(p, context));
	}
	override listDir(path: string, context: Context) {
		return this.#at(path, context, (p) => super.listDir(p, context));
	}
	override openDirReader(path: string, context: Context) {
		return this.#at(path, context, (p) => super.openDirReader(p, context));
	}
	override canonicalPath(path: string, context: Context) {
		return this.#at(path, context, (p) => super.canonicalPath(p, context));
	}
	override exists(path: string, context: Context) {
		return this.#at(path, context, (p) => super.exists(p, context));
	}
	override createDir(path: string, options: { recursive?: boolean } | undefined, context: Context) {
		return this.#at(path, context, (p) => super.createDir(p, options, context));
	}
	override remove(path: string, options: { recursive?: boolean; force?: boolean } | undefined, context: Context) {
		return this.#at(path, context, (p) => super.remove(p, options, context));
	}
	override watch(targets: readonly WatchTarget[], onChange: (change: WatchChange) => void, context: Context) {
		return lock.run(true, async () => {
			const confined: WatchTarget[] = [];
			for (const target of targets) {
				const real = await this.#confine(target.path, context);
				if (!real.ok) return err<never, FileError>(real.error);
				confined.push({ ...target, path: real.value });
			}
			return super.watch(confined, onChange, context);
		});
	}
}
