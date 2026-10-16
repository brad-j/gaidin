// Skills: guides gaidin opens when a task calls for one. A skill is a directory holding a SKILL.md, front
// matter with a name and a one-line description and then Markdown, as agentskills.io has it, and the files
// it points to. The system prompt lists each skill by name and description; read_skill opens one, or one of
// its files, so a long guide costs tokens only when it's used.
//
// docs/ is the built-in gaidin skill, so gaidin can read the documentation of the version that's running.
// Local skills are directories in <data>/skills, which the sandbox can't see. The owner writes them from the
// app, and gaidin with write_skill and remove_skill, which always ask the owner first, showing the change.
// Every change is a commit in that directory's Git repository, and the list is read again after it. A change
// made on disk by hand shows once the server starts again.
import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { clip, guard } from "./guards.ts";
import { object, optional, string } from "./parse.ts";

const run = promisify(execFile);

export const BUILT_IN_DIR = resolve(import.meta.dirname, "../docs");

export type Skill = {
	name: string;
	description: string;
	source: "built-in" | "local";
	/** Its files, relative to its directory, SKILL.md first. */
	files: string[];
	dir: string;
};

const NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const MAX_DESCRIPTION = 1024;
/** Kinds of file read_skill opens: text a guide would point to. */
const TEXT = /\.(md|txt|json|ya?ml|csv|sh|ts|js|py)$/i;
const MAX_FILE = 200_000;
const MAX_FILES = 100;
/** A file's path in a skill: up to three parts, none hidden, so none is "..". */
const FILE = /^(?:[A-Za-z0-9][\w.-]*\/){0,2}[A-Za-z0-9][\w.-]*$/;

/** A SKILL.md's name, description and body, or throws with what's wrong. */
export function parseSkill(text: string) {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
	if (match === null) throw new Error("SKILL.md has no front matter between --- lines");
	const fields = new Map<string, string>();
	for (const line of match[1].split(/\r?\n/)) {
		const field = /^([a-z][\w-]*):\s*(.*)$/.exec(line);
		if (field !== null) fields.set(field[1], field[2].trim().replace(/^(["'])(.*)\1$/, "$2"));
	}
	const name = fields.get("name") ?? "";
	const description = fields.get("description") ?? "";
	if (!NAME.test(name)) throw new Error(`SKILL.md's name "${name}" isn't lowercase letters, digits and hyphens, up to 64`);
	if (description === "") throw new Error("SKILL.md has no description");
	if (description.length > MAX_DESCRIPTION) throw new Error(`SKILL.md's description is over ${MAX_DESCRIPTION} characters`);
	return { name, description, body: text.slice(match[0].length) };
}

/** The text files under `dir`, relative to it, skipping hidden names and links, which could point outside it. */
function filesIn(dir: string, under = ""): string[] {
	const found: string[] = [];
	for (const name of readdirSync(join(dir, under)).sort()) {
		if (name.startsWith(".")) continue;
		const path = join(under, name);
		const info = lstatSync(join(dir, path));
		if (info.isDirectory() && under.split(sep).length < 3) found.push(...filesIn(dir, path));
		else if (info.isFile() && TEXT.test(name) && info.size <= MAX_FILE) found.push(path);
	}
	return found;
}

/** The skill in `dir`, or throws with what's wrong. */
function loadSkill(dir: string, source: Skill["source"]): Skill {
	const { name, description } = parseSkill(readFileSync(join(dir, "SKILL.md"), "utf8"));
	const files = filesIn(dir).filter((f) => f !== "SKILL.md").slice(0, MAX_FILES - 1);
	return { name, description, source, files: ["SKILL.md", ...files], dir };
}

/** The built-in skill, then each local skill in `localDir`; one that can't be read, or has a name already taken, is a problem instead. */
export function loadSkills(localDir: string | undefined, builtIn = BUILT_IN_DIR) {
	const skills: Skill[] = [loadSkill(builtIn, "built-in")];
	const problems: string[] = [];
	const entries = localDir !== undefined && existsSync(localDir) ? readdirSync(localDir).filter((name) => !name.startsWith(".")).sort() : [];
	for (const entry of entries) {
		const dir = join(localDir!, entry);
		try {
			if (!lstatSync(dir).isDirectory()) continue;
			const skill = loadSkill(dir, "local");
			if (skills.some((s) => s.name === skill.name)) throw new Error(`there's already a skill named ${skill.name}`);
			skills.push(skill);
		} catch (error) {
			problems.push(`skills/${entry}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return { skills, problems };
}

/** One of a skill's files, by its path in the skill; throws if it isn't one. */
export function readSkillFile(skill: Skill, file = "SKILL.md"): string {
	const path = file.replace(/^\.\//, "");
	if (!skill.files.includes(path)) throw new Error(`${skill.name} has no file ${file}. Its files: ${skill.files.join(", ")}`);
	// The file was a plain file inside the skill when the server started; it must still resolve inside it.
	const real = realpathSync(join(skill.dir, path));
	const inside = relative(realpathSync(skill.dir), real);
	if (inside.startsWith("..") || isAbsolute(inside)) throw new Error(`${file} is outside the skill ${skill.name}`);
	return readFileSync(real, "utf8");
}

/** Who changed a skill, for its commit. */
export type Author = "owner" | "gaidin";

/** A change to a local skill: a file's new text, or with no text, the file removed (SKILL.md: the whole skill). */
export type SkillChange = { name: string; file: string; text?: string };

/**
 * The lines `after` adds to and removes from `before`, as "+ " and "- " lines with two unchanged lines around each
 * change, and how many of each. Files too long to compare line by line show as all removed and all added.
 */
export function lineDiff(before: string, after: string) {
	const a = before === "" ? [] : before.replace(/\n$/, "").split("\n");
	const b = after === "" ? [] : after.replace(/\n$/, "").split("\n");
	const ops: [" " | "-" | "+", string][] = [];
	if (a.length * b.length > 4_000_000) {
		ops.push(...a.map((line): ["-", string] => ["-", line]), ...b.map((line): ["+", string] => ["+", line]));
	} else {
		// The longest common subsequence of lines, from the end, then walked from the start.
		const width = b.length + 1;
		const common = new Uint32Array((a.length + 1) * width);
		for (let i = a.length - 1; i >= 0; i--) {
			for (let j = b.length - 1; j >= 0; j--) {
				common[i * width + j] = a[i] === b[j] ? common[(i + 1) * width + j + 1] + 1 : Math.max(common[(i + 1) * width + j], common[i * width + j + 1]);
			}
		}
		let i = 0;
		let j = 0;
		while (i < a.length || j < b.length) {
			if (i < a.length && j < b.length && a[i] === b[j]) {
				ops.push([" ", a[i]!]);
				i++;
				j++;
			} else if (i < a.length && (j === b.length || common[(i + 1) * width + j] >= common[i * width + j + 1])) {
				// Removals before additions, so a changed line reads as the old one, then the new.
				ops.push(["-", a[i]!]);
				i++;
			} else {
				ops.push(["+", b[j]!]);
				j++;
			}
		}
	}
	const near = (n: number) => ops.slice(Math.max(0, n - 2), n + 3).some(([op]) => op !== " ");
	const lines: string[] = [];
	let skipped = false;
	ops.forEach(([op, line], n) => {
		if (op !== " " || near(n)) {
			if (skipped && lines.length > 0) lines.push("…");
			lines.push(`${op} ${line}`);
			skipped = false;
		} else skipped = true;
	});
	return { text: lines.join("\n"), added: ops.filter(([op]) => op === "+").length, removed: ops.filter(([op]) => op === "-").length };
}

export function createSkills(localDir: string | undefined, owner = "the owner", builtIn?: string) {
	let { skills, problems } = loadSkills(localDir, builtIn);
	for (const problem of problems) console.error("[skills]", problem);
	const find = (name: string) => skills.find((s) => s.name === name);

	/** Reads the skills again, after a change. */
	function reload() {
		({ skills, problems } = loadSkills(localDir, builtIn));
	}

	/** Where a change goes, or throws with why it can't be made. */
	function target(change: SkillChange) {
		if (localDir === undefined) throw new Error("There's no skills directory.");
		const { name, file, text } = change;
		if (!NAME.test(name)) throw new Error(`"${name}" isn't a skill name: lowercase letters, digits and hyphens, up to 64.`);
		const skill = find(name);
		if (skill?.source === "built-in") throw new Error(`${name} is built in: it's the documentation in gaidin's code, and changes with it.`);
		if (!FILE.test(file) || !TEXT.test(file)) throw new Error(`"${file}" isn't a file a skill can hold: a path of up to three parts, ending .md, .txt, .json, .yaml, .csv, .sh, .ts, .js or .py.`);
		const dir = skill?.dir ?? join(localDir, name);
		const path = join(dir, file);
		if (text === undefined) {
			if (skill === undefined) throw new Error(`No skill ${name}.`);
			if (!skill.files.includes(file)) throw new Error(`${name} has no file ${file}. Its files: ${skill.files.join(", ")}`);
		} else {
			if (skill === undefined && file !== "SKILL.md") throw new Error(`There's no skill ${name} yet; write its SKILL.md first.`);
			if (Buffer.byteLength(text) > MAX_FILE) throw new Error(`A skill's file is at most ${MAX_FILE / 1000} KB.`);
			if (file === "SKILL.md") {
				const parsed = parseSkill(text);
				if (parsed.name !== name) throw new Error(`SKILL.md names the skill ${parsed.name}, not ${name}.`);
			}
		}
		// Nothing on the way may be a link, which could carry the write out of the skills directory.
		for (let at = path; at !== localDir && at.startsWith(localDir); at = dirname(at)) {
			if (existsSync(at) && lstatSync(at).isSymbolicLink()) throw new Error(`${relative(localDir, at)} is a link.`);
		}
		return { path, skill };
	}

	/** Why `change` can't be made, or nothing. */
	function problemWith(change: SkillChange): string | undefined {
		try {
			target(change);
			return undefined;
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
	}

	/** What `change` would do, as a summary and the lines it adds and removes. */
	function describe(change: SkillChange) {
		const { name, file, text } = change;
		const skill = find(name);
		const before = skill?.files.includes(file) ? readSkillFile(skill, file) : "";
		if (text === undefined) {
			const all = file === "SKILL.md";
			return {
				summary: all ? `remove skill ${name}${skill && skill.files.length > 1 ? ` and its ${skill.files.length - 1} other files` : ""}` : `remove ${file} from skill ${name}`,
				detail: all ? skill?.files.join("\n") ?? "" : lineDiff(before, "").text,
			};
		}
		const diff = lineDiff(before, text);
		const counts = `(+${diff.added} −${diff.removed} lines)`;
		const summary = skill === undefined ? `create skill ${name}: ${parseSkill(text).description}`
			: before === "" ? `add ${file} to skill ${name} ${counts}`
			: `change ${file} in skill ${name} ${counts}`;
		return { summary: clip(summary, 300), detail: diff.text };
	}

	async function commit(message: string, by: Author) {
		const dir = localDir!;
		try {
			if (!existsSync(join(dir, ".git"))) await run("git", ["-C", dir, "init", "-q"]);
			await run("git", ["-C", dir, "add", "-A"]);
			await run("git", ["-C", dir, "-c", `user.name=${by}`, "-c", "user.email=gaidin@localhost", "commit", "-q", "--allow-empty", "-m", message]);
		} catch (error) {
			// The change is made; only its history is missing.
			console.error("[skills] couldn't commit:", error instanceof Error ? error.message : error);
		}
	}

	/** Makes `change`, keeps it in the history and reads the skills again. Throws with why it can't be made. */
	async function apply(change: SkillChange, by: Author): Promise<Skill | undefined> {
		const { path, skill } = target(change);
		const { name, file, text } = change;
		if (text === undefined) {
			rmSync(file === "SKILL.md" ? skill!.dir : path, { recursive: true, force: true });
			await commit(`remove ${file === "SKILL.md" ? name : `${name}/${file}`}`, by);
		} else {
			mkdirSync(dirname(path), { recursive: true });
			// Written beside it and renamed over it, so a reader never sees half a file.
			const temporary = join(dirname(path), `.${Date.now()}.tmp`);
			writeFileSync(temporary, text.endsWith("\n") ? text : `${text}\n`);
			renameSync(temporary, path);
			await commit(`${skill === undefined ? "create" : "change"} ${name}/${file}`, by);
		}
		reload();
		return find(name);
	}

	const skillsSection = section("skills", () =>
		[
			"Skills are guides for particular tasks. When a request matches a skill's description, open it with read_skill before you act or answer,",
			"then open the files it points to as you need them.",
			`When ${owner} asks you to keep a way of doing something, or you've worked out a procedure you'll need again, offer to write it as a skill`,
			`with write_skill; ${owner} sees the change and approves it first.`,
			"",
			...skills.map((s) => `- ${s.name}: ${s.description}`),
		].join("\n"),
	);

	const readSkill = defineTool({
		name: "read_skill",
		description: "Open a skill's SKILL.md, or one of its files by its path in the skill.",
		parameters: Type.Object({
			name: Type.String({ description: "The skill's name, as listed" }),
			file: Type.Optional(Type.String({ description: "A file the skill points to, such as tools.md. Default: SKILL.md" })),
		}),
		replay: "safe",
		execute: async (args) => {
			const skill = find(args.name);
			if (skill === undefined) throw new Error(`No skill ${args.name}. Skills: ${skills.map((s) => s.name).join(", ")}`);
			const text = readSkillFile(skill, args.file);
			const others = skill.files.filter((f) => f !== (args.file ?? "SKILL.md"));
			return { output: [{ type: "text", text: (args.file ?? "SKILL.md") === "SKILL.md" ? `${text}\n\n[files: ${others.join(", ")}]` : text }] };
		},
	});

	const writeSkill = defineTool({
		name: "write_skill",
		description:
			`Create a skill, or replace one of its files, once ${owner} approves the change. A new skill starts with its SKILL.md: front matter ` +
			'between --- lines with `name` (the skill\'s name: lowercase letters, digits and hyphens) and `description` (one line: what it\'s for and ' +
			"when to open it), then the guide in Markdown. Keep SKILL.md short and put long reference material in other files it points to, such " +
			"as references/backups.md. `text` is the whole file. The built-in gaidin skill can't be changed.",
		parameters: Type.Object({
			name: Type.String({ description: "The skill's name" }),
			file: Type.Optional(Type.String({ description: "The file's path in the skill. Default: SKILL.md" })),
			text: Type.String({ description: "The file's whole new text" }),
		}),
		replay: "safe",
		execute: async (args) => {
			const file = args.file ?? "SKILL.md";
			const skill = await apply({ name: args.name, file, text: args.text }, "gaidin");
			return { output: [{ type: "text", text: `Wrote ${args.name}/${file}. Its files: ${skill?.files.join(", ") ?? "none"}` }] };
		},
	});

	const removeSkill = defineTool({
		name: "remove_skill",
		description: `Remove a skill, or one of its files, once ${owner} approves. Removing SKILL.md removes the whole skill. Its history is kept.`,
		parameters: Type.Object({
			name: Type.String({ description: "The skill's name" }),
			file: Type.Optional(Type.String({ description: "One of its files. Default: SKILL.md, the whole skill" })),
		}),
		replay: "safe",
		execute: async (args) => {
			const file = args.file ?? "SKILL.md";
			await apply({ name: args.name, file }, "gaidin");
			return { output: [{ type: "text", text: file === "SKILL.md" ? `Removed skill ${args.name}.` : `Removed ${file} from ${args.name}.` }] };
		},
	});

	// A skill is instructions gaidin follows, so every change gaidin makes is shown to the owner first.
	const changeArgs = object({ name: string, file: optional(string), text: string });
	const removeArgs = object({ name: string, file: optional(string) });
	const guards = [
		guard("write_skill", changeArgs, {
			refuse: (a) => problemWith({ name: a.name, file: a.file ?? "SKILL.md", text: a.text }),
			ask: (a) => describe({ name: a.name, file: a.file ?? "SKILL.md", text: a.text }),
		}),
		guard("remove_skill", removeArgs, {
			refuse: (a) => problemWith({ name: a.name, file: a.file ?? "SKILL.md" }),
			ask: (a) => describe({ name: a.name, file: a.file ?? "SKILL.md" }),
		}),
	];

	return {
		list: () => skills,
		problems: () => problems,
		find,
		apply,
		guards,
		extension: defineExtension({ name: "skills", sections: [skillsSection], tools: [readSkill, writeSkill, removeSkill] }),
	};
}
