import { test, expect } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkflowOwner, ProcessExecutor, inspectArtifact, ActivityWorker, connectOwnerV2, dispatchWorkerRequest, authorizeRun } from "@barry-rocks/sdk/internal/workflows";
import { createWorkflowServer } from "../src/server.js";
import { approveExecutionScope } from "@barry-rocks/sdk/bounds";


let url: string, owner: WorkflowOwner, worker: ActivityWorker, activityDigests: Record<string, string>, close: () => Promise<void>;
test.beforeAll(async () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-browser-")), executor = new ProcessExecutor();
  const artifact = fileURLToPath(new URL("../src/builtin-artifact.mjs", import.meta.url));
  activityDigests = { "echo@1": inspectArtifact(artifact, "echo@1", "1", false).digest };
  owner = new WorkflowOwner({ id: "browser-test", path: join(root, "jobs.db"), artifacts: [inspectArtifact(artifact, "echo", "1")], activityArtifacts: activityDigests, executor });
  worker = new ActivityWorker({ connections: [connectOwnerV2(owner.id, async request => dispatchWorkerRequest(owner, "worker", request))], artifacts: activityDigests, activities: { "echo@1": executor.activity(inspectArtifact(artifact, "echo@1", "1", false)) } });
  const server = createWorkflowServer({ owner, secret: "browser-test-secret", authenticateWorker: () => null, runAuthorization: async job => approveExecutionScope({ identity: job.identity, harness: job.harness, traitNames: job.traits, traits: {}, tools: [], boundByName: async () => undefined }) });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const timer = setInterval(() => { void owner.pump().catch(() => {}); void worker.tick().catch(() => {}); }, 50);
  close = async () => { clearInterval(timer); await worker.drain(2000); await owner.drain(); await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }); owner.close(); rmSync(root, { recursive: true, force: true }); };
});
test.afterAll(async () => { await close?.(); });
test.beforeEach(async ({ page }) => {
  await page.goto(url); await page.getByLabel("Barry secret").fill("browser-test-secret"); await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Runs", exact: true })).toBeVisible();
});

test("starts, signals and inspects a real isolated run with keyboard tabs and inert payloads", async ({ page }) => {
  await page.getByRole("button", { name: "+ Start run" }).click();
  await page.getByLabel("Run ID", { exact: true }).fill("browser-job");
  await page.getByLabel("Input · JSON").fill(JSON.stringify({ message: "<img src=x onerror=alert(1)>", waitForSignal: true }));
  await page.getByRole("button", { name: "Start run", exact: true }).click();
  await expect(page.getByRole("heading", { name: "browser-job", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Send signal", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Send signal", exact: true }).click();
  await expect.poll(() => owner.get("browser-job").status).toBe("completed");
  await page.getByRole("button", { name: "Refresh", exact: false }).click();
  await page.getByRole("tab", { name: "Steps & attempts" }).focus();
  await page.keyboard.press("End");
  await expect(page.getByRole("tab", { name: "Input & output" })).toBeFocused();
  await page.getByText("Load input & outcome", { exact: true }).click();
  await expect(page.getByRole("tabpanel")).toContainText("<img src=x onerror=alert(1)>");
  await expect(page.locator("#content img")).toHaveCount(0);
  const audit = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(audit.violations).toEqual([]);
});

test("inspects grants and resources and recovers a lost reauthorization acknowledgement", async ({ page }) => {
  const job = { traits: [], identity: "browser-identity" };
  const grant = await authorizeRun(job, "local-operator", async () => approveExecutionScope({ identity: job.identity, traitNames: [], traits: {}, tools: [], boundByName: async () => undefined }));
  owner.start({ id: "grant-browser", type: "echo", version: "1", input: { message: "wait", waitForSignal: true }, job }, "local-operator", undefined, grant);
  await expect.poll(() => owner.inspect("grant-browser").commands.length).toBeGreaterThan(0);
  await page.goto(`${url}/#runs/grant-browser?tab=permissions`);
  await page.getByText("Inspect approved grant and current permission state", { exact: true }).click();
  await expect(page.getByRole("tabpanel")).toContainText("browser-identity");
  await expect(page.getByRole("tabpanel")).toContainText("No approved tool capabilities.");
  await page.getByRole("tab", { name: "Resources", exact: true }).click();
  await page.getByText("Inspect queue timing, payload metadata and session bindings", { exact: true }).click();
  await expect(page.getByRole("tabpanel")).toContainText("Physical state unknown: 0");
  await page.getByText("Resource evidence", { exact: true }).click();
  await expect(page.getByRole("tabpanel")).toContainText("not-observed");
  let dropped = false;
  await page.route("**/api/runs/grant-browser/reauthorize", async route => {
    const response = await route.fetch();
    if (!dropped) { dropped = true; await route.abort("failed"); } else await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "Reauthorize", exact: true }).click();
  await page.locator("#reauthorize-reason").fill("Explicit reviewed approval");
  await page.locator("#reauthorize-form").getByRole("button", { name: /Approve/ }).click();
  await expect.poll(() => owner.grant("grant-browser")?.revision).toBe(2);
  await page.reload();
  await page.getByRole("button", { name: "Check / retry", exact: true }).click();
  await expect(page.getByRole("button", { name: "Check / retry", exact: true })).toHaveCount(0);
  expect(owner.history("grant-browser").filter(event => event.type === "JobReauthorized")).toHaveLength(1);
});

test("explains permission loss and ambiguous outcomes with distinct recovery guidance", async ({ page }) => {
  const cases = [
    ["blocked-policy", "PolicyRevoked: selected trait was removed", "Permissions changed after this run was approved."],
    ["blocked-unknown", "OutcomeUnknown: session turn acknowledgement was lost", "An effect or session turn may have completed without an acknowledgement."],
  ];
  for (const [id, error, guidance] of cases) {
    owner.start({ id, type: "echo", version: "1", input: { message: id, waitForSignal: true } });
    owner.blockExecution(id, error);
    await page.goto(`${url}/#runs/${id}`);
    // The top bar's freshness indicator is a status region too.
    const explanation = page.getByRole("region", { name: "Runs" }).getByRole("status");
    await expect(explanation).toContainText(guidance);
    await expect(explanation).toContainText(error.split(": ")[1]);
  }
});

test("still opens a run from a link made before the console said runs", async ({ page }) => {
  owner.start({ id: "old-link", type: "echo", version: "1", input: { message: "wait", waitForSignal: true } });
  await page.goto(`${url}/#jobs/old-link`);
  await expect(page.getByRole("heading", { name: "old-link", exact: true })).toBeVisible();
});

test("shares blocker-reason filters in the URL and returns the matching run", async ({ page }) => {
  owner.start({ id: "filter-policy-job", type: "echo", version: "1", input: { message: "wait", waitForSignal: true } });
  owner.blockExecution("filter-policy-job", "PolicyRevoked: selected capability removed");
  await page.goto(`${url}/#runs`);
  await page.getByLabel("Blocking reason").selectOption("PolicyRevoked");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page).toHaveURL(/blockingReason=PolicyRevoked/);
  await expect(page.getByRole("link", { name: "filter-policy-job" })).toBeVisible();
  await expect(page.getByRole("link", { name: "race-A" })).toHaveCount(0);
});

test("shows real worker occupancy for an activity step", async ({ page }) => {
  owner.start({ id: "capacity-view", type: "echo", version: "1", input: { message: "held" } });
  owner.advertise("capacity-ui", { types: ["echo@1"], artifacts: activityDigests, capacity: 1 });
  // start() records the run; its activity step only exists once the owner's
  // pump has evaluated it, so the claim waits for that. A step of another
  // test's run claimed on the way is finished at once rather than held.
  const held: { task: ReturnType<WorkflowOwner["claim"]> } = { task: null };
  await expect.poll(() => {
    const claimed = owner.claim("capacity-ui");
    if (claimed?.runId === "capacity-view") held.task = claimed;
    else if (claimed) owner.completeStatus("capacity-ui", claimed.token, { ok: true, value: null });
    return held.task?.runId;
  }).toBe("capacity-view");
  try {
    await page.goto(`${url}/#runs/capacity-view?tab=steps`);
    await page.getByText("Worker checks (2)", { exact: true }).click();
    await expect(page.getByRole("tabpanel")).toContainText("capacity-ui");
    await expect(page.getByRole("tabpanel")).toContainText("1 / 1");
  } finally {
    if (held.task) owner.completeStatus("capacity-ui", held.task.token, { ok: true, value: "held" });
  }
});

test("links activity claim events back to their step and attempt", async ({ page }) => {
  owner.start({ id: "timeline-step-link", type: "echo", version: "1", input: { message: "trace me" } });
  await expect.poll(() => owner.history("timeline-step-link").some(event => event.type === "ActivityClaimed")).toBe(true);
  await page.goto(`${url}/#runs/timeline-step-link?tab=history`);
  const attemptLink = page.getByRole("link", { name: /Step 1\.1 · attempt 1 · worker/ });
  await expect(attemptLink).toBeVisible();
  await attemptLink.click();
  await expect(page).toHaveURL(/tab=steps/);
  await expect(page.getByRole("tab", { name: "Steps & attempts" })).toHaveAttribute("aria-selected", "true");
});

test("discards a previous run's delayed history and keeps a narrow view usable", async ({ page }) => {
  for (const id of ["race-A", "race-B"]) owner.start({ id, type: "echo", version: "1", input: { message: id, waitForSignal: true } });
  let release!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  let intercepted!: () => void;
  const interception = new Promise<void>(resolve => { intercepted = resolve; });
  await page.route("**/api/runs/race-A/history*", async route => { intercepted(); await delayed; await route.fulfill({ json: [{ sequence: 999999, at: 0, type: "WRONG_RUN_EVENT", details: {} }] }); });
  await page.goto(`${url}/#runs/race-A`); await interception;
  await page.evaluate(() => { location.hash = "runs/race-B"; }); release();
  await expect(page.getByRole("heading", { name: "race-B", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Event history" }).click();
  await expect(page.locator("#content")).not.toContainText("WRONG_RUN_EVENT");
  await page.setViewportSize({ width: 320, height: 740 });
  await expect(page.getByRole("heading", { name: "race-B", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("retries lost start and cancel acknowledgements using the original operation identities", async ({ page }) => {
  let dropStart = true, dropCancel = true;
  await page.route("**/api/runs", async route => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    const response = await route.fetch();
    if (dropStart) { dropStart = false; await route.abort("failed"); } else await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "+ Start run" }).click();
  await page.getByLabel("Run ID", { exact: true }).fill("lost-ack");
  await page.getByLabel("Input · JSON").fill(JSON.stringify({ message: "once", waitForSignal: true }));
  await page.getByRole("button", { name: "Start run", exact: true }).click();
  await expect(page.locator("#start-form .form-error")).toContainText("Outcome unknown");
  await page.reload();
  await page.getByRole("button", { name: "Check / retry", exact: true }).click();
  await expect(page.getByLabel("Run ID", { exact: true })).toHaveValue("lost-ack");
  await expect(page.getByLabel("Input · JSON")).toHaveValue("");
  await page.getByLabel("Input · JSON").fill(JSON.stringify({ message: "changed", waitForSignal: true }));
  await page.getByRole("button", { name: "Start run", exact: true }).click();
  await expect(page.locator("#start-form .form-error")).toContainText("original input");
  await page.getByLabel("Input · JSON").fill(JSON.stringify({ message: "once", waitForSignal: true }));
  await page.getByRole("button", { name: "Start run", exact: true }).click();
  await expect(page.getByRole("heading", { name: "lost-ack", exact: true })).toBeVisible();
  await expect.poll(() => owner.inspect("lost-ack").commands.some(command => command.definition.kind === "signal")).toBe(true);
  await page.getByRole("button", { name: "Refresh", exact: false }).click();
  await page.route("**/api/runs/lost-ack/cancel", async route => {
    const response = await route.fetch();
    if (dropCancel) { dropCancel = false; await route.abort("failed"); } else await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "Cancel run", exact: true }).click();
  await page.locator("#cancel-form").getByRole("button", { name: "Cancel run", exact: true }).click();
  await expect(page.locator("#cancel-form .form-error")).toContainText("Outcome unknown");
  await page.reload();
  await page.getByRole("button", { name: "Check / retry", exact: true }).click();
  await expect(page.getByRole("region", { name: "Unconfirmed operations" })).not.toBeVisible();
  expect(owner.history("lost-ack").filter(event => event.type === "WorkflowStarted")).toHaveLength(1);
  expect(owner.history("lost-ack").filter(event => event.type === "WorkflowClosed")).toHaveLength(1);
  expect(owner.get("lost-ack").status).toBe("cancelled");
});

test("recovers an ambiguous signal after reload without persisting its payload", async ({ page }) => {
  owner.start({ id: "signal-reload", type: "echo", version: "1", input: { message: "waiting", waitForSignal: true } });
  await expect.poll(() => owner.inspect("signal-reload").commands.some(command => command.definition.kind === "signal")).toBe(true);
  await page.goto(`${url}/#runs/signal-reload`);
  await page.getByRole("button", { name: "Send signal", exact: true }).click();
  await page.getByLabel("Payload · JSON").fill('{"secret":"do-not-persist"}');
  let dropped = false;
  await page.route("**/api/runs/signal-reload/signal", async route => {
    const response = await route.fetch();
    if (!dropped) { dropped = true; await route.abort("failed"); } else await route.fulfill({ response });
  });
  await page.getByRole("dialog").getByRole("button", { name: "Send signal", exact: true }).click();
  await expect(page.locator("#signal-form .form-error")).toContainText("Outcome unknown");
  expect(await page.evaluate(() => JSON.stringify(sessionStorage))).not.toContain("do-not-persist");
  await page.reload();
  await page.getByRole("button", { name: "Check / retry", exact: true }).click();
  await page.getByLabel("Payload · JSON").fill('{"secret":"do-not-persist"}');
  await page.getByRole("dialog").getByRole("button", { name: "Send signal", exact: true }).click();
  await expect(page.locator("#signal-dialog")).not.toBeVisible();
  expect(owner.history("signal-reload").filter(event => event.type === "SignalReceived")).toHaveLength(1);
});

test("shares filtered runs and event deep links, and preserves stale data across disconnects", async ({ page }) => {
  owner.start({ id: "filter-link", type: "echo", version: "1", input: { waitForSignal: true } });
  await page.getByLabel("Workflow type", { exact: true }).fill("missing");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page.getByRole("heading", { name: "No runs here yet" })).toBeVisible();
  await page.getByLabel("Workflow type", { exact: true }).fill("echo");
  await page.getByLabel("Run ID prefix").fill("filter-link");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page.getByRole("link", { name: "filter-link", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Workflow type", { exact: true })).toHaveValue("echo");
  await page.getByRole("link", { name: "filter-link", exact: true }).click();
  await page.getByRole("tab", { name: "Event history" }).click();
  await page.getByLabel("Event type", { exact: true }).fill("WorkflowStarted");
  await page.getByRole("button", { name: "Filter events" }).click();
  await expect(page.locator(".timeline li")).toHaveCount(1);
  const event = owner.history("filter-link")[0];
  await page.getByRole("link", { name: `#${event.sequence}`, exact: true }).click();
  await page.reload();
  await expect(page.locator(`#event-${event.sequence}`)).toHaveClass("selected-event");
  await page.route("**/api/overview", route => route.abort("failed"));
  await page.getByRole("button", { name: "Refresh", exact: false }).click();
  await expect(page.locator("#freshness")).toContainText("Disconnected");
  await expect(page.locator(`#event-${event.sequence}`)).toBeVisible();
  await page.unroute("**/api/overview");
  await page.getByRole("button", { name: "Refresh", exact: false }).click();
  await expect(page.locator("#freshness")).toContainText("Live");
});
