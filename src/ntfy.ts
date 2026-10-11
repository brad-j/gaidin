import type { Notify } from "./reminders.ts";

/**
 * Posts to an ntfy topic URL, e.g. https://ntfy.sh/<topic>. The topic name is a secret. Without one,
 * reminders are printed to stderr instead.
 */
/** Sends a scheduled job's report as a notification, cut to fit; without ntfy, prints it. */
export function ntfyReporter(ntfy: { url: string; token?: string; icon?: string } | undefined) {
	return async (report: { title: string; text: string }) => {
		if (ntfy === undefined) {
			console.error(`[job] ${report.title}: ${report.text}`);
			return;
		}
		const body = report.text.length > 3000 ? `${report.text.slice(0, 3000)}…` : report.text;
		const response = await fetch(ntfy.url, {
			method: "POST",
			body,
			headers: {
				// Header values must be ASCII.
				Title: `gaidin: ${report.title}`.replace(/[^\x20-\x7e]/g, "?"),
				Tags: "calendar",
				Markdown: "yes",
				...(ntfy.icon ? { Icon: ntfy.icon } : {}),
				...(ntfy.token ? { Authorization: `Bearer ${ntfy.token}` } : {}),
			},
			signal: AbortSignal.timeout(15_000),
		});
		if (!response.ok) throw new Error(`ntfy answered ${response.status}`);
	};
}

/**
 * Pushes a reminder. With `web`, the web view's address, tapping the push opens the web view, and two buttons
 * snooze it; the phone calls the web view, so they work while it's on the tailnet.
 */
function snoozeActions(web: string, id: number): string {
	const snooze = (label: string, minutes: number) =>
		`http, ${label}, ${web}/api/reminders/snooze, headers.Content-Type=application/json, body='${JSON.stringify({ id, minutes })}', clear=true`;
	return [snooze("Snooze 10 min", 10), snooze("Snooze 1 h", 60)].join("; ");
}

export function ntfyNotifier(ntfy: { url: string; token?: string; icon?: string } | undefined, web?: string): Notify {
	if (ntfy === undefined) {
		return async (reminder) => {
			console.error(`[reminder] ${reminder.text} (no ntfy.url, not pushed)`);
		};
	}
	const { url, token, icon } = ntfy;
	return async (reminder) => {
		const response = await fetch(url, {
			method: "POST",
			body: reminder.text,
			headers: {
				Title: "gaidin",
				Tags: "alarm_clock",
				...(icon ? { Icon: icon } : {}),
				...(web === undefined ? {} : { Click: web, Actions: snoozeActions(web, reminder.taskId) }),
				...(token ? { Authorization: `Bearer ${token}` } : {}),
			},
			signal: AbortSignal.timeout(15_000),
		});
		if (!response.ok) throw new Error(`ntfy answered ${response.status}`);
	};
}
