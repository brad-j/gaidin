// Workspaces: machines where gaidin works on projects as their user, such as a desktop. Each one is a
// name and an SSH target, listed in the keys directory's `workspaces` file, one per line:
//
//   egwene brad@192.168.1.36
//
// The server connects with the `workspace` key, checking host keys against `workspaces_known_hosts`
// (deploy/vm/add-workspace.sh writes both). On the machine, the key only runs
// deploy/workspace/gaidin-workspace.py, which confines everything to the roots it's configured with.
// Every call waits for the owner's approval (`workspaceGuards`) unless they allowed that workspace for an
// hour in the conversation. With no workspaces listed there are no workspace tools.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { Context } from "@earendil-works/chord";
import { defineExtension, defineTool, type DocumentReader, type ToolRegistration } from "@earendil-works/pi-durable";
import { type Ask, clip, guard, type Guard, type Situation, type Where, whole } from "./guards.ts";
import { array, boolean, integer, object, optional, ParseError, type Parser, parseJson, string } from "./parse.ts";
import { type Redactor, redactingStream } from "./redact.ts";

export type Workspace = { name: string; target: string };
export type Operation = "run" | "read" | "write" | "edit";
/** What an operation sends the helper, as deploy/workspace/gaidin-workspace.py reads it. */
export type HelperRequest =
	| { command: string; cwd?: string; timeout?: number }
	| { path: string; offset?: number; limit?: number }
	| { path: string; content: string }
	| { path: string; edits: { oldText: string; newText: string }[] };

/** Sends one request to a workspace's helper. `run` streams through onOutput and resolves with the exit code. */
export type Remote = (
	workspace: Workspace,
	operation: Operation,
	request: HelperRequest,
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

/** What the helper answers a read with: a directory's entries, or some of a file's lines. */
export const readAnswer = object({ path: string, directory: optional(array(string)), offset: optional(integer), totalLines: optional(integer), text: optional(string) });

/** A file operation's JSON answer as `parser` has it, or the helper's refusal as a thrown Error. */
export function answer<T>(output: string, parser: Parser<T>): T {
	try {
		const { ok, error } = parseJson(output, object({ ok: boolean, error: optional(string) }), "the workspace's answer");
		if (!ok) throw new Error(error ?? "the workspace refused");
		return parseJson(output, parser, "the workspace's answer");
	} catch (error) {
		if (error instanceof ParseError) throw new Error(`Unexpected answer from the workspace (${error.message}): ${output.slice(0, 500)}`);
		throw error;
	}
}

/** A workspace_edit's changes, each old text and its replacement, as the owner is asked about them. */
function editsDetail(edits: readonly { oldText: string; newText: string }[]): string {
	const lines = (text: string, mark: string) => text.split("\n").map((line) => `${mark} ${line}`);
	return edits.map((e, i) => [`Change ${i + 1}:`, ...lines(e.oldText, "-"), ...lines(e.newText, "+")].join("\n")).join("\n\n");
}

/**
 * Every workspace call asks, showing all of what it allows, unless the owner allowed that workspace for an hour in this
 * conversation. A workspace taken out of the settings, or one the calling agent wasn't given, isn't put to the owner.
 * Reads and runs return text from outside.
 */
function workspaceGuards(names: readonly string[]): Guard[] {
	const refuse = (a: { workspace: string }, _read: DocumentReader, _context: Context, where: Where) => {
		const given = where.agent.workspaces;
		const usable = given === undefined ? names : names.filter((n) => given.includes(n));
		if (usable.includes(a.workspace)) return undefined;
		if (names.includes(a.workspace)) return `${where.agent.name} hasn't been given the workspace ${a.workspace}; ${usable.length === 0 ? "it has none" : `it has ${usable.join(", ")}`}.`;
		return `No workspace ${a.workspace}; one of ${usable.join(", ") || "none"}`;
	};
	const unlessAllowed = (a: { workspace: string }, situation: Situation, ask: Ask): Ask | undefined => {
		const now = Date.now();
		if (situation.grants.some((g) => g.workspace === a.workspace && g.conversationId === situation.conversationId && g.until > now)) return undefined;
		return { ...ask, always: { kind: "workspace-hour", value: a.workspace, label: `Allow ${a.workspace} for an hour here`, done: `Allowed ${a.workspace} for an hour` } };
	};
	return [
		guard("workspace_run", object({ workspace: string, command: string, cwd: optional(string) }), {
			refuse,
			ask: (a, situation) => unlessAllowed(a, situation, whole(`run on ${a.workspace}${a.cwd ? ` in ${a.cwd}` : ""}: ${clip(a.command)}`, clip(a.command), a.command)),
			outside: true,
		}),
		guard("workspace_read", object({ workspace: string, path: string }), {
			refuse,
			ask: (a, situation) => unlessAllowed(a, situation, { summary: `read ${a.path} on ${a.workspace}` }),
			outside: true,
		}),
		guard("workspace_write", object({ workspace: string, path: string, content: string }), {
			refuse,
			ask: (a, situation) => unlessAllowed(a, situation, { summary: `write ${a.path} on ${a.workspace} (${a.content.length} characters)`, detail: a.content }),
		}),
		guard("workspace_edit", object({ workspace: string, path: string, edits: array(object({ oldText: string, newText: string })) }), {
			refuse,
			ask: (a, situation) => unlessAllowed(a, situation, { summary: `edit ${a.path} on ${a.workspace} (${a.edits.length} changes)`, detail: editsDetail(a.edits) }),
		}),
	];
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
			const result = answer((await remote!(find(args.workspace), "read", { path: args.path, offset: args.offset, limit: args.limit }, {})).output, readAnswer);
			if (result.directory !== undefined) return { content: [{ type: "text", text: `${result.path}/\n${result.directory.join("\n")}` }] };
			const { offset = 1, totalLines = 0, text: lines = "" } = result;
			const last = Math.min(offset + (lines === "" ? 0 : lines.split("\n").length) - 1, totalLines);
			const text = `${result.path} (lines ${offset}-${last} of ${totalLines})\n${lines}`;
			return { content: [{ type: "text", text }] };
		},
	});

	const write = defineTool({
		name: "workspace_write",
		description: `Create or replace a file in a workspace's projects. ${asks}`,
		parameters: Type.Object({ workspace: workspaceParam, path: pathParam, content: Type.String() }),
		execute: async (args) => {
			const result = answer((await remote!(find(args.workspace), "write", { path: args.path, content: args.content }, {})).output, object({ path: string, created: boolean, bytes: integer }));
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
			const result = answer((await remote!(find(args.workspace), "edit", { path: args.path, edits: args.edits }, {})).output, object({ path: string, edits: integer }));
			return { content: [{ type: "text", text: `Edited ${result.path} (${result.edits} changes)` }] };
		},
	});

	const tools: ToolRegistration[] = workspaces.length === 0 || remote === undefined ? [] : [run, read, write, edit];
	return {
		tools,
		names,
		// With or without the tools: a workspace's past reads still count as outside text.
		guards: workspaceGuards(names),
		extension: defineExtension({
			name: "workspaces",
			tools,
		}),
	};
}
