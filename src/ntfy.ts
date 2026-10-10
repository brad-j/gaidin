import type { Notify } from "./reminders.ts";

/**
 * Posts to an ntfy topic URL, e.g. https://ntfy.sh/<topic>. The topic name is a secret. Without one,
 * reminders are printed to stderr instead.
 */
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
