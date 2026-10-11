// The memory page: the notes gaidin keeps about the owner and their world, which every conversation sees.
// The owner adds, edits and forgets them here without asking; gaidin's own writes ask after outside text.
import type { Gets } from "../src/web.ts";
import { load, post } from "./api.ts";
import { ago, el, when } from "./dom.ts";
import { button, empty, PageState, sectionHead } from "./page.ts";

type Listing = Gets["/api/memory"];
type Note = Listing["notes"][number];

let listing: Listing | undefined;
let root: HTMLElement | undefined;
/** The note being edited and its draft, kept across redraws. */
let editing: { id: number; draft: string } | undefined;
let adding = "";
const page = new PageState(() => draw());

/** Loads the notes and draws the page into `into`. */
export async function renderMemory(into: HTMLElement) {
	root = into;
	if (await page.attempt(async () => {
		listing = await load("/api/memory");
	})) draw();
}

async function reload() {
	listing = await load("/api/memory");
	draw();
}

function draw() {
	if (root === undefined) return;
	if (listing === undefined) {
		root.replaceChildren(...page.problems());
		return;
	}
	const { notes, maxNote, maxTotal } = listing;
	const used = notes.reduce((sum, n) => sum + n.text.length, 0);
	const head = sectionHead("Memory", String(notes.length));
	head.append(el("span", `usage${used > maxTotal * 0.9 ? " near" : ""}`, `${used.toLocaleString()} of ${maxTotal.toLocaleString()} characters`));
	const section = el("section");
	section.append(
		head,
		el("p", "page-note", "Notes gaidin keeps about you and your world. Every conversation sees them at the end of its system prompt, as things it was told, not instructions."),
		addForm(maxNote),
		notes.length === 0 ? empty("No notes yet. Add one above, or tell gaidin something worth keeping.") : list(notes, maxNote),
	);
	root.replaceChildren(...page.problems(), section);
}

/** A text box that grows with its text, with a count of characters against `max`. */
function noteBox(text: string, max: number, label: string, onInput: (text: string) => void) {
	const box = el("textarea", "note-box");
	box.rows = 1;
	box.value = text;
	box.setAttribute("aria-label", label);
	const count = el("span", "chars");
	const update = () => {
		box.style.height = "auto";
		box.style.height = `${box.scrollHeight}px`;
		const length = box.value.trim().replace(/\s+/g, " ").length;
		count.textContent = length === 0 ? "" : `${length}/${max}`;
		count.classList.toggle("over", length > max);
		onInput(box.value);
	};
	box.addEventListener("input", update);
	queueMicrotask(update);
	return { box, count };
}

function addForm(max: number): HTMLElement {
	const form = el("form", "note-add");
	const { box, count } = noteBox(adding, max, "A new note", (text) => {
		adding = text;
	});
	box.placeholder = "Add a note: the NAS is in the hall closet";
	const add = el("button", "primary", "add");
	add.type = "submit";
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		if (adding.trim() === "") return;
		add.disabled = true;
		void page.attempt(async () => {
			await post("/api/memory/add", { text: adding });
			adding = "";
			await reload();
		}).finally(() => {
			add.disabled = false;
		});
	});
	// Enter adds; Shift+Enter starts a new line.
	box.addEventListener("keydown", (press) => {
		if (press.key === "Enter" && !press.shiftKey && !press.isComposing) {
			press.preventDefault();
			form.requestSubmit();
		}
	});
	const bar = el("div", "note-bar");
	bar.append(count, add);
	form.append(box, bar);
	return form;
}

function list(notes: readonly Note[], max: number): HTMLElement {
	const node = el("ol", "note-list");
	// Newest first: the one just added or changed is at the top.
	for (const note of [...notes].sort((a, b) => b.updatedAt - a.updatedAt)) node.append(noteRow(note, max));
	return node;
}

function noteRow(note: Note, max: number): HTMLElement {
	const item = el("li", "note-row");
	const meta = el("div", "meta");
	const who = el("span", `by ${note.by}`, note.by === "owner" ? "you" : "gaidin");
	const at = el("span", undefined, `${note.updatedAt === note.createdAt ? "added" : "changed"} ${ago(note.updatedAt)}`);
	at.title = when.format(note.updatedAt);
	meta.append(who, at, el("span", "id", `#${note.id}`));

	if (editing?.id === note.id) {
		const current = editing;
		const { box, count } = noteBox(current.draft, max, `Note ${note.id}`, (text) => {
			current.draft = text;
		});
		const save = page.action("save", async () => {
			await post("/api/memory/update", { id: note.id, text: current.draft });
			editing = undefined;
			await reload();
		}, "primary");
		const cancel = button("cancel", () => {
			editing = undefined;
			draw();
		});
		box.addEventListener("keydown", (press) => {
			if (press.key === "Enter" && !press.shiftKey && !press.isComposing) {
				press.preventDefault();
				save.click();
			} else if (press.key === "Escape") {
				press.preventDefault();
				press.stopPropagation();
				cancel.click();
			}
		});
		const bar = el("div", "note-bar");
		bar.append(count, cancel, save);
		item.classList.add("editing");
		item.append(box, bar, meta);
		queueMicrotask(() => {
			box.focus();
			box.setSelectionRange(box.value.length, box.value.length);
		});
		return item;
	}

	const actions = el("div", "actions");
	actions.append(
		button("edit", () => {
			editing = { id: note.id, draft: note.text };
			draw();
		}),
		page.confirm(`n${note.id}`, "forget", async () => {
			await post("/api/memory/forget", { id: note.id });
			await reload();
		}),
	);
	item.append(el("p", "text", note.text), actions, meta);
	return item;
}
