import { expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";

it("drains the actual service on SIGTERM while an activity child ignores cancellation", async () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-shutdown-"));
  const reserve = createServer(); await new Promise<void>(resolve => reserve.listen(0, "127.0.0.1", resolve));
  const port = (reserve.address() as { port: number }).port; await new Promise<void>(resolve => reserve.close(() => resolve()));
  const artifact = fileURLToPath(new URL("../../../../sdk/src/workflows/execution-fixture.mjs", import.meta.url));
  const manifest = join(root, "artifacts.json");
  writeFileSync(manifest, JSON.stringify({ workflows: [{ path: artifact, type: "stuck-activity", version: "1" }], activities: [{ path: artifact, type: "loop", version: "1" }] }));
  const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./service.ts", import.meta.url))], { env: { PATH: process.env.PATH, BARRY_HOME: join(root, "home"), BARRY_SECRET: "test-shutdown", BARRY_WORKFLOW_MODULE: manifest, BARRY_WORKFLOW_DRAIN_MS: "500", PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", errors = "";
  child.stdout.on("data", data => { output += String(data); }); child.stderr.on("data", data => { errors += String(data); });
  const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
  try {
    await expect.poll(() => output + errors, { timeout: 10_000 }).toContain("runtime ready");
    const url = `http://127.0.0.1:${port}`, headers = { Authorization: "Bearer test-shutdown", "Content-Type": "application/json" };
    const started = await fetch(`${url}/api/runs`, { method: "POST", headers, body: JSON.stringify({ id: "shutdown", type: "stuck-activity", version: "1", input: null }) });
    expect(started.status).toBe(202);
    await expect.poll(async () => { const detail = await (await fetch(`${url}/api/runs/shutdown`, { headers })).json(); return detail.commands[0]?.state; }, { timeout: 5000 }).toBe("leased");
    await new Promise(resolve => setTimeout(resolve, 100));
    const before = performance.now(); child.kill("SIGTERM");
    expect(await exited).toEqual({ code: 0, signal: null });
    expect(performance.now() - before).toBeLessThan(5500);
    expect(errors).not.toMatch(/closed database|not open|incomplete drain/);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; rmSync(root, { recursive: true, force: true }); }
}, 20_000);
