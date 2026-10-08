export const timeZone = process.env.GAIDIN_TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

const formatter = new Intl.DateTimeFormat("en-US", {
	timeZone,
	weekday: "short",
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
	hour: "2-digit",
	minute: "2-digit",
	hourCycle: "h23",
	timeZoneName: "shortOffset",
});

/** "Thu 2026-10-08 19:30 GMT-4" in the host's time zone. */
export function formatTime(ms: number): string {
	const p = Object.fromEntries(formatter.formatToParts(ms).map((part) => [part.type, part.value]));
	return `${p.weekday} ${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${p.timeZoneName}`;
}
