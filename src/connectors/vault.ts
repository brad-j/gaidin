// Where connectors' tokens are kept: one JSON file, <data>/connectors/vault.json, mode 600 in a directory only the server
// can enter, outside every sandbox and outside gaidin.sqlite, so no document, transcript or answer of the API can
// carry one. Each held token is redacted from tool output (redact.ts) under the connector's name. The VM's backups
// hold the file, as they hold the browser's cookies.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GrowingRedactor } from "../redact.ts";
import { dictionary, object, optional, parseJson, string } from "../parse.ts";

/** What's kept for a connector: a bearer token the owner pasted, or OAuth's (step 2). */
export type Held = { token?: string };

const file = dictionary(object({ token: optional(string) }));

export function createVault(dir: string, redactor?: GrowingRedactor) {
	const path = join(dir, "vault.json");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
	const held = new Map<string, Held>(existsSync(path) ? parseJson(readFileSync(path, "utf8"), file, path) : []);
	const name = (connector: string) => `CONNECTOR_${connector.toUpperCase().replace(/-/g, "_")}_TOKEN`;
	for (const [connector, value] of held) redactor?.set(name(connector), value.token);

	function save() {
		const temporary = `${path}.${process.pid}`;
		writeFileSync(temporary, `${JSON.stringify(Object.fromEntries(held), null, 2)}\n`, { mode: 0o600 });
		renameSync(temporary, path);
	}

	return {
		get: (connector: string): Held | undefined => held.get(connector),
		set(connector: string, value: Held) {
			held.set(connector, value);
			save();
			redactor?.set(name(connector), value.token);
		},
		remove(connector: string) {
			if (!held.delete(connector)) return;
			save();
			redactor?.set(name(connector), undefined);
		},
	};
}

export type Vault = ReturnType<typeof createVault>;
