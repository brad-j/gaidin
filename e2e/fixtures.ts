import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { test as base } from "@playwright/test";

export { expect } from "@playwright/test";

export const USER = "brad@example.com";

/** Starts e2e/server.ts and resolves with its address once it prints its port. */
async function start(): Promise<{ child: ChildProcess; base: string }> {
	const child = spawn(process.execPath, ["--no-warnings", "e2e/server.ts", USER], { stdio: ["ignore", "pipe", "inherit"] });
	const lines = createInterface({ input: child.stdout! });
	const port = await new Promise<string>((resolve, reject) => {
		child.once("exit", (code) => reject(new Error(`e2e/server.ts exited with ${code}`)));
		lines.on("line", (line) => {
			const match = /^port (\d+)$/.exec(line);
			if (match !== null) resolve(match[1]!);
		});
	});
	return { child, base: `http://127.0.0.1:${port}` };
}

/**
 * Each test gets its own server and data directory, and a browser signed in as the owner the way tailscale serve does it.
 * A test fails if the page breaks its Content-Security-Policy.
 */
export const test = base.extend<{ server: string }>({
	// oxlint-disable-next-line no-empty-pattern -- Playwright reads a fixture's dependencies from this pattern, and this one has none
	server: async ({}, use) => {
		const { child, base } = await start();
		await use(base);
		const exited = new Promise((resolve) => child.once("exit", resolve));
		child.kill("SIGTERM");
		await exited;
	},
	context: async ({ browser, server }, use) => {
		const context = await browser.newContext({ baseURL: server, extraHTTPHeaders: { "Tailscale-User-Login": USER }, serviceWorkers: "block" });
		await use(context);
		await context.close();
	},
	page: async ({ page }, use) => {
		const violations: string[] = [];
		page.on("console", (message) => {
			// frame-ancestors refusals are another page framing this one, which a test does on purpose.
			if (message.text().includes("Content Security Policy") && !message.text().includes("frame-ancestors")) violations.push(message.text());
		});
		await use(page);
		if (violations.length > 0) throw new Error(`The page broke its Content-Security-Policy:\n${violations.join("\n")}`);
	},
});
