// Workspaces: machines where gaidin works on projects as their user, such as a desktop. Each one is a
// name and an SSH target, listed in the keys directory's `workspaces` file, one per line:
//
//   egwene brad@192.168.1.36
//
// The server connects with the `workspace` key, checking host keys against `workspaces_known_hosts`
// (deploy/vm/add-workspace.sh writes both). On the machine, the key only runs
// deploy/workspace/gaidin-workspace.py, which confines everything to the roots it's configured with.
// Every call waits for the owner's approval (approvals.ts) unless they allowed that workspace for an hour in
// the conversation. With no workspaces listed there are no workspace tools.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { type Redactor, redactingStream } from "./redact.ts";

export type Workspace = { name: string; target: string };
export type Operation = "run" | "read" | "write" | "edit";

/** Sends one request to a workspace's helper. `run` streams through onOutput and resolves with the exit code. */
export type Remote = (
	workspace: Workspace,
	operation: Operation,
	request: object,
	options: { signal?: AbortSignal; onOutput?: (text: string) => void },
) => Promise<{ code: number; output: string }>;

export function readWorkspaces(dir: string): Workspace[] {
	const file = join(dir, "workspaces");
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "" && !line.startsWith("#"))
		.map((line) => {
			const [name, target] = line.split(/\s+/);
			if (!name || !target || !/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`Bad line in ${file}: ${line}`);
			return { name, target };
		});
}

export function sshRemote(dir: string): Remote | undefined {
	const key = join(dir, "workspace");
	if (!existsSync(key)) return undefined;
	return (workspace, operation, request, { signal, onOutput }) =>
		new Promise((resolve, reject) => {
			const child = spawn("ssh", [
				"-F", "/dev/null", "-T",
				"-i", key,
				"-o", "IdentitiesOnly=yes",
				"-o", "BatchMode=yes",
				"-o", "StrictHostKeyChecking=yes",
				"-o", `UserKnownHostsFile=${join(dir, "workspaces_known_hosts")}`,
				"-o", "ConnectTimeout=8",
				"-o", "ServerAliveInterval=30",
				workspace.target,
				operation,
			], { stdio: ["pipe", "pipe", "pipe"] });
			let output = "";
			let errors = "";
			child.stdout.setEncoding("utf8").on("data", (text: string) => {
				output += text;
				onOutput?.(text);
			});
			child.stderr.setEncoding("utf8").on("data", (text: string) => (errors += text));
			child.stdin.on("error", () => {});
			child.stdin.write(`${JSON.stringify(request)}\n`);
			// A run keeps stdin open: closing it is how the helper learns to stop the command.
			if (operation !== "run") child.stdin.end();
			const abort = () => {
				child.stdin.end();
				setTimeout(() => child.kill("SIGKILL"), 3000).unref();
			};
			if (signal?.aborted) abort();
			else signal?.addEventListener("abort", abort, { once: true });
			child.once("error", reject);
			child.once("close", (code) => {
				signal?.removeEventListener("abort", abort);
				if (signal?.aborted) return reject(signal.reason ?? new Error("stopped"));
				// 255 with nothing from the helper is ssh failing to connect or authenticate.
				if (code === 255 && output === "") return reject(new Error(`Couldn't reach ${workspace.name}: ${errors.trim() || "ssh failed"}`));
				resolve({ code: code ?? 1, output });
			});
		});
}

/** A file operation's JSON answer, or its error as a thrown Error. */
function answer(output: string): Record<string, any> {
	let parsed: Record<string, any>;
	try {
		parsed = JSON.parse(output);
	} catch {
		throw new Error(`Unexpected answer from the workspace: ${output.slice(0, 500)}`);
	}
	if (parsed.ok !== true) throw new Error(String(parsed.error));
	return parsed;
}

export function createWorkspaces(options: { workspaces: Workspace[]; remote: Remote | undefined; redactor: Redactor; owner: string }) {
	const { workspaces, remote, redactor, owner } = options;
	const asks = `Each call waits for ${owner}'s approval.`;
	const names = workspaces.map((w) => w.name);
	const find = (name: string) => {
		const workspace = workspaces.find((w) => w.name === name);
		if (workspace === undefined) throw new Error(`No workspace ${name}; one of ${names.join(", ")}`);
		return workspace;
	};
	const workspaceParam = Type.String({ description: `One of: ${names.join(", ")}` });
	const pathParam = Type.String({ description: "Relative to the workspace's first root, or absolute inside a root" });

	const run = defineTool({
		name: "workspace_run",
		description:
			`Run a bash command on one of ${owner}'s machines (${names.join(", ")}), as ${owner}'s user, in their projects: tests, builds, git, ` +
			"package installs. Only the workspace's project roots are writable, secret files are hidden, and there's network " +
			`but no SSH keys or tokens, so git push won't work. Commits are authored by gaidin. ${asks}`,
		parameters: Type.Object({
			workspace: workspaceParam,
			command: Type.String(),
			cwd: Type.Optional(pathParam),
			timeout: Type.Optional(Type.Number({ minimum: 1, maximum: 1800, description: "Seconds; default 120" })),
		}),
		execute: async (args, api, context) => {
			const workspace = find(args.workspace);
			// Streamed, and redacted on the way, so the live output never holds gaidin's own secrets.
			const stream = redactingStream(redactor, (text) => api.output(text));
			const signals = [context.abortSignal].filter((s) => s !== undefined);
			const { code } = await remote!(workspace, "run", { command: args.command, cwd: args.cwd, timeout: args.timeout }, {
				signal: signals.length > 0 ? AbortSignal.any(signals) : undefined,
				onOutput: (text) => stream.write(text, { stream: "stdout" }),
			});
			stream.end();
			api.diagnostic({ severity: code === 0 ? "info" : "error", code: "exit_code", message: `Exit code ${code}` });
			return { isError: code !== 0 };
		},
	});

	const read = defineTool({
		name: "workspace_read",
		description: `Read a text file, or list a directory, in a workspace's projects. ${asks}`,
		parameters: Type.Object({
			workspace: workspaceParam,
			path: pathParam,
			offset: Type.Optional(Type.Number({ minimum: 1, description: "First line, from 1" })),
			limit: Type.Optional(Type.Number({ minimum: 1, maximum: 5000, description: "Default 2000 lines" })),
		}),
		replay: "safe",
		execute: async (args) => {
			const result = answer((await remote!(find(args.workspace), "read", { path: args.path, offset: args.offset, limit: args.limit }, {})).output);
			if (result.directory !== undefined) return { content: [{ type: "text", text: `${result.path}/\n${(result.directory as string[]).join("\n")}` }] };
			const last = Math.min(result.offset + (result.text === "" ? 0 : result.text.split("\n").length) - 1, result.totalLines);
			const text = `${result.path} (lines ${result.offset}-${last} of ${result.totalLines})\n${result.text}`;
			return { content: [{ type: "text", text }] };
		},
	});

	const write = defineTool({
		name: "workspace_write",
		description: `Create or replace a file in a workspace's projects. ${asks}`,
		parameters: Type.Object({ workspace: workspaceParam, path: pathParam, content: Type.String() }),
		execute: async (args) => {
			const result = answer((await remote!(find(args.workspace), "write", { path: args.path, content: args.content }, {})).output);
			return { content: [{ type: "text", text: `${result.created ? "Created" : "Replaced"} ${result.path} (${result.bytes} bytes)` }] };
		},
	});

	const edit = defineTool({
		name: "workspace_edit",
		description: `Edit a file in a workspace's projects: each oldText must occur exactly once and is replaced by newText. ${asks}`,
		parameters: Type.Object({
			workspace: workspaceParam,
			path: pathParam,
			edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() }), { minItems: 1 }),
		}),
		execute: async (args) => {
			const result = answer((await remote!(find(args.workspace), "edit", { path: args.path, edits: args.edits }, {})).output);
			return { content: [{ type: "text", text: `Edited ${result.path} (${result.edits} changes)` }] };
		},
	});

	const tools: ToolRegistration[] = workspaces.length === 0 || remote === undefined ? [] : [run, read, write, edit];
	return {
		tools,
		extension: defineExtension({
			name: "workspaces",
			tools,
		}),
	};
}
