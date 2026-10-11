// The spend guard. Pi Durable keeps each conversation's model and tool costs; this totals them, keeps a
// baseline at the start of each local day and month, and refuses new model requests once the day's or
// the month's spend reaches its limit. Requests are refused by the model lookup the Harness makes before
// each one: with no model, the run ends as unanswered, without retrying. The owner can allow more for
// the day from the web view.
//
// The total is refreshed after every model response, so the request that crosses a limit still
// finishes. Scheduled jobs make requests without the owner, which is what this is mainly for.
import { BACKGROUND_CONTEXT as background } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import { defineDoc, defineExtension, GenerationTask, type Harness, hook } from "@earendil-works/pi-durable";
import { timeZone } from "./time.ts";

export type Limits = { daily: number; monthly: number };

export const Budget = defineDoc<{
	day: string;
	dayStart: number;
	month: string;
	monthStart: number;
	/** Extra dollars the owner allowed, by day. */
	extra: Record<string, number>;
	/** The day the owner was last told about 80% and about the limit. */
	warned?: string;
	stopped?: string;
}>({
	kind: "gaidin.budget",
	version: 1,
	scope: "session",
	initial: () => ({ day: "", dayStart: 0, month: "", monthStart: 0, extra: {} }),
});

export type BudgetStatus = {
	today: number;
	month: number;
	dailyLimit: number;
	monthlyLimit: number;
	stopped: boolean;
	reason?: string;
};

/** Total cost so far across every conversation, in dollars. */
export async function totalSpend(harness: Harness): Promise<number> {
	const usage = await harness.usage(background);
	return [...Object.values(usage.models), ...Object.values(usage.tools)].reduce((sum, u) => sum + u.cost.total, 0);
}

/** The local day and month, in the configured time zone. */
export function localDay(ms = Date.now()) {
	const day = new Intl.DateTimeFormat("en-CA", { timeZone: timeZone(), year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
	return { day, month: day.slice(0, 7) };
}

const money = (dollars: number) => `$${dollars.toFixed(2)}`;

export function createBudget(options: {
	limits: Limits;
	/** Tells the owner, once a day, about 80% and about reaching a limit. */
	notify: (text: string) => Promise<void>;
	/** Defaults to the Pi Durable totals. */
	spend?: (harness: Harness) => Promise<number>;
}) {
	const { limits } = options;
	const spend = options.spend ?? totalSpend;
	let harness: Harness | undefined;
	let status: BudgetStatus = { today: 0, month: 0, dailyLimit: limits.daily, monthlyLimit: limits.monthly, stopped: false };
	let statusDay = "";
	let refreshing: Promise<BudgetStatus> | undefined;

	async function compute(): Promise<BudgetStatus> {
		const h = harness!;
		const root = await h.root(background);
		const total = await spend(h);
		const { day, month } = localDay();
		const { state, warn } = await root.commit(async (tx) => {
			const doc = await tx.doc(Budget);
			// A new day or month starts its count from here.
			if (doc.day !== day) {
				doc.day = day;
				doc.dayStart = total;
				for (const key of Object.keys(doc.extra)) if (key < day) delete doc.extra[key];
			}
			if (doc.month !== month) {
				doc.month = month;
				doc.monthStart = total;
			}
			const today = total - doc.dayStart;
			const thisMonth = total - doc.monthStart;
			const dailyLimit = limits.daily + (doc.extra[day] ?? 0);
			const overDay = limits.daily > 0 && today >= dailyLimit;
			const overMonth = limits.monthly > 0 && thisMonth >= limits.monthly;
			const reason = overMonth
				? `This month's spend is ${money(thisMonth)}, at the monthly limit of ${money(limits.monthly)}.`
				: overDay ? `Today's spend is ${money(today)}, at the daily limit of ${money(dailyLimit)}.` : undefined;
			let warn: string | undefined;
			if (reason !== undefined && doc.stopped !== day) {
				doc.stopped = day;
				warn = `gaidin has stopped making model requests. ${reason} Allow more in the web view, or it starts again ${overMonth ? "next month" : "tomorrow"}.`;
			} else if (reason === undefined && limits.daily > 0 && today >= dailyLimit * 0.8 && doc.warned !== day) {
				doc.warned = day;
				warn = `gaidin has spent ${money(today)} today, 80% of the daily limit of ${money(dailyLimit)}.`;
			}
			const next: BudgetStatus = { today, month: thisMonth, dailyLimit, monthlyLimit: limits.monthly, stopped: reason !== undefined };
			if (reason !== undefined) next.reason = reason;
			return { state: next, warn };
		}, background);
		status = state;
		statusDay = day;
		if (warn !== undefined) options.notify(warn).catch((error) => console.error("[budget]", error));
		return state;
	}

	function refresh(): Promise<BudgetStatus> {
		if (harness === undefined) return Promise.resolve(status);
		// One at a time; a refresh asked for during one waits for it, then runs again.
		const next = (refreshing ?? Promise.resolve()).catch(() => {}).then(compute);
		refreshing = next;
		return next;
	}

	/** Why requests are refused right now, or nothing. A new day clears a daily stop. */
	function blocked(): string | undefined {
		if (!status.stopped) return undefined;
		if (statusDay !== localDay().day) {
			void refresh();
			// A monthly stop holds until the refresh says otherwise.
			if (!(status.reason ?? "").startsWith("This month")) return undefined;
		}
		return status.reason;
	}

	/** The models, with every lookup refused while the guard is stopped. */
	function guard(models: Models): Models {
		return new Proxy(models, {
			get(target, key) {
				if (key === "getModel") {
					return (provider: string, id: string) => (blocked() === undefined ? target.getModel(provider, id) : undefined);
				}
				// SAFETY: a get trap is only asked for keys of the object it wraps.
				const value = target[key as keyof Models];
				return value instanceof Function ? value.bind(target) : value;
			},
		});
	}

	/** Lets today go `amount` dollars past the daily limit. */
	async function allowMore(amount: number): Promise<BudgetStatus> {
		const root = await harness!.root(background);
		const { day } = localDay();
		await root.commit(async (tx) => {
			const doc = await tx.doc(Budget);
			doc.extra[day] = (doc.extra[day] ?? 0) + amount;
			// Tell the owner again if it's reached a second time.
			if (doc.stopped === day) delete doc.stopped;
		}, background);
		return refresh();
	}

	return {
		attach(h: Harness) {
			harness = h;
			return refresh();
		},
		refresh,
		blocked,
		guard,
		allowMore,
		status: () => status,
		extension: defineExtension({
			name: "budget",
			hooks: [hook(GenerationTask, { afterResponse: () => void refresh().catch((error) => console.error("[budget]", error)) })],
		}),
	};
}

export type BudgetGuard = ReturnType<typeof createBudget>;
