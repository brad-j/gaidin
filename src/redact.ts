// Keeps the server's credentials out of what tools see and what the transcript keeps. Transcripts are
// kept forever; the July Pi audit found secrets in retained session files.
//
// Three layers: bash children don't inherit the credentials; shell output is redacted as it streams, so
// the running output, the stored result and a crash's partial result are all clean; and an afterTool hook
// redacts every tool's final result, which covers the file tools (`read /proc/self/environ`).
//
// This catches the values as they are. It doesn't stop a command from encoding or sending them, since
// tools run as the server's user; the sandbox (sandbox.ts) is what keeps those values out of reach.
import type { Context } from "@earendil-works/chord";
import { defineExtension, hook, ToolTask } from "@earendil-works/pi-durable";
import type { ShellExecOptions, ShellOutputInfo } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";

/** Environment variables that hold credentials. */
export const SECRET_NAMES = ["ANTHROPIC_API_KEY", "NTFY_URL", "NTFY_TOKEN", "SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "TAVILY_API_KEY", "ALERTS_URL", "ALERTS_TOKEN"] as const;

// Shorter values would redact ordinary text.
const MIN_LENGTH = 8;

export type Redactor = {
	redact(text: string): string;
	/** Length of the longest secret, so a stream can hold back enough to catch one split across chunks. */
	readonly longest: number;
};

/** A redactor for the secrets in `env`. */
export function redactorFromEnv(env: NodeJS.ProcessEnv = process.env): Redactor {
	return redactorFor(Object.fromEntries(SECRET_NAMES.map((name) => [name, env[name]])));
}

/** A redactor for secret values by name. An ntfy topic URL, for reminders or alerts, also redacts the bare topic name. */
export function redactorFor(values: Record<string, string | undefined>): Redactor {
	const secrets = new Map<string, string>();
	for (const [name, value] of Object.entries(values)) {
		if (!value) continue;
		secrets.set(value, name);
		if (name === "NTFY_URL" || name === "ALERTS_URL") {
			const topic = value.replace(/\/+$/, "").split("/").at(-1);
			if (topic) secrets.set(topic, name === "NTFY_URL" ? "NTFY_TOPIC" : "ALERTS_TOPIC");
		}
	}
	return createRedactor(secrets);
}

/**
 * A redactor whose secrets can change while it's in use, such as a connector's token (connectors/), with `base` among
 * them for good. What it redacts follows each change at once.
 */
export function growingRedactor(base: Record<string, string | undefined>) {
	const fixed = new Map<string, string>();
	const added = new Map<string, string>();
	let current = redactorFor(base);
	for (const [name, value] of Object.entries(base)) if (value) fixed.set(name, value);
	const rebuild = () => {
		current = redactorFor({ ...Object.fromEntries(fixed), ...Object.fromEntries(added) });
	};
	const redactor: Redactor = {
		redact: (text) => current.redact(text),
		get longest() {
			return current.longest;
		},
	};
	return {
		redactor,
		/** Redacts `value` as `name` from now on, in place of what `name` was. */
		set(name: string, value: string | undefined) {
			if (value === undefined || value === "") added.delete(name);
			else added.set(name, value);
			rebuild();
		},
	};
}

export type GrowingRedactor = ReturnType<typeof growingRedactor>;

/** `secrets` maps each value to the name it's replaced with. */
export function createRedactor(secrets: ReadonlyMap<string, string>): Redactor {
	// Longest first, so a URL is replaced whole before the topic inside it.
	const values = [...secrets.keys()].filter((v) => v.length >= MIN_LENGTH).sort((a, b) => b.length - a.length);
	if (values.length === 0) return { redact: (text) => text, longest: 0 };
	const pattern = new RegExp(values.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
	return {
		redact: (text) => text.replace(pattern, (match) => `[redacted ${secrets.get(match)}]`),
		longest: values[0]!.length,
	};
}

/** The tool environment: bash children get none of the credentials, and their output is redacted. */
export class RedactingEnv extends NodeExecutionEnv {
	readonly #redactor: Redactor;

	constructor(options: { cwd: string; redactor: Redactor }) {
		super({ cwd: options.cwd, shellEnv: Object.fromEntries(SECRET_NAMES.map((name) => [name, undefined])) });
		this.#redactor = options.redactor;
	}

	override async exec(
		command: string | readonly string[],
		options: ShellExecOptions | undefined,
		context: Context,
	): ReturnType<NodeExecutionEnv["exec"]> {
		const onOutput = options?.onOutput;
		if (onOutput === undefined || this.#redactor.longest === 0) return super.exec(command, options, context);
		const stream = redactingStream(this.#redactor, (text, info) => onOutput(text, context, info));
		try {
			return await super.exec(command, { ...options, onOutput: (text, _context, info) => stream.write(text, info) }, context);
		} finally {
			stream.end();
		}
	}
}

/**
 * Redacts a stream of chunks. It holds back the last `longest - 1` characters until more arrive, so a
 * secret split across chunks is still whole when it's matched.
 */
export function redactingStream(redactor: Redactor, emit: (text: string, info: ShellOutputInfo) => void) {
	const keep = redactor.longest - 1;
	let held = "";
	let stream: ShellOutputInfo["stream"] = "stdout";
	// An omission reported with a chunk still being held goes out with that chunk's first text.
	let skipped: ShellOutputInfo["skipped"];
	const flush = (upTo: number) => {
		if (upTo <= 0) return;
		emit(held.slice(0, upTo), skipped === undefined ? { stream } : { stream, skipped });
		held = held.slice(upTo);
		skipped = undefined;
	};
	return {
		write(text: string, info: ShellOutputInfo) {
			// Output was omitted before this chunk, so what's held can't run into it.
			if (info.skipped !== undefined) {
				flush(held.length);
				skipped = info.skipped;
			}
			stream = info.stream;
			held = redactor.redact(held + text);
			flush(held.length - keep);
		},
		end() {
			flush(held.length);
		},
	};
}

/** Redacts every tool's final result before it's stored. */
export function redactionExtension(redactor: Redactor) {
	return defineExtension({
		name: "redaction",
		hooks: [
			hook(ToolTask, {
				afterTool: (_call, result) => {
					if (redactor.longest === 0 || result.content === undefined) return undefined;
					const redacted = { ...result, content: result.content.map((part) => (part.type === "text" ? { ...part, text: redactor.redact(part.text) } : part)) };
					if (result.diagnostics !== undefined) redacted.diagnostics = result.diagnostics.map((d) => ({ ...d, message: redactor.redact(d.message) }));
					return redacted;
				},
			}),
		],
	});
}
