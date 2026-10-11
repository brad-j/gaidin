import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

async function send(page: Page, text: string) {
	await page.locator("#message").fill(text);
	await page.locator("#message").press("Enter");
}

test("without the owner's tailnet login the page is refused", async ({ server }) => {
	expect((await fetch(server)).status).toBe(403);
	expect((await fetch(server, { headers: { "Tailscale-User-Login": "someone@example.com" } })).status).toBe(403);
});

test("another site can't put the page in a frame", async ({ page, server }) => {
	// Another origin, served from loopback too, so Chrome's local network checks don't refuse the frame before the page's headers do.
	const other = createServer((_request, response) => response.end(`<iframe src="${server}/"></iframe>`));
	await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
	try {
		// The outer page's load waits for its frame's, so the frame has loaded or been refused by now.
		await page.goto(`http://127.0.0.1:${(other.address() as AddressInfo).port}/`, { waitUntil: "load" });
		await expect(page.frameLocator("iframe").locator("#message")).toHaveCount(0);
	} finally {
		other.close();
	}
});

test("a message is answered in the log", async ({ page }) => {
	await page.goto("/");
	await send(page, "hi");
	await expect(page.locator("#log")).toContainText("Hello, Brad.");
});

test("a fetch waits in the dock until it's allowed, and Deny stops it", async ({ page }) => {
	await page.goto("/");
	const dock = page.locator("#approvals");
	const log = page.locator("#log");
	await send(page, "fetch the page");
	await expect(dock).toContainText("fetch_url");
	await dock.getByRole("button", { name: "Allow once" }).click();
	await expect(log).toContainText("The page says: page text.");
	await expect(dock).toBeEmpty();

	await send(page, "fetch it again");
	await expect(dock).toContainText("fetch_url");
	await dock.getByRole("button", { name: "Deny" }).click();
	await expect(log).toContainText("Brad said no.");
	await expect(dock).toBeEmpty();
});

test("Alt+N denies, Alt+Y allows once and Alt+A allows the host from then on", async ({ page }) => {
	await page.goto("/");
	const dock = page.locator("#approvals");
	const log = page.locator("#log");
	const fetched = log.getByText("The page says: page text.");

	await send(page, "fetch");
	await expect(dock).toContainText("fetch_url");
	await page.keyboard.press("Alt+KeyN");
	await expect(log).toContainText("Brad said no.");

	await send(page, "fetch");
	await expect(dock).toContainText("fetch_url");
	await page.keyboard.press("Alt+KeyY");
	await expect(fetched).toHaveCount(1);

	await send(page, "fetch");
	await expect(dock).toContainText("fetch_url");
	await page.keyboard.press("Alt+KeyA");
	await expect(fetched).toHaveCount(2);

	// Allowed for good: the next fetch doesn't ask.
	await send(page, "fetch");
	await expect(fetched).toHaveCount(3);
	await expect(dock).toBeEmpty();
});

test("a question is answered with its button or in the owner's own words", async ({ page }) => {
	await page.goto("/");
	const dock = page.locator("#approvals");
	await send(page, "ask me");
	await expect(dock).toContainText("Keep the old branch?");
	await dock.getByRole("button", { name: "No" }).click();
	await expect(page.locator("#log")).toContainText("Brad answered: No");

	await send(page, "ask me again");
	await expect(dock).toContainText("Keep the old branch?");
	await send(page, "only if it's merged");
	await expect(page.locator("#log")).toContainText("Brad answered: only if it's merged");
	await expect(dock).toBeEmpty();
});

test("a note is added, listed and forgotten with commands", async ({ page }) => {
	await page.goto("/");
	const log = page.locator("#log");
	await send(page, "/remember the dog is called Bela");
	await send(page, "/memory");
	await expect(log).toContainText("the dog is called Bela");
	await log.getByRole("button", { name: "forget" }).click();
	await send(page, "/clear");
	await send(page, "/memory");
	await expect(log).toContainText("gaidin has no notes yet.");
	await expect(log).not.toContainText("the dog is called Bela");
});

test("a fired reminder in the log can be snoozed", async ({ page }) => {
	await page.goto("/");
	await send(page, "remind me");
	const snooze = page.getByRole("button", { name: "snooze 10 min" });
	await expect(snooze).toBeVisible({ timeout: 15_000 });
	await snooze.click();
	await expect(page.locator("#log")).toContainText("Snoozed until");
});

test("settings commands change one setting and keep the others, and the timeline loads", async ({ page }) => {
	await page.goto("/");
	const log = page.locator("#log");
	await send(page, "/tool fetch_url off");
	await expect(log).toContainText("fetch_url off.");
	await send(page, "/thinking high");
	await expect(log).toContainText("Thinking set to high.");
	await send(page, "/thinking banana");
	await expect(log).toContainText("No thinking level banana. Levels: off, low, medium, high.");
	// Changing the thinking level left fetch_url off.
	await send(page, "/clear");
	await send(page, "/tools");
	await expect(log).toContainText(/off\s*fetch_url/);
	await send(page, "/thinking");
	await expect(log).toContainText("Thinking high.");
	await send(page, "/timeline");
	await expect(log).toContainText(/Nothing on the timeline yet\.|older|ok|running/);
});
