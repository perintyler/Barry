import { expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Duplex } from "node:stream";
import { z } from "zod";
import { processBootIdentity } from "./work-process-supervisor.js";

const identity = z.strictObject({ pid: z.number().int().positive(), pgid: z.number().int().positive(), pidStartedAt: z.number().finite().positive(), bootIdentity: z.string().min(1), hostname: z.string().min(1) });
const readySchema = z.strictObject({ ready: z.literal(true), guardian: identity, application: identity, descendant: identity, deadline: z.number().int().positive() });
type Identity = z.infer<typeof identity>;
const fixture = fileURLToPath(new URL("./fixtures/guardian-report-loss.ts", import.meta.url)), loader = import.meta.resolve("tsx");
function present(pid: number): boolean {
  try { process.kill(pid, 0);return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;throw error; }
}
function capturedNativeMatches(expected: Identity): boolean {
  if (!present(expected.pid)) return false;
  if (expected.bootIdentity !== processBootIdentity() || expected.hostname !== hostname()) throw new Error("Owned fixture boot/host identity changed; refusing signals");
  const pgid = Number(execFileSync("/bin/ps", ["-o", "pgid=", "-p", String(expected.pid)], { encoding: "utf8", timeout: 1000 }).trim());
  const start = Math.floor(Date.parse(execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(expected.pid)], { encoding: "utf8", timeout: 1000 }).trim()) / 1000);
  if (pgid !== expected.pgid || start !== expected.pidStartedAt) throw new Error("Owned fixture PID identity changed; refusing signals");
  return true;
}

it("retains its live native group and autonomous escalation when application-close verdict reporting loses its private pipe", async () => {
  const root = mkdtempSync(join(tmpdir(), "guardian-report-loss-")), deadline = Date.now() + 30000;
  const child = spawn(process.execPath, ["--import", loader, fixture, "guardian", root, String(deadline)], {
    cwd: root, detached: true, env: { PATH: process.env.PATH, TMPDIR: tmpdir(), LC_ALL: "C" }, stdio: ["ignore", "ignore", "pipe", "pipe", "ipc"],
  });
  let stderr = "", closed = false, ready: z.infer<typeof readySchema> | undefined;
  child.stderr!.on("data", bytes => { stderr = (stderr + String(bytes)).slice(-16000); });
  const terminal = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once("close", (code, signal) => { closed = true;resolve({ code, signal }); }));
  const pipe = child.stdio[3] as Duplex;pipe.on("error", () => {});
  const failures: unknown[] = [];
  try {
    ready = await Promise.race([
      new Promise<z.infer<typeof readySchema>>((resolve, reject) => child.on("message", value => { try { resolve(readySchema.parse(value)); } catch (error) { reject(error); } })),
      terminal.then(() => { throw new Error("Fixture exited before native readiness: " + stderr); }),
    ]);
    expect(ready.guardian.pid).toBe(child.pid);expect(ready.guardian.pgid).toBe(child.pid);
    for (const owned of [ready.guardian, ready.application, ready.descendant]) {
      expect(capturedNativeMatches(owned)).toBe(true);expect(owned.pgid).toBe(ready.guardian.pgid);
    }
    const peerClosed = new Promise<void>(resolve => pipe.once("close", resolve));pipe.destroy();await peerClosed;
    child.send({ command: "exit-application" });
    await expect.poll(() => existsSync(join(root, "report-loss.json")), { timeout: 4000 }).toBe(true);
    const lost = z.strictObject({ code: z.string(), at: z.number() }).parse(JSON.parse(readFileSync(join(root, "report-loss.json"), "utf8")));
    expect(["EPIPE", "ECONNRESET"]).toContain(lost.code);
    expect(existsSync(join(root, "stopping.json"))).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 150));
    // Before any cleanup or parent-issued stop, native ownership survives the
    // throwing report callback and the descendant ignores actual group TERM.
    expect(present(ready.application.pid)).toBe(false);
    expect(capturedNativeMatches(ready.guardian), stderr).toBe(true);
    expect(capturedNativeMatches(ready.descendant)).toBe(true);expect(closed).toBe(false);
    await expect.poll(() => present(-ready!.guardian.pgid), { timeout: 10000 }).toBe(false);
    expect(present(ready.descendant.pid)).toBe(false);
    expect(await terminal).toEqual({ code: null, signal: "SIGKILL" });
    expect(Date.now()).toBeLessThan(deadline); // Application-close escalation, not the fallback deadline.
  } catch (error) { failures.push(error); } finally {
    try {
      if (ready) {
        // Failure-only cleanup is not cessation evidence. Signal only this
        // independently recaptured live group; never use a dead leader's PGID.
        if (capturedNativeMatches(ready.guardian)) process.kill(-ready.guardian.pgid, "SIGKILL");
        else for (const owned of [ready.application, ready.descendant]) if (capturedNativeMatches(owned)) process.kill(owned.pid, "SIGKILL");
      } else if (!closed && child.pid) {
        // No durable metadata means no authority to signal an unknown numeric
        // PID/group. The fixture's retained absolute deadline owns cleanup.
        await expect.poll(() => closed, { timeout: 35000 }).toBe(true);
      }
      await terminal;
      if (ready) await expect.poll(() => present(-ready!.guardian.pgid), { timeout: 3000 }).toBe(false);
    } catch (error) { failures.push(error); }
    if (!failures.length) rmSync(root, { recursive: true, force: true });
  }
  if (failures.length) throw new AggregateError(failures, `Native report-loss fixture failed; retained ${root}`);
}, 20000);
