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

test("the schedule view lists reminders and jobs, and pauses, opens and cancels them", async ({ page }) => {
	await page.goto("/");
	const views = page.getByRole("navigation", { name: "Views" });
	const schedule = page.locator("#schedule");
	await send(page, "remind me about the dentist");
	await expect(page.locator("#log")).toContainText("Reminder");

	await views.getByRole("link", { name: /schedule/ }).click();
	await expect(page).toHaveURL(/#\/schedule$/);
	await expect(page.locator("#log")).toBeHidden();
	const reminder = schedule.locator(".sched-row", { hasText: "Call the dentist" });
	await expect(reminder).toContainText(/in (1 h 59 min|2 h)/);
	await expect(schedule).toContainText("No scheduled jobs.");

	// The dock stays on this view; what's sent from it goes back to the console to be answered.
	await send(page, "set up a briefing");
	await expect(page).toHaveURL(/#\/$/);
	await page.locator("#approvals").getByRole("button", { name: "Allow once" }).click();
	await expect(page.locator("#approvals")).toBeEmpty();

	await views.getByRole("link", { name: /schedule/ }).click();
	const job = schedule.locator(".sched-row", { hasText: "Morning briefing" });
	await expect(job).toContainText("at 07:30, weekdays");
	await expect(views).toContainText("schedule 2");

	await job.getByRole("button", { name: "pause" }).click();
	await expect(job.locator(".due")).toHaveText("paused");
	await expect(page.locator("#schedule-count")).toHaveClass(/warn/);
	await job.getByRole("button", { name: "resume" }).click();
	await expect(job.getByRole("button", { name: "pause" })).toBeVisible();

	await job.getByRole("button", { name: "Morning briefing" }).click();
	await expect(job).toContainText("Summarise the weather and today's calendar.");
	await expect(job).toContainText("no reports yet");

	// Cancelling takes a second press.
	await reminder.getByRole("button", { name: "cancel" }).click();
	await reminder.getByRole("button", { name: "Press again to cancel for good" }).click();
	await expect(schedule).toContainText("No reminders.");
	await expect(views).toContainText("schedule 1");
});

test("the skills page lists the gaidin skill and reads its files, following links between them", async ({ page }) => {
	await page.goto("/");
	await page.getByRole("navigation", { name: "Views" }).getByRole("link", { name: "skills" }).click();
	const skills = page.locator("#skills");
	await expect(skills.locator(".skill-row")).toHaveCount(1);
	await skills.getByRole("link", { name: /gaidin/ }).click();
	await expect(page).toHaveURL(/#\/skills\/gaidin$/);
	await expect(page.locator("#log")).toBeHidden();
	await expect(skills.locator(".skill-doc")).toContainText("This is gaidin's documentation");
	// The front matter is shown as the description above, not in the document.
	await expect(skills.locator(".skill-doc")).not.toContainText("description:");

	await skills.getByRole("navigation", { name: "Files" }).getByRole("link", { name: "tools.md" }).click();
	await expect(page).toHaveURL(/#\/skills\/gaidin\/tools\.md$/);
	await expect(skills.locator(".skill-doc h2")).toHaveText("Tools");
	// A link to another doc opens it here, at the heading it names.
	await skills.locator(".skill-doc").getByRole("link", { name: "Security" }).first().click();
	await expect(page).toHaveURL(/#\/skills\/gaidin\/security\.md#[a-z-]+$/);
	await expect(skills.locator(".skill-doc h2")).toHaveText("Security");

	await page.reload();
	await expect(skills.locator(".skill-doc h2")).toHaveText("Security");
	await page.goBack();
	await expect(skills.locator(".skill-doc h2")).toHaveText("Tools");
});

test("Esc stops a run, and the log says gaidin will drop the request", async ({ page }) => {
	await page.goto("/");
	await send(page, "ask me something");
	await expect(page.locator("#approvals")).toContainText("Keep the old branch?");
	await page.keyboard.press("Escape");
	const stopped = page.locator("#log .row.stopped");
	await expect(stopped).toHaveText(/Stopped\. gaidin will drop that request unless you ask again\./);
	await expect(stopped).toHaveCount(1);
	await expect(page.locator("#approvals")).toBeEmpty();
});
