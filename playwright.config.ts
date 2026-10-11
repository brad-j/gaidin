import { defineConfig } from "@playwright/test";

// Browser tests of the web view (`pnpm e2e`). Each test starts its own server on the scripted model (e2e/server.ts).
export default defineConfig({
	testDir: "e2e",
	fullyParallel: true,
	forbidOnly: true,
	reporter: "list",
	timeout: 30_000,
	use: { browserName: "chromium", trace: "retain-on-failure" },
	outputDir: "e2e/results",
});
