#!/usr/bin/env tsx
import { Barry } from "@barry-rocks/sdk";
import { identities, bags } from "@barry-rocks/identities-bag";
import { sessions } from "@barry-rocks/sessions-bag";
import { actions } from "@barry-rocks/actions-bag";
import { events } from "@barry-rocks/events-bag";
import { schedules } from "@barry-rocks/schedules-bag";
import { tracker } from "@barry-rocks/tracker-bag";
import { services } from "./index.js";
import { startMcpApplication } from "./application.js";
import { createLogger as createDiagnosticLogger } from "@barry-rocks/sdk/logging";
const diagnostics = createDiagnosticLogger("mcp.server", { transport: "stderr" });

// The subjects a session's grants are composed from, answered in-process.
Barry.use(identities, bags, sessions, actions, events, schedules, tracker, services);
// sessions.api owns the shared bag-build maintenance cycle.
const controller = new AbortController();
let application: Awaited<ReturnType<typeof startMcpApplication>> | undefined;
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true; controller.abort();
  if (application) void application.close().then(() => process.exit(0));
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
const identityFlag = process.argv.indexOf("--identity-id");
const identityId = identityFlag < 0 ? undefined : Number(process.argv[identityFlag + 1]);
if (identityId !== undefined && (!Number.isSafeInteger(identityId) || identityId <= 0)) {
  throw new Error("--identity-id requires a positive local identity key");
}
const harnessFlag = process.argv.indexOf("--harness");
const harness = harnessFlag < 0 ? undefined : process.argv[harnessFlag + 1];
if (harnessFlag >= 0 && (!harness || harness.startsWith("--"))) throw new Error("--harness requires an installed harness identifier");
void startMcpApplication({ mode: process.argv.includes("--stdio") ? "stdio" : "http", identityId, harness, signal: controller.signal }).then(async started => {
  application = started;
  if (stopping) { await application.close(); process.exit(0); }
}, error => { diagnostics.error("mcp.start_failed", { error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined }); process.exit(stopping ? 0 : 1); });
