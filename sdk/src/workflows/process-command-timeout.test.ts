import assert from "node:assert/strict";
import { expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { processBootIdentity } from "./work-process-supervisor.js";

const native = z.object({ pid: z.number().int().positive(), pgid: z.number().int().positive(), pidStartedAt: z.number().finite().positive(), bootIdentity: z.string(), hostname: z.string() });
const readySchema = z.strictObject({ ready: z.literal(true), parent: native, guardian: native, application: native.extend({ startedAt: z.number() }), descendant: native, commandTimeout: z.number(), deadline: z.number() });
type Native = z.infer<typeof native>;
function present(pid: number): boolean { try { process.kill(pid, 0);return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;throw error; } }
function validate(owned: Native): boolean {
  if (!present(owned.pid)) return false;
  const pgid = Number(execFileSync("/bin/ps", ["-o", "pgid=", "-p", String(owned.pid)], { encoding: "utf8", timeout: 1000 }).trim());
  const startedAt = Math.floor(Date.parse(execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(owned.pid)], { encoding: "utf8", timeout: 1000 }).trim()) / 1000);
  if (owned.bootIdentity !== processBootIdentity() || owned.hostname !== hostname() || pgid !== owned.pgid || startedAt !== owned.pidStartedAt) throw new Error("Owned native fixture identity changed; refusing signals");
  return true;
}

/** Test observation only: a stopped owner cannot reap its dead guardian. This
 * does not satisfy production cessation proof, which still requires ESRCH. */
function noExecutableGroupMembers(guardian: Native): boolean {
  const output = execFileSync("/bin/ps", ["-axo", "pid=,pgid=,state=,lstart="], {
    encoding: "utf8", timeout: 1000, maxBuffer: 1024 * 1024, env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
  });
  const members: { pid: number; state: string; startedAt: number }[] = [];
  for (const line of output.trim().split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!match) throw new Error("Native membership observation is unknown");
    if (Number(match[2]) === guardian.pgid) members.push({ pid: Number(match[1]), state: match[3]!, startedAt: Math.floor(Date.parse(match[4]!) / 1000) });
  }
  if (guardian.bootIdentity !== processBootIdentity() || guardian.hostname !== hostname()) throw new Error("Native fixture boot identity changed");
  // Complete absence is also safe to observe; any retained member must be the
  // exact captured guardian zombie, never a runnable or unrecognized survivor.
  return members.length <= 1 && members.every(member => member.pid === guardian.pid && member.state.startsWith("Z") && member.startedAt === guardian.pidStartedAt);
}

it("enforces the shorter native command budget while its actual ProcessExecutor parent is SIGSTOPed", async () => {
  const root = mkdtempSync(join(tmpdir(), "process-command-timeout-")), fixture = fileURLToPath(new URL("./fixtures/process-command-timeout-parent.ts", import.meta.url));
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), fixture, "parent", root, "5000"], {
    cwd: root, env: { PATH: process.env.PATH, TMPDIR: tmpdir(), LC_ALL: "C" }, stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let diagnostic = "", suspended = false, done = false, ready: z.infer<typeof readySchema> | undefined;
  child.stderr!.on("data", bytes => { diagnostic = (diagnostic + String(bytes)).slice(-16000); });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once("close", (code, signal) => { done = true;resolve({ code, signal }); }));
  const failures: unknown[] = [];
  try {
    ready = await Promise.race([new Promise<z.infer<typeof readySchema>>((resolve, reject) => child.once("message", value => { try { resolve(readySchema.parse(value)); } catch (error) { reject(error); } })),
      closed.then(() => { throw new Error("Native command parent ended before readiness: " + diagnostic); })]);
    expect(ready.parent.pid).toBe(child.pid);expect(ready.guardian.pgid).toBe(ready.guardian.pid);
    for (const owned of [ready.parent, ready.guardian, ready.application, ready.descendant]) expect(validate(owned)).toBe(true);
    expect(ready.application.pgid).toBe(ready.guardian.pgid);expect(ready.descendant.pgid).toBe(ready.guardian.pgid);
    expect(ready.deadline - Date.now()).toBeGreaterThan(45000);
    expect(child.kill("SIGSTOP")).toBe(true);suspended = true;
    await expect.poll(() => execFileSync("/bin/ps", ["-o", "state=", "-p", String(child.pid)], { encoding: "utf8", timeout: 1000 }).trim().startsWith("T")).toBe(true);
    // No parent timer/IPC or outer stop runs while it is suspended. The real
    // guardian must narrow from the60s work deadline to the5s command budget.
    // Autonomous execution cessation precedes resume; an unreaped guardian Z
    // may retain its PGID until the stopped owner can collect its exit status.
    await expect.poll(() => noExecutableGroupMembers(ready!.guardian), { timeout: ready.commandTimeout + 8000 }).toBe(true);
    expect(present(ready.descendant.pid)).toBe(false);expect(present(ready.application.pid)).toBe(false);
    expect(Date.now()).toBeLessThan(ready.deadline - 20000);
    expect(execFileSync("/bin/ps", ["-o", "state=", "-p", String(child.pid)], { encoding: "utf8", timeout: 1000 }).trim().startsWith("T")).toBe(true);
    expect(validate(ready.parent)).toBe(true);expect(child.kill("SIGCONT")).toBe(true);suspended = false;
    await expect.poll(() => done, { timeout: 8000 }).toBe(true);
    expect(await closed, diagnostic).toEqual({ code: 0, signal: null });
    // Only after actual owner resume/reap assert full native group absence and
    // the executor's independent production cessation verdict.
    await expect.poll(() => present(-ready!.guardian.pgid), { timeout: 3000 }).toBe(false);
    const result = JSON.parse(readFileSync(join(root, "result.json"), "utf8"));
    expect(result.physical).toMatchObject({ ceased: true, application_started: true });
    expect(result.report).toMatchObject({ passed: false, unknown: true });
  } catch (error) { failures.push(error); } finally {
    try {
      if (suspended) {
        assert.ok(ready && validate(ready.parent), "Lost suspended parent identity; refusing resume");
        child.kill("SIGCONT");suspended = false;
      }
      if (!done) {
        // First let the actual resumed executor's expired command timer drain.
        // Any later failure cleanup is identity-validated, never success proof.
        try { await expect.poll(() => done, { timeout: 8000 }).toBe(true); }
        catch {
          if (ready && validate(ready.guardian)) process.kill(-ready.guardian.pgid, "SIGKILL");
          else if (ready) for (const owned of [ready.application, ready.descendant]) if (validate(owned)) process.kill(owned.pid, "SIGKILL");
          if (ready && validate(ready.parent)) child.kill("SIGKILL");
        }
      }
      await closed;
      if (ready) await expect.poll(() => present(-ready!.guardian.pgid), { timeout: 3000 }).toBe(false);
    } catch (error) { failures.push(error); }
    if (!failures.length) rmSync(root, { recursive: true, force: true });
  }
  if (failures.length) throw new AggregateError(failures, `Native command fixture failed; retained ${root}`);
}, 30000);

it("classifies a graceful TERM-to-zero command as timed out when its parent never consumed the native started marker", async () => {
  const root = mkdtempSync(join(tmpdir(), "process-command-timeout-")), fixture = fileURLToPath(new URL("./fixtures/process-command-timeout-parent.ts", import.meta.url));
  const earlySchema = z.strictObject({ ready: z.literal(true), inert: z.literal(true), parent: native, guardian: native, commandTimeout: z.number(), deadline: z.number() });
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), fixture, "parent", root, "3000", "freeze-inert"], {
    cwd: root, env: { PATH: process.env.PATH, TMPDIR: tmpdir(), LC_ALL: "C" }, stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let ready: z.infer<typeof earlySchema> | undefined, done = false, diagnostic = "";
  child.stderr!.on("data", bytes => { diagnostic = (diagnostic + String(bytes)).slice(-16000); });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once("close", (code, signal) => { done = true;resolve({ code, signal }); }));
  const state = (pid: number) => execFileSync("/bin/ps", ["-o", "state=", "-p", String(pid)], { encoding: "utf8", timeout: 1000 }).trim();
  const failures: unknown[] = [];
  try {
    ready = await Promise.race([new Promise<z.infer<typeof earlySchema>>((resolve, reject) => child.once("message", value => { try { resolve(earlySchema.parse(value)); } catch (error) { reject(error); } })),
      closed.then(() => { throw new Error("Inert command parent ended before readiness: " + diagnostic); })]);
    expect(ready.parent.pid).toBe(child.pid);expect(ready.guardian.pid).toBe(ready.guardian.pgid);
    expect(validate(ready.parent)).toBe(true);expect(validate(ready.guardian)).toBe(true);
    await expect.poll(() => state(ready!.parent.pid).startsWith("T")).toBe(true);
    expect(state(ready.guardian.pid).startsWith("T")).toBe(true);
    // Both real processes are suspended before the guardian could launch its
    // command: there can be no started ACK or armed parent command timer yet.
    expect(() => readFileSync(join(root, "application.json"))).toThrow();
    expect(validate(ready.guardian)).toBe(true);process.kill(ready.guardian.pid, "SIGCONT");
    await expect.poll(() => {
      try { return JSON.parse(readFileSync(join(root, "application.json"), "utf8")).pid as number; } catch { return null; }
    }, { timeout: 3000 }).not.toBeNull();
    const application = native.extend({ startedAt: z.number() }).parse(JSON.parse(readFileSync(join(root, "application.json"), "utf8")));
    expect(validate(application)).toBe(true);expect(application.pgid).toBe(ready.guardian.pgid);
    expect(state(ready.parent.pid).startsWith("T")).toBe(true);
    await expect.poll(() => noExecutableGroupMembers(ready!.guardian), { timeout: ready.commandTimeout + 5000 }).toBe(true);
    expect(present(application.pid)).toBe(false);expect(state(ready.parent.pid).startsWith("T")).toBe(true);
    expect(Date.now()).toBeLessThan(ready.deadline - 30000);
    expect(validate(ready.parent)).toBe(true);child.kill("SIGCONT");
    await expect.poll(() => done, { timeout: 6000 }).toBe(true);
    expect(await closed, diagnostic).toEqual({ code: 0, signal: null });
    // A zombie-only observation above was not production release proof. The
    // resumed executor must now reap and prove strict ESRCH for the whole group.
    await expect.poll(() => present(-ready!.guardian.pgid), { timeout: 3000 }).toBe(false);
    const result = JSON.parse(readFileSync(join(root, "result.json"), "utf8"));
    expect(result.physical).toMatchObject({ ceased: true, application_started: true, command: { code: 0, signal: null, spawn_failed: false }, fault: "EvaluationBudgetExceeded" });
    expect(result.report).toMatchObject({ passed: false, unknown: true, detail: "command timed out" });
  } catch (error) { failures.push(error); } finally {
    try {
      // A failed test still owns these exact live instances. Resume first so
      // their real deadline/stop code can settle; never signal a recovered PGID.
      if (ready && validate(ready.guardian)) process.kill(ready.guardian.pid, "SIGCONT");
      if (!done && ready && validate(ready.parent)) child.kill("SIGCONT");
      if (!done) {
        try { await expect.poll(() => done, { timeout: 9000 }).toBe(true); }
        catch {
          if (ready && validate(ready.guardian)) process.kill(-ready.guardian.pgid, "SIGKILL");
          if (ready && validate(ready.parent)) child.kill("SIGKILL");
        }
      }
      await closed;
      if (ready) await expect.poll(() => present(-ready!.guardian.pgid), { timeout: 3000 }).toBe(false);
    } catch (error) { failures.push(error); }
    if (!failures.length) rmSync(root, { recursive: true, force: true });
  }
  if (failures.length) throw new AggregateError(failures, `Graceful native command fixture failed; retained ${root}`);
}, 25000);
