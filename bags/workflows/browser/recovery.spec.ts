import { test, expect } from "@playwright/test";
import { join } from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { recoveryFixture } from "./recovery-fixture.js";
let fixture: Awaited<ReturnType<typeof recoveryFixture>>;
test.beforeAll(async () => { fixture = await recoveryFixture(); });
test.afterAll(async () => { await fixture?.close(); });
test.beforeEach(async ({ page }) => {
  await page.goto(fixture.url); await page.getByLabel("Barry secret").fill("recovery-browser-secret"); await page.getByRole("button", { name: "Sign in", exact: true }).click();
});
async function open(page: import("@playwright/test").Page, id: string) {
  await page.goto(`${fixture.url}/work#work/${id}`); await expect(page.locator("#work-content [role=status]")).toHaveText("Needs attention");
  await page.getByRole("button", { name: "Review recovery evidence", exact: true }).click(); await expect(page.locator("#reconcile-evidence")).toContainText("Retained complete outcome");
}
test("reviews a real late result, replays a lost decision after restart, and preserves one audited application", async ({ page }) => {
  const work = await fixture.late("<img src=x onerror=alert(1)> retained outcome");
  await open(page, work.workId); await expect(page.locator("#submit-reconcile")).toBeDisabled();
  await expect(page.locator("#reconcile-evidence")).not.toContainText("null");
  await page.locator("#reconcile-receipt").selectOption("0");
  await page.getByLabel("Why this evidence resolves the problem").fill("Reviewed original execution and retained cessation evidence.");
  await page.getByLabel("Remaining risk you accept").fill("<img src=x onerror=alert(1)> Original known effects only; no second launch.");
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
  if (process.env.BARRY_WORK_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.BARRY_WORK_EVIDENCE_DIR, "p3-recovery-ui-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
  if (process.env.BARRY_WORK_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.BARRY_WORK_EVIDENCE_DIR, "p3-recovery-ui-mobile.png"), fullPage: true });
  const bodies: unknown[] = [];
  await page.route(`**/api/v2/work/${work.workId}/reconciliation`, async route => {
    const response = await route.fetch(); if (route.request().method() !== "POST") { await route.fulfill({ response }); return; }
    bodies.push(route.request().postDataJSON()); if (bodies.length === 1) await route.abort("failed"); else await route.fulfill({ response });
  });
  await page.locator("#submit-reconcile").click(); await expect(page.locator("#reconcile-error")).not.toBeEmpty();
  await expect(page.locator("#reconcile-pending")).toBeVisible(); const requestId = await page.locator("#reconcile-request").textContent();
  await fixture.restart(); await page.reload(); await page.locator("#retry-reconcile").click();
  await expect(page.locator("#reconcile-pending")).toBeHidden(); expect(bodies).toHaveLength(2); expect(bodies[1]).toEqual(bodies[0]);
  await expect(page.locator("#work-content [role=status]")).toHaveText("Completed");
  await page.getByRole("button", { name: "View result", exact: true }).click(); await expect(page.locator("#work-result")).toContainText("retained outcome");
  await page.getByText("Execution details", { exact: true }).click(); await page.getByRole("button", { name: "Review recovery evidence", exact: true }).click();
  await page.getByText(`Decision ${requestId}`, { exact: true }).click(); await expect(page.locator("#reconcile-evidence")).toContainText("Original known effects only");
  await expect(page.locator("#reconcile-evidence img")).toHaveCount(0); await expect(page.locator("#reconcile-receipt")).toBeDisabled();
  expect(fixture.owner.workReconciliationEvidence(work.workId).audit).toHaveLength(1);
  expect(fixture.journal.claimStage(work.binding, "execution").launch).toBe(false); expect(fixture.errors).toEqual([]);
});
test("ignores delayed evidence after navigation and binds a new review to its own task", async ({ page }) => {
  const first = await fixture.late("first retained result"), second = await fixture.late("second retained result");
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), intercepted = new Promise<void>(resolve => { entered = resolve; });
  await page.route(`**/api/v2/work/${first.workId}/reconciliation`, async route => { const response = await route.fetch(); entered(); await gate; await route.fulfill({ response }); });
  try {
    await page.goto(`${fixture.url}/work#work/${first.workId}`); await page.getByRole("button", { name: "Review recovery evidence", exact: true }).click(); await intercepted;
    await page.evaluate(id => { location.hash = `work/${id}`; }, second.workId); await expect(page.locator("#reconcile-dialog")).toBeHidden();
    await page.getByRole("button", { name: "Review recovery evidence", exact: true }).click(); await expect(page.locator("#reconcile-task")).toContainText("reviewed revision");
    release(); await page.locator("#reconcile-receipt").selectOption("0"); await page.getByLabel("Why this evidence resolves the problem").fill("Reviewed the second task."); await page.getByLabel("Remaining risk you accept").fill("Known effects only.");
    const response = page.waitForResponse(response => response.url().endsWith(`/${second.workId}/reconciliation`) && response.request().method() === "POST");
    await page.locator("#submit-reconcile").click(); expect((await response).ok()).toBe(true);
    expect(fixture.owner.workReconciliationEvidence(first.workId).audit).toHaveLength(0); expect(fixture.owner.workReconciliationEvidence(second.workId).audit).toHaveLength(1);
  } finally { release(); }
});
test("keeps unknown evidence disabled and refuses a stale reviewed revision without replacing its request", async ({ page }) => {
  const work = await fixture.late("review only after evidence is known");
  // Presentation-only uncertainty injection; actual receipt/cessation enforcement is covered by SDK/HTTP tests.
  await page.route(`**/api/v2/work/${work.workId}/reconciliation`, async route => { const response = await route.fetch(), evidence = await response.json(); evidence.receipts[0].effect_certainty = "uncertain"; await route.fulfill({ response, json: evidence }); });
  await open(page, work.workId); await expect(page.locator("#reconcile-evidence")).toContainText("cannot be applied"); await expect(page.locator("#reconcile-receipt")).toBeDisabled();
  await expect(page.locator("#submit-reconcile")).toBeDisabled(); await page.getByRole("button", { name: "Close recovery review" }).click();
  await page.unroute(`**/api/v2/work/${work.workId}/reconciliation`); await page.getByRole("button", { name: "Review recovery evidence", exact: true }).click();
  await expect(page.locator("#reconcile-receipt")).toBeEnabled(); await page.locator("#reconcile-receipt").selectOption("0");
  await page.getByLabel("Why this evidence resolves the problem").fill("Previously inspected evidence."); await page.getByLabel("Remaining risk you accept").fill("Original effects only.");
  fixture.owner.cancel(work.workflowId);
  await page.locator("#submit-reconcile").click(); await expect(page.locator("#reconcile-error")).toContainText("Work changed");
  const id = await page.locator("#reconcile-request").textContent(); await page.getByRole("button", { name: "Close recovery review" }).click(); await page.locator("#check-reconcile").click();
  await expect(page.locator("#work-notice")).toContainText("not recorded yet"); await expect(page.locator("#reconcile-request")).toHaveText(id!);
  expect(fixture.owner.workReconciliationEvidence(work.workId).audit).toHaveLength(0);
  await page.locator("#review-reconcile").click(); await expect(page.locator("#reconcile-pending")).toBeHidden(); await expect(page.locator("#reconcile-receipt")).toBeDisabled();
});


test("preserves a request lost before acceptance until the same decision is retried", async ({ page }) => {
  const work = await fixture.late("same reviewed request only"); await open(page, work.workId);
  await page.locator("#reconcile-receipt").selectOption("0"); await page.getByLabel("Why this evidence resolves the problem").fill("Original known result reviewed."); await page.getByLabel("Remaining risk you accept").fill("Original effects only.");
  const requests: unknown[] = [];
  page.on("request", request => { if (request.method() === "POST" && request.url().endsWith(`/${work.workId}/reconciliation`)) requests.push(request.postDataJSON()); });
  await page.route(`**/api/v2/work/${work.workId}/reconciliation`, route => route.request().method() === "POST" ? route.abort("failed") : route.continue());
  await page.locator("#submit-reconcile").click(); await expect(page.locator("#reconcile-error")).not.toBeEmpty();
  await page.getByRole("button", { name: "Close recovery review" }).click(); await page.locator("#review-reconcile").click();
  await expect(page.locator("#work-notice")).toContainText("Retry the same decision before replacing its request"); await expect(page.locator("#reconcile-pending")).toBeVisible();
  expect(fixture.owner.workReconciliationEvidence(work.workId).audit).toHaveLength(0);
  await page.unroute(`**/api/v2/work/${work.workId}/reconciliation`); await page.locator("#retry-reconcile").click(); await expect(page.locator("#reconcile-pending")).toBeHidden();
  expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]); expect(fixture.owner.workReconciliationEvidence(work.workId).audit).toHaveLength(1);
});


test("refreshes recovery permissions even when the canonical task revision stays unchanged", async ({ page }) => {
  const work = await fixture.late("permission refresh"); await page.goto(`${fixture.url}/work#work/${work.workId}`);
  await expect(page.getByRole("button", { name: "Review recovery evidence", exact: true })).toBeVisible();
  // Presentation-only policy change; SDK tests recheck current control authority at the same canonical revision.
  await page.route(`**/api/v2/work/${work.workId}`, async route => { const response = await route.fetch(), value = await response.json(); value.can_review_reconciliation = false; value.allowed_actions = value.allowed_actions.filter((action: string) => action !== "reconcile"); await route.fulfill({ response, json: value }); });
  await page.locator("#work-refresh").click(); await expect(page.getByRole("button", { name: "Review recovery evidence", exact: true })).toHaveCount(0);
  await page.unroute(`**/api/v2/work/${work.workId}`); await page.locator("#work-refresh").click(); await expect(page.getByRole("button", { name: "Review recovery evidence", exact: true })).toBeVisible();
});
