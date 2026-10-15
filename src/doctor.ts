// `gaidin doctor`: checks the settings and everything the server depends on, without starting it and
// without spending tokens. Only `--push` sends anything a person would see (one ntfy notification).
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config, Loaded } from "./config.ts";
import { fetchFeeds } from "./extensions/homelab/status.ts";
import { sshRunner } from "./extensions/homelab/logs.ts";
import { bwrapArgs, findBwrap, prepareServerDirs } from "./sandbox.ts";
import { tavilyUsage } from "./search.ts";
import { isListening, socketPathFor } from "./server.ts";
import { answer, readAnswer, readWorkspaces, sshRemote } from "./workspaces.ts";

export type Check = { status: "ok" | "warn" | "fail" | "skip"; area: string; detail: string };

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

async function json(url: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
	const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
	const text = await response.text();
	let body: unknown = text;
	try {
		body = JSON.parse(text);
	} catch {}
	return { status: response.status, body };
}

/** Each check resolves to one or more lines; none of them throws. */
export async function runChecks(loaded: Loaded, options: { push?: boolean } = {}): Promise<Check[]> {
	const { config } = loaded;
	const groups: Promise<Check[]>[] = [
		settings(loaded),
		node(),
		data(config),
		sandbox(config),
		model(config),
		ntfy(config, options.push === true),
		push(config),
		alerts(config),
		slack(config),
		web(config),
		search(config),
		workspaces(config),
		homelab(config),
	];
	return (await Promise.all(groups.map((group) => group.catch((error): Check[] => [{ status: "fail", area: "doctor", detail: message(error) }])))).flat();
}

async function settings({ config, errors, warnings }: Loaded): Promise<Check[]> {
	const source = config.file === undefined ? "no settings file; defaults and the environment" : config.file;
	return [
		{ status: errors.length === 0 ? "ok" : "fail", area: "settings", detail: source },
		...errors.map((detail): Check => ({ status: "fail", area: "settings", detail })),
		...warnings.map((detail): Check => ({ status: "warn", area: "settings", detail })),
	];
}

async function node(): Promise<Check[]> {
	const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
	const ok = major > 22 || (major === 22 && minor >= 18);
	return [{ status: ok ? "ok" : "fail", area: "node", detail: ok ? `Node ${process.versions.node}` : `Node ${process.versions.node}; gaidin needs 22.18 or later` }];
}

async function data(config: Config): Promise<Check[]> {
	try {
		mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
		accessSync(config.dataDir, constants.W_OK);
	} catch (error) {
		return [{ status: "fail", area: "data", detail: `${config.dataDir} isn't writable: ${message(error)}` }];
	}
	const running = await isListening(socketPathFor(config));
	return [
		{ status: "ok", area: "data", detail: config.dataDir },
		{ status: running ? "ok" : "warn", area: "server", detail: running ? "running" : "not running" },
	];
}

async function sandbox(config: Config): Promise<Check[]> {
	if (config.sandbox === "none") return [{ status: "warn", area: "sandbox", detail: "off: tools run unconfined" }];
	const bwrap = findBwrap();
	if (bwrap === undefined) return [{ status: "fail", area: "sandbox", detail: "bwrap isn't on PATH; install bubblewrap" }];
	// A real sandboxed command, which also proves user namespaces work here (AppArmor on Ubuntu).
	const dir = mkdtempSync(join(tmpdir(), "gaidin-doctor-"));
	try {
		await prepareServerDirs(dir);
		const result = spawnSync(bwrap, [...(await bwrapArgs(dir, dir)), "--", "true"], { encoding: "utf8", timeout: 10_000 });
		if (result.status === 0) return [{ status: "ok", area: "sandbox", detail: `bubblewrap works (${bwrap})` }];
		const why = (result.stderr || result.error?.message || `exit ${result.status}`).trim();
		return [{ status: "fail", area: "sandbox", detail: `bubblewrap can't start a sandbox: ${why}. On Ubuntu, install deploy/vm/bwrap.apparmor` }];
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

async function model(config: Config): Promise<Check[]> {
	if (config.model.provider === "faux") return [{ status: "warn", area: "model", detail: "the faux model: scripted answers, no network" }];
	if (config.model.apiKey === undefined) return [{ status: "fail", area: "model", detail: "no API key" }];
	// Looking the model up checks the key and the model id, and costs nothing.
	const { status, body } = await json(`https://api.anthropic.com/v1/models/${encodeURIComponent(config.model.id)}`, {
		headers: { "x-api-key": config.model.apiKey, "anthropic-version": "2023-06-01" },
	});
	if (status === 200) return [{ status: "ok", area: "model", detail: `${config.model.id}, key accepted` }];
	if (status === 401 || status === 403) return [{ status: "fail", area: "model", detail: `Anthropic refused the API key (${status})` }];
	if (status === 404) return [{ status: "fail", area: "model", detail: `the key works, but there's no model ${config.model.id}` }];
	return [{ status: "fail", area: "model", detail: `Anthropic answered ${status}: ${JSON.stringify(body).slice(0, 200)}` }];
}

async function ntfy(config: Config, push: boolean): Promise<Check[]> {
	if (config.ntfy === undefined) return [{ status: "skip", area: "ntfy", detail: "not set up; notifications go only to devices signed up in the web view" }];
	const headers = config.ntfy.token === undefined ? undefined : { Authorization: `Bearer ${config.ntfy.token}` };
	if (push) {
		const pushHeaders = new Headers(headers);
		pushHeaders.set("Title", "gaidin");
		if (config.ntfy.icon) pushHeaders.set("Icon", config.ntfy.icon);
		const response = await fetch(config.ntfy.url, { method: "POST", body: "gaidin doctor: test push", headers: pushHeaders, signal: AbortSignal.timeout(10_000) });
		return [{ status: response.ok ? "ok" : "fail", area: "ntfy", detail: response.ok ? "test push sent; check your phone" : `the push failed (${response.status})` }];
	}
	// Reads the topic's recent messages, which sends nothing.
	const { status } = await json(`${config.ntfy.url}/json?poll=1&since=1m`, headers === undefined ? {} : { headers });
	return [{ status: status === 200 ? "ok" : "fail", area: "ntfy", detail: status === 200 ? "topic reachable (gaidin doctor --push sends a test)" : `the topic answered ${status}` }];
}

/** Web Push sends to the push services of Apple and Google (and others), so the server has to reach them. */
async function push(config: Config): Promise<Check[]> {
	if (config.web?.url === undefined) return [{ status: "skip", area: "push", detail: "not set up; notifications from the web view need web.url" }];
	const services = ["web.push.apple.com", "fcm.googleapis.com"];
	const unreachable = (
		await Promise.all(services.map(async (host) => (await fetch(`https://${host}/`, { signal: AbortSignal.timeout(10_000) }).then(() => true, () => false)) ? [] : [host]))
	).flat();
	if (unreachable.length > 0) return [{ status: "fail", area: "push", detail: `can't reach ${unreachable.join(" or ")}, so notifications to those devices won't arrive` }];
	return [{ status: "ok", area: "push", detail: "push services reachable; sign devices up with /notifications in the web view" }];
}

async function alerts(config: Config): Promise<Check[]> {
	if (config.alerts === undefined) return [{ status: "skip", area: "alerts", detail: "not set up; gaidin doesn't follow an alert topic" }];
	const headers = config.alerts.token === undefined ? {} : { headers: { Authorization: `Bearer ${config.alerts.token}` } };
	const { status } = await json(`${config.alerts.url}/json?poll=1&since=1m`, headers);
	return [{ status: status === 200 ? "ok" : "fail", area: "alerts", detail: status === 200 ? "alert topic reachable" : `the alert topic answered ${status}` }];
}

async function slack(config: Config): Promise<Check[]> {
	if (config.slack === undefined) return [{ status: "skip", area: "slack", detail: "not set up" }];
	const call = (method: string, token: string) => json(`https://slack.com/api/${method}`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
	const [auth, connection] = await Promise.all([call("auth.test", config.slack.botToken), call("apps.connections.open", config.slack.appToken)]);
	return [
		auth.body?.ok
			? { status: "ok", area: "slack", detail: `bot token works: ${auth.body.user} in ${auth.body.team}` }
			: { status: "fail", area: "slack", detail: `bot token refused: ${auth.body?.error ?? auth.status}` },
		connection.body?.ok
			? { status: "ok", area: "slack", detail: "app token can open Socket Mode" }
			: { status: "fail", area: "slack", detail: `app token refused: ${connection.body?.error ?? connection.status}${connection.body?.error === "missing_scope" ? " (it needs connections:write)" : ""}` },
	];
}

async function web(config: Config): Promise<Check[]> {
	if (config.web === undefined) return [{ status: "skip", area: "web", detail: "not set up" }];
	const checks: Check[] = [];
	const result = spawnSync("tailscale", ["serve", "status", "--json"], { encoding: "utf8", timeout: 10_000 });
	if (result.error !== undefined) checks.push({ status: "warn", area: "web", detail: `tailscale isn't installed; the web view on 127.0.0.1:${config.web.port} has no way in` });
	else {
		const served = result.stdout.includes(`127.0.0.1:${config.web.port}`);
		checks.push({
			status: served ? "ok" : "warn",
			area: "web",
			detail: served ? `tailscale serve proxies to 127.0.0.1:${config.web.port}, for ${config.web.user}` : `tailscale serve isn't proxying to port ${config.web.port}; run: sudo tailscale serve --bg --yes ${config.web.port}`,
		});
	}
	if (config.web.app !== undefined) {
		const built = existsSync(join(config.web.app, "_shell.html"));
		checks.push({ status: built ? "ok" : "fail", area: "web", detail: built ? `the app is in ${config.web.app}` : `web.app is ${config.web.app}, which has no _shell.html; deploy moiraine's build there` });
	}
	return checks;
}

async function search(config: Config): Promise<Check[]> {
	if (config.search === undefined) return [{ status: "skip", area: "search", detail: "not set up; no web_search" }];
	try {
		const { used, limit } = await tavilyUsage(config.search.apiKey);
		const nearly = limit !== null && used >= limit * 0.9;
		return [{ status: nearly ? "warn" : "ok", area: "search", detail: `Tavily key works; ${used}${limit === null ? "" : ` of ${limit}`} credits used this cycle` }];
	} catch (error) {
		return [{ status: "fail", area: "search", detail: message(error) }];
	}
}

async function workspaces(config: Config): Promise<Check[]> {
	let list;
	try {
		list = readWorkspaces(config.keysDir);
	} catch (error) {
		return [{ status: "fail", area: "workspaces", detail: message(error) }];
	}
	if (list.length === 0) return [{ status: "skip", area: "workspaces", detail: "none listed" }];
	const remote = sshRemote(config.keysDir);
	if (remote === undefined) return [{ status: "fail", area: "workspaces", detail: `${list.length} listed, but there's no key at ${join(config.keysDir, "workspace")}` }];
	return Promise.all(list.map(async (workspace): Promise<Check> => {
		try {
			const { output } = await remote(workspace, "read", { path: "." }, { signal: AbortSignal.timeout(15_000) });
			return { status: "ok", area: "workspaces", detail: `${workspace.name}: ${answer(output, readAnswer).path}` };
		} catch (error) {
			return { status: "fail", area: "workspaces", detail: `${workspace.name}: ${message(error)}` };
		}
	}));
}

async function homelab(config: Config): Promise<Check[]> {
	if (config.homelab === undefined) return [{ status: "skip", area: "homelab", detail: "extension off" }];
	const feeds = await fetchFeeds(config.homelab);
	const checks: Check[] = Object.entries(feeds).map(([name, feed]) =>
		feed.error === undefined ? { status: "ok", area: "homelab", detail: `${name} feed` } : { status: "fail", area: "homelab", detail: `${name} feed: ${feed.error}` });
	const hosts = Object.keys(config.homelab.logHosts);
	if (hosts.length === 0) return checks;
	const run = sshRunner(config.keysDir, config.homelab.logHosts);
	if (run === undefined) return [...checks, { status: "warn", area: "homelab", detail: `no docker-logs key in ${config.keysDir}, so no container_logs` }];
	for (const host of hosts) {
		try {
			const count = (await run(host, "list")).split("\n").filter((line) => line.trim() !== "").length;
			checks.push({ status: "ok", area: "homelab", detail: `logs on ${host}: ${count} containers` });
		} catch (error) {
			checks.push({ status: "fail", area: "homelab", detail: `logs on ${host}: ${message(error)}` });
		}
	}
	return checks;
}

export function printChecks(checks: Check[]): number {
	const width = Math.max(...checks.map((c) => c.area.length));
	for (const check of checks) console.log(`${check.status.padEnd(4)}  ${check.area.padEnd(width)}  ${check.detail}`);
	const failed = checks.filter((c) => c.status === "fail").length;
	console.log(failed === 0 ? "\nNo problems found." : `\n${failed} problem${failed === 1 ? "" : "s"} found.`);
	return failed === 0 ? 0 : 1;
}
