import type { Notify } from "./reminders.ts";

/**
 * Posts to an ntfy topic URL (NTFY_URL, e.g. https://ntfy.sh/<topic>). The topic name is a credential.
 * Without NTFY_URL, reminders are printed to stderr instead.
 */
export function ntfyNotifier(url = process.env.NTFY_URL, token = process.env.NTFY_TOKEN): Notify {
	if (!url) {
		return async (reminder) => {
			console.error(`[reminder] ${reminder.text} (NTFY_URL not set, not pushed)`);
		};
	}
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
