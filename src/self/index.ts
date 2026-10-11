// Self-extension: tools gaidin writes for itself, run in a box. docs/tools.md describes it for the owner.
//
// gaidin drafts an extension in the sandbox, in extensions/<name>/. load_extension copies the draft out
// through the sandbox's own file operations, which refuse anything outside it, so a symlink can't pull a
// file in. It checks the copy (a strict type check, the extension's tests and Oxlint, each in a box, and
// imports and check-disabling comments here), has a second model run review the diff against GUIDE, and
// asks the owner with the diff. On approval the copy replaces <data>/extensions/<name>, a Git repository
// the sandbox can't see, and its tools are installed as the extension "self-<name>", replacing the old ones
// in place: a call already running finishes on the old code.
//
// Each installed extension runs in one Node process in a box (runner.ts): no network, no settings, no data,
// nothing writable but its own /tmp. Its fetches come back here and follow fetch_url's rules and the
// owner's host approvals. A tool can also serve as a scheduled job's gate (jobs.ts); then its fetches reach
// only hosts the owner allowed for good, since a gate has no one to ask.
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Duplex } from "node:stream";
import { promisify } from "node:util";
import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { configure, defineExtension, defineTool, type Registry, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { type ApprovalService, signalOf } from "../approvals.ts";
import { outsideText } from "../guards.ts";
import { type FetchOptions, fetchPublic } from "../fetch.ts";
import { assistantText } from "../host.ts";
import type { Gate, GateArgs, GateResult } from "../jobs.ts";
import { boxArgs } from "../sandbox.ts";
import { array, boolean, integer, json, type Json, jsonObject, object, optional, parse, parseJson, ParseError, string, text } from "../parse.ts";
import type { Fetched } from "./api.ts";
import type { ToRunner } from "./runner.ts";

const run = promisify(execFile);
const APP = resolve(import.meta.dirname, "../..");
const SELF = import.meta.dirname;
// The boxes run the server's own Node, which on egwene lives outside /usr.
const NODE = process.execPath;
const NODE_HOME = dirname(dirname(NODE));
const NAME = /^[a-z][a-z0-9-]{0,30}$/;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,40}$/;
const MAX_BYTES = 200_000;
const CHECK_MS = 120_000;
const LOAD_MS = 10_000;
// A literal module specifier after from, import or require.
const SPECIFIER = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["'`]([^"'`]+)["'`]/g;
const SWITCH_OFF = /\b(?:eslint|oxlint)-disable|@ts-(?:ignore|expect-error|nocheck)/;

/** How self-written code should be. The model reads it in load_extension's description, and the reviewer checks against it. */
const GUIDE = [
	"- The least code that does the job. Prefer deleting to adding.",
	"- No options, arguments or features nobody asked for.",
	"- No wrapper, helper or abstraction used only once.",
	"- No comments that restate the code; comment only on why.",
	"- No tool that does what an existing tool already does.",
	"- Check outside data where it comes in, with plain checks, rather than asserting a type with `as`.",
	"- A test for every tool, of what it does, with a fake fetch where it fetches.",
].join("\n");

const EXAMPLE = `import type { Tool } from "gaidin";

export const roll = {
	name: "roll_dice",
	description: "Roll n six-sided dice and give the total.",
	parameters: { type: "object", properties: { n: { type: "integer", minimum: 1, maximum: 20 } }, required: ["n"] },
	execute: async (args: { n: number }) => {
		let total = 0;
		for (let i = 0; i < args.n; i += 1) total += 1 + Math.floor(Math.random() * 6);
		return String(total);
	},
} satisfies Tool;

export const tools = [roll];`;

const REVIEW =
	"You review a change to an extension gaidin wrote for itself: tools in TypeScript that run in a sandbox with only Node's built-ins. " +
	`Check the diff against this guide:\n${GUIDE}\n` +
	'Answer just "OK" if it follows the guide. Otherwise list each problem as "- file: what to cut or change", at most eight, and nothing else.';

type Described = { name: string; description: string; parameters: { readonly [keyword: string]: Json } };
const described = object({ name: string, description: string, parameters: jsonObject });
/** A line from the box. The extension's own code can write to the channel too, so every line is parsed. */
const fromRunner = object({ tools: optional(json), id: optional(integer), fetchId: optional(integer), fetch: optional(string), result: optional(string), error: optional(string) });
type Reply = { result: string } | { error: string };
type Call = { process: ChildProcess; settle: (reply: Reply) => void; fetch: (url: string) => Promise<Fetched> };
const GATE_CALL_MS = 30_000;

/** A tool's answer as a gate: JSON {"wake": boolean, "data"?: anything, "topic"?: string}. */
function gateResult(reply: Reply, tool: string): GateResult {
	if ("error" in reply) throw new Error(reply.error);
	const { wake, data, topic } = parseJson(reply.result, object({ wake: boolean, data: optional(text), topic: optional(string) }), `${tool}'s answer`);
	const result: GateResult = { wake };
	if (data !== undefined) result.data = data;
	if (topic !== undefined) result.topic = topic;
	return result;
}

/** What a failed command printed, cut to its end, or nothing if it succeeded. */
async function failure([command = "", ...rest]: string[], timeout: number): Promise<string | undefined> {
	try {
		await run(command, rest, { env: {}, timeout, killSignal: "SIGKILL", maxBuffer: 10_000_000 });
		return undefined;
	} catch (error) {
		// SAFETY: execFile rejects with an Error that carries what the command printed.
		const { stdout = "", stderr = "", message } = error as Error & { stdout?: string; stderr?: string };
		const printed = `${stdout}${stderr}`.trim() || message;
		return printed.length > 4000 ? `…${printed.slice(-4000)}` : printed;
	}
}

/** The diff between two directories under `cwd`, with file names relative to them. */
async function diff(cwd: string, from: string, to: string): Promise<string> {
	const [a, b] = [relative(cwd, from), relative(cwd, to)];
	const { stdout } = await run("git", ["diff", "--no-index", "--no-prefix", "--no-color", "--", a, b], { cwd, maxBuffer: 10_000_000 }).catch(
		(error: { code?: number; stdout?: string }) => {
			// Exit status 1 means they differ.
			if (error.code === 1 && error.stdout !== undefined) return { stdout: error.stdout };
			throw error;
		},
	);
	return stdout.replaceAll(`${a}/`, "").replaceAll(`${b}/`, "");
}

/** Copies the draft into `to` through the sandbox's file operations, which refuse paths that land outside it. */
async function copyDraft(env: ExecutionEnv, from: string, to: string, context: Context): Promise<string[]> {
	const listed = await env.listDir(from, context);
	if (!listed.ok) throw new Error(listed.error.message);
	const problems: string[] = [];
	let bytes = 0;
	for (const entry of listed.value) {
		if (entry.kind !== "file" || !entry.name.endsWith(".ts")) {
			problems.push(`${entry.name}: an extension is a folder of .ts files only`);
			continue;
		}
		const read = await env.readBinaryFile(`${from}/${entry.name}`, context);
		if (!read.ok) throw new Error(read.error.message);
		bytes += read.value.length;
		writeFileSync(join(to, entry.name), read.value);
	}
	if (bytes > MAX_BYTES) problems.push(`The extension is ${bytes} bytes; the limit is ${MAX_BYTES}`);
	for (const file of ["index.ts", "test.ts"]) if (!existsSync(join(to, file))) problems.push(`${file} is missing`);
	return problems;
}

/** What the checks in the box can't be trusted with: imports from outside, and comments that turn checks off. */
function scan(dir: string): string[] {
	const problems: string[] = [];
	for (const file of readdirSync(dir)) {
		const text = readFileSync(join(dir, file), "utf8");
		for (const [, specifier = ""] of text.matchAll(SPECIFIER)) {
			const own = specifier.startsWith("./") && !specifier.includes("/", 2);
			if (!own && !specifier.startsWith("node:") && specifier !== "gaidin") {
				problems.push(`${file} imports "${specifier}"; an extension imports only node: built-ins, its own ./ files and types from "gaidin"`);
			}
		}
		const off = SWITCH_OFF.exec(text);
		if (off !== null) problems.push(`${file} turns a check off with ${off[0]}`);
	}
	return problems;
}

/** What's wrong with the tools an extension exports. `taken` holds every other extension's tool names. */
function toolProblems(tools: Described[], taken: ReadonlySet<string>): string[] {
	if (tools.length === 0) return ["index.ts exports no tools"];
	const problems: string[] = [];
	const seen = new Set<string>();
	for (const tool of tools) {
		const { name } = tool;
		if (!TOOL_NAME.test(name)) problems.push(`"${name}" isn't a tool name: lowercase letters, digits and _`);
		else if (taken.has(name) || seen.has(name)) problems.push(`${name} is already a tool's name`);
		seen.add(name);
		if (tool.description.trim() === "") problems.push(`${name} has no description`);
		if (tool.parameters.type !== "object") problems.push(`${name}'s parameters must be an object schema`);
	}
	return problems;
}

/** The box's channel, which the runner is spawned with as fd 3. */
function channelOf(process: ChildProcess): Duplex {
	// SAFETY: runnerFor spawns every box with a pipe as fd 3.
	return process.stdio[3] as Duplex;
}

const write = (process: ChildProcess, message: ToRunner) => channelOf(process).write(`${JSON.stringify(message)}\n`);

/** One extension's process, started on first use and again after it stops. */
class Runner {
	readonly #spawn: () => Promise<ChildProcess>;
	#child: Promise<{ process: ChildProcess; tools: Promise<Described[]> }> | undefined;
	readonly #calls = new Map<number, Call>();
	#next = 0;

	constructor(start: () => Promise<ChildProcess>) {
		this.#spawn = start;
	}

	async tools(): Promise<Described[]> {
		const { tools } = await this.#start();
		// The box and its pipes don't keep the server running, so this timer does while it waits: at start, before
		// anything else is open, nothing else would, and the server would exit with the load unfinished.
		let timer: ReturnType<typeof setTimeout> | undefined;
		const late = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`index.ts didn't load in ${LOAD_MS / 1000} seconds`)), LOAD_MS);
		});
		try {
			return await Promise.race([tools, late]);
		} finally {
			clearTimeout(timer);
		}
	}

	async call(name: string, args: Json, fetch: Call["fetch"], signal: AbortSignal, timeoutMs: number): Promise<Reply> {
		await this.tools();
		const child = await this.#start();
		const id = this.#next++;
		return new Promise((resolve) => {
			const settle = (reply: Reply) => {
				clearTimeout(timer);
				signal.removeEventListener("abort", stopped);
				this.#calls.delete(id);
				resolve(reply);
			};
			const timer = setTimeout(() => {
				settle({ error: `No answer in ${timeoutMs / 1000} seconds; the extension starts again on the next call.` });
				this.stop();
			}, timeoutMs);
			const stopped = () => settle({ error: "The call was stopped." });
			signal.addEventListener("abort", stopped, { once: true });
			this.#calls.set(id, { process: child.process, settle, fetch });
			write(child.process, { id, call: name, args });
		});
	}

	stop() {
		const child = this.#child;
		this.#child = undefined;
		void child?.then(({ process }) => process.kill("SIGKILL"));
	}

	#start() {
		if (this.#child === undefined) {
			const child = this.#spawn().then((process) =>
				this.#attach(process, () => {
					if (this.#child === child) this.#child = undefined;
				}),
			);
			this.#child = child;
		}
		return this.#child;
	}

	#attach(process: ChildProcess, forget: () => void) {
		// The box dies with the server (--die-with-parent), and mustn't keep it running.
		process.unref();
		// SAFETY: a child's pipes are sockets, which can be unref'd; Node's types only say so for the child itself.
		for (const pipe of [process.stderr, channelOf(process)] as ({ unref?: () => void } | null)[]) pipe?.unref?.();
		let stderr = "";
		process.stderr!.on("data", (chunk: Buffer) => {
			stderr = `${stderr}${chunk}`.slice(-2000);
		});
		const { promise: tools, resolve: listed, reject: failed } = Promise.withResolvers<Described[]>();
		tools.catch(() => {});
		createInterface({ input: channelOf(process) }).on("line", (line) => this.#receive(line, process, listed, failed));
		const ended = (why: string) => {
			forget();
			const error = `The extension stopped (${why})${stderr === "" ? "" : `:\n${stderr.trim()}`}`;
			failed(new Error(error));
			for (const call of this.#calls.values()) if (call.process === process) call.settle({ error });
		};
		process.once("exit", (code, signal) => ended(signal ?? `exit ${code}`));
		// A box that can't start at all reports an error, and may not exit.
		process.once("error", (error) => ended(error.message));
		return { process, tools };
	}

	#receive(line: string, process: ChildProcess, listed: (tools: Described[]) => void, failed: (error: Error) => void) {
		let message;
		try {
			message = parseJson(line, fromRunner, "the extension's message");
			if (message.tools !== undefined) return listed(parse(message.tools, array(described), "the extension's tools"));
		} catch (error) {
			if (!(error instanceof ParseError)) throw error;
			// What a call sends is the call's to fail; anything else, the load's.
			const call = message?.id === undefined ? undefined : this.#calls.get(message.id);
			if (call === undefined) failed(error);
			else call.settle({ error: error.message });
			return;
		}
		const { id, fetchId, fetch, result, error } = message;
		const call = id === undefined ? undefined : this.#calls.get(id);
		if (call === undefined) return;
		if (fetch !== undefined && fetchId !== undefined) {
			call.fetch(fetch).then(
				(page) => write(process, { fetchId, page }),
				(problem: Error) => write(process, { fetchId, error: problem.message }),
			);
		} else if (result !== undefined) {
			call.settle({ result });
		} else {
			call.settle({ error: error ?? "The extension answered without a result" });
		}
	}
}

export function createSelf(options: {
	dataDir: string;
	/** Drafts are in its extensions/ directory. */
	sandbox: string;
	bwrap: string;
	/** Files the boxes must not read, such as the settings. */
	hide: readonly string[];
	registry: Registry;
	approvals: () => ApprovalService;
	owner: string;
	fetch?: FetchOptions;
	callTimeoutMs?: number;
}) {
	const { registry, owner } = options;
	const approved = resolve(options.dataDir, "extensions");
	const staging = resolve(options.dataDir, "staging");
	const runners = new Map<string, Runner>();
	const nodeHome = NODE_HOME.startsWith("/usr/") ? [] : [NODE_HOME];

	const box = async (cwd: string, readOnly: string[], argv: string[]) => [
		options.bwrap,
		...(await boxArgs(cwd, [...nodeHome, ...readOnly], options.hide)),
		"--",
		NODE,
		...argv,
	];
	const runnerFor = (dir: string) =>
		new Runner(async () => {
			const [command = "", ...rest] = await box(dir, [SELF, dir], [join(SELF, "runner.ts"), dir]);
			return spawn(command, rest, { env: {}, stdio: ["ignore", "ignore", "pipe", "pipe"] });
		});
	const taken = (except: string) => new Set(registry.snapshot().tools().filter((t) => t.extension.name !== except).map((t) => t.tool.name));

	/** The type check, the tests and the lint rules, each in a box that sees the staged copy read-only. */
	async function check(stage: string): Promise<string[]> {
		const readOnly = [join(APP, "node_modules"), SELF, join(APP, "tools/oxlint"), stage];
		const steps: [string, string, string[]][] = [
			["The type check", stage, [join(APP, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json", "--pretty", "false"]],
			["The tests", join(stage, "ext"), ["--test", "test.ts"]],
			["Lint", stage, [join(APP, "node_modules/oxlint/bin/oxlint"), "-c", join(SELF, "oxlintrc.json"), "--disable-nested-config", "--deny-warnings", "--format", "unix", "ext"]],
		];
		const failures: string[] = [];
		for (const [label, cwd, argv] of steps) {
			const printed = await failure(await box(cwd, readOnly, argv), CHECK_MS);
			if (printed !== undefined) failures.push(`${label} failed:\n${printed}`);
		}
		return failures;
	}

	/** A second model run, with no tools, that checks the diff against GUIDE. */
	async function review(change: string, api: ToolExecutionApi, context: Context): Promise<string> {
		const id = await api.commit(async (tx) => {
			const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
			await configure(tx, created.id, { extensions: [], instructions: REVIEW });
			return created.id;
		}, context);
		const conversation = await api.conversation(id, context);
		if (conversation === undefined) throw new Error("The review's conversation is gone");
		const submission = await conversation.submit({ type: "input", content: change, requestId: `review:${api.taskId}` }, context);
		const settled = await submission.wait(context);
		if (settled.status !== "done" || settled.type !== "input") throw new Error(`The review didn't finish (${settled.status})`);
		return (await api.commit(async (tx) => assistantText(await tx.entry(settled.answer)), context))?.trim() ?? "";
	}

	/** A tool's fetch: a host the owner hasn't allowed for good asks, including one a redirect leads to. */
	function fetchFor(url: string, tool: string, api: ToolExecutionApi, signal: AbortSignal): Promise<Fetched> {
		return fetchPage(url, async (host, next) => {
			const approvals = options.approvals();
			if ((await approvals.state()).fetchHosts.includes(host)) return;
			const at = { conversationId: api.conversationId, taskId: api.taskId };
			const request = await approvals.open(`self-fetch:${api.taskId}:${host}`, at, tool, {
				summary: `fetch ${next}`,
				always: { kind: "fetch-host", value: host, label: `Always allow ${host}`, done: `Always allowed ${host}` },
			});
			const done = await approvals.wait(request, signal);
			if (done.status !== "approved") throw new Error(`${owner} didn't allow fetching from ${host}`);
		});
	}

	/** A gate's fetch, which can't ask: only hosts allowed for good, redirects included. */
	function fetchAllowed(url: string): Promise<Fetched> {
		return fetchPage(url, async (host) => {
			if (!(await options.approvals().state()).fetchHosts.includes(host)) throw new Error(`${owner} hasn't allowed ${host} for good, and a gate can't ask`);
		});
	}

	/** Fetches `url`, following redirects to other hosts once `allow` lets each host through. */
	async function fetchPage(url: string, allow: (host: string, url: string) => Promise<void>): Promise<Fetched> {
		let next = url;
		for (let hop = 0; ; hop += 1) {
			await allow(new URL(next).hostname, next);
			const page = await fetchPublic(next, options.fetch);
			if (page.redirect === undefined) return { url: page.url, status: page.status, contentType: page.contentType, text: page.body.toString("utf8") };
			if (hop >= 5) throw new Error("More than 5 redirects to other hosts");
			next = page.redirect;
		}
	}

	function toolFor(described: Described, runner: Runner): ToolRegistration {
		return defineTool({
			name: described.name,
			description: described.description,
			parameters: Type.Unsafe<{ readonly [name: string]: Json }>(described.parameters),
			execute: async (args, api, context) => {
				const signal = signalOf(api, context);
				const reply = await runner.call(described.name, args, (url) => fetchFor(url, described.name, api, signal), signal, options.callTimeoutMs ?? 60_000);
				return "result" in reply ? { content: [{ type: "text", text: reply.result }] } : { content: [{ type: "text", text: reply.error }], isError: true };
			},
		});
	}

	function install(name: string, tools: Described[], runner: Runner) {
		runners.get(name)?.stop();
		runners.set(name, runner);
		registry.install(defineExtension({ name: `self-${name}`, tools: tools.map((tool) => toolFor(tool, runner)) }));
	}

	async function commit(message: string) {
		if (!existsSync(join(approved, ".git"))) await run("git", ["-C", approved, "init", "-q"]);
		await run("git", ["-C", approved, "add", "-A"]);
		await run("git", ["-C", approved, "-c", "user.name=gaidin", "-c", "user.email=gaidin@localhost", "commit", "-q", "-m", message]);
	}

	const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

	const load = defineTool({
		name: "load_extension",
		description:
			`Check the extension drafted in extensions/<name>/ in the sandbox and, once ${owner} approves it, start using its tools. ` +
			'Before drafting, read "Writing a tool" with read_skill (skill gaidin, file tools.md): it shows how to read JSON so the lint rules pass, and what they refuse. ' +
			"Write it with the file tools first: index.ts exports `tools`, and test.ts tests each one with node:test. A tool looks like this:\n" +
			`${EXAMPLE}\n` +
			"execute gets arguments that match `parameters` and returns the result text, or throws. Write `satisfies Tool` as above, so a test " +
			"can call execute with the arguments alone; with `: Tool<Args>` instead, a test passes a second argument too. That argument has fetch(url), " +
			`a GET of a public URL that returns { url, status, contentType, text }; a host ${owner} hasn't allowed waits for approval. ` +
			'A tool can also be a scheduled job\'s gate: it then returns JSON {"wake": true or false, "data": what it found, "topic": what that is about}, ' +
			`and its fetches reach only hosts ${owner} has allowed for good. ` +
			'An extension imports only node: built-ins, its own ./ files and types from "gaidin". It has no network but fetch, and no files but /tmp. ' +
			"Before asking, the server runs a strict type check that fails on unused code, the tests, and lint rules against shortcuts such as a type " +
			"assertion without a SAFETY: comment. Comments that turn a check off aren't allowed. Then a reviewer checks the change against this guide:\n" +
			`${GUIDE}\n` +
			`If it objects, fix the code, or call again with \`keep\` saying why the objection doesn't apply; ${owner} sees both.`,
		parameters: Type.Object({
			name: Type.String({ description: "The draft's directory under extensions/: lowercase letters, digits and -" }),
			keep: Type.Optional(Type.String({ description: "Why the reviewer's objections don't apply, to keep the code as it is" })),
		}),
		execute: async (args, api, context) => {
			if (!NAME.test(args.name)) return fail("The name is lowercase letters, digits and -, up to 31 characters, starting with a letter.");
			if (api.env === undefined) return fail("There's no sandbox to read the draft from.");
			const stage = join(staging, String(api.taskId));
			const staged = join(stage, "ext");
			rmSync(stage, { recursive: true, force: true });
			mkdirSync(staged, { recursive: true });
			mkdirSync(join(stage, "none"));
			try {
				const copied = await copyDraft(api.env, join(options.sandbox, "extensions", args.name), staged, context);
				writeFileSync(join(stage, "tsconfig.json"), JSON.stringify({ extends: join(SELF, "tsconfig.json"), include: ["ext"] }));
				const failures = [...copied, ...scan(staged), ...(await check(stage))];
				if (failures.length > 0) return fail(`The checks failed, so ${owner} wasn't asked.\n\n${failures.join("\n\n")}`);

				const runner = runnerFor(staged);
				const tools = await runner.tools().finally(() => runner.stop());
				const problems = toolProblems(tools, taken(`self-${args.name}`));
				if (problems.length > 0) return fail(`The tools aren't right, so ${owner} wasn't asked:\n${problems.join("\n")}`);

				const current = join(approved, args.name);
				const update = existsSync(current);
				const change = await diff(options.dataDir, update ? current : join(stage, "none"), staged);
				if (change === "") return fail(`${args.name} is the same as the approved version.`);
				const verdict = await review(change, api, context);
				const objections = /^ok\.?$/i.test(verdict) ? undefined : verdict;
				if (objections !== undefined && args.keep === undefined) {
					return fail(`The reviewer objects:\n${objections}\n\nFix the code and call load_extension again, or pass keep with why the objections don't apply.`);
				}

				const lines = change.split("\n");
				const added = lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
				const removed = lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length;
				const names = tools.map((t) => t.name).join(", ");
				const approvals = options.approvals();
				const request = await approvals.open(`self:${api.taskId}`, { conversationId: api.conversationId, taskId: api.taskId }, "load_extension", {
					summary: `${update ? "update" : "add"} extension ${args.name} with ${names} (+${added} −${removed} lines)`,
					detail: objections === undefined ? change : `${change}\nThe reviewer objected:\n${objections}\n\ngaidin kept it because: ${args.keep}`,
				});
				const done = await approvals.wait(request, signalOf(api, context));
				if (done.status !== "approved") return fail(`${owner} didn't approve it (${done.status}).`);

				rmSync(current, { recursive: true, force: true });
				mkdirSync(approved, { recursive: true });
				renameSync(staged, current);
				await commit(`${update ? "update" : "add"} ${args.name}`);
				install(args.name, tools, runnerFor(current));
				return { content: [{ type: "text", text: `Loaded ${args.name}. ${names} can be used from the next step.` }] };
			} finally {
				rmSync(stage, { recursive: true, force: true });
			}
		},
	});

	const remove = defineTool({
		name: "remove_extension",
		description: `Stop using a self-written extension and delete it, once ${owner} approves. Its history is kept.`,
		parameters: Type.Object({ name: Type.String() }),
		execute: async (args, api, context) => {
			const extension = registry.snapshot().extension(`self-${args.name}`);
			if (extension === undefined) return fail(`There's no extension ${args.name}. Loaded: ${[...runners.keys()].join(", ") || "none"}.`);
			const names = (extension.tools ?? []).map((t) => t.name);
			const approvals = options.approvals();
			const request = await approvals.open(`self:${api.taskId}`, { conversationId: api.conversationId, taskId: api.taskId }, "remove_extension", {
				summary: `remove extension ${args.name} and its tools ${names.join(", ")}`,
			});
			const done = await approvals.wait(request, signalOf(api, context));
			if (done.status !== "approved") return fail(`${owner} didn't approve it (${done.status}).`);
			registry.uninstall(extension);
			runners.get(args.name)?.stop();
			runners.delete(args.name);
			rmSync(join(approved, args.name), { recursive: true, force: true });
			await commit(`remove ${args.name}`);
			return { content: [{ type: "text", text: `Removed ${args.name}.` }] };
		},
	});

	/** Installs every approved extension. One that won't load is reported and left out. */
	async function start() {
		rmSync(staging, { recursive: true, force: true });
		if (!existsSync(approved)) return;
		for (const name of readdirSync(approved).filter((n) => NAME.test(n))) {
			const runner = runnerFor(join(approved, name));
			try {
				const tools = await runner.tools();
				const problems = toolProblems(tools, taken(`self-${name}`));
				if (problems.length > 0) throw new Error(problems.join("; "));
				install(name, tools, runner);
			} catch (error) {
				runner.stop();
				console.error(`[self] ${name} wasn't loaded: ${error instanceof Error ? error.message : error}`);
			}
		}
	}

	/** The self-written tools, which the web view can switch off. */
	const loaded = () => [...runners.keys()].flatMap((name) => registry.snapshot().extension(`self-${name}`)?.tools ?? []);

	return {
		extension: defineExtension({ name: "self", tools: [load, remove] }),
		start,
		tools: loaded,
		/**
		 * What a self-written tool returns counts as outside text, so a note written after it asks first. Asking is the
		 * exception here: load_extension, remove_extension and a tool's fetches (fetchFor) ask from inside the tool.
		 */
		guards: () => loaded().map((tool) => outsideText(tool.name)),
		/** The self-written tools as gates for scheduled jobs. */
		gates: (): Gate[] =>
			[...runners].flatMap(([name, runner]) =>
				(registry.snapshot().extension(`self-${name}`)?.tools ?? []).map((tool) => ({
					name: tool.name,
					description: tool.description,
					tool: true,
					check: async (args: GateArgs, signal: AbortSignal) => gateResult(await runner.call(tool.name, args, fetchAllowed, signal, GATE_CALL_MS), tool.name),
				})),
			),
	};
}
