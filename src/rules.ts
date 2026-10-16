// Rules: the owner's own say over what asks (docs/plan.md, "Design: rules"). A rule allows or asks, for one agent or
// every agent, for a tool or a family of tools by prefix (`home_*`), optionally only when the call's arguments meet
// conditions, and optionally until a time. The approvals hook (approvals.ts) decides each call with them:
//
//   1. A guard's refusal wins: a rule can't give an agent what it hasn't been given.
//   2. An ask rule that matches makes the call ask, whatever else would let it through, any tool's call included.
//   3. Otherwise an allow rule that matches lets through a call its guard would ask about, except for the FLOOR's tools,
//      and only while no outside text is in the conversation unless the rule says even after.
//
// Rules are made by the owner only, from the app or the command line; there's no tool for them.
import { defineDoc, type DocumentReader, type Harness } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as background } from "@earendil-works/chord/context";
import type { Conversation } from "@earendil-works/pi-durable";
import { DEFAULT_AGENT, type RosterService } from "./agents.ts";
import { array, attempt, isObject, type Json, literal, object, optional, type Parser, number, boolean, scalar, string } from "./parse.ts";

/** A condition on one of the call's arguments, by its name, or a dotted path into an object argument. */
export type Condition = { arg: string; op: "equals" | "one-of" | "starts-with" | "contains" | "host"; value: string | string[] };

export type Rule = {
	/** r1, r2, ... */
	id: string;
	effect: "allow" | "ask";
	/** Its agent; absent, every agent. */
	agent?: string;
	/** A tool's name, or a prefix ending in * for a family. */
	tool: string;
	/** Every one must hold. */
	when?: Condition[];
	/** When it ends, as epoch milliseconds. */
	until?: number;
	/** An allow rule that holds even while outside text is in the conversation. */
	afterOutside?: boolean;
	note?: string;
	createdAt: number;
};

export const Rules = defineDoc<{ items: Rule[]; next: number }>({
	kind: "gaidin.rules",
	version: 1,
	scope: "session",
	initial: () => ({ items: [], next: 1 }),
});

/** Tools no allow rule reaches: each puts code, instructions or the owner's files where they act later or leave for good. */
export const FLOOR = ["load_extension", "remove_extension", "write_skill", "remove_skill", "schedule_job", "browser_upload"];

const TOOL = /^[A-Za-z0-9_.-]+\*?$|^\*$/;
const OPS = ["equals", "one-of", "starts-with", "contains", "host"] as const;

/** Whether `pattern` names `tool`: the same name, or a prefix ending in *. */
export const toolMatches = (pattern: string, tool: string) => (pattern.endsWith("*") ? tool.startsWith(pattern.slice(0, -1)) : pattern === tool);

/** The argument at `path` as text, or nothing when it's absent or not a string, number or boolean. */
function argument(args: Json, path: string): string | undefined {
	let value: Json | undefined = args;
	for (const key of path.split(".")) value = value !== undefined && isObject(value) ? value[key] : undefined;
	return value === undefined ? undefined : attempt(value, scalar);
}

/** Whether `condition` holds for `args`. Text compares without case, except equals; a host is a URL's, exactly. */
export function holds(condition: Condition, args: Json): boolean {
	const value = argument(args, condition.arg);
	if (value === undefined) return false;
	const wanted = Array.isArray(condition.value) ? condition.value : [condition.value];
	switch (condition.op) {
		case "equals":
			return value === wanted[0];
		case "one-of":
			return wanted.includes(value);
		case "starts-with":
			return value.toLowerCase().startsWith((wanted[0] ?? "").toLowerCase());
		case "contains":
			return value.toLowerCase().includes((wanted[0] ?? "").toLowerCase());
		case "host":
			return URL.parse(value)?.hostname.toLowerCase() === (wanted[0] ?? "").toLowerCase();
	}
}

/** Whether `rule` covers a call of `tool` with `args` by `agent` at `now`. */
export function covers(rule: Rule, agent: string, tool: string, args: Json, now: number): boolean {
	if (rule.until !== undefined && rule.until <= now) return false;
	if (rule.agent !== undefined && rule.agent !== agent) return false;
	if (!toolMatches(rule.tool, tool)) return false;
	return (rule.when ?? []).every((c) => holds(c, args));
}

/** The rules that decide a call: the first ask rule that covers it, and the allow rules that do. */
export function rulesFor(rules: readonly Rule[], agent: string, tool: string, args: Json, now = Date.now()): { ask?: Rule; allow: Rule[] } {
	const covering = rules.filter((r) => covers(r, agent, tool, args, now));
	const ask = covering.find((r) => r.effect === "ask");
	const allow = FLOOR.includes(tool) ? [] : covering.filter((r) => r.effect === "allow");
	return ask === undefined ? { allow } : { ask, allow };
}

/** The rules in force, read where a hook or guard can. */
export async function rulesIn(read: DocumentReader, context: Context): Promise<readonly Rule[]> {
	return (await read.snapshot(Rules, context))?.items ?? [];
}

/** A rule in a line, for the command line and the timeline. */
export function describeRule(rule: Rule): string {
	const who = rule.agent ?? "every agent";
	const when = (rule.when ?? []).map((c) => `${c.arg} ${c.op} ${Array.isArray(c.value) ? c.value.join(",") : c.value}`).join(" and ");
	const parts = [
		`${rule.id}: ${rule.effect} ${rule.tool} for ${who}`,
		when === "" ? undefined : `when ${when}`,
		rule.effect === "allow" ? (rule.afterOutside === true ? "even after outside text" : "until outside text is read") : undefined,
		rule.until === undefined ? undefined : `until ${new Date(rule.until).toISOString()}`,
		rule.note === undefined ? undefined : `(${rule.note})`,
	];
	return parts.filter((p) => p !== undefined).join(", ");
}

/** What the owner gives to make a rule. */
export type NewRule = Omit<Rule, "id" | "createdAt">;

const conditionValue: Parser<string | string[]> = (value, at) => attempt(value, string) ?? array(string)(value, at);
/** A new rule as a request carries it. */
export const newRule = object({
	effect: literal("allow", "ask"),
	agent: optional(string),
	tool: string,
	when: optional(array(object({ arg: string, op: literal(...OPS), value: conditionValue }))),
	until: optional(number),
	afterOutside: optional(boolean),
	note: optional(string),
});

export function createRules(options: { harness: Harness; root: () => Conversation; roster: () => RosterService }) {
	const read = async () => (await options.harness.snapshot(Rules, background))?.items ?? [];

	/** Why `rule` can't be made, or nothing. */
	async function problem(rule: NewRule): Promise<string | undefined> {
		if (rule.effect !== "allow" && rule.effect !== "ask") return "A rule allows or asks.";
		if (!TOOL.test(rule.tool)) return "A rule's tool is a tool's name, or a prefix ending in *, such as home_*.";
		if (rule.tool === "*" && rule.effect === "allow") return "An allow rule names a tool or a family of tools, not every tool.";
		if (rule.effect === "allow" && FLOOR.includes(rule.tool)) return `${rule.tool} always asks; no allow rule reaches it.`;
		if (rule.agent !== undefined && rule.agent !== DEFAULT_AGENT && !(await options.roster().list()).some((a) => a.id === rule.agent)) return `There's no agent ${rule.agent}.`;
		for (const c of rule.when ?? []) {
			if (!OPS.includes(c.op)) return `A condition is one of ${OPS.join(", ")}, not ${c.op}.`;
			if (c.arg.trim() === "") return "A condition names an argument.";
			if ((Array.isArray(c.value) ? c.value : [c.value]).some((v) => v === "")) return `The condition on ${c.arg} has no value.`;
		}
		if (rule.until !== undefined && rule.until <= Date.now()) return "That rule would end before it starts.";
		if (rule.afterOutside === true && rule.effect === "ask") return "Even after outside text is for allow rules; an ask rule always asks.";
		return undefined;
	}

	async function add(rule: NewRule): Promise<Rule> {
		const why = await problem(rule);
		if (why !== undefined) throw new Error(why);
		return options.root().commit(async (tx) => {
			const doc = await tx.doc(Rules);
			// Ended rules go as others are made.
			doc.items = doc.items.filter((r) => r.until === undefined || r.until > Date.now());
			const made: Rule = { ...rule, id: `r${doc.next}`, createdAt: Date.now() };
			doc.next += 1;
			doc.items.push(made);
			// SAFETY: a rule is plain JSON data, so a JSON round trip gives back the same rule.
			return JSON.parse(JSON.stringify(made)) as Rule;
		}, background);
	}

	async function remove(id: string): Promise<void> {
		const removed = await options.root().commit(async (tx) => {
			const doc = await tx.doc(Rules);
			const at = doc.items.findIndex((r) => r.id === id);
			if (at < 0) return false;
			doc.items.splice(at, 1);
			return true;
		}, background);
		if (!removed) throw new Error(`There's no rule ${id}.`);
	}

	return {
		/** The rules in force, ended ones left out. */
		list: async () => (await read()).filter((r) => r.until === undefined || r.until > Date.now()),
		add,
		remove,
	};
}

export type RuleService = ReturnType<typeof createRules>;
