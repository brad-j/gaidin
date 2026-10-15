#!/usr/bin/env -S node --no-warnings
// The gaidin command.
import { parseArgs } from "node:util";
import type { AgentChange } from "./agents.ts";
import { agents, ask, watch } from "./cli.ts";
import { loadConfig, maskedConfig } from "./config.ts";
import { printChecks, runChecks } from "./doctor.ts";
import { serve } from "./server.ts";

const USAGE = `usage: gaidin [--config FILE] COMMAND

  serve                     run the agent and its surfaces
  ask [--id ID] [--agent ID] "MESSAGE"
                            send a message and print the run; the same --id reattaches
  watch [--agent ID]        print everything the agent does, until Ctrl+C
  agent list                list the agents
  agent add ID --name NAME [--job TEXT]
                            add an agent
  agent set ID [--name NAME] [--job TEXT] [--channel SLACK_ID]
               [--can-message ID,ID] [--workspaces NAME,NAME] [--profiles NAME,NAME]
                            change an agent; an empty list clears it
  doctor [--push]           check the settings and everything the server needs
  config                    print the settings in use, secrets shortened

Settings come from --config, GAIDIN_CONFIG, ./gaidin.json or /etc/gaidin/config.json,
with environment variables on top. docs/deploy.md lists them.`;

const { values, positionals } = parseArgs({
	options: {
		config: { type: "string" },
		id: { type: "string" },
		agent: { type: "string" },
		name: { type: "string" },
		job: { type: "string" },
		channel: { type: "string" },
		"can-message": { type: "string" },
		workspaces: { type: "string" },
		profiles: { type: "string" },
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
		if (prompt === "") fail(['usage: gaidin ask [--id ID] [--agent ID] "MESSAGE"']);
		process.exit(await ask(loaded.config, prompt, values.id, values.agent));
	}
	case "watch":
		process.exit(await watch(loaded.config, values.agent));
	case "agent": {
		const [action = "list", id] = rest;
		const list = (text: string | undefined) => (text === undefined ? undefined : text.split(",").map((s) => s.trim()).filter((s) => s !== ""));
		if (action === "list") process.exit(await agents(loaded.config, { type: "agent", action: "list" }));
		if (id === undefined || (action !== "add" && action !== "set")) fail(["usage: gaidin agent list | add ID --name NAME [--job TEXT] | set ID [options]", "", USAGE]);
		if (action === "add") {
			if (values.name === undefined) fail(["usage: gaidin agent add ID --name NAME [--job TEXT]"]);
			process.exit(await agents(loaded.config, { type: "agent", action: "add", id: id!, name: values.name!, job: values.job ?? "" }));
		}
		const change: AgentChange = {};
		if (values.name !== undefined) change.name = values.name;
		if (values.job !== undefined) change.job = values.job;
		if (values.channel !== undefined) change.channel = values.channel;
		const canMessage = list(values["can-message"]);
		if (canMessage !== undefined) change.canMessage = canMessage;
		const workspaces = list(values.workspaces);
		if (workspaces !== undefined) change.workspaces = workspaces;
		const profiles = list(values.profiles);
		if (profiles !== undefined) change.profiles = profiles;
		process.exit(await agents(loaded.config, { type: "agent", action: "set", id: id!, change }));
	}
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
