// The skills page: the guides gaidin can open, and each one's files, shown as gaidin reads them. Its
// address names what's open: #/skills, #/skills/<name>, #/skills/<name>/<file>, and #<heading> after
// that for a place in the file. Links between a skill's files stay on the page.
import type { Gets } from "../src/web.ts";
import { load } from "./api.ts";
import { el } from "./dom.ts";
import { markdown } from "./markdown.ts";

type Listing = Gets["/api/skills"];
type Skill = Listing["skills"][number];
export type SkillRoute = { name?: string; file?: string; anchor?: string };

/** Skills are read when the server starts, so the page asks once. */
let listing: Listing | undefined;
const texts = new Map<string, string>();
/** The route being drawn; a newer one wins over an older one still loading. */
let drawing = "";

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

export async function renderSkills(root: HTMLElement, route: SkillRoute) {
	const key = JSON.stringify(route);
	drawing = key;
	try {
		listing ??= await load("/api/skills");
		const skill = listing.skills.find((s) => s.name === route.name);
		if (route.name === undefined || skill === undefined) {
			if (drawing === key) root.replaceChildren(...list(listing, route.name));
			return;
		}
		const file = route.file ?? "SKILL.md";
		const text = await fileText(skill, file);
		if (drawing !== key) return;
		root.replaceChildren(...page(skill, file, text));
		const target = route.anchor === undefined ? undefined : document.getElementById(`h-${route.anchor}`);
		if (target) target.scrollIntoView({ block: "start" });
		else root.parentElement?.scrollTo({ top: 0 });
	} catch (error) {
		if (drawing === key) root.replaceChildren(el("p", "page-problem", error instanceof Error ? error.message : String(error)));
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

function list(listing: Listing, missing: string | undefined): HTMLElement[] {
	const head = el("div", "section-head");
	head.append(el("h2", undefined, "Skills"), el("span", "count", String(listing.skills.length)));
	const note = el("p", "page-note",
		"Guides gaidin opens when a request matches one's description. The built-in one is gaidin's own documentation. " +
		"Local skills are folders with a SKILL.md in skills/ in gaidin's data directory, read when it starts.");
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
	section.append(head, note, rows);
	const problems = listing.problems.map((p) => el("p", "page-problem", `Not loaded: ${p}`));
	return [...(missing === undefined ? [] : [el("p", "page-problem", `No skill ${missing}.`)]), ...problems, section];
}

function page(skill: Skill, file: string, text: string): HTMLElement[] {
	const crumbs = el("nav", "crumbs");
	crumbs.setAttribute("aria-label", "Breadcrumb");
	const back = el("a", undefined, "skills");
	back.href = skillHref();
	crumbs.append(back, el("span", "sep", "/"), el("span", undefined, skill.name));
	const head = el("div", "skill-head");
	head.append(el("h2", undefined, skill.name), el("span", "tag", skill.source));

	const files = el("nav", "skill-files");
	files.setAttribute("aria-label", "Files");
	for (const name of skill.files) {
		const link = el("a", undefined, name);
		link.href = skillHref(skill.name, name);
		if (name === file) link.setAttribute("aria-current", "page");
		files.append(link);
	}

	const doc = el("article", "skill-doc");
	if (/\.md$/i.test(file)) {
		// SKILL.md's front matter is the name and description, shown above.
		const body = file === "SKILL.md" ? text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "") : text;
		doc.append(markdown(body, { document: true, link: (href) => resolve(skill, file, href) }));
	} else doc.append(el("pre", undefined, text));

	const header = el("header", "skill-header");
	header.append(crumbs, head, el("p", "skill-desc", skill.description));
	const body = el("div", "skill-body");
	body.append(files, doc);
	return [header, body];
}

/** Where a relative link in one of a skill's files goes on this page: one of its files, or a heading in this one. */
function resolve(skill: Skill, from: string, href: string): string | undefined {
	const [path = "", anchor] = href.split("#");
	if (path === "") return anchor === undefined ? undefined : skillHref(skill.name, from, anchor);
	const target = decodeURIComponent(new URL(path, `file:///${from}`).pathname.slice(1));
	return skill.files.includes(target) ? skillHref(skill.name, target, anchor) : undefined;
}
