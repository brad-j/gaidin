import { Type } from "@earendil-works/pi-ai";
import { type ConversationId, defineDoc, defineEntry, defineExtension, defineTask, defineTool, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { agentIdOf, DEFAULT_AGENT } from "./agents.ts";
import { guard, ifOutsideText, quoted } from "./guards.ts";
import { SPEAKER, SpeakerOf, SPEECH } from "./threads.ts";
import { formatClock, formatTime } from "./time.ts";
import { taskId } from "./ids.ts";
import { number, object } from "./parse.ts";

/**
 * `agent`: the agent that set it; absent, the default agent. `speaker`: the speaker in the house that says it (voice.ts),
 * or "*" for every speaker; absent, it goes to the owner's phone.
 */
export type Reminder = { taskId: number; text: string; at: number; agent?: string; speaker?: string };
export type Notify = (reminder: Reminder) => Promise<void>;

/** Open reminders. A reminder leaves the list when it fires or is cancelled. */
export const Reminders = defineDoc<{ items: Reminder[] }>({
	kind: "gaidin.reminders",
	version: 1,
	scope: "session",
	initial: () => ({ items: [] }),
});

/** Transcript record of a fired reminder. It carries no model messages, so the model doesn't see it. */
export const ReminderFired = defineEntry<{ text: string; at: number; delivered: boolean; error?: string; taskId?: number }>("gaidin.reminder-fired");

/** Whether `reminder` is `agent`'s. */
export const reminderOf = (reminder: Reminder, agent: string) => (reminder.agent ?? DEFAULT_AGENT) === agent;

/**
 * Takes a reminder off the open list. Its task finds itself gone when it wakes, and finishes without
 * notifying. Returns the reminder, or nothing if it wasn't open, or wasn't `agent`'s when one is given.
 */
export async function removeReminder(tx: Tx, id: number, agent?: string): Promise<Reminder | undefined> {
	const doc = await tx.doc(Reminders);
	const found = doc.items.find((r) => r.taskId === id && (agent === undefined || reminderOf(r, agent)));
	if (found === undefined) return undefined;
	doc.items = doc.items.filter((r) => r.taskId !== id);
	return found === undefined ? undefined : { ...found };
}

const MAX_ATTEMPTS = 5;

/** For a reminder within the hour, its exact time and how far off it is, since formatTime leaves out the seconds. */
export function soon(at: number, now = Date.now()): string {
	const seconds = Math.round((at - now) / 1000);
	if (seconds >= 3600) return "";
	const wait = seconds < 60 ? `${seconds} seconds` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
	return ` (${formatClock(at)}, in ${wait})`;
}

/** Where a reminder is heard, in words. */
export const placeOf = (speaker: string) => (speaker === "*" ? "every speaker" : `the ${speaker} speaker`);

type State = { phase: "wait" } | { phase: "notify"; attempt: number; retryAt: number };
type Result = "sent" | "cancelled" | "failed";

/** Where `to` sends a reminder: a speaker, "*" for every speaker, or undefined for the phone; by default, the thread's speaker. */
export function speakerFor(to: string | undefined, here: { speaker?: string } | undefined): string | undefined {
	const place = to?.trim().toLowerCase();
	if (place === undefined || place === "") return here?.speaker;
	if (place === "phone") return undefined;
	if (["every speaker", "everywhere", "all", "all speakers"].includes(place)) return "*";
	const name = place.replace(/ speaker$/, "").replace(/^the /, "");
	if (!SPEAKER.test(name)) throw new Error(`"${to}" isn't a speaker's name, "every speaker" or "phone".`);
	return name;
}

export function createReminders(notify: Notify, owner = "the user") {
	const ReminderTask = defineTask<{ text: string; at: number; agent?: string; speaker?: string }, State, Result>({
		name: "gaidin.reminder",
		version: 1,
		initial: () => ({ phase: "wait" }),
		phases: {
			wait: async (task, runtime, context) => {
				// The fire time is in the task's input, so after a restart this sleeps until the same moment.
				await runtime.sleep(task.input.at, context);
				await runtime.commit(async (tx) => {
					const open = (await tx.doc(Reminders)).items.some((r) => r.taskId === task.id);
					if (!open) return { status: "terminal", outcome: { status: "completed", result: "cancelled" } };
					return { status: "running", checkpoint: { phase: "notify", attempt: 1, retryAt: 0 } };
				}, context);
			},
			notify: async (task, runtime, context) => {
				const { attempt, retryAt } = task.state.checkpoint;
				await runtime.sleep(retryAt, context);
				const reminder = { taskId: task.id, ...task.input };
				// At least once: a crash after the push and before this commit sends it again.
				let error: string | undefined;
				try {
					await notify(reminder);
				} catch (e) {
					error = e instanceof Error ? e.message : String(e);
				}
				await runtime.commit(async (tx) => {
					const doc = await tx.doc(Reminders);
					if (error !== undefined && attempt < MAX_ATTEMPTS) {
						const delay = 2 ** attempt * 1000;
						return { status: "running", checkpoint: { phase: "notify", attempt: attempt + 1, retryAt: runtime.now() + delay } };
					}
					doc.items = doc.items.filter((r) => r.taskId !== task.id);
					const data = { ...task.input, taskId: task.id, delivered: error === undefined };
					await tx.appendEntry(ReminderFired, task.conversationId, { data: error === undefined ? data : { ...data, error } });
					return {
						status: "terminal",
						outcome: error === undefined
							? { status: "completed", result: "sent" }
							: { status: "failed", error: { message: error }, result: "failed" },
					};
				}, context);
			},
		},
		abort: async (task, runtime, context) => {
			await runtime.commit(async (tx) => {
				const doc = await tx.doc(Reminders);
				doc.items = doc.items.filter((r) => r.taskId !== task.id);
				return { status: "terminal", outcome: { status: "aborted" } };
			}, context);
		},
	});

	async function add(tx: Tx, conversationId: ConversationId, text: string, at: number, agent: string, speaker?: string): Promise<number> {
		const input: { text: string; at: number; agent?: string; speaker?: string } = agent === DEFAULT_AGENT ? { text, at } : { text, at, agent };
		if (speaker !== undefined) input.speaker = speaker;
		// Background: the conversation goes idle while it waits, and Esc doesn't cancel it.
		const id = await tx.createTask(ReminderTask, input, { ownership: { kind: "conversation" }, conversationId, background: true });
		(await tx.doc(Reminders)).items.push({ taskId: id, ...input });
		return id;
	}

	/** Sets a reminder that has fired again, `minutes` from now, in the same conversation. Nothing if `id` isn't a reminder. */
	async function snooze(tx: Tx, id: number, minutes: number): Promise<Reminder | undefined> {
		const task = await tx.task(taskId(id));
		if (task === undefined || task.kind !== "gaidin.reminder") return undefined;
		// SAFETY: a gaidin.reminder task's input is what add() made it with.
		const { text, agent = DEFAULT_AGENT, speaker } = task.input as { text: string; agent?: string; speaker?: string };
		const at = Date.now() + minutes * 60_000;
		const again = await add(tx, task.conversationId, text, at, agent, speaker);
		const snoozed: Reminder = agent === DEFAULT_AGENT ? { taskId: again, text, at } : { taskId: again, text, at, agent };
		if (speaker !== undefined) snoozed.speaker = speaker;
		return snoozed;
	}

	const remind = defineTool({
		name: "remind",
		description:
			`Schedule a reminder or timer: a push notification to ${owner}'s phone, or said aloud by a speaker in the house. Give exactly one of \`inMinutes\` (relative) or \`at\` ` +
			"(ISO 8601 with a UTC offset, e.g. 2026-10-09T08:30:00-04:00). Check the time and the place in the result.",
		parameters: Type.Object({
			text: Type.String({ description: `What to remind ${owner} about, as they should read it, or hear it said` }),
			inMinutes: Type.Optional(Type.Number({ minimum: 0, description: "Minutes from now; fractions are fine, so 0.5 is a 30-second timer" })),
			at: Type.Optional(Type.String()),
			to: Type.Optional(Type.String({ description: `Where it's heard: a speaker's name such as "kitchen", "every speaker", or "phone". Set while talking at a speaker it defaults to that speaker, otherwise to ${owner}'s phone.` })),
		}),
		execute: async (args, api, context) => {
			if ((args.inMinutes === undefined) === (args.at === undefined)) throw new Error("Give exactly one of inMinutes or at.");
			const at = args.at === undefined ? Date.now() + args.inMinutes! * 60_000 : Date.parse(args.at);
			if (Number.isNaN(at)) throw new Error(`Can't parse at: ${args.at}`);
			if (at < Date.now() - 60_000) throw new Error(`${formatTime(at)} is in the past.`);
			const agent = await agentIdOf(api, api.conversationId, context);
			const speaker = speakerFor(args.to, await api.snapshot(SpeakerOf, api.conversationId, context));
			const taskId = await api.commit((tx) => add(tx, api.conversationId, args.text, at, agent, speaker), context);
			const place = speaker === undefined ? "" : `, said on ${placeOf(speaker)}`;
			return { output: [{ type: "text", text: `Reminder ${taskId} set for ${formatTime(at)}${soon(at)}${place}: ${args.text}` }] };
		},
	});

	const listReminders = defineTool({
		name: "list_reminders",
		description: "List open reminders with their ids and times.",
		parameters: Type.Object({}),
		replay: "safe",
		execute: async (_args, api, context) => {
			const agent = await agentIdOf(api, api.conversationId, context);
			const items = ((await api.snapshot(Reminders, context))?.items ?? []).filter((r) => reminderOf(r, agent));
			const text = items.length === 0
				? "No open reminders."
				: items.sort((a, b) => a.at - b.at).map((r) => `${r.taskId}: ${formatTime(r.at)}${r.speaker === undefined ? "" : ` (${placeOf(r.speaker)})`}: ${r.text}`).join("\n");
			return { output: [{ type: "text", text }] };
		},
	});

	const cancelReminder = defineTool({
		name: "cancel_reminder",
		description: "Cancel an open reminder by id.",
		parameters: Type.Object({ id: Type.Number() }),
		replay: "safe",
		execute: async (args, api, context) => {
			const agent = await agentIdOf(api, api.conversationId, context);
			const removed = await api.commit((tx) => removeReminder(tx, args.id, agent), context);
			const text = removed ? `Cancelled ${args.id}: ${removed.text}` : `No open reminder ${args.id}.`;
			return { output: [{ type: "text", text }] };
		},
	});

	// Cancelling asks after outside text, so a page can't quietly undo what the owner set up. Speech at a speaker doesn't
	// count: whoever is in the room can cancel the timer they or someone else set there, which is what a timer is for, and an
	// agent only ever cancels its own reminders. A page read in the same conversation still makes it ask.
	const guards = [
		guard("cancel_reminder", object({ id: number }), {
			ask: (a, situation) =>
				ifOutsideText(situation, async () => `cancel reminder ${a.id}${quoted((await situation.snapshot(Reminders))?.items.find((r) => r.taskId === a.id && reminderOf(r, situation.agent.id))?.text)}`, [SPEECH]),
		}),
	];

	return {
		ReminderTask,
		snooze,
		guards,
		extension: defineExtension({
			name: "reminders",
			tools: [remind, listReminders, cancelReminder],
			tasks: [ReminderTask],
		}),
	};
}

export type ReminderTaskId = TaskId<Result>;
