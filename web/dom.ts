// Helpers every part of the page uses: finding and making elements, dates, times and money in words, and
// tool calls in a line.

export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
export type Fields = { readonly [key: string]: Json };
export const isText = (value: Json | undefined): value is string => typeof value === "string";
export const isNumber = (value: Json | undefined): value is number => typeof value === "number";
export const isFields = (value: Json | undefined): value is Fields => typeof value === "object" && value !== null && !Array.isArray(value);

export function $<T extends HTMLElement = HTMLElement>(id: string): T {
	// SAFETY: every id asked for is an element of that type in index.html.
	return document.getElementById(id) as T;
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

export const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
export const when = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** "in 25 min", "in 3 h 10 min", "in 4 days". */
export function fromNow(at: number): string {
	const minutes = Math.round((at - Date.now()) / 60_000);
	if (minutes < 1) return "now";
	if (minutes < 60) return `in ${minutes} min`;
	if (minutes < 48 * 60) return `in ${Math.floor(minutes / 60)} h${minutes % 60 === 0 ? "" : ` ${minutes % 60} min`}`;
	return `in ${Math.round(minutes / 1440)} days`;
}

/** "just now", "25 min ago", "3 h ago", "4 days ago". */
export function ago(at: number): string {
	const minutes = Math.round((Date.now() - at) / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min ago`;
	if (minutes < 48 * 60) return `${Math.floor(minutes / 60)} h ago`;
	return `${Math.round(minutes / 1440)} days ago`;
}

const weekday = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const date = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

/** "today", "tomorrow", a weekday within the week, or "Oct 20". */
export function day(at: number): string {
	const start = new Date();
	start.setHours(0, 0, 0, 0);
	const days = Math.floor((at - start.getTime()) / 86_400_000);
	return days === 0 ? "today" : days === 1 ? "tomorrow" : days > 1 && days < 7 ? weekday.format(at) : date.format(at);
}

export function money(dollars: number): string {
	return `$${dollars.toFixed(dollars < 1 ? 3 : 2)}`;
}

/** A tool call in a line: the command, path, URL or text it was given. */
export function argsSummary(name: string, args: Fields): string {
	if (name === "bash" && isText(args.command)) return args.command;
	if (/^(read|write|remove)_skill$/.test(name) && isText(args.name)) return `${args.name}/${isText(args.file) ? args.file : "SKILL.md"}`;
	if (isText(args.path)) return args.path;
	if (isText(args.url)) return args.url;
	if (name === "remind") return `${args.text ?? ""} ${args.at ?? (args.inMinutes === undefined ? "" : `in ${args.inMinutes} min`)}`;
	if (isText(args.title)) return args.title;
	if (isText(args.text)) return args.text;
	const json = JSON.stringify(args);
	return json === "{}" ? "" : json;
}

/** A timeline item's tool call arguments, which history.ts keeps as JSON. */
export function toolArguments(detail: string): Fields {
	// SAFETY: history.ts writes a tool call's detail with JSON.stringify of its arguments, an object.
	return JSON.parse(detail) as Fields;
}
