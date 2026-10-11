// The settings page: the root conversation's model, thinking level, tools and standing instructions, which
// apply from its next request, and the devices that get notifications. The settings file's values (keys,
// limits, Slack) stay in the file.
import type { Gets, Posts } from "../src/web.ts";
import { load, post } from "./api.ts";
import { el, when } from "./dom.ts";
import { button, empty, PageState, sectionHead } from "./page.ts";

type Settings = Gets["/api/settings"];
type Push = Gets["/api/push"];

export type SettingsHooks = {
	/** The settings as the page last loaded them. */
	settings: () => Settings | undefined;
	/** Saves `change`, keeping the other settings. */
	configure: (change: Partial<Posts["/api/settings"]["body"]>) => Promise<void>;
};

export const LEVELS = ["off", "low", "medium", "high"] as const;

let root: HTMLElement | undefined;
let hooks: SettingsHooks | undefined;
let push: Push | undefined;
let mine: string | undefined;
/** The instructions as typed, until they're saved. */
let draft: string | undefined;
/** What the last change did, shown under the section it changed. */
let done: { section: string; text: string } | undefined;
const page = new PageState(() => draw());

export async function renderSettings(into: HTMLElement, given: SettingsHooks) {
	root = into;
	hooks = given;
	draw();
	await page.attempt(async () => {
		push = await load("/api/push");
		mine = await thisDevice();
	});
	draw();
}

/** Draws the page again when the settings changed elsewhere, unless instructions are being typed. */
export function settingsChanged() {
	if (root?.isConnected && draft === undefined) draw();
}

function draw() {
	if (root === undefined || hooks === undefined) return;
	const settings = hooks.settings();
	if (settings === undefined) {
		root.replaceChildren(...page.problems(), empty("Loading the settings…"));
		return;
	}
	root.replaceChildren(...page.problems(), agent(settings), tools(settings), instructions(settings), notifications());
}

async function change(section: string, text: string, value: Partial<Posts["/api/settings"]["body"]>) {
	await hooks!.configure(value);
	done = { section, text };
	draw();
}

/** What the last change did, under the section it changed. */
function confirmation(section: string): HTMLElement[] {
	return done?.section === section ? [el("p", "saved", `${done.text} Applies from the next request.`)] : [];
}

/** A row of buttons, one pressed. */
function choices(label: string, options: readonly string[], current: string, choose: (value: string) => Promise<void>): HTMLElement {
	const group = el("div", "choices");
	group.setAttribute("role", "group");
	group.setAttribute("aria-label", label);
	for (const option of options) {
		const node = page.action(option, () => choose(option), option === current ? "choice on" : "choice");
		node.setAttribute("aria-pressed", String(option === current));
		group.append(node);
	}
	return group;
}

function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
	const row = el("div", "field");
	const name = el("div", "field-name");
	name.append(el("span", undefined, label));
	if (hint !== undefined) name.append(el("span", "hint", hint));
	row.append(name, control);
	return row;
}

function agent(settings: Settings): HTMLElement {
	const section = el("section");
	section.append(
		sectionHead("Model", undefined),
		field("model", choices("Model", settings.models, settings.model, (model) => change("model", `Model set to ${model}.`, { model })),
			settings.models.length > 1 ? undefined : "add more in the settings file's model.choices"),
		field("thinking", choices("Thinking", LEVELS, settings.thinkingLevel, (level) => {
			const thinkingLevel = LEVELS.find((l) => l === level) ?? "off";
			return change("model", `Thinking set to ${thinkingLevel}.`, { thinkingLevel });
		}), "more thinks longer and costs more"),
		...confirmation("model"),
	);
	return section;
}

function tools(settings: Settings): HTMLElement {
	const on = settings.tools.filter((t) => t.enabled).length;
	const section = el("section");
	const list = el("ul", "switches");
	for (const tool of settings.tools) {
		const item = el("li");
		const toggle = page.action(tool.name, async () => {
			const off = new Set(settings.tools.filter((t) => !t.enabled).map((t) => t.name));
			if (tool.enabled) off.add(tool.name);
			else off.delete(tool.name);
			await change("tools", `${tool.name} ${tool.enabled ? "off" : "on"}.`, { disabledTools: [...off] });
		}, `switch${tool.enabled ? " on" : ""}`);
		toggle.setAttribute("role", "switch");
		toggle.setAttribute("aria-checked", String(tool.enabled));
		toggle.prepend(el("span", "track"));
		item.append(toggle);
		list.append(item);
	}
	section.append(
		sectionHead("Tools", `${on} of ${settings.tools.length} on`),
		el("p", "page-note", "Tools you can switch off. Reminders, jobs, memory, questions and skills are always on."),
		list,
		...confirmation("tools"),
	);
	return section;
}

function instructions(settings: Settings): HTMLElement {
	const section = el("section");
	const box = el("textarea", "instructions-box");
	box.value = draft ?? settings.instructions;
	box.placeholder = "Answer in British English. Keep answers under five sentences unless I ask for more.";
	box.setAttribute("aria-label", "Standing instructions");
	const save = page.action("save", async () => {
		const text = draft ?? settings.instructions;
		await change("instructions", text.trim() === "" ? "Standing instructions cleared." : "Standing instructions saved.", { instructions: text });
		draft = undefined;
		draw();
	}, "primary");
	const revert = button("revert", () => {
		draft = undefined;
		draw();
	});
	const fit = () => {
		box.style.height = "auto";
		box.style.height = `${Math.max(box.scrollHeight, 96)}px`;
		const changed = draft !== undefined && draft !== settings.instructions;
		save.disabled = !changed;
		revert.hidden = !changed;
	};
	box.addEventListener("input", () => {
		draft = box.value;
		fit();
	});
	queueMicrotask(fit);
	const bar = el("div", "note-bar");
	bar.append(revert, save);
	section.append(
		sectionHead("Standing instructions", undefined),
		el("p", "page-note", "Added to the system prompt of every conversation, Slack threads and job runs included."),
		box,
		bar,
		...confirmation("instructions"),
	);
	return section;
}

function notifications(): HTMLElement {
	const section = el("section");
	if (push === undefined) {
		section.append(sectionHead("Notifications", undefined), empty("Loading…"));
		return section;
	}
	if (push === null) {
		section.append(sectionHead("Notifications", undefined), empty("Notifications need web.url in gaidin's settings file."));
		return section;
	}
	const info = push;
	const supported = "serviceWorker" in navigator && "PushManager" in window;
	const actions: HTMLElement[] = [];
	if (supported && !info.devices.some((d) => d.endpoint === mine)) {
		actions.push(page.action("turn on here", async () => {
			await subscribeHere(info.publicKey);
			push = await load("/api/push");
			mine = await thisDevice();
			done = { section: "push", text: "Notifications are on for this device." };
			draw();
		}, "primary"));
	}
	if (info.devices.length > 0) {
		actions.push(page.action("send a test", async () => {
			const { sent } = await post("/api/push/test", {});
			done = { section: "push", text: `Sent to ${sent} device${sent === 1 ? "" : "s"}.` };
			draw();
		}));
	}
	const list = el("ul", "devices");
	for (const device of info.devices) {
		const item = el("li");
		const name = el("div", "device");
		name.append(el("span", undefined, device.label));
		if (device.endpoint === mine) name.append(el("span", "tag", "this device"));
		const since = el("span", "since", `since ${when.format(device.addedAt)}`);
		item.append(name, since, page.confirm(device.endpoint, "remove", async () => {
			await unsubscribe(device.endpoint);
			push = await load("/api/push");
			mine = await thisDevice();
			draw();
		}));
		list.append(item);
	}
	const note = supported ? "Reminders, job reports, and approvals and questions waiting on you, on each device that's turned on."
		: /iPhone|iPad/.test(navigator.userAgent) ? "On an iPhone or iPad, add gaidin to the Home Screen (Share, then Add to Home Screen) and open it from there to turn notifications on."
		: "This browser can't get notifications.";
	section.append(
		sectionHead("Notifications", String(info.devices.length), ...actions),
		el("p", "page-note", note),
		info.devices.length === 0 ? empty("No device gets notifications yet.") : list,
	);
	if (done?.section === "push") section.append(el("p", "saved", done.text));
	return section;
}

// --- Web Push for this device (push.ts on the server, sw.js here) ---

/** What kind of device this is, to tell the signed-up ones apart. */
export function deviceLabel(): string {
	const ua = navigator.userAgent;
	return /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : "Linux";
}

/** The service worker's registration (sw.js), which holds this device's push subscription, if there is one. */
async function registration(): Promise<ServiceWorkerRegistration | undefined> {
	return "serviceWorker" in navigator ? navigator.serviceWorker.getRegistration() : undefined;
}

/** This device's push address, if it gets notifications. */
export async function thisDevice(): Promise<string | undefined> {
	return (await (await registration())?.pushManager.getSubscription())?.endpoint;
}

/** Signs this device up for notifications, or throws with why not. */
export async function subscribeHere(publicKey: string) {
	// Asked before anything else, while the tap still counts: iOS allows the request only in answer to one.
	if ((await Notification.requestPermission()) !== "granted") throw new Error("Notifications aren't allowed for gaidin here. Allow them in the device's settings, then try again.");
	const key = Uint8Array.from(atob(publicKey.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
	const worker = await registration();
	if (worker === undefined) throw new Error("gaidin's service worker isn't running here; reload the page and try again.");
	const subscription = await worker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
	const { endpoint, keys } = subscription.toJSON();
	if (endpoint === undefined || keys?.p256dh === undefined || keys.auth === undefined) throw new Error("The browser didn't give a push address and keys for this device.");
	await post("/api/push/subscribe", { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth }, label: deviceLabel() });
}

/** Stops notifications to the device at `endpoint`, this one or another. */
export async function unsubscribe(endpoint: string) {
	await post("/api/push/unsubscribe", { endpoint });
	const here = await (await registration())?.pushManager.getSubscription();
	if (here?.endpoint === endpoint) await here.unsubscribe();
}
