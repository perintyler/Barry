import { test, expect } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
let url: string, root: string, child: ReturnType<typeof spawn> | undefined, exited: Promise<unknown>;
async function start() {
  let output = "", errors = "";
  child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../runtime/src/service.ts", import.meta.url))], {
    env: { PATH: process.env.PATH, BARRY_HOME: join(root, "home"), BARRY_SECRET: "work-browser-secret", BARRY_BAGS_SNAPSHOT: join(root, "snapshot.json"), BARRY_WORKFLOW_DELEGATION_KEYS: join(root, "keys.json"), BARRY_WORKFLOW_SCRIPT_RESOURCES: join(root, "scripts.json"), BARRY_WORKFLOW_SCRIPT_TRAITS: '["bash"]', PORT: new URL(url).port }, stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout!.on("data", data => { output += String(data); }); child.stderr!.on("data", data => { errors += String(data); });
  exited = new Promise(resolve => child!.once("exit", resolve));
  await expect.poll(() => output + errors, { timeout: 15000 }).toContain("runtime ready");
}
async function stop() { child!.kill("SIGTERM"); await exited; child = undefined; }
test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "background-work-browser-"));
  const reserve = createServer(); await new Promise<void>(resolve => reserve.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(reserve.address() as { port: number }).port}`; await new Promise<void>(resolve => reserve.close(() => resolve()));
  const job = join(root, "browser-job"); mkdirSync(job);
  writeFileSync(join(job, "bag.yaml"), JSON.stringify({ name: "fixturebrowser", description: "Disposable browser node job", bounds: { "no-files": { description: "No file access", files: { allow: [] }, nodes: { allow: ["local"] } } }, jobs: { run: { description: "Return a value", version: 1, bounds: ["fixturebrowser:no-files"], runs: { using: "node", main: "main.mjs" }, input_schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] }, output_schema: { type: "object" }, timeout: "5s" } } }));
  writeFileSync(join(job, "main.mjs"), 'const input=JSON.parse(process.getBuiltinModule("node:fs").readFileSync(0,"utf8"));process.stderr.write("<img src=x onerror=alert(1)>");process.stdout.write(JSON.stringify({value:input.value}));');
  const script = join(job, "actions", "script"); mkdirSync(script, { recursive: true });
  writeFileSync(join(script, "action.yaml"), JSON.stringify({ name: "script", description: "Disposable browser script", run: "main.sh", context: "none", preflight: { command: "printf preflight-diagnostic >&2; exit 1", hint: "browser advisory probe" }, validate: { files_exist: ["missing-output"], command: "printf post-diagnostic >&2; exit 1" }, input_schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] }, output_schema: { type: "object" }, timeout: 5 }));
  writeFileSync(join(script, "main.sh"), `printf '<script>inert script log</script>' >&2; IFS= read -r input || :; printf '%s' "$input"`);
  writeFileSync(join(root, "scripts.json"), JSON.stringify({ version: 1, scripts: [{ reference: "fixturebrowser:script", resource_policy: "closed", allowed_roots: [script], entry: "main.sh", files: ["main.sh", "action.yaml"].map(path => ({ path, source: join(script, path) })), arguments: [{ index: 0, path: "main.sh" }] }] }));
  writeFileSync(join(root, "snapshot.json"), JSON.stringify({ bags: { workflows: { type: "local", path: fileURLToPath(new URL("../", import.meta.url)) }, fixturebrowser: { type: "local", path: job }, bash: { type: "local", path: fileURLToPath(new URL("../../bash", import.meta.url)) } } }));
  const setup = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../runtime/test/browser-setup.ts", import.meta.url))], {
    cwd: fileURLToPath(new URL("../runtime/", import.meta.url)), env: { PATH: process.env.PATH, BARRY_HOME: join(root, "home"), BARRY_BAGS_SNAPSHOT: join(root, "snapshot.json") }, stdio: "pipe",
  });
  let setupError = ""; setup.stderr!.on("data", data => { setupError += String(data); }); await new Promise<void>(resolve => setup.once("close", () => resolve())); expect(setup.exitCode, setupError).toBe(0);
  writeFileSync(join(root, "keys.json"), JSON.stringify({ "workflows.runtime.operator": [{ id: "operator", secret: "fixture-only-browser-work-operator-key", not_before: Date.now() - 1000, not_after: Date.now() + 3600000 }] }), { mode: 0o600 });
  await start();
});
test.afterAll(async () => { if (child) await stop(); rmSync(root, { recursive: true, force: true }); });
test.beforeEach(async ({ page }) => {
  await page.goto(url); await page.getByLabel("Barry secret").fill("work-browser-secret"); await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("link", { name: "Background work", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Background work", exact: true })).toBeVisible();
  await expect(page.locator("#start-task")).toBeEnabled();
});
async function task(page: import("@playwright/test").Page, message: string, delay = 0) {
  await page.locator("#start-task").click(); await page.getByLabel("Message", { exact: true }).fill(message); await page.getByLabel("Delay (seconds)").fill(String(delay));
  await page.locator("#submit-task").click(); await expect(page.locator("#work-detail-title")).toHaveText("Echo");
}
test("starts real isolated work, shows its inert result, and keeps detail focus across refresh", async ({ page }) => {
  const payload = "<img src=x onerror=alert(1)>";
  await task(page, payload); await expect(page.locator("#work-content [role=status]")).toHaveText("Completed");
  await page.getByRole("button", { name: "View result", exact: true }).click(); await expect(page.locator("#work-result")).toContainText(payload);
  await expect(page.locator("#work-content img")).toHaveCount(0);
  const details = page.getByText("Execution details", { exact: true }); await details.focus(); await page.keyboard.press("Enter");
  await expect(page.locator("details.work-details")).toHaveAttribute("open", "");
  await page.locator("#work-refresh").click(); await details.focus(); await page.waitForTimeout(2200); await expect(details).toBeFocused();
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
  await page.screenshot({ path: process.env.BARRY_WORK_EVIDENCE_DIR ? join(process.env.BARRY_WORK_EVIDENCE_DIR, "p3-work-surfaces-desktop.png") : test.info().outputPath("work-desktop.png"), fullPage: true });
});
test("starts a registered node job from its schema and shows the retained native result", async ({ page }) => {
  let submitted: unknown;
  page.on("request", request => { if (request.url().endsWith("/api/v2/work/start")) submitted = request.postDataJSON().definition; });
  await page.locator("#start-task").click(); await page.locator("#task-definition").selectOption({ label: "fixturebrowser:run@1" });
  await page.getByLabel("Value", { exact: true }).fill("Browser native job"); await page.locator("#submit-task").click();
  await expect(page.locator("#work-detail-title")).toHaveText("fixturebrowser:run@1");
  await expect(page.locator("#work-content [role=status]")).toHaveText("Completed");
  expect(submitted).toEqual({ kind: "job", reference: "fixturebrowser:run@1" });
  await page.getByRole("button", { name: "View result", exact: true }).click(); await expect(page.locator("#work-result")).toContainText("Browser native job");
  await page.getByText("execution logs", { exact: true }).click();
  await expect(page.locator("#work-result")).toContainText("<img src=x onerror=alert(1)>");
  await expect(page.locator("#work-result img")).toHaveCount(0);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
});
test("starts an installed script with its catalog namespace and renders retained results and logs", async ({ page }) => {
  let submitted: unknown;
  page.on("request", request => { if (request.url().endsWith("/api/v2/work/start")) submitted = request.postDataJSON().definition; });
  await page.locator("#start-task").click(); await page.locator("#task-definition").selectOption({ label: "script" });
  await page.getByLabel("Value", { exact: true }).fill("Browser installed script"); await page.locator("#submit-task").click();
  await expect(page.locator("#work-detail-title")).toHaveText("script"); await expect(page.locator("#work-content [role=status]")).toHaveText("Completed");
  expect(submitted).toEqual({ kind: "action", reference: "fixturebrowser:script", catalog_namespace: "fixturebrowser" });
  await page.getByRole("button", { name: "View result", exact: true }).click(); await expect(page.locator("#work-result")).toContainText("Browser installed script");
  await expect(page.getByRole("heading", { name: "Preflight check", exact: true })).toBeVisible(); await expect(page.getByRole("heading", { name: "Postconditions", exact: true })).toBeVisible();
  await expect(page.getByText("Not passed", { exact: true })).toHaveCount(2); await expect(page.locator("#work-result")).toContainText("browser advisory probe");
  await expect(page.locator("#work-result")).toContainText("expected file not found: missing-output");
  await page.getByText("execution logs", { exact: true }).click(); await expect(page.locator("#work-result")).toContainText("<script>inert script log</script>");
  await expect(page.locator("#work-result script")).toHaveCount(0);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
});
test("recovers an accepted submission after its HTTP reply is lost and the page reloads", async ({ page }) => {
  let starts = 0, key = "", workId = "";
  await page.route("**/api/v2/work/start", async route => { starts++; key = route.request().postDataJSON().idempotency_key; const response = await route.fetch(); workId = (await response.json()).work.work_id; await route.abort("failed"); });
  await page.locator("#start-task").click(); await page.getByLabel("Message", { exact: true }).fill("one accepted invocation"); await page.locator("#submit-task").click();
  await expect(page.locator("#task-error")).not.toBeEmpty(); await page.getByRole("button", { name: "Close start task" }).click();
  await page.reload(); await page.locator("#check-submission").click(); await expect(page).toHaveURL(new RegExp(`work/${workId}$`));
  await expect(page.locator("#work-content [role=status]")).toHaveText("Completed"); expect(starts).toBe(1);
  await page.goto(`${url}/work#history`); await page.getByText("Find a submission by its key", { exact: true }).click(); await page.getByLabel("Submission key", { exact: true }).fill(key); await page.getByRole("button", { name: "Check submission key" }).click();
  await expect(page).toHaveURL(new RegExp(`work/${workId}$`));
});
test("recovers a lost stop acknowledgement after the actual service restarts", async ({ page }) => {
  await task(page, "stop the authored wait", 60); await expect(page.locator("#work-content [role=status]")).toHaveText("Waiting");
  await expect(page.locator("#work-content")).toContainText("does not hold an execution slot");
  let stopCalls = 0;
  await page.route("**/api/v2/work/*/stop", async route => { const response = await route.fetch(); stopCalls++; if (stopCalls === 1) await route.abort("failed"); else await route.fulfill({ response }); });
  await page.getByRole("button", { name: "Stop task", exact: true }).click(); await page.locator("#submit-stop").click(); await expect(page.locator("#stop-error")).not.toBeEmpty();
  await stop(); await start(); await page.reload(); await page.locator("#check-stop").click(); await expect(page.locator("#stop-pending")).toBeHidden();
  await expect(page.locator("#work-content [role=status]")).toHaveText("Cancelled"); expect(stopCalls).toBe(2);
  await page.getByRole("button", { name: "View result", exact: true }).click(); await expect(page.locator("#work-result")).toContainText("Stop requested");
});
test("retains the last confirmed task during disconnection and fits a narrow screen", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 }); await task(page, "mobile work", 60);
  await expect(page.locator("#work-content [role=status]")).toHaveText("Waiting");
  await page.route(/\/api\/v2\/work(?:\/|\?)/, route => route.abort("failed")); await page.locator("#work-refresh").click();
  await expect(page.locator("#connection")).toHaveText("Offline · showing last confirmed state"); await expect(page.locator("#work-detail-title")).toHaveText("Echo");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
  await page.screenshot({ path: process.env.BARRY_WORK_EVIDENCE_DIR ? join(process.env.BARRY_WORK_EVIDENCE_DIR, "p3-work-surfaces-mobile.png") : test.info().outputPath("work-mobile.png"), fullPage: true });
});

test("ignores a delayed detail response after navigating to another real task", async ({ page }) => {
  const create = async (message: string) => (await (await page.request.post(`${url}/api/v2/work/start`, { headers: { Origin: url }, data: { version: 2, request_id: crypto.randomUUID(), idempotency_key: crypto.randomUUID(), definition: { kind: "workflow", reference: "echo", version: "1" }, inputs: { message } } })).json()).work.work_id as string;
  const first = await create("older detail"), second = await create("newer detail");
  await expect.poll(async () => Promise.all([first, second].map(async id => (await (await page.request.get(`${url}/api/v2/work/${id}`)).json()).state)), { timeout: 15000 }).toEqual(["completed", "completed"]);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), intercepted = new Promise<void>(resolve => { entered = resolve; });
  await page.route(`**/api/v2/work/${first}`, async route => { const response = await route.fetch(); entered(); await gate; await route.fulfill({ response }); });
  try {
    await page.goto(`${url}/work#work/${first}`); await intercepted;
    await page.evaluate(id => { location.hash = `work/${id}`; }, second);
    await expect(page.locator("#work-content [role=status]")).toHaveText("Completed");
    await page.getByRole("button", { name: "View result", exact: true }).click(); await expect(page.locator("#work-result")).toContainText("newer detail");
    release(); await expect(page).toHaveURL(new RegExp(`work/${second}$`)); await expect(page.locator("#work-result")).not.toContainText("older detail");
  } finally { release(); }
});

test("closes a stop confirmation when navigation changes its task", async ({ page }) => {
  const create = async () => (await (await page.request.post(`${url}/api/v2/work/start`, { headers: { Origin: url }, data: { version: 2, request_id: crypto.randomUUID(), idempotency_key: crypto.randomUUID(), definition: { kind: "workflow", reference: "echo", version: "1" }, inputs: { message: "keep waiting", delayMs: 60000 } } })).json()).work.work_id as string;
  const first = await create(), second = await create();
  await page.goto(`${url}/work#work/${first}`); await page.getByRole("button", { name: "Stop task", exact: true }).click(); await expect(page.locator("#stop-dialog")).toBeVisible();
  await page.evaluate(id => { location.hash = `work/${id}`; }, second); await expect(page.locator("#stop-dialog")).toBeHidden();
  await expect(page.locator("#work-content [role=status]")).toHaveText("Waiting");
  expect((await (await page.request.get(`${url}/api/v2/work/${first}`)).json()).facts.stop_requested).toBe(false);
  expect((await (await page.request.get(`${url}/api/v2/work/${second}`)).json()).facts.stop_requested).toBe(false);
});

test("keeps the selected definition stable while a background catalog refresh changes its advertisement", async ({ page }) => {
  await page.locator("#start-task").click(); await page.getByLabel("Message", { exact: true }).fill("selected version stays stable");
  let refreshed = false;
  await page.route("**/api/metadata", async route => { const response = await route.fetch(), value = await response.json(); value.work.definitions[0].version = "unaccepted-advertisement"; refreshed = true; await route.fulfill({ response, json: value }); });
  await page.evaluate(() => document.querySelector("#work-refresh")!.dispatchEvent(new Event("click")));
  await expect.poll(() => refreshed).toBe(true);
  await page.locator("#submit-task").click(); await expect(page.locator("#work-content [role=status]")).toHaveText("Completed");
  await page.getByRole("button", { name: "View result", exact: true }).click(); await expect(page.locator("#work-result")).toContainText("selected version stays stable");
});


test("keeps an old pending request unchanged when recovery metadata requires new invocation keys", async ({ page }) => {
  const epoch = "fae7af55-ad99-4a5f-8bf7-4fe2b2b05439", bodies: Record<string, unknown>[] = []; let active = false;
  // Metadata/payload presentation probe; actual generation enforcement and execution use the runtime restore test.
  await page.route("**/api/v2/work/start", async route => {
    const body = route.request().postDataJSON(); bodies.push(body);
    if (body.recovery_epoch) { await route.abort("failed"); return; }
    const response = await route.fetch(); if (bodies.length === 1) await route.abort("failed"); else await route.fulfill({ response });
  });
  await page.locator("#start-task").click(); await page.getByLabel("Message", { exact: true }).fill("original pending invocation"); await page.locator("#submit-task").click();
  await expect(page.locator("#task-error")).not.toBeEmpty(); const original = bodies[0];
  await page.route("**/api/metadata", async route => { const response = await route.fetch(), value = await response.json(); value.recovery = { version: 1, epoch, active }; value.work.enabled = active; await route.fulfill({ response, json: value }); });
  await page.reload(); await expect(page.locator("#admission-status")).toContainText("paused after restore"); await expect(page.locator("#start-task")).toBeDisabled();
  active = true; await page.locator("#work-refresh").click(); await expect(page.locator("#admission-status")).toContainText("new invocation");
  await page.locator("#retry-submission").click(); await expect(page.locator("#submission-pending")).toBeHidden();
  expect(bodies[1].idempotency_key).toBe(original.idempotency_key); expect(bodies[1].inputs).toEqual(original.inputs); expect(bodies[1]).not.toHaveProperty("recovery_epoch");
  await page.locator("#start-task").click(); await page.getByLabel("Message", { exact: true }).fill("separate new invocation"); await page.locator("#submit-task").click();
  await expect(page.locator("#task-error")).not.toBeEmpty(); expect(bodies[2].recovery_epoch).toBe(epoch); expect(String(bodies[2].idempotency_key).startsWith(`${epoch}:`)).toBe(true);
});

test("review R2-2: definite refusal allows correction and a fresh key across reload", async ({ page }) => {
  const bodies: { idempotency_key: string; inputs: unknown }[] = [];
  await page.route("**/api/v2/work/start", async route => {
    bodies.push(route.request().postDataJSON());
    await route.fulfill({ status: 422, json: { code: "InvalidInputs", error: "Fixture input refused", admission_disposition: "not-accepted" } });
  });
  await page.locator("#start-task").click(); await page.getByLabel("Message", { exact: true }).fill("invalid"); await page.locator("#submit-task").click();
  await expect(page.locator("#task-error")).toContainText("Fixture input refused");
  await page.getByLabel("Message", { exact: true }).fill("corrected"); await page.locator("#submit-task").click();
  await expect.poll(() => bodies.length).toBe(2); expect(bodies[1].idempotency_key).not.toBe(bodies[0].idempotency_key); expect(bodies[1].inputs).toMatchObject({ message: "corrected" });
  await expect(page.locator("#submission-pending")).toBeHidden();
  await page.reload(); await expect(page.locator("#start-task")).toBeEnabled();
});
test("review R2-2: a refusal after an ambiguous reply preserves the original key and payload", async ({ page }) => {
  const bodies: { idempotency_key: string; inputs: unknown }[] = [];
  await page.route("**/api/v2/work/start", async route => {
    bodies.push(route.request().postDataJSON());
    if (bodies.length === 1) { await route.abort("failed"); return; }
    await route.fulfill({ status: 422, json: { code: "InvalidInputs", error: "Fixture refusal after uncertain reply", admission_disposition: "not-accepted" } });
  });
  await page.locator("#start-task").click(); await page.getByLabel("Message", { exact: true }).fill("original"); await page.locator("#submit-task").click();
  await expect(page.locator("#task-error")).not.toBeEmpty(); await page.reload(); await page.locator("#retry-submission").click();
  await expect(page.locator("#work-notice")).toContainText("Fixture refusal"); await expect(page.locator("#start-task")).toBeDisabled();
  expect(bodies[1].idempotency_key).toBe(bodies[0].idempotency_key); expect(bodies[1].inputs).toEqual(bodies[0].inputs);
  await page.reload(); await expect(page.locator("#start-task")).toBeDisabled();
});

test("P5: validates required schema fields locally without burning a key and renders Scheduled view", async ({ page }) => {
  let networkStarts = 0;
  page.on("request", request => { if (request.url().endsWith("/api/v2/work/start")) networkStarts += 1; });
  await page.locator("#start-task").click();
  await page.locator("#task-definition").selectOption({ label: "script" });
  await page.getByLabel("Value", { exact: true }).fill("");
  await page.locator("#submit-task").click();
  expect(networkStarts).toBe(0);
  await expect(page.locator("#task-error")).toContainText("is required");
  await expect(page.getByLabel("Value", { exact: true })).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator("#submission-pending")).toBeHidden();
  await page.getByRole("button", { name: "Close start task" }).click();

  let scheduledRequested = false;
  page.on("request", request => {
    if (request.url().includes("/api/v2/work") && request.url().includes("trigger=schedule")) scheduledRequested = true;
  });
  await page.getByRole("link", { name: "Scheduled", exact: true }).click();
  await expect.poll(() => scheduledRequested).toBe(true);
  await expect(page.locator("#view-title")).toHaveText("Scheduled");
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
});

test("P5: keeps Execution inspector link reachable at 320px width and retains focus when Stop disappears", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await expect(page.getByRole("link", { name: "Execution inspector", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  await task(page, "focus retention check", 60);
  await expect(page.locator("#work-content [role=status]")).toHaveText("Waiting");
  const stopBtn = page.getByRole("button", { name: "Stop task", exact: true });
  await stopBtn.focus();
  await expect(stopBtn).toBeFocused();

  await page.route("**/api/v2/work/work_*", async route => {
    if (route.request().url().endsWith("/result") || route.request().url().endsWith("/stop")) {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const json = await response.json();
    json.state = "completed";
    json.facts = { ...json.facts, coordinator: "completed", phase: "terminal", physical: "ceased", has_result: true };
    json.allowed_actions = ["inspect", "result"];
    await route.fulfill({ response, json });
  });
  await page.evaluate(() => document.querySelector("#work-refresh")!.dispatchEvent(new Event("click")));
  await expect(page.locator("#work-content [role=status]")).toHaveText("Completed");
  await expect(page.locator("#work-detail-title")).toBeFocused();
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
});

test("P5: refreshes stale revision on Stop conflict without trapping in unconfirmed Stop banner", async ({ page }) => {
  await task(page, "stale stop revision", 60);
  await expect(page.locator("#work-content [role=status]")).toHaveText("Waiting");
  await page.route("**/api/v2/work/*/stop", async route => {
    await route.fulfill({
      status: 409,
      json: {
        code: "WorkRevisionConflict",
        error: "Work revision changed before stop was applied.",
        stop_disposition: "refused",
        retryable: false,
      },
    });
  });
  await page.getByRole("button", { name: "Stop task", exact: true }).click();
  await page.locator("#submit-stop").click();
  await expect(page.locator("#stop-dialog")).toBeHidden();
  await expect(page.locator("#stop-pending")).toBeHidden();
  await expect(page.locator("#work-notice")).toContainText("Work revision changed");
});

