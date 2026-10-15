#!/usr/bin/env -S node --no-warnings
// The gaidin command.
import { parseArgs } from "node:util";
import type { AgentChange } from "./agents.ts";
import { agents, ask, connectors, watch } from "./cli.ts";
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
               [--connectors NAME,NAME]
                            change an agent; an empty list clears it
  connector list            list the connectors (MCP servers)
  connector show NAME       a connector's tools and how each is set
  connector add NAME URL [--token]
                            add a remote MCP server; --token reads its bearer token from stdin
  connector token NAME [--token]
                            change its token, read from stdin, or take it away without --token
  connector tool NAME TOOL allow|ask|off
                            set a tool, which also accepts its definition as it is now
  connector connect NAME [--client-id ID]
                            sign it in with OAuth: prints the address to open in a browser
  connector client-document print gaidin's client id document, for connectors.clientId
  connector refresh NAME    read its tools again
  connector remove NAME     remove it, its token and every agent's grant of it
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
		connectors: { type: "string" },
		token: { type: "boolean" },
		"client-id": { type: "string" },
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
		const granted = list(values.connectors);
		if (granted !== undefined) change.connectors = granted;
		process.exit(await agents(loaded.config, { type: "agent", action: "set", id: id!, change }));
	}
	case "connector": {
		const [action = "list", name, third, fourth] = rest;
		const usage = "usage: gaidin connector list | show NAME | add NAME URL [--token] | connect NAME [--client-id ID] | token NAME [--token] | tool NAME TOOL allow|ask|off | refresh NAME | remove NAME | client-document";
		// The token comes on stdin, so it's in no shell history or process list.
		const token = async () => {
			if (values.token !== true) return undefined;
			if (process.stdin.isTTY) process.stderr.write("Token, then Enter: ");
			let text = "";
			for await (const chunk of process.stdin) {
				text += String(chunk);
				if (process.stdin.isTTY && text.includes("\n")) break;
			}
			return text.trim();
		};
		if (action === "list") process.exit(await connectors(loaded.config, { type: "connector", action: "list" }));
		if (action === "client-document") process.exit(await connectors(loaded.config, { type: "connector", action: "client-document" }));
		if (name === undefined) fail([usage]);
		if (action === "show" || action === "refresh" || action === "remove") process.exit(await connectors(loaded.config, { type: "connector", action, name: name! }));
		if (action === "add") {
			if (third === undefined) fail([usage]);
			const add: Parameters<typeof connectors>[1] = { type: "connector", action: "add", name: name!, url: third! };
			const given = await token();
			if (given !== undefined) add.token = given;
			process.exit(await connectors(loaded.config, add));
		}
		if (action === "connect") {
			const connect: Parameters<typeof connectors>[1] = { type: "connector", action: "connect", name: name! };
			if (values["client-id"] !== undefined) connect.clientId = values["client-id"];
			process.exit(await connectors(loaded.config, connect));
		}
		if (action === "token") {
			const change: Parameters<typeof connectors>[1] = { type: "connector", action: "token", name: name! };
			const given = await token();
			if (given !== undefined) change.token = given;
			process.exit(await connectors(loaded.config, change));
		}
		if (action === "tool" && third !== undefined && (fourth === "allow" || fourth === "ask" || fourth === "off")) {
			process.exit(await connectors(loaded.config, { type: "connector", action: "tool", name: name!, tool: third, setting: fourth }));
		}
		fail([usage]);
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
