// The schedule view: open reminders and scheduled jobs, soonest first. A job opens to show its instruction
// and the reports it last sent. New ones are asked of gaidin at the prompt, so they go through its approvals.
import type { Gets } from "../src/web.ts";
import { post } from "./api.ts";
import { ago, clock, day, el, fromNow, when } from "./dom.ts";
import { markdown } from "./markdown.ts";

type Reminder = Gets["/api/reminders"][number];
type Job = Gets["/api/jobs"][number];

export type ScheduleHooks = {
	/** Loads the lists again after a change. */
	changed: () => Promise<void>;
	/** Puts text at the prompt, to ask gaidin for something new. */
	prefill: (text: string) => void;
};

/** Jobs opened to show their instruction and reports, so a re-render keeps them open. */
const opened = new Set<number>();
/** The item whose cancel was pressed once and waits for a second press, as "r12" or "j3". */
let confirming: string | undefined;
let confirmTimer: ReturnType<typeof setTimeout> | undefined;
/** What went wrong with the last change, shown above the lists until the next one. */
let problem: string | undefined;
let signature = "";
let redraw = () => {};

/** Jobs that need the owner: paused, or failing. */
export function troubled(jobs: readonly Job[]): number {
	return jobs.filter((j) => j.paused !== undefined || (j.failures ?? 0) > 0).length;
}

export function renderSchedule(root: HTMLElement, reminders: readonly Reminder[], jobs: readonly Job[], hooks: ScheduleHooks) {
	redraw = () => {
		signature = "";
		renderSchedule(root, reminders, jobs, hooks);
	};
	// Rebuilt only when something shown changed, so a button under the pointer stays put.
	const next = JSON.stringify([reminders, jobs, [...opened], confirming, problem, Math.floor(Date.now() / 60_000)]);
	if (next === signature) return;
	signature = next;

	const sortedJobs = [...jobs].sort((a, b) => (a.paused ? Infinity : a.nextAt ?? Infinity) - (b.paused ? Infinity : b.nextAt ?? Infinity));
	root.replaceChildren(
		...(problem === undefined ? [] : [el("p", "page-problem", problem)]),
		section("Reminders", reminders.length, "new reminder", () => hooks.prefill("Remind me to "),
			reminders.length === 0 ? empty("No reminders. Ask gaidin for one, like “remind me to call the dentist at 3”.") : list(reminders.map((r) => reminderRow(r, hooks)))),
		section("Jobs", jobs.length, "new job", () => hooks.prefill("Schedule a job: "),
			jobs.length === 0 ? empty("No scheduled jobs. Ask gaidin for a morning briefing, or a check every few hours that tells you only when something changes.") : list(sortedJobs.map((j) => jobRow(j, hooks)))),
	);
}

function section(title: string, count: number, action: string, run: () => void, body: HTMLElement): HTMLElement {
	const node = el("section", "sched");
	const head = el("div", "section-head");
	const button = el("button", "plain", `+ ${action}`);
	button.type = "button";
	button.addEventListener("click", run);
	head.append(el("h2", undefined, title), el("span", "count", String(count)), button);
	node.append(head, body);
	return node;
}

function empty(text: string): HTMLElement {
	return el("p", "page-empty", text);
}

function list(rows: HTMLElement[]): HTMLElement {
	const node = el("ol", "sched-list");
	node.append(...rows);
	return node;
}

/** When something is next due: the day and time, and how long from now. */
function due(at: number | undefined, fallback: string, tone = ""): HTMLElement {
	const node = el("div", `due ${tone}`);
	if (at === undefined) {
		node.append(el("span", "at", fallback));
		return node;
	}
	node.title = when.format(at);
	node.append(el("span", "at", `${day(at)} ${clock.format(at)}`), el("span", "in", fromNow(at)));
	if (at - Date.now() < 3_600_000) node.classList.add("soon");
	return node;
}

function action(label: string, run: () => Promise<void>, hooks: ScheduleHooks, className = "plain"): HTMLButtonElement {
	const button = el("button", className, label);
	button.type = "button";
	button.addEventListener("click", () => {
		button.disabled = true;
		problem = undefined;
		void run()
			.then(hooks.changed)
			.catch((error) => {
				problem = error instanceof Error ? error.message : String(error);
				redraw();
			})
			.finally(() => {
				button.disabled = false;
			});
	});
	return button;
}

/** Cancel asks for a second press within 4 seconds; a cancelled job or reminder can't be brought back. */
function cancelButton(ref: string, path: "/api/reminders/cancel" | "/api/jobs/cancel", id: number, hooks: ScheduleHooks): HTMLButtonElement {
	if (confirming !== ref) {
		const button = el("button", "plain", "cancel");
		button.type = "button";
		button.addEventListener("click", () => {
			confirming = ref;
			clearTimeout(confirmTimer);
			confirmTimer = setTimeout(() => {
				confirming = undefined;
				redraw();
			}, 4000);
			redraw();
		});
		return button;
	}
	const button = action("confirm cancel", async () => {
		confirming = undefined;
		const { ok } = await post(path, { id });
		if (!ok) throw new Error(`${ref.startsWith("r") ? "That reminder" : "That job"} was already gone.`);
	}, hooks, "danger");
	button.setAttribute("aria-label", "Press again to cancel for good");
	// The second press lands on the same spot, so it keeps its focus.
	queueMicrotask(() => button.focus());
	return button;
}

function reminderRow(reminder: Reminder, hooks: ScheduleHooks): HTMLElement {
	const node = el("li", "sched-row");
	const body = el("div", "body");
	body.append(el("div", "title", reminder.text));
	const actions = el("div", "actions");
	actions.append(cancelButton(`r${reminder.taskId}`, "/api/reminders/cancel", reminder.taskId, hooks));
	node.append(due(reminder.at, ""), body, actions);
	return node;
}

const RESULT = { reported: "reported", quiet: "nothing new", failed: "failed" } as const;

function jobRow(job: Job, hooks: ScheduleHooks): HTMLElement {
	const open = opened.has(job.taskId);
	const node = el("li", `sched-row job${open ? " open" : ""}${job.paused ? " paused" : ""}`);

	const title = el("button", "title toggle", job.title);
	title.type = "button";
	title.setAttribute("aria-expanded", String(open));
	title.addEventListener("click", () => {
		if (opened.has(job.taskId)) opened.delete(job.taskId);
		else opened.add(job.taskId);
		redraw();
	});

	const meta = el("div", "meta");
	const part = (text: string, className = "") => meta.append(el("span", className, text));
	if (job.mode === "watch") part("watch", "tag");
	part(job.when);
	if (job.gate !== undefined) part(`gate ${job.gate.name}`);
	part(`${job.runs} run${job.runs === 1 ? "" : "s"}${job.skipped ? `, ${job.skipped} skipped by the gate` : ""}`);
	if (job.lastAt !== undefined) part(`last ${ago(job.lastAt)}${job.lastResult ? `: ${RESULT[job.lastResult]}` : ""}`, job.lastResult === "failed" ? "bad" : "");

	const body = el("div", "body");
	body.append(title, meta);
	// Why it needs the owner, on a line of its own: "paused by the owner", or "5 failed runs in a row".
	if (job.paused) {
		const reason = job.paused.reason.startsWith("paused") ? job.paused.reason : `paused after ${job.paused.reason}`;
		body.append(el("div", "status warn", `${reason} · ${ago(job.paused.at)}`));
	} else if ((job.failures ?? 0) > 0) body.append(el("div", "status bad", `${job.failures} failed run${job.failures === 1 ? "" : "s"} in a row; it pauses after 5`));
	if (open) body.append(jobDetail(job));

	const actions = el("div", "actions");
	actions.append(
		job.paused
			? action("resume", async () => void (await post("/api/jobs/resume", { id: job.taskId })), hooks)
			: action("pause", async () => void (await post("/api/jobs/pause", { id: job.taskId })), hooks),
		cancelButton(`j${job.taskId}`, "/api/jobs/cancel", job.taskId, hooks),
	);
	node.append(job.paused ? due(undefined, "paused", "warn") : due(job.nextAt, "no next run"), body, actions);
	return node;
}

function jobDetail(job: Job): HTMLElement {
	const detail = el("div", "detail");
	detail.append(el("div", "label", "instruction"), el("p", "instruction", job.instruction));
	if (job.gate?.args !== undefined) detail.append(el("div", "label", `gate ${job.gate.name} with`), el("pre", undefined, JSON.stringify(job.gate.args, null, 2)));
	const recent = [...(job.recent ?? [])].reverse();
	detail.append(el("div", "label", recent.length === 0 ? "no reports yet" : `last ${recent.length === 1 ? "report" : `${recent.length} reports`}`));
	for (const report of recent) {
		const item = el("div", "report");
		item.append(el("div", "stamp", `${when.format(report.at)} · ${ago(report.at)}`), markdown(report.text));
		detail.append(item);
	}
	return detail;
}
