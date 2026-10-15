// The browser's Chromium: one per profile in use, each with the profile's directory as its user data, so sign-ins and
// site storage outlive it. One Chromium can't hold two such directories, so each profile is a Chromium of its own. A
// profile opens when a tool first uses it and closes after IDLE_MS unused, and at most MAX_OPEN are open at once, the
// least recently used idle one closing to make room (docs/plan.md has the memory measured on the VM).
//
// Chromium keeps its own sandbox: it's launched with `chromiumSandbox`, never --no-sandbox. On Ubuntu 24.04 that needs
// the AppArmor profile deploy/vm/setup.sh installs.
//
// Every request a page makes is routed through `#route`:
// - Any request to a private, LAN, tailnet or loopback address is refused, as fetch_url refuses them, so a page can't
//   reach the owner's network or gaidin's own port. The name is resolved here, which a second DNS answer could still
//   get round; WebSockets aren't routed and aren't checked.
// - A new navigation of a tab's main frame, by a click or a page's script, goes ahead only to the page's own host or a
//   host the agent may fetch from without asking. Any other is stopped, leaving the page as it was, and the next result
//   says so, so the model opens it with browser_open, which asks. A navigation browser_open makes, and the redirects
//   of an allowed one, go ahead.
// Routing turns off Chromium's HTTP cache, which costs some speed on pages with many files.
//
// A download is saved in the downloads/ of the sandbox of the agent whose call last used the profile, which its commands
// see read-only, up to MAX_FILE. A page's dialogs are dismissed, except that leaving a page goes ahead, and the next
// result says what they said.
import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { isIP, type BlockList } from "node:net";
import { join } from "node:path";
import { type BrowserContext, chromium, type Download, type Page, type Request, type Route } from "playwright-core";
import { blockedRanges, type Resolve } from "../fetch.ts";
import { MAX_FILE, saveUpload } from "../files.ts";

export const IDLE_MS = 15 * 60_000;
export const MAX_OPEN = 2;
const VIEWPORT = { width: 1280, height: 800 };
const NAVIGATION_TIMEOUT_MS = 30_000;
/** How long an answer about a host's addresses is kept. */
const RESOLVED_MS = 60_000;
/** How long an action's result waits for the downloads it started. */
const DOWNLOAD_WAIT_MS = 60_000;

export type ChromiumOptions = {
	/** Where the profiles' directories are: <data>/browser. */
	dir: string;
	/** How names are resolved for the address check, and which addresses are refused; tests replace them. */
	resolve?: Resolve;
	blocked?: BlockList;
	/** More Chromium arguments; tests map their hosts to loopback with --host-resolver-rules. */
	args?: string[];
	idleMs?: number;
	maxOpen?: number;
};

/** What a tool call allows a profile's tabs while it holds the profile. */
export type Allowance = {
	/** Hosts the calling agent may fetch from without asking. */
	hosts: readonly string[];
	/** The calling agent's sandbox, whose downloads/ gets what a page downloads. Without it, downloads are dropped. */
	sandbox?: string;
};

/** A profile that's open: its Chromium, the tab the tools work in, and what happened there since the last result. */
export class Profile {
	readonly name: string;
	readonly context: BrowserContext;
	#current: Page;
	#allowance: Allowance = { hosts: [] };
	/** URLs browser_open is loading, which go ahead whatever their host. */
	readonly #permitted = new Set<string>();
	/** What happened since the last result: navigations stopped, downloads, dialogs. */
	#notes: string[] = [];
	readonly #downloads = new Set<Promise<void>>();
	/** Each page's last snapshot, which its refs belong to. Taking any other snapshot, even of one element, would renumber them. */
	readonly #snapshots = new WeakMap<Page, string>();
	readonly #resolved = new Map<string, { at: number; blocked: Promise<string | undefined> }>();
	readonly #resolve: Resolve;
	readonly #blocked: BlockList;

	private constructor(name: string, context: BrowserContext, options: ChromiumOptions) {
		this.name = name;
		this.context = context;
		this.#resolve = options.resolve ?? (async (host) => lookup(host, { all: true }));
		this.#blocked = options.blocked ?? blockedRanges();
		this.#current = context.pages()[0]!;
		// A tab a page opens becomes the one the tools work in, as it would for someone at the screen.
		context.on("page", (page) => {
			this.#current = page;
			this.#watch(page);
		});
		for (const page of context.pages()) this.#watch(page);
	}

	#watch(page: Page) {
		page.on("close", () => this.#fallBack());
		// A new document's elements aren't the snapshot's.
		page.on("framenavigated", (frame) => {
			if (frame === page.mainFrame()) this.#snapshots.delete(page);
		});
		page.on("dialog", (dialog) => {
			// Leaving a page goes ahead; any other dialog is dismissed, which is "cancel" for a confirm.
			const leaving = dialog.type() === "beforeunload";
			if (!leaving) this.#notes.push(`the page showed a ${dialog.type()} dialog, ${JSON.stringify(dialog.message().slice(0, 300))}, which was dismissed`);
			void (leaving ? dialog.accept() : dialog.dismiss()).catch(() => {});
		});
		page.on("download", (download) => {
			const saving = this.#save(download).finally(() => this.#downloads.delete(saving));
			this.#downloads.add(saving);
		});
	}

	async #save(download: Download): Promise<void> {
		const name = download.suggestedFilename();
		const sandbox = this.#allowance.sandbox;
		try {
			const path = await download.path();
			const size = statSync(path).size;
			if (sandbox === undefined) this.#notes.push(`the page downloaded ${name}, which wasn't kept: nothing was using the profile`);
			else if (size > MAX_FILE) this.#notes.push(`the page downloaded ${name}, which wasn't kept: it's over ${MAX_FILE / 1_000_000} MB`);
			else {
				const saved = saveUpload(sandbox, randomUUID().slice(0, 8), name, readFileSync(path), "downloads");
				this.#notes.push(`the page downloaded ${name}, saved as ${saved} (${Math.ceil(size / 1000)} KB); it's from the web`);
			}
		} catch (error) {
			this.#notes.push(`the page's download of ${name} failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
		} finally {
			await download.delete().catch(() => {});
		}
	}

	static async open(name: string, options: ChromiumOptions): Promise<Profile> {
		const dir = join(options.dir, name);
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const context = await chromium.launchPersistentContext(dir, {
			headless: true,
			chromiumSandbox: true,
			viewport: VIEWPORT,
			// Routing doesn't see what a service worker fetches, so pages don't get them.
			serviceWorkers: "block",
			acceptDownloads: true,
			args: options.args ?? [],
		});
		if (context.pages().length === 0) await context.newPage();
		const profile = new Profile(name, context, options);
		context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
		await context.route("**/*", (route, request) => profile.#route(route, request));
		return profile;
	}

	get page(): Page {
		return this.#current;
	}

	set allowance(allowance: Allowance) {
		this.#allowance = allowance;
	}

	/** Loads `url` in the current tab, as browser_open does once it's allowed. */
	async goto(url: string): Promise<void> {
		this.#permitted.add(url);
		try {
			await this.#current.goto(url, { waitUntil: "domcontentloaded" });
			// Most pages fill in after the document; give them a moment, but don't wait on one that never settles.
			await this.#current.waitForLoadState("load", { timeout: 5_000 }).catch(() => {});
		} finally {
			this.#permitted.delete(url);
		}
	}

	/** Goes back a page in the current tab. The page it goes back to was allowed when it was opened. */
	async back(): Promise<void> {
		const cdp = await this.context.newCDPSession(this.#current);
		try {
			const history = await cdp.send("Page.getNavigationHistory");
			const previous = history.entries[history.currentIndex - 1];
			if (previous === undefined) throw new Error("There's no earlier page in this tab.");
			this.#permitted.add(previous.url);
			try {
				await this.#current.goBack({ waitUntil: "domcontentloaded" });
			} finally {
				this.#permitted.delete(previous.url);
			}
		} finally {
			await cdp.detach().catch(() => {});
		}
	}

	/** After an action: the page's load, a moment for it to settle, and the downloads it started. */
	async settle(): Promise<void> {
		await this.#current.waitForLoadState("load", { timeout: 5_000 }).catch(() => {});
		await new Promise((resolve) => setTimeout(resolve, 300));
		if (this.#downloads.size === 0) return;
		const waited = Promise.all(this.#downloads).then(() => true);
		const done = await Promise.race([waited, new Promise<false>((resolve) => setTimeout(() => resolve(false), DOWNLOAD_WAIT_MS).unref())]);
		if (!done) this.#notes.push(`a download is still going after ${DOWNLOAD_WAIT_MS / 1000} s; it'll be in downloads/ when it's done`);
	}

	/** The current page's accessibility snapshot, with a ref for each element, kept as the one its refs belong to. */
	async snapshot(): Promise<string> {
		const page = this.#current;
		const snapshot = await page.ariaSnapshot({ mode: "ai", timeout: 10_000 });
		this.#snapshots.set(page, snapshot);
		return snapshot;
	}

	/** The element `ref` names, as the current page's last snapshot showed it, or nothing when it didn't. */
	seen(ref: string): string | undefined {
		const snapshot = this.#snapshots.get(this.#current);
		const line = snapshot?.split("\n").find((l) => l.includes(`[ref=${ref}]`));
		return line?.trim().replace(/^- /, "").replace(/:$/, "");
	}

	/** What happened since the last call, which a result reports. */
	takeNotes(): string[] {
		const notes = this.#notes;
		this.#notes = [];
		return notes;
	}

	tabs(): Page[] {
		return this.context.pages();
	}

	select(page: Page) {
		this.#current = page;
	}

	async close(): Promise<void> {
		await this.context.close().catch(() => {});
	}

	#fallBack() {
		const open = this.context.pages();
		if (!open.includes(this.#current) && open.length > 0) this.#current = open.at(-1)!;
	}

	/** Why `host` can't be reached, or nothing: it's, or resolves to, a refused address. */
	#addressProblem(host: string): Promise<string | undefined> {
		const bare = host.replace(/^\[|\]$/g, "");
		if (isIP(bare)) return Promise.resolve(this.#isBlocked(bare) ? `${bare} is a private or reserved address` : undefined);
		const known = this.#resolved.get(bare);
		if (known !== undefined && known.at > Date.now() - RESOLVED_MS) return known.blocked;
		const blocked = this.#resolve(bare).then(
			(addresses) => {
				const bad = addresses.find((a) => this.#isBlocked(a.address));
				return bad === undefined ? undefined : `${bare} resolves to ${bad.address}, a private or reserved address`;
			},
			// Chromium reports a name that doesn't resolve itself.
			() => undefined,
		);
		this.#resolved.set(bare, { at: Date.now(), blocked });
		return blocked;
	}

	#isBlocked(address: string): boolean {
		return this.#blocked.check(address, isIP(address) === 6 ? "ipv6" : "ipv4");
	}

	async #route(route: Route, request: Request): Promise<void> {
		try {
			const url = new URL(request.url());
			if (url.protocol === "http:" || url.protocol === "https:") {
				const problem = await this.#addressProblem(url.hostname);
				if (problem !== undefined) {
					if (mainNavigation(request)) this.#notes.push(`the page tried to go to ${request.url()}, which was refused: ${problem}`);
					return await route.abort("addressunreachable");
				}
			}
			if (mainNavigation(request) && !(await this.#navigationAllowed(request, url))) {
				this.#notes.push(stoppedNote(request.url()));
				// "aborted" leaves the page as it was; another error code would show Chrome's error page in its place.
				return await route.abort("aborted");
			}
			await route.continue();
		} catch {
			// The page or the profile closed while the request waited.
		}
	}

	async #navigationAllowed(request: Request, url: URL): Promise<boolean> {
		if (this.#permitted.has(request.url())) return true;
		// A redirect is the server's, not the page's or the model's choice; the navigation it continues was checked.
		if (request.redirectedFrom() !== null) return true;
		if (url.protocol !== "http:" && url.protocol !== "https:") return false;
		if (this.#allowance.hosts.includes(url.hostname)) return true;
		// A tab a page opened starts blank; its first page is checked against the page that opened it.
		const page = request.frame().page();
		const opener = page.url() === "about:blank" ? await page.opener() : null;
		const from = URL.parse((opener ?? page).url());
		return from !== null && from.hostname === url.hostname;
	}
}

const stoppedNote = (url: string) => `the page tried to go to ${url}, which was stopped; to go there, open it with browser_open`;

/** A navigation of a tab's main frame, not a frame's or a file's. */
function mainNavigation(request: Request): boolean {
	try {
		return request.isNavigationRequest() && request.frame().parentFrame() === null;
	} catch {
		// A request from a service worker or a closed frame has none.
		return false;
	}
}

/** The open profiles, taken one call at a time each. */
export class Chromium {
	readonly #options: ChromiumOptions;
	readonly #open = new Map<string, { profile: Promise<Profile>; lastUsed: number; busy: number; timer?: NodeJS.Timeout }>();
	readonly #queues = new Map<string, Promise<unknown>>();
	/** Counts uses, so the least recently used is clear even within a millisecond. */
	#uses = 0;
	#closed = false;

	constructor(options: ChromiumOptions) {
		this.#options = options;
	}

	/** Whether `name` is open now. */
	isOpen(name: string): boolean {
		return this.#open.has(name);
	}

	/**
	 * Runs `work` with profile `name`, opening it if it isn't, after any other call on it. `opened` runs first when this
	 * call opened it, as a reopen at the last URL does. A stopped call stops waiting for its turn.
	 */
	async use<T>(name: string, allowance: Allowance, work: (profile: Profile) => Promise<T>, options: { signal?: AbortSignal; opened?: (profile: Profile) => Promise<void> } = {}): Promise<T> {
		const previous = this.#queues.get(name) ?? Promise.resolve();
		let release!: () => void;
		const mine = new Promise<void>((resolve) => (release = resolve));
		const turn = previous.then(() => mine);
		this.#queues.set(name, turn);
		try {
			await abortable(previous, options.signal);
			if (this.#closed) throw new Error("The browser is shutting down.");
			const fresh = !this.#open.has(name);
			const profile = await this.#profile(name);
			const entry = this.#open.get(name)!;
			entry.busy += 1;
			clearTimeout(entry.timer);
			try {
				profile.allowance = allowance;
				if (fresh) await options.opened?.(profile);
				return await work(profile);
			} finally {
				entry.busy -= 1;
				entry.lastUsed = ++this.#uses;
				entry.timer = setTimeout(() => void this.#closeIdle(name), this.#options.idleMs ?? IDLE_MS);
				entry.timer.unref();
			}
		} finally {
			release();
			if (this.#queues.get(name) === turn) this.#queues.delete(name);
		}
	}

	/** Runs `work` with profile `name` in its turn if it's open, without opening it or changing its allowance, as a guard looks. */
	async peek<T>(name: string, work: (profile: Profile) => Promise<T>): Promise<T | undefined> {
		if (!this.#open.has(name)) return undefined;
		const previous = this.#queues.get(name) ?? Promise.resolve();
		let release!: () => void;
		const mine = new Promise<void>((resolve) => (release = resolve));
		const turn = previous.then(() => mine);
		this.#queues.set(name, turn);
		try {
			await previous;
			const entry = this.#open.get(name);
			return entry === undefined ? undefined : await work(await entry.profile);
		} finally {
			release();
			if (this.#queues.get(name) === turn) this.#queues.delete(name);
		}
	}

	async #profile(name: string): Promise<Profile> {
		// Checked and claimed with no wait between, so two profiles opening at once can't both take the last room.
		for (;;) {
			const known = this.#open.get(name);
			if (known !== undefined) return known.profile;
			if (this.#open.size < (this.#options.maxOpen ?? MAX_OPEN)) break;
			await this.#makeRoom();
		}
		const profile = Profile.open(name, this.#options);
		this.#open.set(name, { profile, lastUsed: ++this.#uses, busy: 0 });
		try {
			return await profile;
		} catch (error) {
			this.#open.delete(name);
			throw error;
		}
	}

	/** Closes the least recently used idle profile, or waits a little when every open one is in use. */
	async #makeRoom(): Promise<void> {
		const idle = [...this.#open].filter(([name, e]) => e.busy === 0 && !this.#queues.has(name)).sort(([, a], [, b]) => a.lastUsed - b.lastUsed)[0];
		if (idle !== undefined) await this.#close(idle[0]);
		else await new Promise((resolve) => setTimeout(resolve, 200));
	}

	async #closeIdle(name: string): Promise<void> {
		const entry = this.#open.get(name);
		if (entry !== undefined && entry.busy === 0 && !this.#queues.has(name)) await this.#close(name);
	}

	async #close(name: string): Promise<void> {
		const entry = this.#open.get(name);
		if (entry === undefined) return;
		this.#open.delete(name);
		clearTimeout(entry.timer);
		await (await entry.profile.catch(() => undefined))?.close();
	}

	/** Closes every profile; calls after this fail. */
	async close(): Promise<void> {
		this.#closed = true;
		await Promise.all([...this.#open.keys()].map((name) => this.#close(name)));
	}
}

/** `promise`, or a rejection once `signal` aborts. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (signal === undefined) return promise;
	signal.throwIfAborted();
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason ?? new Error("stopped"));
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => (signal.removeEventListener("abort", onAbort), resolve(value)),
			(cause: unknown) => (signal.removeEventListener("abort", onAbort), reject(cause)),
		);
	});
}
