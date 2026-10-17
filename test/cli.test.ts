import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PROTOCOL } from "../src/web.ts";

const MAIN = join(import.meta.dirname, "..", "src", "main.ts");

/** Runs the gaidin command with settings from a file that doesn't exist, so a real gaidin.json is never read. */
function gaidin(...args: string[]) {
	const result = spawnSync("node", ["--no-warnings", MAIN, ...args], {
		encoding: "utf8",
		env: { ...process.env, GAIDIN_CONFIG: join(import.meta.dirname, "no-such-gaidin.json") },
	});
	return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("--help prints the usage and exits 0", () => {
	const run = gaidin("--help");
	assert.equal(run.status, 0);
	assert.match(run.stdout, /usage: gaidin/);
});

test("no command prints the usage and exits 2", () => {
	const run = gaidin();
	assert.equal(run.status, 2);
	assert.match(run.stdout, /usage: gaidin/);
});

test("an unknown command exits 1 with the usage", () => {
	const run = gaidin("bogus");
	assert.equal(run.status, 1);
	assert.match(run.stderr, /unknown command bogus/);
	assert.match(run.stderr, /usage: gaidin/);
});

test("an unknown option exits 1 with the usage and no stack trace", () => {
	for (const args of [["--nope"], ["ask", "--agnet", "min", "hi"]]) {
		const run = gaidin(...args);
		assert.equal(run.status, 1);
		assert.match(run.stderr, new RegExp(`unknown option ${args.find((a) => a.startsWith("--"))}`));
		assert.match(run.stderr, /usage: gaidin/);
		assert.doesNotMatch(run.stderr, /ERR_PARSE_ARGS|\n\s+at /);
	}
});

test("ask with no message exits 1 with its usage line", () => {
	const run = gaidin("ask");
	assert.equal(run.status, 1);
	assert.match(run.stderr, /usage: gaidin ask/);
});

test("--version and version print the version and protocol and exit 0", () => {
	const { version } = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));
	for (const args of [["--version"], ["version"]]) {
		const run = gaidin(...args);
		assert.equal(run.status, 0);
		assert.equal(run.stdout, `gaidin ${version} (protocol ${PROTOCOL})\n`);
	}
});
