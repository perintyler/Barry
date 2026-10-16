import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./server/browser", workers: 1, timeout: 90_000, forbidOnly: Boolean(process.env.CI), retries: 0,
  use: { channel: process.env.ACTIONS_BROWSER_CHANNEL ?? "chrome", headless: true, trace: "retain-on-failure" },
  outputDir: process.env.BARRY_ACTIONS_BROWSER_RESULTS ?? "./node_modules/.cache/actions-browser-results", reporter: "list",
});
