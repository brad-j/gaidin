import type { Adapter } from "./notifications.ts";
import type { Notify } from "./reminders.ts";

// Notifications through ntfy: posts to a topic URL, e.g. https://ntfy.sh/<topic>. The topic name is a secret.
// notifications.ts decides which notices come this way.

/** Sends a scheduled job's report or another notice as a notification, cut to fit. */
export function ntfyReporter(ntfy: { url: string; token?: string; icon?: string }) {
	return async (report: { title: string; text: string }) => {
		const body = report.text.length > 3000 ? `${report.text.slice(0, 3000)}…` : report.text;
		// Header values must be ASCII.
		const headers = new Headers({ Title: `gaidin: ${report.title}`.replace(/[^\x20-\x7e]/g, "?"), Tags: "calendar", Markdown: "yes" });
		if (ntfy.icon) headers.set("Icon", ntfy.icon);
		if (ntfy.token) headers.set("Authorization", `Bearer ${ntfy.token}`);
		const response = await fetch(ntfy.url, { method: "POST", body, headers, signal: AbortSignal.timeout(15_000) });
		if (!response.ok) throw new Error(`ntfy answered ${response.status}`);
	};
}

/**
 * Pushes a reminder. With `web`, the app's address, tapping the push opens the app, and two buttons
 * snooze it; the phone calls gaidin, so they work while it's on the tailnet.
 */
function snoozeActions(web: string, id: number): string {
	const snooze = (label: string, minutes: number) =>
		`http, ${label}, ${web}/api/reminders/snooze, headers.Content-Type=application/json, body='${JSON.stringify({ id, minutes })}', clear=true`;
	return [snooze("Snooze 10 min", 10), snooze("Snooze 1 h", 60)].join("; ");
}

export function ntfyNotifier(ntfy: { url: string; token?: string; icon?: string }, web?: string): Notify {
	const { url, token, icon } = ntfy;
	return async (reminder) => {
		const headers = new Headers({ Title: "gaidin", Tags: "alarm_clock" });
		if (icon) headers.set("Icon", icon);
		if (web !== undefined) headers.set("Actions", snoozeActions(web, reminder.taskId));
		if (token) headers.set("Authorization", `Bearer ${token}`);
		const response = await fetch(url, { method: "POST", body: reminder.text, headers, signal: AbortSignal.timeout(15_000) });
		if (!response.ok) throw new Error(`ntfy answered ${response.status}`);
	};
}

/** ntfy as a way to reach the owner: reminders with their snooze buttons, and reports and warnings as text. Requests don't come this way. */
export function ntfyAdapter(ntfy: { url: string; token?: string; icon?: string }, web?: string): Adapter {
	const remind = ntfyNotifier(ntfy, web);
	const report = ntfyReporter(ntfy);
	return {
		async send(notice) {
			switch (notice.kind) {
				case "reminder":
					await remind(notice.reminder);
					return true;
				case "report":
				case "paused":
					await report(notice.report);
					return true;
				case "budget":
					await report({ title: "budget", text: notice.text });
					return true;
				case "connector":
					await report({ title: `connector ${notice.name}`, text: `It needs signing in again: ${notice.problem}` });
					return true;
				case "request":
					return false;
			}
		},
	};
}
