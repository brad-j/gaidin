// Enough Markdown for model answers: fences, headings, lists, quotes, tables, rules, and inline code,
// emphasis and links. It builds DOM nodes, never HTML strings, so nothing in a message can inject markup.
import { el } from "./dom.ts";

const INLINE = /(`+)([\s\S]*?[^`])\1(?!`)|\*\*([^*][\s\S]*?)\*\*|__([^_][\s\S]*?)__|~~([\s\S]+?)~~|!?\[([^\]]+)\]\(<?((?:[^()\s<>]|\([^()\s]*\))+)>?\)|<?(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"\]])>?|\*([^*\s](?:[^*]*[^*\s])?)\*|(?<![\w])_([^_\s](?:[^_]*[^_\s])?)_(?![\w])/g;

function inline(text: string, parent: HTMLElement) {
	let last = 0;
	for (const m of text.matchAll(INLINE)) {
		const index = m.index ?? 0;
		if (index > last) parent.append(text.slice(last, index));
		last = index + m[0].length;
		if (m[1] !== undefined) parent.append(el("code", undefined, m[2].replace(/^ (.*) $/, "$1")));
		else if (m[3] !== undefined || m[4] !== undefined) inline(m[3] ?? m[4], parent.appendChild(el("strong")));
		else if (m[5] !== undefined) inline(m[5], parent.appendChild(el("s")));
		else if (m[6] !== undefined) parent.append(link(m[7], m[6]));
		else if (m[8] !== undefined) parent.append(link(m[8]));
		else inline(m[9] ?? m[10], parent.appendChild(el("em")));
	}
	if (last < text.length) parent.append(text.slice(last));
}

/** A link to an http(s) or mailto address; anything else is shown as its label. A label holding a URL stays plain, so links don't nest. */
function link(href: string, label?: string): Node {
	const local = /^(https?:|mailto:)/i.test(href) ? undefined : options.link?.(href);
	if (!/^(https?:|mailto:)/i.test(href) && local === undefined) return document.createTextNode(label ?? href);
	const a = el("a");
	if (local !== undefined) a.href = local;
	else {
		a.href = href;
		a.target = "_blank";
		a.rel = "noopener noreferrer";
	}
	if (label === undefined || /https?:\/\//.test(label)) a.textContent = label ?? href;
	else inline(label, a);
	return a;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+-]*)/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

export type MarkdownOptions = {
	/** Where a relative link goes on this page, or undefined to show it as plain text. */
	link?: (href: string) => string | undefined;
	/** A document rather than an answer: # is a page title (h2) and ## a section (h3), and headings get ids for anchors. */
	document?: boolean;
};

/** The options of the markdown() call in progress; it's synchronous, so one at a time. */
let options: MarkdownOptions = {};

export function markdown(source: string, given: MarkdownOptions = {}): HTMLElement {
	const root = el("div", "md");
	options = given;
	try {
		blocks(source.replace(/\r\n?/g, "\n").split("\n"), root);
	} finally {
		options = {};
	}
	return root;
}

/** A heading's anchor, as GitHub makes them: "Tools that reach outside" is "tools-that-reach-outside". */
export function anchor(text: string): string {
	return text.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").trim().replace(/\s/g, "-");
}

function cells(row: string): string[] {
	return row.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

function isTable(lines: string[], i: number): boolean {
	return lines[i].includes("|") && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]);
}

function startsBlock(lines: string[], i: number): boolean {
	const line = lines[i];
	return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || ITEM.test(line) || QUOTE.test(line) || isTable(lines, i);
}

function blocks(lines: string[], parent: HTMLElement) {
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (line.trim() === "") {
			i++;
			continue;
		}
		const fence = FENCE.exec(line);
		if (fence) {
			// An unclosed fence runs to the end, which is what a streaming answer looks like mid-block.
			const close = new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}\\s*$`);
			const body: string[] = [];
			for (i++; i < lines.length && !close.test(lines[i]); i++) body.push(lines[i]);
			i++;
			const pre = el("pre");
			const code = el("code", undefined, body.join("\n"));
			if (fence[2]) code.dataset.lang = fence[2];
			pre.append(code);
			parent.append(pre);
			continue;
		}
		const heading = HEADING.exec(line);
		if (heading) {
			const level = heading[1].length;
			const h = options.document
				? el(level === 1 ? "h2" : level === 2 ? "h3" : "h4")
				: el(level <= 2 ? "h3" : level === 3 ? "h4" : "h5");
			if (options.document) h.id = `h-${anchor(heading[2])}`;
			inline(heading[2], h);
			parent.append(h);
			i++;
			continue;
		}
		if (RULE.test(line)) {
			parent.append(el("hr"));
			i++;
			continue;
		}
		if (QUOTE.test(line)) {
			const body: string[] = [];
			for (; i < lines.length && lines[i].trim() !== "" && QUOTE.test(lines[i]); i++) body.push(QUOTE.exec(lines[i])![1]);
			const quote = el("blockquote");
			blocks(body, quote);
			parent.append(quote);
			continue;
		}
		if (isTable(lines, i)) {
			const align = cells(lines[i + 1]).map((c) => (c.endsWith(":") ? (c.startsWith(":") ? "center" : "right") : ""));
			const table = el("table");
			const head = table.createTHead().insertRow();
			for (const [n, text] of cells(line).entries()) {
				const th = el("th");
				if (align[n]) th.style.textAlign = align[n];
				inline(text, th);
				head.append(th);
			}
			const body = table.createTBody();
			for (i += 2; i < lines.length && lines[i].includes("|") && lines[i].trim() !== ""; i++) {
				const row = body.insertRow();
				for (const [n, text] of cells(lines[i]).entries()) {
					const td = row.insertCell();
					if (align[n]) td.style.textAlign = align[n];
					inline(text, td);
				}
			}
			const wrap = el("div", "table");
			wrap.append(table);
			parent.append(wrap);
			continue;
		}
		const item = ITEM.exec(line);
		if (item) {
			i = list(lines, i, item[1].length, parent);
			continue;
		}
		// Line breaks inside a paragraph are kept: answers use them on purpose.
		const paragraph = el("p");
		for (let first = true; i < lines.length && lines[i].trim() !== "" && (first || !startsBlock(lines, i)); i++, first = false) {
			if (!first) paragraph.append(el("br"));
			inline(lines[i].trim(), paragraph);
		}
		parent.append(paragraph);
	}
}

/** A list at `indent`; lines indented further belong to the item above them. Returns the next line. */
function list(lines: string[], i: number, indent: number, parent: HTMLElement): number {
	const first = ITEM.exec(lines[i])!;
	const ordered = /\d/.test(first[2]);
	const node = ordered ? el("ol") : el("ul");
	if (node instanceof HTMLOListElement && parseInt(first[2]) !== 1) node.start = parseInt(first[2]);
	while (i < lines.length) {
		const item = ITEM.exec(lines[i]);
		if (!item || item[1].length !== indent || /\d/.test(item[2]) !== ordered) break;
		const body = [item[3]];
		let loose = false;
		for (i++; i < lines.length; i++) {
			const line = lines[i];
			const leading = line.length - line.trimStart().length;
			if (line.trim() === "") {
				// A blank line ends the item; the list goes on if the next text is another item or indented under this one.
				const next = lines.slice(i + 1).find((l) => l.trim() !== "");
				if (next === undefined || next.length - next.trimStart().length <= indent) break;
				body.push("");
				loose = true;
			} else if (leading > indent) body.push(line.slice(Math.min(leading, indent + 2)));
			else if (ITEM.test(line) || startsBlock(lines, i)) break;
			else body.push(line.trim());
		}
		const li = el("li");
		if (body.length === 1) inline(body[0], li);
		else {
			blocks(body, li);
			// A tight item's first paragraph sits inline, so the bullet lines up with its text.
			const lead = li.firstElementChild;
			if (!loose && lead?.tagName === "P") lead.replaceWith(...lead.childNodes);
		}
		node.append(li);
		if (lines[i]?.trim() === "") {
			let next = i;
			while (next < lines.length && lines[next].trim() === "") next++;
			const following = next < lines.length ? ITEM.exec(lines[next]) : null;
			if (following && following[1].length === indent) i = next;
		}
	}
	parent.append(node);
	return i;
}
