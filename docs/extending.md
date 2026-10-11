# Extending

## How the code is laid out

`src/main.ts` is the `gaidin` command, `src/config.ts` reads and checks the settings, and `src/doctor.ts` is `gaidin doctor`. `src/host.ts` opens the Harness and installs every extension into one registry. Each extension is a named bundle of tools, prompt sections and hooks:

| File | Extension |
|---|---|
| `host.ts` | the persona prompt |
| Pi Durable's `CodingTools` | `read`, `write`, `edit`, `bash` |
| `reminders.ts` | reminders and their background task |
| `fetch.ts` | `fetch_url` |
| `workspaces.ts` | the workspace tools |
| `history.ts` | `search_history` and `read_history`, over its own index of past messages |
| `self/` | `load_extension`, `remove_extension`, and one extension `self-<name>` per tool set gaidin wrote |
| `extensions/homelab/` | the homelab extension, when configured |
| `approvals.ts` | the approval hook |
| `redact.ts` | the redaction hook, installed last so it sees every result |

The surfaces are separate: `server.ts` wires the socket, Slack (`slack.ts`, `slack-approvals.ts`) and the web view (`web.ts`, `web/`). `sandbox.ts` is the tools' execution environment.

## Adding a tool

Define it with `defineTool` and install it in an extension in `host.ts`:

```ts
const weather = defineTool({
	name: "weather",
	description: "Today's forecast for a city.",
	parameters: Type.Object({ city: Type.String() }),
	replay: "safe",
	execute: async (args) => ({ content: [{ type: "text", text: await forecast(args.city) }] }),
});
registry.install(defineExtension({ name: "weather", tools: [weather] }));
```

- Mark it `replay: "safe"` only if running it again after a crash is harmless. A tool that isn't replay-safe is not rerun after a crash, and the model is told it may have partly run.
- Its result passes through redaction automatically.
- A tool that runs commands should use the environment it's given (`api.env`), which is the sandbox, so it can't reach anything the sandbox hides.
- If it reads text from outside, say so in the result, as `fetch_url` and `container_logs` do.
- To make it switchable in the web view, add it to `switchable` in `host.ts`.
- A tool that needs a secret takes it from the settings: add it to `Config` and `loadConfig` in `config.ts` and to `secretsOf`, so it's redacted, and add its environment variable to `SECRET_NAMES` in `redact.ts`.
- A tool's description should name the owner with `config.owner`, not a fixed name.

Durable state goes in a document (`defineDoc`) changed inside `api.commit`, and timed work goes in a task (`defineTask`), as `reminders.ts` does. Both survive restarts.

### Tools that reach outside

A tool that changes anything outside the sandbox, or sends data to a place the owner hasn't approved, should ask first. Add a case to `defaultPolicy` in `approvals.ts` that returns a one-line `summary` of the call, and optionally an `always` grant for the second button. Slack and the web view render any request; their labels come from the request. If some calls can't succeed for reasons known before they run, such as a name that doesn't exist, add a `Refusal` to the list `host.ts` passes to `approvalExtension`, so they're blocked with the reason instead of being put to the owner.

## Tests

The tests use Pi Durable's faux provider, which plays back scripted model responses, so they run without a key or network:

```ts
const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
faux.setResponses([
	fauxAssistantMessage(fauxToolCall("weather", { city: "Boston" }), { stopReason: "toolUse" }),
	fauxAssistantMessage(fauxText("Sunny.")),
]);
```

`openHost` takes the settings (`configFor({...})` builds them in a test) and options that replace each outside dependency: the notifier, the homelab feeds and log runner, `fetch_url`'s resolver, the workspace list and remote, and the approval timeout. `test/` has an example for each.

## The homelab extension

`src/extensions/homelab/` holds `homelab_status` and `container_logs`, written for gaidin's first deployment. It's off unless the settings have `extensions.homelab`:

```json
"extensions": {
  "homelab": {
    "feeds": "http://192.0.2.10:8080/data",
    "kuma": { "url": "https://status.example.com", "page": "homelab" },
    "dashboard": "https://dashboard.example.com",
    "logHosts": { "apps": "192.0.2.11" }
  }
}
```

`feeds` is the base URL of `beszel.json`, `docker.json` and `backups.json` snapshots in the format that deployment's dashboard collectors write, and `kuma` names an Uptime Kuma public status page. `container_logs` exists only with `logHosts` and the `docker-logs` key in the keys directory; each host needs the restricted account and script described in [Security](security.md#container-logs). The thresholds copy that dashboard's own. It's the model for an extension: tools in their own directory, configured by a section of the settings, installed in `host.ts` only when that section is there.

## Still specific to one deployment

- `deploy/vm/setup.sh` clones the original repository.
- The scripts that set up the container logs account live in that deployment's homelab repository.
- The homelab snapshot formats are those of that deployment's dashboard collectors.
