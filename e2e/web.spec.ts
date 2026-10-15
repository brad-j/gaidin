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

test("a fired reminder in the log can be snoozed", async ({ page }) => {
	await page.goto("/");
	await send(page, "remind me");
	const snooze = page.getByRole("button", { name: "snooze 10 min" });
	await expect(snooze).toBeVisible({ timeout: 15_000 });
	await snooze.click();
	await expect(page.locator("#log")).toContainText("Snoozed until");
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

test("on a phone only the console has the prompt, and a new reminder starts there", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto("/#/schedule");
	await expect(page.locator("#message")).toBeHidden();
	await expect(page.locator("#views a")).toHaveCount(7);
	await page.getByRole("button", { name: "+ new reminder" }).click();
	await expect(page).toHaveURL(/#\/$/);
	await expect(page.locator("#message")).toBeVisible();
	await expect(page.locator("#message")).toHaveValue("Remind me to ");
	await expect(page.locator("#message")).toBeFocused();
});

test("while the server can't be reached, the page's own refreshes don't fill the log with errors", async ({ page }) => {
	// The stream never connects and every request fails, as when the server is down behind tailscale serve.
	await page.route("**/events", (route) => route.abort());
	await page.route("**/api/**", (route) => route.fulfill({ status: 502, body: "" }));
	await page.clock.install();
	await page.goto("/");
	await expect(page.locator("#statusline .status")).toHaveText("reconnecting");
	await page.clock.runFor(5 * 60_000);
	await expect(page.locator("#log .row.err")).toHaveCount(0);
});

test("the memory page adds, edits and forgets notes, and /remember adds one from the console", async ({ page }) => {
	await page.goto("/");
	await send(page, "/remember the dog is called Bela");
	await expect(page.locator("#log")).toContainText("Noted [1]: the dog is called Bela");
	await send(page, "/memory");
	await expect(page).toHaveURL(/#\/memory$/);
	const memory = page.locator("#memory");
	await expect(memory.locator(".note-row")).toHaveCount(1);
	await expect(memory.locator(".usage")).toHaveText("22 of 8,000 characters");

	await memory.getByRole("textbox", { name: "A new note" }).fill("The NAS is in the hall closet.");
	await memory.getByRole("textbox", { name: "A new note" }).press("Enter");
	await expect(memory.locator(".note-row").first()).toContainText("The NAS is in the hall closet.");
	await expect(memory.getByRole("textbox", { name: "A new note" })).toHaveValue("");

	const bela = memory.locator(".note-row", { hasText: "Bela" });
	await bela.getByRole("button", { name: "edit" }).click();
	const box = memory.getByRole("textbox", { name: "Note 1" });
	await box.fill("The dog is called Bela, and she's afraid of the hoover.");
	await box.press("Enter");
	await expect(memory.locator(".note-row", { hasText: "hoover" })).toContainText("you");

	const nas = memory.locator(".note-row", { hasText: "NAS" });
	await nas.getByRole("button", { name: "forget" }).click();
	await nas.getByRole("button", { name: "Press again to forget for good" }).click();
	await expect(memory.locator(".note-row")).toHaveCount(1);
	await expect(memory).not.toContainText("NAS");
});

test("the settings page switches the model's thinking and a tool, and keeps the instructions", async ({ page }) => {
	await page.goto("/#/settings");
	const settings = page.locator("#settings");
	await settings.getByRole("group", { name: "Thinking" }).getByRole("button", { name: "high" }).click();
	await expect(settings.getByRole("group", { name: "Thinking" }).getByRole("button", { name: "high" })).toHaveAttribute("aria-pressed", "true");
	await expect(settings).toContainText("Thinking set to high. Applies from the next request.");

	const fetchTool = settings.getByRole("switch", { name: "fetch_url" });
	await expect(fetchTool).toHaveAttribute("aria-checked", "true");
	await fetchTool.click();
	await expect(fetchTool).toHaveAttribute("aria-checked", "false");
	await expect(page.locator("#statusline")).toContainText("fetch_url off");
	// Switching a tool kept the thinking level.
	await expect(settings.getByRole("group", { name: "Thinking" }).getByRole("button", { name: "high" })).toHaveAttribute("aria-pressed", "true");

	const instructions = settings.getByRole("textbox", { name: "Standing instructions" });
	await instructions.fill("Answer in British English.");
	await settings.getByRole("button", { name: "save" }).click();
	await expect(settings).toContainText("Standing instructions saved.");
	await page.reload();
	await expect(settings.getByRole("textbox", { name: "Standing instructions" })).toHaveValue("Answer in British English.");
	await expect(settings.getByRole("switch", { name: "fetch_url" })).toHaveAttribute("aria-checked", "false");
	await expect(settings).toContainText("Notifications need web.url in gaidin's settings file.");
});

test("the activity page shows spend against the limits and what gaidin did", async ({ page }) => {
	await page.goto("/");
	await send(page, "fetch the page");
	await page.locator("#approvals").getByRole("button", { name: "Allow once" }).click();
	await expect(page.locator("#log")).toContainText("The page says: page text.");
	await send(page, "/timeline");
	await expect(page).toHaveURL(/#\/activity$/);
	const activity = page.locator("#activity");
	await expect(activity.getByRole("meter", { name: /^today: \$0\.000 of \$5\.00$/ })).toBeVisible();
	await expect(activity.locator(".event.is-tool")).toContainText("fetch_url");
	await expect(activity.locator(".event.is-tool .outcome")).toHaveText("ok");
	await expect(activity.locator(".event.is-approval")).toContainText("allowed once");
});

test("the owner creates a skill, adds a file and edits it, and removes the skill", async ({ page }) => {
	await page.goto("/#/skills");
	const skills = page.locator("#skills");
	await expect(skills.getByRole("link", { name: /gaidin/ })).toBeVisible();
	await skills.getByRole("button", { name: "+ new skill" }).click();
	await skills.locator(".skill-form input").fill("homelab-alerts");
	await skills.getByRole("textbox", { name: "Description" }).fill("What to do when a homelab alert comes in.");
	await skills.getByRole("textbox", { name: "Guide" }).fill("# Homelab alerts\n\nCheck the NAS first.");
	await skills.getByRole("button", { name: "create skill" }).click();
	await expect(page).toHaveURL(/#\/skills\/homelab-alerts$/);
	await expect(skills.locator(".skill-doc h2")).toHaveText("Homelab alerts");
	await expect(skills.locator(".skill-head .tag")).toHaveText("local");

	await skills.getByRole("button", { name: "+ file" }).click();
	await skills.getByRole("textbox", { name: "New file's path" }).fill("references/backups.md");
	await skills.getByRole("textbox", { name: "New file's path" }).press("Enter");
	await skills.getByRole("textbox", { name: "homelab-alerts/references/backups.md" }).fill("# Backups\n\nThey run at 03:00.");
	await skills.getByRole("button", { name: "create file" }).click();
	await expect(skills.locator(".skill-doc h2")).toHaveText("Backups");

	await skills.getByRole("button", { name: "edit" }).click();
	await skills.getByRole("textbox", { name: "homelab-alerts/references/backups.md" }).fill("# Backups\n\nThey run at 04:00 now.");
	await skills.getByRole("button", { name: "save" }).click();
	await expect(skills.locator(".skill-doc")).toContainText("They run at 04:00 now.");

	// A broken SKILL.md isn't saved, and the page says why.
	await skills.getByRole("navigation", { name: "Files" }).getByRole("link", { name: "SKILL.md" }).click();
	await skills.getByRole("button", { name: "edit" }).click();
	await skills.getByRole("textbox", { name: "homelab-alerts/SKILL.md" }).fill("no front matter");
	await skills.getByRole("button", { name: "save" }).click();
	await expect(skills.locator(".page-problem")).toHaveText("SKILL.md has no front matter between --- lines");
	await skills.getByRole("button", { name: "cancel" }).click();

	await skills.getByRole("button", { name: "remove skill" }).click();
	await skills.getByRole("button", { name: "Press again to remove skill for good" }).click();
	await expect(page).toHaveURL(/#\/skills$/);
	await expect(skills.locator(".skill-row")).toHaveCount(1);
	// The built-in skill has nothing to change.
	await skills.getByRole("link", { name: /gaidin/ }).click();
	await expect(skills.getByRole("button", { name: "edit" })).toHaveCount(0);
});

test("Esc in a text box on another page leaves the run going; on the console it stops it", async ({ page }) => {
	await page.goto("/");
	await send(page, "ask me something");
	await expect(page.locator("#approvals")).toContainText("Keep the old branch?");
	await page.getByRole("navigation", { name: "Views" }).getByRole("link", { name: "memory" }).click();
	await page.getByRole("textbox", { name: "A new note" }).press("Escape");
	await page.keyboard.press("Escape");
	await expect(page.locator("#statusline .status")).toHaveText("working");
	await expect(page.locator("#approvals")).toContainText("Keep the old branch?");

	await page.getByRole("navigation", { name: "Views" }).getByRole("link", { name: "console" }).click();
	await page.locator("#message").press("Escape");
	await expect(page.locator("#log .row.stopped")).toHaveCount(1);
	await expect(page.locator("#approvals")).toBeEmpty();
});

test("the history page lists a job run and opens its transcript", async ({ page }) => {
	await page.goto("/");
	await send(page, "check the weather soon");
	await page.locator("#approvals").getByRole("button", { name: "Allow once" }).click();
	// The run reports into the console when it's done.
	await expect(page.locator("#log .row.job")).toContainText("Quick weather check", { timeout: 15_000 });

	await page.getByRole("navigation", { name: "Views" }).getByRole("link", { name: "history" }).click();
	const history = page.locator("#history");
	const run = history.locator(".convo-row", { hasText: "Quick weather check" });
	await expect(run).toContainText("job run");
	await expect(run).toContainText("2 messages");
	await run.click();
	await expect(page).toHaveURL(/#\/history\/\d+$/);
	await expect(history.locator(".convo-title")).toHaveText("Quick weather check");
	await expect(history.locator(".log .row.prompt")).toContainText("Check the weather once.");
	await expect(history.locator(".log .row.gaidin")).toContainText("Hello, Brad.");
	await page.reload();
	await expect(history.locator(".convo-title")).toHaveText("Quick weather check");

	await page.goto("/#/history/1");
	await expect(history.locator(".page-problem")).toHaveText("No thread, job run or conversation from another agent 1");
});
