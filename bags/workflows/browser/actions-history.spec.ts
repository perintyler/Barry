import { test, expect } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
let server: Server, url: string;
const record = (id: string) => ({ run_id: id, action: `fixture:${id}`, status: id === "checked" ? "failed" : "started", summary: "Owned by Background work", started_at: new Date().toISOString(),
  output: id === "checked" ? '{"answer":42}' : null, output_type: id === "checked" ? "json" : null,
  workflow: { work_id: id, workflow_id: `workflow-${id}`, owner: "owner", revision: 3, state: id === "stale" ? "needs-attention" : id === "checked" ? "completed" : "stopping", current: id !== "stale", url: id === "bad-url" ? "javascript:alert(1)" : `http://localhost:1234/work#work/${id}` } });
test.beforeAll(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url!, "http://fixture").pathname;
    const json = (value: unknown) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(value)); };
    if (path === "/api/catalog") return json({ actions: [] });
    if (path === "/api/runs") return json({ runs: [record("one"), record("stale"), record("bad-url"), record("checked")] });
    if (path.startsWith("/api/runs/")) return json(record(path.split("/").at(-1)!));
    const file = path === "/" ? "index.html" : path.slice(1);
    if (!["index.html", "app.js", "app.css", "search.js"].includes(file)) { res.writeHead(404).end(); return; }
    res.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html");
    res.end(readFileSync(new URL(`../../actions/web/${file}`, import.meta.url)));
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done)); url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
test.afterAll(() => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }));
test.beforeEach(async ({ page }) => { await page.goto(url); await page.locator("button[data-view=runs]").click(); });
test("renders pending Stop and links to the owner's Work surface", async ({ page }) => {
  await page.locator("#runs button").filter({ hasText: "one" }).click();
  await expect(page.locator("#sheet-body")).toContainText("Stopping");
  await expect(page.getByRole("link", { name: "Open Background work" })).toHaveAttribute("href", "http://localhost:1234/work#work/one");
  await expect(page.getByRole("link", { name: "Open Background work" })).toHaveAttribute("rel", "noopener");
});
test("explains stale recovery and refuses script URLs", async ({ page }) => {
  await page.locator("#runs button").filter({ hasText: "stale" }).click();
  await expect(page.locator("#sheet-body")).toContainText("Needs attention"); await expect(page.locator("#sheet-body")).toContainText("awaits recovery");
  await page.locator("#sheet-close").click(); await page.locator("#runs button").filter({ hasText: "bad-url" }).click();
  await expect(page.locator("#sheet-body")).toContainText("Stopping");
  await expect(page.getByRole("link", { name: "Open Background work" })).toHaveCount(0);
});

test("shows completed main work with failed checks and keeps its deliverable readable", async ({ page }) => {
  await page.locator("#runs button").filter({ hasText: "checked" }).click();
  await expect(page.locator("#sheet-body")).toContainText("Completed; checks failed");
  const output = page.locator("#sheet-body .report");
  await expect(output).toBeVisible();
  expect(JSON.parse((await output.textContent())!)).toEqual({ answer: 42 });
  await expect(page.getByRole("link", { name: "Open Background work" })).toHaveAttribute("href", "http://localhost:1234/work#work/checked");
});
