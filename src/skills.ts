// Skills: guides gaidin opens when a task calls for one. A skill is a directory holding a SKILL.md, front
// matter with a name and a one-line description and then Markdown, as agentskills.io has it, and the files
// it points to. The system prompt lists each skill by name and description; read_skill opens one, or one of
// its files, so a long guide costs tokens only when it's used.
//
// docs/ is the built-in gaidin skill, so gaidin can read the documentation of the version that's running.
// Local skills are directories in <data>/skills, which the sandbox can't see, so only whoever runs the
// server puts them there. Skills are read when the server starts.
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";

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

export function createSkills(localDir: string | undefined, builtIn?: string) {
	const { skills, problems } = loadSkills(localDir, builtIn);
	for (const problem of problems) console.error("[skills]", problem);
	const find = (name: string) => skills.find((s) => s.name === name);

	const skillsSection = section("skills", () =>
		[
			"Skills are guides for particular tasks. When a request matches a skill's description, open it with read_skill before you act or answer,",
			"then open the files it points to as you need them.",
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
			return { content: [{ type: "text", text: (args.file ?? "SKILL.md") === "SKILL.md" ? `${text}\n\n[files: ${others.join(", ")}]` : text }] };
		},
	});

	return { skills, problems, find, extension: defineExtension({ name: "skills", sections: [skillsSection], tools: [readSkill] }) };
}
