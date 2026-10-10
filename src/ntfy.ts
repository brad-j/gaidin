import type { Notify } from "./reminders.ts";

/**
 * Posts to an ntfy topic URL, e.g. https://ntfy.sh/<topic>. The topic name is a secret. Without one,
 * reminders are printed to stderr instead.
 */
/** Sends a scheduled job's report as a notification, cut to fit; without ntfy, prints it. */
export function ntfyReporter(ntfy: { url: string; token?: string } | undefined) {
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
				...(ntfy.token ? { Authorization: `Bearer ${ntfy.token}` } : {}),
			},
			signal: AbortSignal.timeout(15_000),
		});
		if (!response.ok) throw new Error(`ntfy answered ${response.status}`);
	};
}

export function ntfyNotifier(ntfy: { url: string; token?: string } | undefined): Notify {
	if (ntfy === undefined) {
		return async (reminder) => {
			console.error(`[reminder] ${reminder.text} (no ntfy.url, not pushed)`);
		};
	}
	const { url, token } = ntfy;
	return async (reminder) => {
		const response = await fetch(url, {
			method: "POST",
			body: reminder.text,
			headers: {
				Title: "gaidin",
				Tags: "alarm_clock",
				...(token ? { Authorization: `Bearer ${token}` } : {}),
			},
			signal: AbortSignal.timeout(15_000),
		});
		if (!response.ok) throw new Error(`ntfy answered ${response.status}`);
	};
}
