// The homelab extension, written for gaidin's first deployment: homelab_status reads a dashboard's
// monitoring feeds, and container_logs reads Docker logs over a restricted SSH key. It's on only when
// the config has `extensions.homelab`. docs/tools.md describes both tools. Its gate lets a scheduled job
// check the same feeds without waking the model.
import { defineExtension, type ToolRegistration } from "@earendil-works/pi-durable";
import type { HomelabConfig } from "../../config.ts";
import { containerLogsTool, type RunRemote, sshRunner } from "./logs.ts";
import { type FetchJson, fetchJson, homelabGate, homelabStatusTool } from "./status.ts";

export type HomelabOptions = {
	/** How homelab_status fetches its feeds; tests replace it. */
	fetch?: FetchJson;
	/** How container_logs reaches the hosts; tests replace it. Defaults to ssh with the keys directory's docker-logs key. */
	logs?: RunRemote;
};

export function createHomelab(config: HomelabConfig, owner: string, keysDir: string, options: HomelabOptions = {}) {
	const tools: ToolRegistration[] = [homelabStatusTool(config, owner, options.fetch ?? fetchJson)];
	const hosts = Object.keys(config.logHosts);
	const run = options.logs ?? sshRunner(keysDir, config.logHosts);
	// Without hosts or a key there's no container_logs.
	if (hosts.length > 0 && run !== undefined) tools.push(containerLogsTool(hosts, run, owner));
	return { extension: defineExtension({ name: "homelab", tools }), gate: homelabGate(config, options.fetch ?? fetchJson) };
}
