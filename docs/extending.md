# Extending

## How the code is laid out

`src/host.ts` opens the Harness and installs every extension into one registry. Each extension is a named bundle of tools, prompt sections and hooks:

| File | Extension |
|---|---|
| `host.ts` | the persona prompt |
| Pi Durable's `CodingTools` | `read`, `write`, `edit`, `bash` |
| `reminders.ts` | reminders and their background task |
| `fetch.ts` | `fetch_url` |
| `workspaces.ts` | the workspace tools |
| `homelab.ts`, `logs.ts` | the homelab extension |
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
- A tool that needs a secret reads it from the environment; add the variable to `SECRET_NAMES` in `redact.ts`.

Durable state goes in a document (`defineDoc`) changed inside `api.commit`, and timed work goes in a task (`defineTask`), as `reminders.ts` does. Both survive restarts.

### Tools that reach outside

A tool that changes anything outside the sandbox, or sends data to a place the owner hasn't approved, should ask first. Add a case to `defaultPolicy` in `approvals.ts` that returns a one-line `summary` of the call, and optionally an `always` grant for the second button. Slack and the web view render any request; their labels come from the request.

## Tests

The tests use Pi Durable's faux provider, which plays back scripted model responses, so they run without a key or network:

```ts
const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
faux.setResponses([
	fauxAssistantMessage(fauxToolCall("weather", { city: "Boston" }), { stopReason: "toolUse" }),
	fauxAssistantMessage(fauxText("Sunny.")),
]);
```

`openHost` takes options that replace each outside dependency: the notifier, the homelab feeds, `fetch_url`'s resolver, the container logs runner, the workspace list and remote, and the approval timeout. `test/` has an example for each.

## Parts written for one deployment

gaidin is generic apart from these, which were written for its first owner and would move into a separate, optional extension pack before a release:

- The persona prompt and several tool descriptions name the owner ("Brad").
- `homelab.ts` defaults to that homelab's feed URLs and links its dashboard. Its thresholds copy the dashboard's own and have to be kept in step with it.
- `logs.ts` names two Docker hosts and their addresses. The script it calls on them, and its installer, live in the homelab's own repository.
- `deploy/vm/setup.sh` clones a specific repository.
- `deploy/gaidin.service` points at a specific Node install.
- The web view offers a fixed list of Anthropic models.

The plan for a release is a core package (the conversation, surfaces, sandbox, redaction, approvals, reminders, `fetch_url`, workspaces) with the owner's name as a setting, and the homelab tools as an example extension configured by a file instead of constants.
