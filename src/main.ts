#!/usr/bin/env -S node --no-warnings
// The gaidin command.
import { parseArgs } from "node:util";
import { ask, watch } from "./cli.ts";
import { loadConfig, maskedConfig } from "./config.ts";
import { printChecks, runChecks } from "./doctor.ts";
import { serve } from "./server.ts";

const USAGE = `usage: gaidin [--config FILE] COMMAND

  serve                     run the agent and its surfaces
  ask [--id ID] "MESSAGE"   send a message and print the run; the same --id reattaches
  watch                     print everything the agent does, until Ctrl+C
  doctor [--push]           check the settings and everything the server needs
  config                    print the settings in use, secrets shortened

Settings come from --config, GAIDIN_CONFIG, ./gaidin.json or /etc/gaidin/config.json,
with environment variables on top. docs/deploy.md lists them.`;

const { values, positionals } = parseArgs({
	options: {
		config: { type: "string" },
		id: { type: "string" },
		push: { type: "boolean" },
		help: { type: "boolean", short: "h" },
	},
	allowPositionals: true,
});
const [command, ...rest] = positionals;
if (values.help || command === undefined || command === "help") {
	console.log(USAGE);
	process.exit(command === undefined && !values.help ? 2 : 0);
}

const loaded = loadConfig(values.config === undefined ? {} : { file: values.config });
const fail = (lines: string[]) => {
	for (const line of lines) console.error(line);
	process.exit(1);
};

switch (command) {
	case "serve":
		if (loaded.errors.length > 0) fail(["gaidin can't start; fix these settings (gaidin doctor checks the rest):", ...loaded.errors.map((e) => `  ${e}`)]);
		for (const warning of loaded.warnings) console.error(`warning: ${warning}`);
		await serve(loaded.config);
		break;
	case "ask": {
		const prompt = rest.join(" ");
		if (prompt === "") fail(['usage: gaidin ask [--id ID] "MESSAGE"']);
		process.exit(await ask(loaded.config, prompt, values.id));
	}
	case "watch":
		process.exit(await watch(loaded.config));
	case "doctor":
		process.exit(printChecks(await runChecks(loaded, { push: values.push === true })));
	case "config":
		console.log(JSON.stringify(maskedConfig(loaded.config), null, 2));
		for (const error of loaded.errors) console.error(`error: ${error}`);
		for (const warning of loaded.warnings) console.error(`warning: ${warning}`);
		process.exit(loaded.errors.length === 0 ? 0 : 1);
	default:
		fail([`unknown command ${command}`, "", USAGE]);
}
