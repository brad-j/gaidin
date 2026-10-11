import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { configFor } from "../src/config.ts";
import { context, startHost } from "../src/host.ts";
import { BUILT_IN_DIR, loadSkills, parseSkill, readSkillFile } from "../src/skills.ts";

const skillMd = (name: string, description = `What ${name} is for.`) => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;

function scratch(t: TestContext): string {
	const dir = mkdtempSync(join(tmpdir(), "gaidin-skills-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function skillDir(root: string, dir: string, text: string): string {
	const path = join(root, dir);
	mkdirSync(path, { recursive: true });
	writeFileSync(join(path, "SKILL.md"), text);
	return path;
}

test("front matter gives a skill's name and description", () => {
	assert.deepEqual(parseSkill(`---\nname: homelab\ndescription: "What to do when an alert comes in."\n---\nBody\n`), {
		name: "homelab",
		description: "What to do when an alert comes in.",
		body: "Body\n",
	});
	assert.throws(() => parseSkill("# No front matter"), /no front matter/);
	assert.throws(() => parseSkill(skillMd("Homelab")), /isn't lowercase/);
	assert.throws(() => parseSkill(skillMd("-homelab")), /isn't lowercase/);
	assert.throws(() => parseSkill("---\nname: homelab\n---\n"), /no description/);
	assert.throws(() => parseSkill(skillMd("homelab", "x".repeat(1025))), /over 1024/);
});

test("local skills load beside the built-in one; a broken one, or one taking a name already used, is a problem instead", (t) => {
	const local = scratch(t);
	const outside = scratch(t);
	writeFileSync(join(outside, "secret.md"), "secret");
	const homelab = skillDir(local, "homelab", skillMd("homelab"));
	mkdirSync(join(homelab, "references"));
	writeFileSync(join(homelab, "references", "think-2.md"), "Backups at 03:00.");
	writeFileSync(join(homelab, ".hidden.md"), "hidden");
	writeFileSync(join(homelab, "photo.png"), "not text");
	symlinkSync(join(outside, "secret.md"), join(homelab, "linked.md"));
	skillDir(local, "broken", "no front matter");
	skillDir(local, "impostor", skillMd("gaidin"));
	writeFileSync(join(local, "stray.md"), "not a skill");

	const { skills, problems } = loadSkills(local);
	assert.deepEqual(skills.map((s) => [s.name, s.source]), [["gaidin", "built-in"], ["homelab", "local"]]);
	assert.deepEqual(skills[1]!.files, ["SKILL.md", join("references", "think-2.md")]);
	assert.equal(problems.length, 2);
	assert.match(problems[0]!, /^skills\/broken: SKILL\.md has no front matter/);
	assert.match(problems[1]!, /^skills\/impostor: there's already a skill named gaidin/);
	assert.deepEqual(loadSkills(join(local, "missing")).problems, []);
});

test("read_skill opens only a skill's own files, even when one is swapped for a link afterwards", (t) => {
	const local = scratch(t);
	const outside = scratch(t);
	writeFileSync(join(outside, "secret.md"), "secret");
	const dir = skillDir(local, "homelab", skillMd("homelab"));
	writeFileSync(join(dir, "notes.md"), "Backups at 03:00.");
	const skill = loadSkills(local).skills.find((s) => s.name === "homelab")!;

	assert.match(readSkillFile(skill), /^---\nname: homelab/);
	assert.equal(readSkillFile(skill, "./notes.md"), "Backups at 03:00.");
	for (const file of ["../homelab/notes.md", join(outside, "secret.md"), "missing.md"]) assert.throws(() => readSkillFile(skill, file), /has no file/);
	unlinkSync(join(dir, "notes.md"));
	symlinkSync(join(outside, "secret.md"), join(dir, "notes.md"));
	assert.throws(() => readSkillFile(skill, "notes.md"), /outside the skill/);
});

test("the gaidin skill is the docs, and its index names every one of them", () => {
	const { skills, problems } = loadSkills(undefined);
	assert.deepEqual(problems, []);
	const gaidin = skills[0]!;
	assert.equal(gaidin.name, "gaidin");
	const docs = readdirSync(BUILT_IN_DIR).filter((f) => f.endsWith(".md") && f !== "SKILL.md").sort();
	assert.deepEqual(gaidin.files.slice(1).sort(), docs);
	const index = readFileSync(join(BUILT_IN_DIR, "SKILL.md"), "utf8");
	const named = [...index.matchAll(/^- \[([\w.-]+\.md)\]\(\1\):/gm)].map((m) => m[1]).sort();
	assert.deepEqual(named, docs, "docs/SKILL.md's file list doesn't match docs/");
});

test("the system prompt lists the skills, and read_skill opens one's file", async (t) => {
	const dir = scratch(t);
	let prompt = "";
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	faux.setResponses([
		(ctx) => {
			prompt = JSON.stringify(ctx.messages.filter((m) => m.role === "system"));
			return fauxAssistantMessage(fauxToolCall("read_skill", { name: "gaidin", file: "tools.md" }), { stopReason: "toolUse" });
		},
		fauxAssistantMessage(fauxText("Done.")),
	]);
	const models = createModels();
	models.setProvider(faux.provider);
	const host = await startHost({ config: configFor({ owner: "Brad" }), dataDir: dir, models, model: { provider: "faux", modelId: "faux-1" }, adapters: { push: { send: async () => true } } });
	t.after(() => host.harness.close(context));
	await (await host.root.submit({ type: "input", content: "how do gates work?" }, context)).wait(context);
	assert.match(prompt, /- gaidin: How gaidin works/);
	const results = (await host.root.context(context)).messages.filter((m) => m.role === "toolResult").map((m) => JSON.stringify(m.content));
	assert.match(results[0]!, /## Scheduled jobs/);
});
