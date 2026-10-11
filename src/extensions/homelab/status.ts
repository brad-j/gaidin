// Read-only homelab status from the feeds behind a homelab dashboard: an Uptime Kuma public status
// page, and JSON snapshots of Beszel host metrics, Docker containers and Proxmox backups. None of them
// needs a key. The checks and thresholds follow the original deployment's dashboard (its homelab repo's
// src/attention.ts), without its coverage checks, which need that repo's inventory.
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import type { HomelabConfig } from "../../config.ts";
import type { Gate } from "../../jobs.ts";

export const DISK_WARNING = 85;
export const DISK_CRITICAL = 95;
export const MEMORY_WARNING = 90;
export const TEMPERATURE_WARNING = 80;
/** The nightly job runs at 02:30, so a healthy guest's newest backup is under 24 hours old. */
export const BACKUP_WARNING_HOURS = 26;
export const BACKUP_CRITICAL_HOURS = 50;
export const BACKUP_STORAGE_WARNING = 85;
const DOCKER_STALE_AFTER_MS = 90_000;
const BESZEL_STALE_AFTER_MS = 180_000;
const BACKUP_STALE_AFTER_MS = 45 * 60_000;

export type Severity = "critical" | "warning" | "notice";
/** `topic` names what the item is about without numbers that drift, such as a disk's percentage, so a gate can tell a new problem from the same one. */
export type Item = { severity: Severity; title: string; detail: string; topic: string };

type KumaMonitor = { name: string; status: string; message: string; uptime24: number | null };
type BeszelSystem = { name: string; status: string; updatedAt: string; cpu: number | null; memory: number | null; disk: number | null; temperature: number | null };
type Container = { name: string; state: string; health: string; status: string; image: string };
type DockerHost = { name: string; status: string; error: string | null; containers: Container[] };
type BackupGuest = { vmid: number; name: string | null; latestAt: string | null };
type BackupJob = { id: string; enabled: boolean; storage: string | null; guests: BackupGuest[]; storageStatus: { active: boolean; totalBytes: number | null; usedBytes: number | null } };
type Backups = { generatedAt: string; node: string; jobs: BackupJob[]; runs: { endedAt: string | null; status: string | null }[] };

export type Feeds = {
	kuma: KumaMonitor[];
	beszel: { generatedAt: string; systems: BeszelSystem[] };
	docker: { generatedAt: string; hosts: DockerHost[] };
	backups: Backups;
};
type Settled<T> = { data?: T; error?: string };
export type FetchedFeeds = { [K in keyof Feeds]: Settled<Feeds[K]> };

export type FetchJson = (url: string) => Promise<unknown>;

export const fetchJson: FetchJson = async (url) => {
	const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
	if (!response.ok) throw new Error(`${response.status} from ${url}`);
	return response.json();
};

const MONITOR_STATES = new Map([[0, "down"], [1, "up"], [2, "pending"], [3, "maintenance"]]);

/** Fetches every feed at once; one failing doesn't stop the others. */
export async function fetchFeeds(sources: Pick<HomelabConfig, "feeds" | "kuma">, get: FetchJson = fetchJson): Promise<FetchedFeeds> {
	const settle = async <T>(load: () => Promise<T>): Promise<Settled<T>> => {
		try {
			return { data: await load() };
		} catch (error) {
			return { error: error instanceof Error ? error.message : String(error) };
		}
	};
	const snapshot = async <T>(name: string, check: (value: any) => boolean): Promise<T> => {
		const value = (await get(`${sources.feeds}/${name}.json`)) as any;
		if (value?.schemaVersion !== 1 || typeof value.generatedAt !== "string" || !check(value)) {
			throw new Error(`${name}.json used an unsupported schema`);
		}
		return value as T;
	};
	const [kuma, beszel, docker, backups] = await Promise.all([
		settle(async () => {
			const [page, heartbeat] = (await Promise.all([
				get(`${sources.kuma.url}/api/status-page/${encodeURIComponent(sources.kuma.page)}`),
				get(`${sources.kuma.url}/api/status-page/heartbeat/${encodeURIComponent(sources.kuma.page)}`),
			])) as [any, any];
			if (!Array.isArray(page?.publicGroupList) || !heartbeat?.heartbeatList) throw new Error("Uptime Kuma answered in an unexpected shape");
			return page.publicGroupList.flatMap((group: any) => group.monitorList).map((monitor: any): KumaMonitor => {
				const latest = (heartbeat.heartbeatList[String(monitor.id)] ?? []).at(-1);
				const uptime = heartbeat.uptimeList?.[`${monitor.id}_24`];
				return {
					name: monitor.name,
					status: latest === undefined ? "unknown" : (MONITOR_STATES.get(latest.status) ?? "unknown"),
					message: latest?.msg ?? "",
					uptime24: typeof uptime === "number" ? uptime : null,
				};
			});
		}),
		settle(() => snapshot<Feeds["beszel"]>("beszel", (v) => Array.isArray(v.systems))),
		settle(() => snapshot<Feeds["docker"]>("docker", (v) => Array.isArray(v.hosts))),
		settle(() => snapshot<Feeds["backups"]>("backups", (v) => Array.isArray(v.jobs) && Array.isArray(v.runs))),
	]);
	return { kuma, beszel, docker, backups };
}

const ORDER = { critical: 0, warning: 1, notice: 2 } satisfies Record<Severity, number>;

function stale(generatedAt: string | undefined, maxAgeMs: number, now: number): boolean {
	const time = generatedAt === undefined ? NaN : Date.parse(generatedAt);
	return Number.isFinite(time) && now - time > maxAgeMs;
}

/** Everything that needs attention, most severe first. */
export function collectAttention(feeds: FetchedFeeds, now = Date.now()): Item[] {
	const items: Item[] = [];
	const add = (severity: Severity, title: string, detail: string, topic = title) => items.push({ severity, title, detail, topic });
	const { kuma, beszel, docker, backups } = feeds;

	if (kuma.error) add("warning", "Uptime Kuma feed unavailable", kuma.error);
	for (const monitor of kuma.data ?? []) {
		if (monitor.status === "up") continue;
		add(monitor.status === "down" ? "critical" : "warning", `${monitor.name} is ${monitor.status}`, monitor.message || "No message from Kuma.");
	}

	if (docker.error) add("warning", "Docker snapshot unavailable", docker.error);
	else if (stale(docker.data?.generatedAt, DOCKER_STALE_AFTER_MS, now)) add("warning", "Docker snapshot is stale", "Check homelab-docker-snapshot.timer on infra-01.");
	for (const host of docker.data?.hosts ?? []) {
		if (host.status !== "up") add("critical", `Docker on ${host.name} unreachable`, host.error ?? "The collector could not reach this host.");
		for (const c of host.containers) {
			if (c.state === "running" && c.health !== "unhealthy") continue;
			const unhealthy = c.health === "unhealthy";
			add(unhealthy ? "critical" : "warning", `${c.name} on ${host.name} is ${unhealthy ? "unhealthy" : c.state}`, c.status || c.image);
		}
	}

	if (beszel.error) add("warning", "Beszel snapshot unavailable", beszel.error);
	else if (stale(beszel.data?.generatedAt, BESZEL_STALE_AFTER_MS, now)) add("warning", "Beszel snapshot is stale", "Check homelab-beszel-snapshot.timer on infra-01.");
	for (const s of beszel.data?.systems ?? []) {
		if (s.status !== "up") {
			add("critical", `${s.name} is ${s.status} in Beszel`, `Last sample ${s.updatedAt}.`);
			continue;
		}
		if (s.disk !== null && s.disk >= DISK_WARNING) {
			add(s.disk >= DISK_CRITICAL ? "critical" : "warning", `${s.name} disk ${Math.round(s.disk)}% full`, `Warning at ${DISK_WARNING}%, critical at ${DISK_CRITICAL}%.`, `${s.name} disk`);
		}
		if (s.memory !== null && s.memory >= MEMORY_WARNING) add("warning", `${s.name} memory at ${Math.round(s.memory)}%`, `Warning at ${MEMORY_WARNING}%.`, `${s.name} memory`);
		if (s.temperature !== null && s.temperature >= TEMPERATURE_WARNING) add("warning", `${s.name} at ${Math.round(s.temperature)}°C`, `Warning at ${TEMPERATURE_WARNING}°C.`, `${s.name} temperature`);
	}

	if (backups.error) add("warning", "Backup snapshot unavailable", backups.error);
	else if (stale(backups.data?.generatedAt, BACKUP_STALE_AFTER_MS, now)) add("warning", "Backup snapshot is stale", "Check homelab-backup-snapshot.timer on infra-01.");
	if (backups.data) {
		const { node, jobs, runs } = backups.data;
		const run = runs.find((r) => r.endedAt);
		if (run && run.status !== "OK") add("critical", `Last backup run on ${node} failed`, `Proxmox status: ${run.status ?? "unknown"}.`);
		for (const job of jobs) {
			if (!job.enabled) add("warning", `Backup job ${job.id} is disabled`, `On ${node}.`);
			const storage = job.storageStatus;
			if (!storage.active) add("critical", `Backup storage ${job.storage} is offline`, `${node} can't reach it.`);
			else if (storage.totalBytes && storage.usedBytes !== null) {
				const used = (storage.usedBytes / storage.totalBytes) * 100;
				if (used >= BACKUP_STORAGE_WARNING) add("warning", `Backup storage ${job.storage} ${Math.round(used)}% full`, `Warning at ${BACKUP_STORAGE_WARNING}%.`, `Backup storage ${job.storage} full`);
			}
			for (const guest of job.guests) {
				const name = guest.name ?? `VM ${guest.vmid}`;
				if (!guest.latestAt) {
					add("critical", `No backup of ${name}`, `${job.id} includes VM ${guest.vmid} but ${job.storage} holds no archive for it.`);
					continue;
				}
				const hours = (now - Date.parse(guest.latestAt)) / 3_600_000;
				if (hours >= BACKUP_WARNING_HOURS) {
					add(hours >= BACKUP_CRITICAL_HOURS ? "critical" : "warning", `${name} last backed up ${Math.floor(hours)} hours ago`, `Warning after ${BACKUP_WARNING_HOURS} hours, critical after ${BACKUP_CRITICAL_HOURS}.`, `${name} backup age`);
				}
			}
		}
	}

	return items.sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
}

const pct = (value: number | null) => (value === null ? "?" : `${Math.round(value)}%`);

/** What the tool returns: the problems, then a short line per source, and with `details` the full lists. */
export function report(feeds: FetchedFeeds, details: boolean, now = Date.now()): string {
	const items = collectAttention(feeds, now);
	const lines = items.length === 0
		? ["Nothing needs attention."]
		: items.map((item) => `${item.severity.toUpperCase()}: ${item.title}. ${item.detail}`);

	const { kuma, beszel, docker, backups } = feeds;
	lines.push("");
	if (kuma.data) lines.push(`Kuma: ${kuma.data.filter((m) => m.status === "up").length} of ${kuma.data.length} monitors up.`);
	if (beszel.data) lines.push(`Beszel: ${beszel.data.systems.filter((s) => s.status === "up").length} of ${beszel.data.systems.length} systems up.`);
	if (docker.data) {
		const containers = docker.data.hosts.flatMap((h) => h.containers);
		lines.push(`Docker: ${containers.filter((c) => c.state === "running").length} of ${containers.length} containers running on ${docker.data.hosts.length} hosts.`);
	}
	if (backups.data) {
		const guests = backups.data.jobs.flatMap((j) => j.guests);
		const run = backups.data.runs.find((r) => r.endedAt);
		lines.push(`Backups: ${guests.length} guests in ${backups.data.jobs.length} job(s); last run ${run?.endedAt ?? "none"} ${run?.status ?? ""}`.trimEnd() + ".");
	}

	if (details) {
		if (kuma.data) {
			lines.push("", "Kuma monitors (24h uptime):");
			for (const m of kuma.data) lines.push(`- ${m.name}: ${m.status}${m.uptime24 === null ? "" : `, ${(m.uptime24 * 100).toFixed(2)}%`}`);
		}
		if (beszel.data) {
			lines.push("", "Hosts (CPU, memory, disk, temperature):");
			for (const s of beszel.data.systems) {
				lines.push(`- ${s.name}: ${s.status}, ${pct(s.cpu)}, ${pct(s.memory)}, ${pct(s.disk)}${s.temperature === null ? "" : `, ${Math.round(s.temperature)}°C`}`);
			}
		}
		if (docker.data) {
			lines.push("", "Containers:");
			for (const h of docker.data.hosts) {
				lines.push(`- ${h.name} (${h.status}): ${h.containers.map((c) => `${c.name} ${c.state}${c.health === "none" ? "" : `/${c.health}`}`).join(", ") || "none"}`);
			}
		}
		if (backups.data) {
			lines.push("", "Newest backup per guest:");
			for (const g of backups.data.jobs.flatMap((j) => j.guests)) lines.push(`- ${g.name ?? `VM ${g.vmid}`}: ${g.latestAt ?? "none"}`);
		}
	}
	return lines.join("\n");
}

export function homelabStatusTool(config: HomelabConfig, owner: string, get: FetchJson = fetchJson) {
	return defineTool({
		name: "homelab_status",
		description:
			`Check ${owner}'s homelab: Uptime Kuma monitors, host metrics from Beszel, Docker containers and Proxmox backups. ` +
			"Read-only. Lists what needs attention first, with the dashboard's thresholds. Set `details` for every monitor, " +
			"host, container and backup.",
		parameters: Type.Object({ details: Type.Optional(Type.Boolean()) }),
		replay: "safe",
		execute: async (args) => {
			const text = report(await fetchFeeds(config, get), args.details === true);
			return { content: [{ type: "text", text: config.dashboard === undefined ? text : `${text}\n\nDashboard: ${config.dashboard}` }] };
		},
	});
}

/**
 * The homelab gate for scheduled jobs (jobs.ts): wakes a run when something needs attention, with the items as what
 * it found. With `severity: "critical"`, only critical items count.
 */
export function homelabGate(config: HomelabConfig, get: FetchJson = fetchJson): Gate {
	return {
		name: "homelab",
		description: 'wakes the run when homelab_status finds something that needs attention; args { severity: "critical" } counts only critical items',
		check: async (args) => {
			const items = collectAttention(await fetchFeeds(config, get)).filter((i) => args.severity !== "critical" || i.severity === "critical");
			if (items.length === 0) return { wake: false };
			return {
				wake: true,
				data: items.map((i) => `${i.severity.toUpperCase()}: ${i.title}. ${i.detail}`).join("\n"),
				topic: items.map((i) => `${i.severity} ${i.topic}`).sort().join("\n"),
			};
		},
	};
}
