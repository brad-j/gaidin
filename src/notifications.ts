// Notifications: everything gaidin tells the owner without being asked, and which way each goes. Reminders,
// job reports, a paused job, budget warnings and requests for approval are handed here as notices; the
// adapters for Slack (slack/notifications.ts), Web Push (push.ts) and ntfy (ntfy.ts) each write a notice
// their own way. docs/surfaces.md#notifications describes the routes for the owner.
//
//   reminder        Web Push and ntfy, which must reach the owner; Slack too, with snooze buttons
//   report, paused  Slack if it's set up, otherwise Web Push and ntfy
//   budget          the same
//   request         Web Push and Slack, as they can; a request also waits in the app
import type { ApprovalRequest } from "./approvals.ts";
import type { Report } from "./jobs.ts";
import type { Reminder } from "./reminders.ts";

export type Notice =
	| { kind: "reminder"; reminder: Reminder }
	| { kind: "report"; report: Report }
	/** A job that paused after failing in a row, which the owner can resume. */
	| { kind: "paused"; report: Report }
	| { kind: "budget"; text: string }
	/** A request for approval or a question, when it opens and again when it's settled. */
	| { kind: "request"; request: ApprovalRequest };

/** One way to reach the owner. `send` resolves with whether it reached anyone, and throws when it failed. */
export type Adapter = { send(notice: Notice): Promise<boolean> };
export type Adapters = { slack?: Adapter; push?: Adapter; ntfy?: Adapter };

/** One line for the server's output, when nothing else reached the owner. */
function describe(notice: Notice): string {
	switch (notice.kind) {
		case "reminder":
			return `reminder: ${notice.reminder.text}`;
		case "report":
		case "paused":
			return `${notice.report.title}: ${notice.report.text}`;
		case "budget":
			return `budget: ${notice.text}`;
		case "request":
			return `request: ${notice.request.summary}`;
	}
}

export function createNotifications(adapters: Adapters) {
	const { slack, push, ntfy } = adapters;
	const phone = [ntfy, push].filter((a) => a !== undefined);

	/** The ways that must reach the owner, and the ones tried as well. */
	type Routes = { required: Adapter[]; extra: Adapter[] };
	function routes(kind: Notice["kind"]): Routes {
		if (kind === "request") return { required: [], extra: [push, slack].filter((a) => a !== undefined) };
		if (kind === "reminder") return { required: phone, extra: slack === undefined ? [] : [slack] };
		return slack === undefined ? { required: phone, extra: [] } : { required: [slack], extra: [] };
	}

	return {
		/**
		 * Tells the owner. Throws when none of the ways that must reach them did and one failed, so a reminder or a
		 * report is tried again later, and the other ways wait for that retry rather than hearing it twice. When
		 * nothing reached the owner without failing, as with no way set up, prints to the server's output.
		 */
		async send(notice: Notice): Promise<void> {
			const { required, extra } = routes(notice.kind);
			const errors: unknown[] = [];
			let told = false;
			for (const adapter of required) {
				try {
					if (await adapter.send(notice)) told = true;
				} catch (error) {
					errors.push(error);
				}
			}
			if (!told && errors.length > 0) throw errors[0];
			for (const error of errors) console.error("[notify]", error);
			if (!told && notice.kind !== "request") console.error(`[notify] ${describe(notice)} (nothing reached the owner: no ntfy, and no device signed up for notifications)`);
			for (const adapter of extra) {
				try {
					await adapter.send(notice);
				} catch (error) {
					console.error("[notify]", error);
				}
			}
		},
	};
}

export type Notifications = ReturnType<typeof createNotifications>;
