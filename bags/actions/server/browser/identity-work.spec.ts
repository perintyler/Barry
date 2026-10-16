import { test, expect, type Page, type Response } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { installedBrowserServices, type InstalledAcceptedWork } from "./installed-services.js";

let fixture: Awaited<ReturnType<typeof installedBrowserServices>>;
const accepted = z.object({ run_id: z.string(), work_id: z.string(), workflow_id: z.string(), idempotency_key: z.string(), created: z.boolean() });
test.beforeEach(async () => { fixture = await installedBrowserServices(); });
test.afterEach(async ({ page }, info) => {
  if (!fixture) return;
  try {
    if (info.status !== info.expectedStatus) {
      await info.attach("managed-process-diagnostics", { body: JSON.stringify(fixture.diagnostics(), null, 2), contentType: "application/json" });
      await info.attach("browser-failure", { body: await page.screenshot(), contentType: "image/png" });
    }
  } finally { await fixture.close(); }
});
async function signIn(page: Page) {
  await page.goto(fixture.webUrl + "/sign-in");
  await page.getByLabel("Barry secret").fill(fixture.secret);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.goto(fixture.webUrl + "/work");
  const cookies = await page.context().cookies();
  expect(cookies.find(cookie => cookie.name === "barry_session")).toMatchObject({ httpOnly: true, sameSite: "Strict" });
  expect(await page.evaluate(() => document.cookie)).not.toContain("barry_session");
}
async function select(page: Page, mode: "finish" | "wait" = "finish") {
  await page.locator("#session-select").selectOption("owned");
  await page.locator("#load-session").click();
  await page.locator("#task-select").selectOption("fixtureinstalled:probe");
  await page.getByRole("combobox", { name: "mode", exact: true }).selectOption({ label: mode });
}
async function start(page: Page): Promise<Response> {
  const response = page.waitForResponse(value => value.url().endsWith("/api/work/start") && value.request().method() === "POST");
  await page.locator("#start-work").click(); return response;
}
async function complete(page: Page, work: InstalledAcceptedWork) {
  await expect(page.locator("#work-state")).toContainText(/completed/i, { timeout: 20000 });
  await expect(page.locator("#work-output")).toContainText(fixture.expectedCredentialDigest);
  await expect(page.locator("#work-output")).toContainText("<img src=x onerror=alert(1)>");
  await expect(page.locator("#work-output img")).toHaveCount(0);
  expect(fixture.effects(work)).toBe("once");
}
async function nativeRunning(page: Page, work: InstalledAcceptedWork) {
  await page.getByText("Execution details", { exact: true }).click();
  const observation = z.object({ work_id: z.string(), revision: z.number().int().positive(), facts: z.object({ phase: z.string(), physical: z.string() }) });
  await expect.poll(async () => {
    const value = observation.safeParse(JSON.parse(await page.locator("#work-metadata").textContent() || "null"));
    return value.success ? { ...value.data, alive: fixture.childAlive(work), state: await page.locator("#work-state").textContent() } : null;
  }, { timeout: 20000 }).toMatchObject({ work_id: work.work_id, alive: true, state: "Running", facts: { phase: "executing", physical: "running" } });
}

test("signs in, corrects a proven refusal with a new key, and renders selected identity output safely with keyboard and narrow layouts", async ({ page }) => {
  expect((await page.request.get(fixture.webUrl + "/api/work/sessions")).status()).toBe(401);
  await page.goto(fixture.webUrl + "/sign-in"); await page.getByLabel("Barry secret").fill("wrong-fixture-secret");
  await page.getByRole("button", { name: "Sign in", exact: true }).click(); await expect(page.getByText("That is not this instance's secret.")).toBeVisible();
  await signIn(page); await select(page);
  fixture.writeIdentitySecret(false);
  const refused = await start(page); expect(refused.status()).toBe(409);
  expect(await refused.json()).toMatchObject({ admission_disposition: "refused" });
  const refusedIntent = refused.request().postDataJSON();
  await expect(page.locator("#start-work")).toBeEnabled(); expect(fixture.ownerRows()).toHaveLength(0); expect(fixture.effectFiles()).toHaveLength(0);
  fixture.writeIdentitySecret(true);
  await page.locator("#start-work").focus(); const response = page.waitForResponse(value => value.url().endsWith("/api/work/start") && value.request().method() === "POST");
  await page.keyboard.press("Enter"); const started = await response; expect(started.status()).toBe(201);
  const work = accepted.parse(await started.json()); expect(work.idempotency_key).not.toBe(refusedIntent.idempotency_key);
  expect(started.request().postDataJSON()).toMatchObject({ session_id: "owned", action: "fixtureinstalled:probe", inputs: { mode: "finish" } });
  await complete(page, work);
  expect(JSON.parse(String((fixture.ownerRows()[0] as { record: string }).record))).toMatchObject({ namespace: { identity_id: fixture.identity, caller_session_id: "owned" }, plan: { process_program: { credential_owner: { kind: "identity", identity: fixture.identity }, secret_names: ["SCRIPT_KEY"] } } });
  expect(JSON.stringify(fixture.ownerRows())).not.toContain(fixture.selectedSecret);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
  await page.screenshot({ path: test.info().outputPath("identity-work-narrow.png"), fullPage: true });
});

test("keeps an ambiguous submission across reload and recovers its original work after API restart and ordinary session closure", async ({ page }) => {
  await signIn(page); await select(page); fixture.relayState.dropSubmissionReply = true;
  const ambiguous = await start(page); expect(ambiguous.status()).toBe(503);
  const original = ambiguous.request().postDataJSON(); await expect(page.locator("#submission-key")).toContainText(original.idempotency_key);
  expect(fixture.ownerRows()).toHaveLength(1);
  const persisted = JSON.parse(String((fixture.ownerRows()[0] as { record: string }).record));
  const work: InstalledAcceptedWork = { run_id: persisted.action_id, work_id: persisted.work_id, workflow_id: persisted.workflow_id, idempotency_key: original.idempotency_key, created: false };
  await expect.poll(async () => (await fixture.workResult(work)).outcome?.ok, { timeout: 20000 }).toBe(true);
  await fixture.readOnlyBounds(); await fixture.endSession(); await fixture.restartApi();
  await page.reload(); await expect(page.locator("#submission-key")).toContainText(original.idempotency_key);
  const retryResponse = page.waitForResponse(value => value.url().endsWith("/api/work/start") && value.request().method() === "POST");
  await page.locator("#retry-submission").click(); const refusedRetry = await retryResponse; expect(refusedRetry.status()).toBe(403);
  expect(refusedRetry.request().postDataJSON()).toEqual(original);
  await expect(page.locator("#submission-key")).toContainText(original.idempotency_key);
  await page.locator("#check-submission").click();
  await expect(page.locator("#work-detail")).toContainText(work.work_id);
  await complete(page, work);
  await page.locator("#lookup-key").fill(original.idempotency_key); await page.locator("#lookup-work").click();
  await expect(page.locator("#work-detail")).toContainText(work.work_id);
  expect(fixture.relayState.submissions).toBe(1); expect(fixture.ownerRows()).toHaveLength(1); expect((await fixture.sessionState()).state).toBe("closed");
});

test("acknowledges Stop before physical cessation and releases held capacity only after the native receipt", async ({ page }) => {
  await signIn(page); await select(page, "wait"); const response = await start(page); expect(response.status()).toBe(201);
  const work = accepted.parse(await response.json()); await nativeRunning(page, work);
  await expect(page.locator("#request-stop")).toBeEnabled(); await page.locator("#request-stop").click();
  await expect(page.locator("#stop-dialog")).toBeVisible();
  // Simulate selection navigation arriving while the modal owns pointer/keyboard focus.
  await page.evaluate(() => { const selected = document.querySelector<HTMLSelectElement>("#session-select")!; selected.value = "other"; selected.dispatchEvent(new Event("change", { bubbles: true })); });
  await expect(page.locator("#stop-dialog")).not.toBeVisible(); await expect(page.locator("#work-detail")).not.toBeVisible();
  expect(fixture.stopAudits(work)).toHaveLength(0); expect(fixture.childAlive(work)).toBe(true);
  await select(page, "wait"); await page.locator("#lookup-key").fill(work.idempotency_key); await page.locator("#lookup-work").click();
  await expect(page.locator("#request-stop")).toBeVisible(); await page.locator("#request-stop").click();
  const stopped = page.waitForResponse(value => value.url().includes(`/api/work/items/${work.work_id}/stop`) && value.request().method() === "POST");
  await page.locator("#confirm-stop").click(); const ack = await stopped; expect(ack.status()).toBe(202);
  expect(await ack.json()).toMatchObject({ work_id: work.work_id, stop_requested: true });
  await expect(page.locator("#stop-status")).toContainText(/requested|stopping/i);
  expect(fixture.childAlive(work)).toBe(true); expect(fixture.reservation(work)).toMatchObject({ state: "held" });
  await expect.poll(() => fixture.receipt(work)?.physical_state, { timeout: 15000 }).toBe("ceased");
  expect(fixture.receipt(work)).toMatchObject({ effect_certainty: "uncertain", outcome: "uncertain" });
  expect(fixture.childAlive(work)).toBe(false); await expect.poll(() => fixture.reservation(work)?.state, { timeout: 5000 }).toBe("released");
  expect(fixture.effects(work)).toBe("once"); expect(fixture.stopAudits(work)).toHaveLength(1);
});

test("rejects invalid identity selection and stale session binding without operator fallback or cross-origin effects", async ({ page, browser }) => {
  await signIn(page); await select(page);
  for (const session of ["missing", "foreign", ""]) {
    const status = await page.evaluate(async ({ session }) => (await fetch("/api/work/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id: session, action: "fixtureinstalled:probe", request_id: crypto.randomUUID(), idempotency_key: crypto.randomUUID(), inputs: { mode: "finish" } }) })).status, { session });
    expect([403, 404, 422]).toContain(status);
  }
  const context = await browser.newContext();
  try {
    await context.addCookies(await page.context().cookies());
    const denied = await context.request.post(fixture.webUrl + "/api/work/start", { headers: { Origin: "https://foreign.example", "Sec-Fetch-Site": "cross-site" }, data: { session_id: "owned", action: "fixtureinstalled:probe", request_id: randomUUID(), idempotency_key: randomUUID(), inputs: { mode: "finish" } } });
    expect(denied.status()).toBe(403);
  } finally { await context.close(); }
  await fixture.rebindSession(); const stale = await start(page); expect([403, 404, 409]).toContain(stale.status());
  expect(fixture.ownerRows()).toHaveLength(0); expect(fixture.relayState.submissions).toBe(0); expect(fixture.effectFiles()).toHaveLength(0);
});

test("recovers from malformed local storage without disabling manual server lookup", async ({ page }) => {
  await signIn(page);
  const work = await fixture.accept(fixture.request("storage-recovery"));
  await expect.poll(async () => (await fixture.workResult(work)).outcome?.ok, { timeout: 20000 }).toBe(true);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  for (const raw of ["{", JSON.stringify({ pending: { session: "owned" }, pendingStop: { session: "owned", workId: "invalid" }, current: { session: "owned", workId: [] } })]) {
    await page.evaluate(value => sessionStorage.setItem("barry-identity-work-v1", value), raw);
    await page.reload();
    await expect(page.locator("#submission-status")).toContainText(/local recovery data.*unavailable|local recovery data.*unreadable/i);
    await select(page); await expect(page.locator("#start-work")).toBeEnabled();
    await page.locator("#lookup-key").fill(work.idempotency_key); await page.locator("#lookup-work").click();
    await complete(page, work);
  }
  expect(errors).toEqual([]); expect(fixture.ownerRows()).toHaveLength(1); expect(fixture.relayState.submissions).toBe(1);
});

test("clears prior output and logs while another real result is delayed or its new detail is refused", async ({ page }) => {
  await signIn(page); await select(page); const firstResponse = await start(page); expect(firstResponse.status()).toBe(201);
  const first = accepted.parse(await firstResponse.json()); await complete(page, first);
  expect(await page.locator("#work-logs").textContent()).toContain(`script-log-${first.run_id}`);
  const second = await fixture.accept(fixture.request("second-result"));
  await expect.poll(async () => (await fixture.workResult(second)).outcome?.ok, { timeout: 20000 }).toBe(true);
  let release = () => {}; const gate = new Promise<void>(resolve => { release = resolve; });
  let reached = () => {}; const requestReached = new Promise<void>(resolve => { reached = resolve; });
  const resultPattern = `**/api/work/items/${second.work_id}/result?*`;
  await page.route(resultPattern, async route => {
    const actual = await route.fetch(); reached(); await gate; await route.fulfill({ response: actual });
  });
  try {
    await page.locator("#lookup-key").fill(second.idempotency_key); await page.locator("#lookup-work").click(); await requestReached;
    await expect(page.locator("#work-detail")).toContainText(second.work_id);
    await expect(page.locator("#work-output")).toBeEmpty(); await expect(page.locator("#work-logs")).toBeEmpty();
  } finally { release(); }
  await complete(page, second); await expect(page.locator("#work-output")).toContainText(second.run_id);
  await expect(page.locator("#work-output")).not.toContainText(first.run_id);
  expect(await page.locator("#work-logs").textContent()).toContain(`script-log-${second.run_id}`);
  await page.unroute(resultPattern);

  const third = await fixture.accept(fixture.request("third-refused-detail"));
  await expect.poll(async () => (await fixture.workResult(third)).outcome?.ok, { timeout: 20000 }).toBe(true);
  // Change real persisted authority before the actual new detail request; its refusal is not fabricated.
  const detailPattern = `**/api/work/items/${third.work_id}?*`;
  let rebound = false;
  await page.route(detailPattern, async route => { if (!rebound) { rebound = true; await fixture.rebindSession(); } await route.continue(); });
  await page.locator("#lookup-key").fill(third.idempotency_key); await page.locator("#lookup-work").click();
  await expect(page.locator("#work-error")).toContainText(/observation unavailable/i);
  await expect(page.locator("#work-state")).toHaveText("Unavailable");
  await expect(page.locator("#work-output")).toBeEmpty(); await expect(page.locator("#work-logs")).toBeEmpty();
  await expect(page.locator("#work-title")).not.toContainText(second.run_id);
  expect(fixture.ownerRows()).toHaveLength(3); expect(fixture.effects(first)).toBe("once"); expect(fixture.effects(second)).toBe("once"); expect(fixture.effects(third)).toBe("once");
});

test("recovers a lost real Stop reply after reload using the original work, session, revision and reason", async ({ page }) => {
  await signIn(page); await select(page, "wait"); const started = await start(page); expect(started.status()).toBe(201);
  const work = accepted.parse(await started.json()); await nativeRunning(page, work);
  await expect(page.locator("#request-stop")).toBeVisible(); await page.locator("#request-stop").click();
  const reason = "Preserve the original browser Stop reason across reply loss";
  await page.locator("#stop-reason").fill(reason); fixture.relayState.dropStopReply = true;
  const lostReply = page.waitForResponse(response => response.url().includes(`/api/work/items/${work.work_id}/stop`) && response.request().method() === "POST");
  await page.locator("#confirm-stop").click(); const lost = await lostReply; expect(lost.status()).toBe(503);
  const original = lost.request().postDataJSON(); expect(original.reason).toBe(reason);
  expect(new URL(lost.url()).searchParams.get("session_id")).toBe("owned");
  await expect(page.locator("#stop-status")).toContainText(original.request_id);
  expect(fixture.relayState.stopReplies).toHaveLength(1); expect(fixture.stopAudits(work)).toHaveLength(1);

  await page.reload(); await expect(page.locator("#stop-status")).toContainText(original.request_id);
  await page.locator("#session-select").selectOption("other");
  await expect(page.locator("#stop-status")).toContainText(`Session owned`); await expect(page.locator("#retry-stop")).toBeVisible();
  const retried = page.waitForResponse(response => response.url().includes(`/api/work/items/${work.work_id}/stop`) && response.request().method() === "POST");
  await page.locator("#retry-stop").click(); const confirmed = await retried; expect(confirmed.status()).toBe(202);
  expect(confirmed.request().postDataJSON()).toEqual(original); expect(new URL(confirmed.url()).searchParams.get("session_id")).toBe("owned");
  expect(await confirmed.json()).toEqual(fixture.relayState.stopReplies[0]);
  expect(fixture.relayState.stopReplies).toHaveLength(2); expect(fixture.relayState.stopReplies[1]).toEqual(fixture.relayState.stopReplies[0]);
  expect(fixture.relayState.stopBodies.map(body => JSON.parse(body))).toEqual([original, original]);
  await expect(page.locator("#stop-status")).toContainText(`Stop requested for ${work.work_id}`);
  await expect.poll(() => fixture.receipt(work)?.physical_state, { timeout: 15000 }).toBe("ceased");
  expect(fixture.receipt(work)).toMatchObject({ effect_certainty: "uncertain", outcome: "uncertain" });
  expect(fixture.childAlive(work)).toBe(false); await expect.poll(() => fixture.reservation(work)?.state, { timeout: 5000 }).toBe("released");
  expect(fixture.effects(work)).toBe("once"); expect(fixture.stopAudits(work)).toHaveLength(1); expect(fixture.ownerRows()).toHaveLength(1);
});
