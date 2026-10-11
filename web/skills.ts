// The skills page: the guides gaidin can open, and each one's files, shown as gaidin reads them. Its
// address names what's open: #/skills, #/skills/<name>, #/skills/<name>/<file>, and #<heading> after
// that for a place in the file. Links between a skill's files stay on the page.
//
// The owner creates, edits and removes local skills here, which takes effect at once; gaidin's own changes
// (write_skill, remove_skill) ask the owner first. The built-in skill is the docs, and changes with the code.
import type { Gets } from "../src/web.ts";
import { load, post } from "./api.ts";
import { el } from "./dom.ts";
import { markdown } from "./markdown.ts";
import { button, PageState, sectionHead } from "./page.ts";

type Listing = Gets["/api/skills"];
type Skill = Listing["skills"][number];
export type SkillRoute = { name?: string; file?: string; anchor?: string };

/** Loaded once, and again after a change made here; gaidin's changes show on the next visit to the list. */
let listing: Listing | undefined;
const texts = new Map<string, string>();
/** The route being drawn; a newer one wins over an older one still loading. */
let drawing = "";
let root: HTMLElement | undefined;
let route: SkillRoute = {};

/** A new skill being written, kept across redraws. */
let creating: { name: string; description: string; body: string } | undefined;
/** A file being edited, or a new one being written, and its text so far. */
let editing: { skill: string; file: string; draft: string; isNew: boolean } | undefined;
/** The path typed for a new file, before its editor opens. */
let newFile: string | undefined;
const page = new PageState(() => void draw());

export function skillHref(name?: string, file = "SKILL.md", anchor?: string): string {
	const path = name === undefined ? "" : `/${encodeURIComponent(name)}${file === "SKILL.md" ? "" : `/${file.split("/").map(encodeURIComponent).join("/")}`}`;
	return `#/skills${path}${anchor === undefined ? "" : `#${anchor}`}`;
}

/** The route in an address like #/skills/gaidin/tools.md#gates. */
export function skillRoute(hash: string): SkillRoute {
	const [path = "", anchor] = hash.replace(/^#/, "").split("#");
	const [, name, ...file] = path.split("/").filter(Boolean).map(decodeURIComponent);
	return { name, file: file.length === 0 ? undefined : file.join("/"), anchor };
}

export async function renderSkills(into: HTMLElement, at: SkillRoute) {
	// A different file or skill leaves whatever was being edited.
	if (editing !== undefined && (editing.skill !== at.name || editing.file !== (at.file ?? "SKILL.md"))) editing = undefined;
	if (at.name !== route.name) newFile = undefined;
	root = into;
	route = at;
	page.problem = undefined;
	await draw(true);
}

/** Draws the page for the current route; `navigated` scrolls to its heading or the top. */
async function draw(navigated = false) {
	const into = root;
	if (into === undefined) return;
	const key = JSON.stringify(route);
	drawing = key;
	try {
		listing ??= await load("/api/skills");
		const skill = listing.skills.find((s) => s.name === route.name);
		if (route.name === undefined || skill === undefined) {
			if (drawing === key) into.replaceChildren(...page.problems(), ...list(listing, route.name));
			return;
		}
		const file = route.file ?? "SKILL.md";
		const text = editing?.isNew ? "" : await fileText(skill, file);
		if (drawing !== key) return;
		into.replaceChildren(...page.problems(), ...skillPage(skill, file, text));
		if (!navigated) return;
		const target = route.anchor === undefined ? undefined : document.getElementById(`h-${route.anchor}`);
		if (target) target.scrollIntoView({ block: "start" });
		else into.parentElement?.scrollTo({ top: 0 });
	} catch (error) {
		if (drawing === key) into.replaceChildren(el("p", "page-problem", error instanceof Error ? error.message.replace(/^\/api\/[\w/]+: /, "") : String(error)));
	}
}

async function fileText(skill: Skill, file: string): Promise<string> {
	const key = `${skill.name}/${file}`;
	const cached = texts.get(key);
	if (cached !== undefined) return cached;
	const { text } = await load("/api/skills/file", `?name=${encodeURIComponent(skill.name)}&file=${encodeURIComponent(file)}`);
	texts.set(key, text);
	return text;
}

/** Forgets what was loaded, after a change. */
function changed(name: string) {
	listing = undefined;
	for (const key of texts.keys()) if (key.startsWith(`${name}/`)) texts.delete(key);
}

/** A text area that grows with its text. */
function editor(text: string, label: string, onInput: (text: string) => void, className = "editor"): HTMLTextAreaElement {
	const box = el("textarea", className);
	box.value = text;
	box.spellcheck = className !== "editor";
	box.setAttribute("aria-label", label);
	const fit = () => {
		box.style.height = "auto";
		box.style.height = `${box.scrollHeight + 2}px`;
	};
	box.addEventListener("input", () => {
		onInput(box.value);
		fit();
	});
	queueMicrotask(fit);
	return box;
}

function list(listing: Listing, missing: string | undefined): HTMLElement[] {
	const add = creating === undefined ? [button("+ new skill", () => {
		creating = { name: "", description: "", body: "" };
		void draw();
	})] : [];
	const note = el("p", "page-note",
		"Guides gaidin opens when a request matches one's description. The built-in one is gaidin's own documentation. " +
		"You write local skills here and they apply at once; gaidin can write them too, after you allow each change.");
	const rows = el("ol", "skill-list");
	for (const skill of listing.skills) {
		const link = el("a", "skill-row");
		link.href = skillHref(skill.name);
		const title = el("div", "title");
		title.append(el("span", "name", skill.name), el("span", "tag", skill.source));
		link.append(title, el("p", "desc", skill.description), el("span", "files", `${skill.files.length} file${skill.files.length === 1 ? "" : "s"}`));
		const item = el("li");
		item.append(link);
		rows.append(item);
	}
	const section = el("section");
	section.append(sectionHead("Skills", String(listing.skills.length), ...add), note);
	if (creating !== undefined) section.append(createForm(creating));
	section.append(rows);
	const problems = listing.problems.map((p) => el("p", "page-problem", `Not loaded: ${p}`));
	return [...(missing === undefined ? [] : [el("p", "page-problem", `No skill ${missing}.`)]), ...problems, section];
}

function createForm(draft: NonNullable<typeof creating>): HTMLElement {
	const form = el("form", "skill-form");
	const name = el("input");
	name.value = draft.name;
	name.placeholder = "homelab-alerts";
	name.autocapitalize = "off";
	name.spellcheck = false;
	name.addEventListener("input", () => {
		draft.name = name.value;
	});
	const description = editor(draft.description, "Description", (text) => {
		draft.description = text;
	}, "line");
	description.rows = 1;
	description.placeholder = "What to do when a homelab alert comes in. Open it for any alert from ntfy.";
	const body = editor(draft.body, "Guide", (text) => {
		draft.body = text;
	});
	body.placeholder = "# Homelab alerts\n\nWhen a backup fails on think-2, check whether the NAS share is asleep before anything else.";
	const labelled = (text: string, hint: string, control: HTMLElement) => {
		const label = el("label", "form-field");
		const head = el("span", "form-label");
		head.append(el("span", undefined, text), el("span", "hint", hint));
		label.append(head, control);
		return label;
	};
	const save = el("button", "primary", "create skill");
	save.type = "submit";
	const cancel = button("cancel", () => {
		creating = undefined;
		void draw();
	});
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		const skillName = draft.name.trim();
		const text = `---\nname: ${skillName}\ndescription: ${draft.description.trim().replace(/\s+/g, " ")}\n---\n\n${draft.body.trim()}\n`;
		save.disabled = true;
		void page.attempt(async () => {
			await post("/api/skills/save", { name: skillName, file: "SKILL.md", text });
			creating = undefined;
			changed(skillName);
			location.hash = skillHref(skillName);
		}).finally(() => {
			save.disabled = false;
		});
	});
	const bar = el("div", "form-bar");
	bar.append(cancel, save);
	form.append(
		labelled("name", "lowercase letters, digits and hyphens", name),
		labelled("description", "one line: what it's for and when gaidin should open it", description),
		labelled("guide", "Markdown; long reference material can go in other files later", body),
		bar,
	);
	queueMicrotask(() => name.focus());
	return form;
}

function skillPage(skill: Skill, file: string, text: string): HTMLElement[] {
	const local = skill.source === "local";
	const crumbs = el("nav", "crumbs");
	crumbs.setAttribute("aria-label", "Breadcrumb");
	const back = el("a", undefined, "skills");
	back.href = skillHref();
	crumbs.append(back, el("span", "sep", "/"), el("span", undefined, skill.name));
	const head = el("div", "skill-head");
	head.append(el("h2", undefined, skill.name), el("span", "tag", skill.source));
	if (local) {
		const actions = el("div", "head-actions");
		actions.append(page.confirm(`skill:${skill.name}`, "remove skill", async () => {
			await post("/api/skills/remove", { name: skill.name });
			changed(skill.name);
			location.hash = skillHref();
		}));
		head.append(actions);
	}
	const header = el("header", "skill-header");
	header.append(crumbs, head, el("p", "skill-desc", skill.description));
	if (!local) header.append(el("p", "page-note", "Built in: the documentation in gaidin's code. It changes when gaidin is updated."));

	const files = el("nav", "skill-files");
	files.setAttribute("aria-label", "Files");
	const shown = editing?.isNew ? [...skill.files, editing.file] : skill.files;
	for (const name of shown) {
		const link = el("a", undefined, name);
		link.href = skillHref(skill.name, name);
		if (name === file) link.setAttribute("aria-current", "page");
		files.append(link);
	}
	if (local) files.append(newFileControl(skill));

	const doc = el("article", "skill-doc");
	if (editing !== undefined) doc.append(fileEditor(skill, file, editing));
	else {
		if (local) {
			const bar = el("div", "doc-bar");
			bar.append(el("span", "file", file), button("edit", () => {
				editing = { skill: skill.name, file, draft: text, isNew: false };
				void draw();
			}));
			if (file !== "SKILL.md") {
				bar.append(page.confirm(`file:${skill.name}/${file}`, "remove file", async () => {
					await post("/api/skills/remove", { name: skill.name, file });
					changed(skill.name);
					location.hash = skillHref(skill.name);
				}));
			}
			doc.append(bar);
		}
		if (/\.md$/i.test(file)) {
			// SKILL.md's front matter is the name and description, shown above.
			const body = file === "SKILL.md" ? text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "") : text;
			doc.append(markdown(body, { document: true, link: (href) => resolve(skill, file, href) }));
		} else doc.append(el("pre", undefined, text));
	}

	const body = el("div", "skill-body");
	body.append(files, doc);
	return [header, body];
}

/** "+ file", then a path for it, which opens an empty editor. */
function newFileControl(skill: Skill): HTMLElement {
	if (newFile === undefined) {
		return button("+ file", () => {
			newFile = "";
			void draw();
		}, "plain add-file");
	}
	const form = el("form", "new-file");
	const path = el("input");
	path.value = newFile;
	path.placeholder = "references/notes.md";
	path.autocapitalize = "off";
	path.spellcheck = false;
	path.setAttribute("aria-label", "New file's path");
	path.addEventListener("input", () => {
		newFile = path.value;
	});
	path.addEventListener("keydown", (press) => {
		if (press.key === "Escape") {
			newFile = undefined;
			void draw();
		}
	});
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		const file = path.value.trim().replace(/^\.?\//, "");
		if (file === "") return;
		if (skill.files.includes(file)) {
			newFile = undefined;
			location.hash = skillHref(skill.name, file);
			return;
		}
		newFile = undefined;
		editing = { skill: skill.name, file, draft: "", isNew: true };
		location.hash = skillHref(skill.name, file);
	});
	form.append(path);
	queueMicrotask(() => path.focus());
	return form;
}

function fileEditor(skill: Skill, file: string, draft: NonNullable<typeof editing>): HTMLElement {
	const wrap = el("div", "file-editor");
	const box = editor(draft.draft, `${skill.name}/${file}`, (text) => {
		draft.draft = text;
	});
	const save = page.action(draft.isNew ? "create file" : "save", async () => {
		await post("/api/skills/save", { name: skill.name, file, text: draft.draft });
		editing = undefined;
		changed(skill.name);
		await draw();
	}, "primary");
	const cancel = button("cancel", () => {
		editing = undefined;
		if (draft.isNew) location.hash = skillHref(skill.name);
		else void draw();
	});
	box.addEventListener("keydown", (press) => {
		// Ctrl+S or ⌘S saves, as in an editor.
		if ((press.ctrlKey || press.metaKey) && press.key === "s") {
			press.preventDefault();
			save.click();
		}
	});
	const bar = el("div", "doc-bar");
	bar.append(el("span", "file", draft.isNew ? `new: ${file}` : file), cancel, save);
	wrap.append(bar, box);
	if (file === "SKILL.md") wrap.append(el("p", "page-note", "Keep the front matter: name, the skill's name, and description, one line saying what it's for and when to open it."));
	queueMicrotask(() => box.focus());
	return wrap;
}

/** Where a relative link in one of a skill's files goes on this page: one of its files, or a heading in this one. */
function resolve(skill: Skill, from: string, href: string): string | undefined {
	const [path = "", anchor] = href.split("#");
	if (path === "") return anchor === undefined ? undefined : skillHref(skill.name, from, anchor);
	const target = decodeURIComponent(new URL(path, `file:///${from}`).pathname.slice(1));
	return skill.files.includes(target) ? skillHref(skill.name, target, anchor) : undefined;
}
