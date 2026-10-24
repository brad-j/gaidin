import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { ntfyNotifier, ntfyReporter } from "../src/ntfy.ts";
import type { Reminder } from "../src/reminders.ts";

test("reminders and job reports carry the icon when one is set", async (t) => {
	const seen: IncomingHttpHeaders[] = [];
	const server = createServer((request, response) => {
		seen.push(request.headers);
		request.resume().on("end", () => response.end("{}"));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => server.close());
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/gaidin-topic`;
	const icon = "https://gaidin.example.ts.net/icon-192.png";
	const reminder = (text: string): Reminder => ({ taskId: 1, text, at: Date.now() });

	await ntfyNotifier({ url, icon })(reminder("check the oven"));
	await ntfyReporter({ url, icon })({ title: "briefing", text: "all quiet" });
	await ntfyNotifier({ url })(reminder("no icon"));
	assert.deepEqual(seen.map((headers) => headers.icon), [icon, icon, undefined]);
});

test("with the API's address, a reminder has two snooze buttons and opens nothing when tapped", async (t) => {
	const seen: IncomingHttpHeaders[] = [];
	const server = createServer((request, response) => {
		seen.push(request.headers);
		request.resume().on("end", () => response.end("{}"));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => server.close());
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/gaidin-topic`;
	const web = "https://gaidin.example.ts.net";

	await ntfyNotifier({ url }, web)({ taskId: 7, text: "check the oven", at: Date.now() });
	assert.equal(seen[0]!.click, undefined);
	assert.equal(
		seen[0]!.actions,
		`http, Snooze 10 min, ${web}/api/reminders/snooze, headers.Content-Type=application/json, body='{"id":7,"minutes":10}', clear=true; ` +
			`http, Snooze 1 h, ${web}/api/reminders/snooze, headers.Content-Type=application/json, body='{"id":7,"minutes":60}', clear=true`,
	);
});
