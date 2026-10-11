// Client for src/web.ts. Served with its types stripped, so it keeps to erasable TypeScript, and imports the
// server's types with `import type`, which stripping removes. The conversation itself is transcript.ts's copy,
// rebuilt from the server's event stream; this draws it, and does what else an event calls for.
import type { ApprovalRequest } from "../src/approvals.ts";
import type { Gets, Posts, StreamEvent } from "../src/web.ts";
import { load, post } from "./api.ts";
import { $, clock, el, fromNow, money, when } from "./dom.ts";
import { createLog, row, splitStamp, textOf } from "./log.ts";
import { renderActivity } from "./activity.ts";
import { historyRoute, renderHistory } from "./history.ts";
import { renderMemory } from "./memory.ts";
import { renderSchedule, troubled } from "./schedule.ts";
import { LEVELS, renderSettings, settingsChanged } from "./settings.ts";
import { renderSkills, skillRoute } from "./skills.ts";
import { applyEvent, newTranscript } from "./transcript.ts";


type Reminder = Gets["/api/reminders"][number];
type Job = Gets["/api/jobs"][number];
type Settings = Gets["/api/settings"];
type Approval = ApprovalRequest;

/** The conversation, as the event stream has it. */
const transcript = newTranscript();

type State = {
	connected: boolean;
	allSpend: number | undefined;
	budget: Gets["/api/budget"] | undefined;
};
const state: State = { connected: false, allSpend: undefined, budget: undefined };

// --- events -----------------------------------------------------------------------------------

function apply(event: StreamEvent) {
	applyEvent(transcript, event);
	switch (event.type) {
		case "snapshot":
			// A (re)connection may have missed changes.
			void loadApprovals();
			break;
		case "run_end":
			void loadSpend();
			if (view() === "activity") void renderActivity($("activity"), { budgetChanged: (budget) => {
				state.budget = budget;
				schedule();
			} });
			void loadReminders();
			void loadJobs();
			break;
		case "entry_appended":
			if (event.entry.kind === "gaidin.reminder-fired") void loadReminders();
			if (event.entry.kind === "gaidin.job-reported") void loadJobs();
			break;
		case "agent_changed":
			void loadSettings();
			break;
		case "approvals_changed":
			void loadApprovals();
			break;
		case "task_failed":
			notice(`${event.kind} failed: ${event.message}`);
			break;
	}
}

function connect() {
	const source = new EventSource("/events");
	source.onopen = () => {
		state.connected = true;
		schedule();
	};
	source.onmessage = (message) => {
		// SAFETY: the server sends each event as JSON (web.ts events()).
		apply(JSON.parse(message.data) as StreamEvent);
		schedule();
	};
	// EventSource reconnects by itself, and the server starts every connection with a snapshot.
	source.onerror = () => {
		state.connected = false;
		schedule();
	};
}

// --- rendering --------------------------------------------------------------------------------

let pending = false;
function schedule() {
	if (pending) return;
	pending = true;
	requestAnimationFrame(() => {
		pending = false;
		render();
	});
}

/** The live conversation's log; a fired reminder there has snooze buttons. */
const log = createLog({ reminderActions: (id) => snoozeButtons(id) });

/** Command output and errors, kept on screen until the page reloads or /clear. */
const local: { after: number; row: HTMLElement }[] = [];
let stick = false;

function lastEntryId(): number {
	let last = 0;
	for (const id of transcript.entries.keys()) if (id > last) last = id;
	return last;
}

function say(kind: "sys" | "err" | "cmd", ...body: (Node | string)[]) {
	const line = row(kind, kind === "err" ? "error" : kind === "cmd" ? "you" : "sys", ...body);
	const previous = local.at(-1)?.row;
	if (kind === "err" && previous?.classList.contains("err") && previous.textContent === line.textContent) return;
	local.push({ after: lastEntryId(), row: line });
	stick = true;
	schedule();
}

let lastHeight = 0;

function render() {
	renderStatusline();
	const asks = approvals.filter((a) => a.kind === "question").length;
	const allows = approvals.length - asks;
	document.title = asks > 0 ? `(${asks}) question · gaidin` : allows > 0 ? `(${allows}) approval · gaidin` : transcript.running ? "working · gaidin" : "gaidin";

	const scroller = $("scroll");
	const atBottom = stick || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;

	const rows = log.render(transcript, local);
	if (rows.length === 0) rows.push(row("sys", "gaidin", "No messages yet. Type below, or / for commands."));

	$("log").replaceChildren(...rows);

	if (atBottom) scroller.scrollTop = scroller.scrollHeight;
	else if (scroller.scrollHeight > lastHeight) $("jump").hidden = false;
	lastHeight = scroller.scrollHeight;
	stick = false;
}

// --- status line ------------------------------------------------------------------------------

let current: Settings | undefined;
let statusSignature = "";

function segment(label: string, title: string, action: () => void, className = ""): HTMLButtonElement {
	const button = el("button", `plain seg ${className}`, label);
	button.type = "button";
	button.title = title;
	button.addEventListener("click", action);
	return button;
}

function renderStatusline() {
	let label = "idle";
	let tone = "";
	if (!state.connected) [label, tone] = ["reconnecting", "problem"];
	else if (transcript.retry) [label, tone] = [transcript.retry, "problem"];
	else if (transcript.running) [label, tone] = ["working", "running"];
	const here = transcript.usage
		? [...Object.values(transcript.usage.models), ...Object.values(transcript.usage.tools)].reduce((sum, u) => sum + (u.cost?.total ?? 0), 0)
		: undefined;
	const budget = state.budget;
	// Today's spend against the daily limit when there's a budget; otherwise the totals.
	const total = budget
		? [budget.dailyLimit > 0 ? `${money(budget.today)} of ${money(budget.dailyLimit)} today` : `${money(budget.today)} today`, budget.monthlyLimit > 0 ? `${money(budget.month)} of ${money(budget.monthlyLimit)} month` : ""]
		: [state.allSpend === undefined ? "" : `${money(state.allSpend)} all`];
	// Each part its own span, so a narrow screen can leave out the conversation's.
	const parts: [string, string][] = [["here", here === undefined ? "" : `${money(here)} conversation`], ...total.map((t): [string, string] => ["total", t])];
	const shown = parts.filter(([, text]) => text !== "");
	const spend = shown.map(([, text]) => text).join(" · ");
	const near = budget !== null && budget !== undefined && !budget.stopped && budget.dailyLimit > 0 && budget.today >= budget.dailyLimit * 0.8;
	const signature = JSON.stringify([label, tone, spend, current, budget?.stopped, near]);
	// Rebuilt only when something in it changed, so a button under the pointer stays put while text streams.
	if (signature === statusSignature) return;
	statusSignature = signature;

	const segs: HTMLElement[] = [el("span", `status ${tone}`, label)];
	if (transcript.running) {
		const button = segment("stop", "Stop the run (Esc or Ctrl+C)", () => void stop(), "danger");
		button.prepend(el("kbd", undefined, "esc"));
		segs.push(button);
	}
	if (current) {
		const settings = current;
		segs.push(segment(settings.model, "Switch the model (/model)", () => prefill("/model "), "model"));
		segs.push(segment(`thinking ${settings.thinkingLevel}`, "Change the thinking level (/thinking)", () => prefill("/thinking "), "thinking"));
		const off = settings.tools.filter((t) => !t.enabled).map((t) => t.name);
		segs.push(segment(off.length === 0 ? `tools ${settings.tools.length}/${settings.tools.length}` : `${off.join(" ")} off`, "Switch tools on and off (/tools)", () => void runCommand("/tools"), "tools"));
		if (settings.instructions !== "") segs.push(segment("instructions", "Standing instructions (/instructions)", () => void runCommand("/instructions"), "instructions"));
	}
	if (budget?.stopped) segs.push(segment("stopped · allow more", budget.reason ?? "The spend limit is reached (/budget)", () => void allowMore(), "danger"));
	if (spend !== "") {
		const line = el("span", `spend${budget?.stopped ? " stopped" : near ? " near" : ""}`);
		line.append(...shown.map(([kind, text]) => el("span", kind, text)));
		if (budget?.reason) line.title = budget.reason;
		segs.push(line);
	}
	segs.push(el("span", "spacer"), segment("/ commands", "Show the commands", () => prefill("/"), "hint"));
	$("statusline").replaceChildren(...segs);
}

// --- horizon ----------------------------------------------------------------------------------
// The header: the views, and the next reminder or scheduled job run.

let reminders: Reminder[] = [];
let jobs: Job[] = [];

type Upcoming = { ref: string; kind: "reminder" | "job"; text: string; at?: number; detail: string; paused?: boolean };

function upcoming(): Upcoming[] {
	return [
		...reminders.map((r): Upcoming => ({ ref: `r${r.taskId}`, kind: "reminder", text: r.text, at: r.at, detail: "reminder" })),
		...jobs.map((j): Upcoming => ({
			ref: `j${j.taskId}`,
			kind: "job",
			text: j.title,
			// A paused job's runs are skipped, so it has no next run to show.
			at: j.paused === undefined ? j.nextAt : undefined,
			detail: `${j.mode === "watch" ? "watch, " : ""}${j.when}${j.gate === undefined ? "" : `, gated by ${j.gate.name}`}${j.paused === undefined ? "" : `, paused: ${j.paused.reason}`}`,
			paused: j.paused !== undefined,
		})),
	].sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity));
}

function renderHorizon() {
	const now = Date.now();
	const items = upcoming();
	const next = items[0];
	const nextUp = $("next-up");
	const text = el("span");
	if (next?.at === undefined) text.textContent = items.length === 0 ? "nothing coming up" : `next: ${next.text}`;
	else {
		text.textContent = `next: ${next.text} · ${fromNow(next.at)}`;
		if (next.at - now < 3_600_000) text.className = "soon";
	}
	nextUp.replaceChildren(text);

	const count = $("schedule-count");
	count.textContent = items.length === 0 ? "" : String(items.length);
	count.classList.toggle("warn", troubled(jobs) > 0);
	count.title = troubled(jobs) > 0 ? "A job is paused or failing" : "";
	if (view() === "schedule") {
		renderSchedule($("schedule"), reminders, jobs, {
			changed: async () => {
				await Promise.all([loadReminders(), loadJobs()]);
			},
			// The answer comes in the console, and on a phone only the console has the prompt.
			prefill: (text) => {
				go("console");
				prefill(text);
			},
		});
	}
}

// --- views ------------------------------------------------------------------------------------
// The console is the conversation; the others are pages beside it. The dock stays on every view, so
// approvals are never out of sight, and anything sent from it goes back to the console to be answered.

const VIEWS = ["console", "history", "schedule", "memory", "skills", "activity", "settings"] as const;
type View = (typeof VIEWS)[number];

/** The view an address names by its first part: #/schedule, #/skills/gaidin. */
function view(): View {
	const first = /^#\/([^/#]*)/.exec(location.hash)?.[1];
	return VIEWS.find((v) => v === first) ?? "console";
}

/** Shows `to` now, rather than when the hash change arrives, so the prompt is there to focus straight after. */
function go(to: View) {
	if (view() === to) return;
	location.hash = `#/${to === "console" ? "" : to}`;
	showView();
}

function showView() {
	const shown = view();
	// The CSS reads it: on a phone, only the console has the prompt.
	document.body.dataset.view = shown;
	for (const main of document.querySelectorAll<HTMLElement>("main[data-view]")) main.hidden = main.dataset.view !== shown;
	for (const link of document.querySelectorAll<HTMLAnchorElement>("#views a")) {
		if (link.dataset.view === shown) link.setAttribute("aria-current", "page");
		else link.removeAttribute("aria-current");
	}
	// On a phone the tabs scroll sideways; keep the current one in sight.
	document.querySelector<HTMLElement>("#views a[aria-current]")?.scrollIntoView({ block: "nearest", inline: "nearest" });
	requestAnimationFrame(() => edges());
	if (shown === "console") {
		stick = true;
		schedule();
	} else if (shown === "history") void renderHistory($("history"), historyRoute(location.hash));
	else if (shown === "schedule") renderHorizon();
	else if (shown === "memory") void renderMemory($("memory"));
	else if (shown === "skills") void renderSkills($("skills"), skillRoute(location.hash));
	else if (shown === "activity") void renderActivity($("activity"), { budgetChanged: (budget) => {
		state.budget = budget;
		schedule();
	} });
	else void renderSettings($("settings"), { settings: () => current, configure });
}

// --- requests ---------------------------------------------------------------------------------

function notice(text: string) {
	if (text !== "") say("err", text);
}

/** A refresh the page makes by itself that failed. While the server can't be reached the status line says so, and each retry would add a line. */
function refreshFailed(text: string) {
	if (state.connected) notice(text);
}

async function loadSpend() {
	try {
		const usage = await load("/api/usage");
		state.allSpend = [...Object.values(usage.models), ...Object.values(usage.tools)].reduce((s, u) => s + (u.cost?.total ?? 0), 0);
		state.budget = await load("/api/budget");
		schedule();
	} catch (error) {
		refreshFailed(String(error));
	}
}

/** Buttons that set a fired reminder again, as its push and its Slack message do. */
function snoozeButtons(id: number): HTMLElement {
	const buttons = el("span", "snooze");
	for (const [label, minutes] of [["snooze 10 min", 10], ["1 h", 60]] as const) {
		const button = el("button", "plain", label);
		button.type = "button";
		button.addEventListener("click", async () => {
			try {
				const { at } = await post("/api/reminders/snooze", { id, minutes });
				say("sys", `Snoozed until ${when.format(at)}.`);
				void loadReminders();
			} catch (error) {
				notice(String(error));
			}
		});
		buttons.append(button);
	}
	return buttons;
}

async function loadReminders() {
	try {
		reminders = await load("/api/reminders");
		renderHorizon();
	} catch (error) {
		refreshFailed(String(error));
	}
}

async function loadJobs() {
	try {
		jobs = await load("/api/jobs");
		renderHorizon();
	} catch (error) {
		refreshFailed(String(error));
	}
}

async function loadSettings() {
	try {
		current = await load("/api/settings");
		settingsChanged();
		schedule();
	} catch (error) {
		refreshFailed(String(error));
	}
}

/** Saves the settings with `change` applied. The server keeps any setting not given, except the switched-off tools, which it takes whole. */
async function configure(change: Partial<Posts["/api/settings"]["body"]>) {
	const settings = current ?? (await load("/api/settings"));
	current = await post("/api/settings", {
		disabledTools: settings.tools.filter((t) => !t.enabled).map((t) => t.name),
		...change,
	});
	schedule();
}

// --- approvals --------------------------------------------------------------------------------
// A request for approval docks above the prompt, like sudo asking first. ⌥Y, ⌥A and ⌥N answer the oldest.

let approvals: Approval[] = [];
const alt = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌥" : "Alt+";

async function loadApprovals() {
	try {
		approvals = await load("/api/approvals");
		renderApprovals();
		schedule();
	} catch (error) {
		refreshFailed(String(error));
	}
}

/** The oldest request to allow a call; questions are answered, not allowed. */
function firstApproval(): Approval | undefined {
	return approvals.find((a) => a.kind !== "question");
}

/** A question from ask_owner: a button per choice, or type the answer at the prompt. */
function questionRow(request: Approval): HTMLElement {
	const ask = el("div", "ask");
	ask.append(el("span", "what", request.summary));
	const buttons = el("div", "buttons");
	for (const choice of request.choices ?? []) {
		const button = el("button", "", choice);
		button.type = "button";
		button.addEventListener("click", () => void answerQuestion(request, choice));
		buttons.append(button);
	}
	const expires = el("span", "expires");
	expires.append(el("span", "typed", "type your answer below · "), `waits until ${when.format(request.expiresAt)}`);
	buttons.append(expires);
	const b = el("div", "b");
	b.append(ask, buttons);
	const node = el("div", "row approval question");
	node.append(el("span", "t", clock.format(Date.now())), el("span", "k", "asks?"), b);
	return node;
}

async function answerQuestion(request: Approval, answer: string) {
	for (const b of $("approvals").querySelectorAll("button")) b.disabled = true;
	try {
		await post("/api/approvals/answer", { id: request.id, answer });
	} catch (error) {
		notice(String(error));
	}
	await loadApprovals();
}

function renderApprovals() {
	const first = firstApproval();
	$("approvals").replaceChildren(
		...approvals.map((request) => {
			if (request.kind === "question") return questionRow(request);
			const ask = el("div", "ask");
			ask.append(el("span", "tool", request.tool), " ", el("span", "what", request.summary));
			if (request.detail !== undefined) {
				const detail = el("details", "detail");
				detail.append(el("summary", undefined, "all of it"), el("pre", undefined, request.detail));
				ask.append(detail);
			}
			const buttons = el("div", "buttons");
			const choices: [Decision, string, string, string][] = [["once", "Allow once", "primary", "Y"]];
			if (request.always !== undefined) choices.push(["always", request.always.label, "", "A"]);
			choices.push(["deny", "Deny", "danger", "N"]);
			for (const [decision, label, className, letter] of choices) {
				const button = el("button", className, label);
				button.type = "button";
				if (request === first) button.append(el("kbd", undefined, `${alt}${letter}`));
				button.addEventListener("click", () => void decide(decision, request));
				buttons.append(button);
			}
			buttons.append(el("span", "expires", `waits until ${clock.format(request.expiresAt)}`));
			const b = el("div", "b");
			b.append(ask, buttons);
			const node = el("div", "row approval");
			node.append(el("span", "t", clock.format(Date.now())), el("span", "k", "allow?"), b);
			return node;
		}),
	);
}

type Decision = "once" | "always" | "deny";

async function decide(decision: Decision, request = firstApproval()) {
	if (request === undefined) return say("sys", "Nothing is waiting for approval.");
	if (decision === "always" && request.always === undefined) return say("err", `${request.tool} has no "always" choice.`);
	for (const b of $("approvals").querySelectorAll("button")) b.disabled = true;
	try {
		await post("/api/approvals/decide", { id: request.id, decision });
	} catch (error) {
		notice(String(error));
	}
	await loadApprovals();
}

// --- commands ---------------------------------------------------------------------------------

type Choice = { value: string; hint?: string };
type Command = { name: string; args?: string; help: string; run: (arg: string) => void | Promise<void>; complete?: () => Choice[] };

async function stop(echo?: string) {
	if (echo) say("cmd", echo);
	if (!transcript.running) return say("sys", "Nothing is running.");
	try {
		await post("/api/abort", {});
	} catch (error) {
		notice(String(error));
	}
}

async function cancel(ref: string) {
	const match = /^([rj])(\d+)$/.exec(ref);
	if (!match) throw new Error(`Give a reference from /next, like r12 or j3, not "${ref}".`);
	const [, kind, id] = match;
	const path = kind === "r" ? "/api/reminders/cancel" : "/api/jobs/cancel";
	const { ok } = await post(path, { id: Number(id) });
	await (kind === "r" ? loadReminders() : loadJobs());
	say(ok ? "sys" : "err", ok ? `Cancelled ${kind === "r" ? "reminder" : "job"} ${id}.` : `No open ${kind === "r" ? "reminder" : "job"} ${id}.`);
}

async function pause(ref: string, paused: boolean) {
	const match = /^j(\d+)$/.exec(ref);
	if (!match) throw new Error(`Give a job's reference from /next, like j3, not "${ref}".`);
	const { ok } = await post(paused ? "/api/jobs/pause" : "/api/jobs/resume", { id: Number(match[1]) });
	await loadJobs();
	say(ok ? "sys" : "err", ok ? `${paused ? "Paused" : "Resumed"} job ${match[1]}.` : `No ${paused ? "running" : "paused"} job ${match[1]}.`);
}

async function allowMore() {
	try {
		state.budget = await post("/api/budget/allow", {});
		say("sys", `Allowed more today: the daily limit is now ${money(state.budget!.dailyLimit)}.`);
	} catch (error) {
		notice(String(error));
	}
}

function showHelp() {
	const help = el("div", "help");
	for (const c of commands) help.append(el("span", "c", `/${c.name}`), el("span", "a", c.args ?? ""), el("span", "h", c.help));
	const keys = el("div", "keys", `Enter sends · Shift+Enter new line · ↑ ↓ history · Tab completes · Esc or Ctrl+C stops a run · ${alt}Y ${alt}A ${alt}N answer an approval · start with // to send a message beginning with /`);
	const body = el("div");
	body.append(help, keys);
	say("sys", body);
}

const commands: Command[] = [
	{ name: "help", help: "Commands and keys", run: showHelp },
	{ name: "next", help: "Upcoming reminders and scheduled jobs (the schedule page)", run: () => go("schedule") },
	{
		name: "cancel",
		args: "<ref>",
		help: "Cancel a reminder or job by its reference (Tab lists them)",
		complete: () => upcoming().map((i) => ({ value: i.ref, hint: `${i.text}${i.at === undefined ? "" : ` · ${fromNow(i.at)}`}` })),
		run: (arg) => cancel(arg),
	},
	{
		name: "pause",
		args: "<ref>",
		help: "Pause a job: its runs are skipped until you resume it",
		complete: () => upcoming().filter((i) => i.kind === "job" && !i.paused).map((i) => ({ value: i.ref, hint: i.text })),
		run: (arg) => pause(arg, true),
	},
	{
		name: "resume",
		args: "<ref>",
		help: "Resume a paused job from its next scheduled run",
		complete: () => upcoming().filter((i) => i.paused).map((i) => ({ value: i.ref, hint: i.text })),
		run: (arg) => pause(arg, false),
	},
	{ name: "stop", help: "Stop the current run (Esc, Ctrl+C)", run: () => stop() },
	{
		name: "model",
		args: "[id]",
		help: "Show or switch the model",
		complete: () => (current?.models ?? []).map((m) => ({ value: m, hint: m === current?.model ? "current" : undefined })),
		run: async (arg) => {
			if (arg === "") return say("sys", `Model ${current?.model ?? "unknown"}. Choices: ${current?.models.join(", ") ?? "none"}.`);
			await configure({ model: arg });
			say("sys", `Model set to ${arg}. Applies from the next request.`);
		},
	},
	{
		name: "thinking",
		args: "[level]",
		help: "Show or set the thinking level",
		complete: () => LEVELS.map((l) => ({ value: l, hint: l === current?.thinkingLevel ? "current" : undefined })),
		run: async (arg) => {
			if (arg === "") return say("sys", `Thinking ${current?.thinkingLevel ?? "unknown"}. Levels: ${LEVELS.join(", ")}.`);
			const level = LEVELS.find((l) => l === arg);
			if (level === undefined) return say("err", `No thinking level ${arg}. Levels: ${LEVELS.join(", ")}.`);
			await configure({ thinkingLevel: level });
			say("sys", `Thinking set to ${level}. Applies from the next request.`);
		},
	},
	{ name: "tools", help: "Switch tools on and off (the settings page)", run: () => go("settings") },
	{ name: "memory", help: "gaidin's notes, which every conversation sees (the memory page)", run: () => go("memory") },
	{ name: "timeline", help: "What gaidin did and who allowed it (the activity page)", run: () => go("activity") },
	{ name: "notifications", help: "Notifications for this device and the others (the settings page)", run: () => go("settings") },
	{
		name: "remember",
		args: "<text>",
		help: "Add a note to gaidin's memory",
		run: async (arg) => {
			if (arg === "") throw new Error("Give the note's text: /remember the NAS is in the hall closet");
			const note = await post("/api/memory/add", { text: arg });
			say("sys", `Noted [${note.id}]: ${note.text}`);
		},
	},
	{
		name: "forget",
		args: "<id>",
		help: "Delete a note by its /memory number",
		run: async (arg) => {
			const id = Number(arg);
			if (!Number.isInteger(id)) throw new Error("Give a note number from /memory, like /forget 3.");
			const { ok } = await post("/api/memory/forget", { id });
			say(ok ? "sys" : "err", ok ? `Forgot note ${id}.` : `No note ${id}.`);
		},
	},
	{ name: "budget", help: "Spend today and this month, against the limits (the activity page)", run: () => go("activity") },
	{
		name: "tool",
		args: "<name> [on|off]",
		help: "Switch a tool on or off",
		complete: () => (current?.tools ?? []).map((t) => ({ value: `${t.name} ${t.enabled ? "off" : "on"}`, hint: t.enabled ? "on now" : "off now" })),
		run: async (arg) => {
			const [name, setting] = arg.split(/\s+/);
			const settings = current ?? (await load("/api/settings"));
			const tool = settings.tools.find((t) => t.name === name);
			if (!tool) throw new Error(`No switchable tool "${name}". /tools lists them.`);
			const on = setting === undefined ? !tool.enabled : setting === "on";
			const disabled = new Set(settings.tools.filter((t) => !t.enabled).map((t) => t.name));
			if (on) disabled.delete(name);
			else disabled.add(name);
			await configure({ disabledTools: [...disabled] });
			say("sys", `${name} ${on ? "on" : "off"}. Applies from the next request.`);
		},
	},
	{
		name: "instructions",
		args: "[text | clear]",
		help: "Show or replace the standing instructions",
		run: async (arg) => {
			if (arg === "") return say("sys", current?.instructions ? current.instructions : "No standing instructions.");
			await configure({ instructions: arg === "clear" ? "" : arg });
			say("sys", arg === "clear" ? "Standing instructions cleared." : "Standing instructions saved. They apply from the next request.");
		},
	},
	{ name: "allow", help: `Allow the waiting request once (${alt}Y)`, run: () => decide("once") },
	{ name: "always", help: `Allow it from now on, where offered (${alt}A)`, run: () => decide("always") },
	{ name: "deny", help: `Deny the waiting request (${alt}N)`, run: () => decide("deny") },
	{
		name: "clear",
		help: "Clear command output from the screen",
		run: () => {
			local.length = 0;
			schedule();
		},
	},
];

async function runCommand(line: string) {
	say("cmd", line);
	const [, name = "", arg = ""] = /^\/(\S*)\s*([\s\S]*)$/.exec(line) ?? [];
	const command = commands.find((c) => c.name === name);
	if (command === undefined) return say("err", `Unknown command /${name}. /help lists them.`);
	try {
		await command.run(arg.trim());
	} catch (error) {
		say("err", error instanceof Error ? error.message : String(error));
	}
}

// --- completion menu --------------------------------------------------------------------------

type Suggestion = { value: string; label: string; args?: string; hint?: string; run: boolean };
let menuItems: Suggestion[] = [];
let menuIndex = 0;
let dismissed: string | undefined;

function suggestions(text: string): Suggestion[] {
	if (!text.startsWith("/") || text.startsWith("//") || text.includes("\n")) return [];
	const body = text.slice(1);
	const space = body.indexOf(" ");
	if (space < 0) {
		return commands
			.filter((c) => c.name.startsWith(body))
			.map((c) => ({ value: c.args ? `/${c.name} ` : `/${c.name}`, label: `/${c.name}`, args: c.args, hint: c.help, run: c.args === undefined }));
	}
	const name = body.slice(0, space);
	const arg = body.slice(space + 1);
	const command = commands.find((c) => c.name === name);
	if (command?.complete === undefined) return [];
	return command
		.complete()
		.filter((o) => o.value.startsWith(arg) && o.value !== arg)
		.map((o) => ({ value: `/${name} ${o.value}`, label: o.value, hint: o.hint, run: true }));
}

function updateMenu() {
	const text = input.value;
	menuItems = text === dismissed ? [] : suggestions(text);
	menuIndex = Math.min(menuIndex, Math.max(0, menuItems.length - 1));
	const menu = $("menu");
	menu.hidden = menuItems.length === 0;
	menu.replaceChildren(
		...menuItems.map((item, n) => {
			const option = el("div", `item${n === menuIndex ? " active" : ""}`);
			option.id = `menu-${n}`;
			option.setAttribute("role", "option");
			option.setAttribute("aria-selected", String(n === menuIndex));
			const value = el("span", "v", item.label);
			if (item.args) value.append(" ", el("span", "a", item.args));
			option.append(value, el("span", "h", item.hint ?? ""));
			option.addEventListener("mousedown", (e) => e.preventDefault());
			option.addEventListener("click", () => accept(item, true));
			return option;
		}),
	);
	if (menuItems.length > 0) input.setAttribute("aria-activedescendant", `menu-${menuIndex}`);
	else input.removeAttribute("aria-activedescendant");
	$(`menu-${menuIndex}`)?.scrollIntoView({ block: "nearest" });
}

function accept(item: Suggestion, submitIfReady: boolean) {
	input.value = item.value;
	fit();
	menuIndex = 0;
	input.focus();
	input.setSelectionRange(input.value.length, input.value.length);
	if (submitIfReady && item.run) void submit();
	else updateMenu();
}

// --- controls ---------------------------------------------------------------------------------

const input = $<HTMLTextAreaElement>("message");
// A phone's one-line prompt has room for the short form.
const narrow = matchMedia("(max-width: 600px)");
const placeholder = () => {
	input.placeholder = narrow.matches ? "Message, or / for commands" : "Message gaidin, or type / for commands";
};
narrow.addEventListener("change", placeholder);
placeholder();

/** The prompt grows with its text, up to the CSS max-height, keeping the log pinned if it was. */
function fit() {
	const scroller = $("scroll");
	const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;
	input.style.height = "auto";
	input.style.height = `${input.scrollHeight}px`;
	if (atBottom) scroller.scrollTop = scroller.scrollHeight;
}

function prefill(text: string) {
	input.value = text;
	dismissed = undefined;
	fit();
	input.focus();
	input.setSelectionRange(text.length, text.length);
	updateMenu();
}

/** Earlier prompts from the log, then commands typed since the page opened. */
const typed: string[] = [];
let historyList: string[] = [];
let historyAt = -1;
let draft = "";

function history(): string[] {
	const prompts = [...transcript.entries.values()]
		.sort((a, b) => a.id - b.id)
		.filter((e) => e.kind === "pi.user")
		.flatMap((e) => (e.model ?? []).flatMap((m) => (m.role === "user" ? [splitStamp(textOf(m.content)).text] : [])));
	return [...prompts, ...typed].filter((text, i, all) => text !== all[i - 1]);
}

function recall(step: number) {
	if (historyAt === -1) {
		historyList = history();
		historyAt = historyList.length;
		draft = input.value;
	}
	historyAt = Math.max(0, Math.min(historyList.length, historyAt + step));
	const text = historyAt === historyList.length ? draft : historyList[historyAt];
	if (historyAt === historyList.length) historyAt = -1;
	input.value = text;
	dismissed = text;
	fit();
	updateMenu();
	input.setSelectionRange(text.length, text.length);
}

/** randomUUID exists only on secure pages (HTTPS or localhost); getRandomValues works on plain http too. */
function requestId(): string {
	if (crypto.randomUUID instanceof Function) return crypto.randomUUID();
	return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function submit() {
	const text = input.value;
	const content = text.trim();
	if (content === "") return;
	historyAt = -1;
	dismissed = undefined;
	input.value = "";
	fit();
	updateMenu();
	go("console");
	if (content.startsWith("/") && !content.startsWith("//")) {
		typed.push(content);
		return runCommand(content);
	}
	stick = true;
	try {
		const sent = await post("/api/message", { content: content.startsWith("//") ? content.slice(1) : content, requestId: requestId() });
		// The server takes a message as the answer when gaidin is waiting on a question.
		if (sent?.answered) say("sys", "Taken as the answer to gaidin's question; the run goes on.");
	} catch (error) {
		// Put the message back so it isn't lost.
		if (input.value === "") {
			input.value = text;
			fit();
		}
		notice(String(error));
	}
}

$("prompt").addEventListener("submit", (e) => {
	e.preventDefault();
	void submit();
});

input.addEventListener("input", () => {
	historyAt = -1;
	dismissed = undefined;
	fit();
	updateMenu();
});

input.addEventListener("keydown", (press) => {
	const { key, shiftKey, isComposing } = press;
	if (isComposing) return;
	if (menuItems.length > 0) {
		const handled = () => {
			press.preventDefault();
			press.stopPropagation();
		};
		if (key === "ArrowDown" || key === "ArrowUp") {
			handled();
			menuIndex = (menuIndex + (key === "ArrowDown" ? 1 : -1) + menuItems.length) % menuItems.length;
			return updateMenu();
		}
		if (key === "Tab") {
			handled();
			return accept(menuItems[menuIndex], false);
		}
		if (key === "Escape") {
			handled();
			dismissed = input.value;
			return updateMenu();
		}
		// Enter takes the highlighted suggestion, unless a whole command is already typed.
		if (key === "Enter" && !shiftKey && !commands.some((c) => input.value === `/${c.name}`)) {
			handled();
			return accept(menuItems[menuIndex], true);
		}
	}
	if (key === "Enter" && !shiftKey) {
		press.preventDefault();
		void submit();
		return;
	}
	const caret = input.selectionStart;
	if (key === "ArrowUp" && input.selectionEnd === caret && !input.value.slice(0, caret).includes("\n")) {
		press.preventDefault();
		recall(-1);
	} else if (key === "ArrowDown" && historyAt !== -1 && input.selectionEnd === caret && !input.value.slice(caret).includes("\n")) {
		press.preventDefault();
		recall(1);
	}
});

const SHORTCUTS = new Map<string, Decision>([["KeyY", "once"], ["KeyA", "always"], ["KeyN", "deny"]]);

document.addEventListener("keydown", (press) => {
	const { key, code, altKey, ctrlKey, metaKey } = press;
	if (altKey && !ctrlKey && !metaKey && firstApproval() !== undefined) {
		const decision = SHORTCUTS.get(code);
		if (decision !== undefined) {
			press.preventDefault();
			void decide(decision);
			return;
		}
	}
	const target = press.target;
	const typing = target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
	// Esc and Ctrl+C stop a run only on the console, from the prompt or with nothing else to type in: a stopped request
	// is dropped, so an Esc that closes an editor on another page mustn't throw it away.
	const stoppable = view() === "console" && (!typing || target === input);
	if (key === "Escape" && transcript.running && stoppable) {
		press.preventDefault();
		void stop();
		return;
	}
	// Ctrl+C stops a run, as in a terminal, unless there's a selection to copy.
	if (ctrlKey && !metaKey && !altKey && (key === "c" || key === "C") && stoppable) {
		const selected = (window.getSelection()?.toString() ?? "") !== "" || input.selectionStart !== input.selectionEnd;
		if (selected) return;
		press.preventDefault();
		if (transcript.running) void stop("^C");
		else if (input.value !== "") prefill("");
		return;
	}
	// Typing anywhere goes to the prompt.
	if (!typing && !ctrlKey && !metaKey && !altKey && key.length === 1) input.focus();
});

const scroller = $("scroll");
scroller.addEventListener("scroll", () => {
	if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48) $("jump").hidden = true;
});
$("jump").addEventListener("click", () => {
	scroller.scrollTop = scroller.scrollHeight;
	$("jump").hidden = true;
});
$("next-up").addEventListener("click", () => go("schedule"));
// On a phone the tabs scroll sideways; a fade on an edge says there are more that way.
const tabs = $("views");
const edges = () => {
	tabs.classList.toggle("more-left", tabs.scrollLeft > 2);
	tabs.classList.toggle("more-right", tabs.scrollLeft + tabs.clientWidth < tabs.scrollWidth - 2);
};
tabs.addEventListener("scroll", edges, { passive: true });
window.addEventListener("resize", edges);
window.addEventListener("hashchange", showView);
showView();

// The service worker shows notifications, and a short page when the server can't be reached.
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch((error) => notice(String(error)));
connect();
void loadReminders();
void loadJobs();
void loadSettings();
void loadSpend();
setInterval(() => {
	void loadReminders();
	void loadJobs();
}, 60_000);
input.focus();
