import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./browser", workers: 1, timeout: 30_000, forbidOnly: Boolean(process.env.CI), retries: 0,
  use: { channel: process.env.WORKFLOW_BROWSER_CHANNEL ?? "chrome", headless: true, trace: "retain-on-failure" },
  outputDir: "./node_modules/.cache/workflow-browser-results", reporter: "list",
});
