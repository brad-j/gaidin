// Taking over a profile: the owner watches its current tab in the app and works it, to sign in, solve a CAPTCHA or
// confirm something. While the owner is there the profile is held (Chromium.hold), so every agent's browser call on it
// waits; the owner's pages go wherever the owner takes them, private addresses aside. The owner's input goes straight to
// the page and never through the model or the transcript.
//
// The view is a CDP screencast of the current tab, relayed to every viewer as an event stream of JPEG frames; input
// comes back as small POSTs (web.ts). The hold ends when the owner presses Done, when no viewer has been there for
// LEAVE_MS (a phone switching apps keeps it), or after IDLE_MS without input, so a page left open on a desk doesn't
// keep agents waiting for good.
import type { CDPSession, Page } from "playwright-core";
import type { Chromium, Profile } from "./chromium.ts";

export const LEAVE_MS = 15_000;
export const IDLE_MS = 10 * 60_000;
/** How often the view checks whether the current tab, its address or its title changed. */
const WATCH_MS = 500;

/** What a viewer is sent. A frame is a JPEG, base64, of the tab at `width` by `height` CSS pixels. */
export type LiveEvent =
	| { type: "frame"; data: string; width: number; height: number }
	| { type: "page"; url: string; title: string; tabs: number }
	| { type: "released"; reason: string };

/** The owner's input, in the page's CSS pixels. `key` is a key's name, such as Enter or a, with modifiers as Control+a. */
export type LiveInput = {
	type: "click" | "down" | "up" | "move" | "wheel" | "key" | "text";
	x?: number;
	y?: number;
	button?: "left" | "right" | "middle";
	dx?: number;
	dy?: number;
	key?: string;
	text?: string;
};

/** A viewer: sends an event, and says whether the stream took it without backing up. */
export type Viewer = (event: LiveEvent) => boolean;

/** Keys besides single characters that the owner's input can press. */
const KEYS = new Set(["Enter", "Backspace", "Tab", "Escape", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "Space"]);
const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta"]);

/** `key` as Playwright presses it, or nothing when it isn't one the owner's input may press. A + itself goes as text. */
export function keyOf(key: string): string | undefined {
	const parts = key.split("+");
	const last = parts.pop() ?? "";
	if (!parts.every((m) => MODIFIERS.has(m)) || new Set(parts).size !== parts.length) return undefined;
	if (!KEYS.has(last) && [...last].length !== 1) return undefined;
	return [...parts, last === "Space" ? " " : last].join("+");
}

/**
 * `events` with the same effect in fewer steps: scrolls in a row add up, moves in a row keep the last, and a move just
 * before anything that moves the pointer itself goes. Each step costs the page a frame or two, and a trackpad sends
 * dozens of scrolls a second, so played one by one they'd fall seconds behind.
 */
export function compact(events: readonly LiveInput[]): LiveInput[] {
	const out: LiveInput[] = [];
	for (const event of events) {
		const last = out.at(-1);
		if (last?.type === "move" && ["move", "wheel", "click", "down", "up"].includes(event.type)) out.pop();
		const previous = out.at(-1);
		if (event.type === "wheel" && previous?.type === "wheel") {
			out[out.length - 1] = { ...event, dx: (previous.dx ?? 0) + (event.dx ?? 0), dy: (previous.dy ?? 0) + (event.dy ?? 0) };
		} else out.push(event);
	}
	return out;
}

type Held = {
	profile: Profile;
	release: () => void;
	viewers: Set<Viewer>;
	cast?: { page: Page; cdp: CDPSession };
	last?: Extract<LiveEvent, { type: "frame" }>;
	shown?: string;
	watch: NodeJS.Timeout;
	leave?: NodeJS.Timeout;
	idle?: NodeJS.Timeout;
};

export function createTakeOver(options: {
	chromium: Chromium;
	/** The page a profile reopens at when the owner takes it over closed. */
	lastUrl: (name: string) => Promise<string | undefined>;
	leaveMs?: number;
	idleMs?: number;
}) {
	const holds = new Map<string, Held>();
	/** Holds being taken, so two viewers arriving at once share one. */
	const taking = new Map<string, Promise<Held>>();

	function send(held: Held, event: LiveEvent): boolean {
		let flowing = true;
		for (const viewer of held.viewers) if (!viewer(event)) flowing = false;
		return flowing;
	}

	/** Starts the screencast of the profile's current tab, again when the tab changed, and says where it is. */
	async function follow(held: Held): Promise<void> {
		const page = held.profile.page;
		if (held.cast?.page !== page) {
			const old = held.cast;
			held.cast = undefined;
			await old?.cdp.send("Page.stopScreencast").catch(() => {});
			await old?.cdp.detach().catch(() => {});
			const cdp = await held.profile.context.newCDPSession(page);
			held.cast = { page, cdp };
			cdp.on("Page.screencastFrame", (frame) => {
				const event: LiveEvent = { type: "frame", data: frame.data, width: frame.metadata.deviceWidth, height: frame.metadata.deviceHeight };
				held.last = event;
				// A viewer that's backed up gets the next frame a little later, rather than a growing queue.
				const delay = send(held, event) ? 0 : 250;
				setTimeout(() => void cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {}), delay);
			});
			await cdp.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: 1280, maxHeight: 800 });
		}
		const shown = { type: "page" as const, url: page.url(), title: await page.title().catch(() => ""), tabs: held.profile.tabs().length };
		const key = JSON.stringify(shown);
		if (key !== held.shown) {
			held.shown = key;
			send(held, shown);
		}
	}

	async function take(name: string): Promise<Held> {
		const last = await options.lastUrl(name);
		const opened = last === undefined ? undefined : (p: Profile) => p.goto(last).catch(() => {});
		const { profile, release } = await options.chromium.hold(name, opened);
		const held: Held = {
			profile,
			release,
			viewers: new Set(),
			watch: setInterval(() => void follow(held).catch(() => {}), WATCH_MS),
		};
		touch(name, held);
		holds.set(name, held);
		await follow(held);
		return held;
	}

	/** Puts off the end of the hold for want of input. */
	function touch(name: string, held: Held) {
		clearTimeout(held.idle);
		held.idle = setTimeout(() => void release(name, `no input for ${Math.round((options.idleMs ?? IDLE_MS) / 60_000)} minutes`), options.idleMs ?? IDLE_MS);
		held.idle.unref();
	}

	/**
	 * Adds a viewer of profile `name`, taking the profile over if the owner doesn't have it yet; it waits for any agent's
	 * call on it to finish. Gives back what stops the viewer.
	 */
	async function watch(name: string, viewer: Viewer): Promise<() => void> {
		let held = holds.get(name);
		if (held === undefined) {
			let pending = taking.get(name);
			if (pending === undefined) {
				pending = take(name).finally(() => taking.delete(name));
				taking.set(name, pending);
			}
			held = await pending;
		}
		const mine = held;
		clearTimeout(mine.leave);
		mine.viewers.add(viewer);
		if (mine.shown !== undefined) viewer(JSON.parse(mine.shown));
		if (mine.last !== undefined) viewer(mine.last);
		return () => {
			mine.viewers.delete(viewer);
			if (mine.viewers.size > 0 || holds.get(name) !== mine) return;
			mine.leave = setTimeout(() => void release(name, "the owner left"), options.leaveMs ?? LEAVE_MS);
			mine.leave.unref();
		};
	}

	/** The held profile, or a refusal that says to take it over first. */
	function heldOf(name: string): Held {
		const held = holds.get(name);
		if (held === undefined) throw new Error(`Profile ${name} isn't taken over; open it in the app first.`);
		touch(name, held);
		return held;
	}

	/** The owner's input, in order, to the profile's current tab, compacted. */
	async function input(name: string, events: readonly LiveInput[]): Promise<void> {
		const page = heldOf(name).profile.page;
		for (const event of compact(events)) {
			const { x = 0, y = 0, button = "left" } = event;
			switch (event.type) {
				case "click":
					await page.mouse.click(x, y, { button });
					break;
				case "down":
					await page.mouse.move(x, y);
					await page.mouse.down({ button });
					break;
				case "up":
					await page.mouse.move(x, y);
					await page.mouse.up({ button });
					break;
				case "move":
					await page.mouse.move(x, y);
					break;
				case "wheel":
					await page.mouse.move(x, y);
					await page.mouse.wheel(event.dx ?? 0, event.dy ?? 0);
					break;
				case "key": {
					const key = keyOf(event.key ?? "");
					if (key === undefined) throw new Error(`Not a key the view can press: ${event.key}`);
					await page.keyboard.press(key);
					break;
				}
				case "text":
					await page.keyboard.insertText(event.text ?? "");
					break;
			}
		}
	}

	/** The owner's navigation: to `url`, or back a page. */
	async function go(name: string, where: { url: string } | { back: true }): Promise<void> {
		const { profile } = heldOf(name);
		if ("url" in where) await profile.goto(where.url);
		else await profile.page.goBack({ waitUntil: "domcontentloaded" }).catch(() => undefined);
	}

	/** Ends the owner's hold, if there is one, and tells its viewers why. */
	async function release(name: string, reason: string): Promise<boolean> {
		const held = holds.get(name);
		if (held === undefined) return false;
		holds.delete(name);
		clearInterval(held.watch);
		clearTimeout(held.leave);
		clearTimeout(held.idle);
		send(held, { type: "released", reason });
		held.viewers.clear();
		await held.cast?.cdp.send("Page.stopScreencast").catch(() => {});
		await held.cast?.cdp.detach().catch(() => {});
		held.release();
		return true;
	}

	return {
		watch,
		input,
		go,
		release,
		/** Whether the owner has profile `name` now. */
		held: (name: string) => holds.has(name),
		/** Ends every hold, as the server stops. */
		close: async () => {
			for (const name of holds.keys()) await release(name, "gaidin is stopping");
		},
	};
}

export type TakeOver = ReturnType<typeof createTakeOver>;
