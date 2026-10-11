// What the pages beside the console are built from: section headings, buttons that run an action and show what
// went wrong, and a cancel or delete that takes a second press.
import { el } from "./dom.ts";

export function button(label: string, onClick: () => void, className = "plain"): HTMLButtonElement {
	const node = el("button", className, label);
	node.type = "button";
	node.addEventListener("click", onClick);
	return node;
}

/** A section's heading: its title, an optional count or note beside it, and its actions on the right. */
export function sectionHead(title: string, count: string | undefined, ...actions: HTMLElement[]): HTMLElement {
	const head = el("div", "section-head");
	head.append(el("h2", undefined, title));
	if (count !== undefined) head.append(el("span", "count", count));
	if (actions.length > 0) {
		const right = el("div", "head-actions");
		right.append(...actions);
		head.append(right);
	}
	return head;
}

export function empty(text: string): HTMLElement {
	return el("p", "page-empty", text);
}

/** A page's state that outlives its redraws: what went wrong with the last action, and what waits for a second press. */
export class PageState {
	/** What went wrong with the last action, shown at the top of the page until the next one. */
	problem: string | undefined;
	#confirming: string | undefined;
	#timer: ReturnType<typeof setTimeout> | undefined;
	readonly #redraw: () => void;

	constructor(redraw: () => void) {
		this.#redraw = redraw;
	}

	/** The problem at the top of the page, if there is one. */
	problems(): HTMLElement[] {
		return this.problem === undefined ? [] : [el("p", "page-problem", this.problem)];
	}

	/** Runs `run`, keeping what went wrong to show; returns whether it worked. */
	async attempt(run: () => Promise<void>): Promise<boolean> {
		this.problem = undefined;
		try {
			await run();
			return true;
		} catch (error) {
			this.problem = error instanceof Error ? error.message.replace(/^\/api\/[\w/]+: /, "") : String(error);
			this.#redraw();
			return false;
		}
	}

	/** A button that runs `run`, disabled while it does; `run` redraws the page when it's done. */
	action(label: string, run: () => Promise<void>, className = "plain"): HTMLButtonElement {
		const node = button(label, () => {
			node.disabled = true;
			void this.attempt(run).finally(() => {
				node.disabled = false;
			});
		}, className);
		return node;
	}

	/**
	 * A button for something that can't be undone, such as a cancel or a delete: the first press turns it into
	 * "confirm", and a second press within 4 seconds runs it. `key` tells this one apart from the page's others.
	 */
	confirm(key: string, label: string, run: () => Promise<void>): HTMLButtonElement {
		if (this.#confirming !== key) {
			return button(label, () => {
				this.#confirming = key;
				clearTimeout(this.#timer);
				this.#timer = setTimeout(() => {
					this.#confirming = undefined;
					this.#redraw();
				}, 4000);
				this.#redraw();
			});
		}
		const node = this.action(`confirm ${label}`, async () => {
			this.#confirming = undefined;
			await run();
		}, "danger");
		node.setAttribute("aria-label", `Press again to ${label} for good`);
		// The second press lands on the same spot, so it keeps its focus.
		queueMicrotask(() => node.focus());
		return node;
	}

	/** What's waiting for a second press, for a page that redraws only when something it shows has changed. */
	get confirming(): string | undefined {
		return this.#confirming;
	}
}
