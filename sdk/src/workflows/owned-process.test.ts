import { afterEach, expect, it } from "vitest";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareOwnedProcess } from "./owned-process.js";
import { processBootIdentity } from "./work-process-supervisor.js";

const fixture = fileURLToPath(new URL("./fixtures/owned-process-parent.ts", import.meta.url)), loader = import.meta.resolve("tsx");
type Owned = Awaited<ReturnType<typeof prepareOwnedProcess>>;
type Ready = { ready: true; application: number; descendant: number };
type ParentReady = { ready: true; handle: Owned["handle"]; application: Ready; deadline: number };
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { const failures: unknown[] = [];for (const close of cleanup.splice(0).reverse()) try { await close(); } catch (error) { failures.push(error); }if (failures.length) throw new AggregateError(failures, "Owned process fixture cleanup failed"); });
function directory(): string { const root = mkdtempSync(join(tmpdir(), "owned-process-test-"));cleanup.push(async () => { rmSync(root, { force: true, recursive: true }); });return root; }
function present(pid: number): boolean { try { process.kill(pid, 0);return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;throw error; } }
function groupPresent(pgid: number): boolean { return present(-pgid); }
function start(pid: number): number { return Math.floor(Date.parse(execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim()) / 1000); }
function group(pid: number): number { return Number(execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).trim()); }
function groupMembers(pgid: number): { pid: number; parent: number; group: number; state: string }[] {
  const output = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,pgid=,state="], { encoding: "utf8", timeout: 1000, maxBuffer: 1024 * 1024 });
  return output.trim().split("\n").filter(Boolean).map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
    if (!match) throw new Error("Native group observation was malformed: " + line);
    return { pid: Number(match[1]), parent: Number(match[2]), group: Number(match[3]), state: match[4] };
  }).filter(member => member.group === pgid);
}
function validate(handle: Owned["handle"]): void {
  expect(handle).toMatchObject({ kind: "process", pgid: handle.pid, hostname: hostname(), bootIdentity: processBootIdentity() });
  expect(group(handle.pid)).toBe(handle.pgid);expect(start(handle.pid)).toBe(handle.pidStartedAt);
}
async function prepared(root: string, deadline = Date.now() + 30000): Promise<Owned> {
  const owned = await prepareOwnedProcess({ deadline, tempRoot: root });cleanup.push(() => owned.dispose());validate(owned.handle);return owned;
}
async function launch(owned: Owned, root: string, behavior: "resist" | "exit-on-term" = "resist"): Promise<Ready> {
  const ready = new Promise<Ready>(resolve => { owned.onMessage(message => { if (message && typeof message === "object" && "ready" in message && message.ready === true) resolve(message as Ready); }); });
  await owned.launch({ command: process.execPath, args: ["--import", loader, fixture, "application", root, behavior], cwd: root, env: { PATH: process.env.PATH ?? "", TMPDIR: tmpdir() } });
  const result = await ready;expect(group(result.application)).toBe(owned.handle.pgid);expect(group(result.descendant)).toBe(owned.handle.pgid);return result;
}
async function owner(root: string, deadline: number): Promise<{ child: ChildProcess; ready: ParentReady; closed: Promise<void> }> {
  const child = spawn(process.execPath, ["--import", loader, fixture, "parent", root, String(deadline)], { stdio: ["ignore", "ignore", "pipe", "ipc"], env: { PATH: process.env.PATH, TMPDIR: tmpdir() } });
  let diagnostic = "";child.stderr!.on("data", bytes => { diagnostic = (diagnostic + String(bytes)).slice(-16000); });
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGCONT");child.kill("SIGKILL"); }await closed; });
  const ready = await Promise.race([new Promise<ParentReady>(resolve => child.on("message", value => { if (value && typeof value === "object" && "ready" in value && value.ready === true) resolve(value as ParentReady); })), closed.then(() => { throw new Error("Owned parent exited before readiness: " + diagnostic); })]);
  validate(ready.handle);expect(group(ready.application.descendant)).toBe(ready.handle.pgid);
  cleanup.push(async () => {
    if (!groupPresent(ready.handle.pgid)) return;
    // Failure-only cleanup may signal solely this live, independently rechecked
    // fixture group. It is never evidence of successful autonomous shutdown.
    if (present(ready.handle.pid) && start(ready.handle.pid) === ready.handle.pidStartedAt && group(ready.handle.pid) === ready.handle.pgid && ready.handle.bootIdentity === processBootIdentity()) {
      process.kill(-ready.handle.pgid, "SIGKILL");
      await expect.poll(() => groupPresent(ready.handle.pgid), { timeout: 5000 }).toBe(false);
      throw new Error("Emergency fixture group cleanup was required; autonomous shutdown was not proven");
    }
    throw new Error("Fixture group remains but captured native guardian identity cannot be safely signaled");
  });
  return { child, ready, closed };
}

it("keeps its captured guardian inert until explicit launch and disposes it with exact group proof", async () => {
  const root = directory(), owned = await prepared(root);
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(existsSync(join(root, "application.json"))).toBe(false);expect(existsSync(join(root, "descendant.json"))).toBe(false);
  expect(owned.proveCessation()).toBe(false);await owned.dispose();await owned.closed;
  expect(owned.proveCessation()).toBe(true);expect(groupPresent(owned.handle.pgid)).toBe(false);
});

it("waits for TERM-resistant root and detached-stdio descendant cessation before stop resolves", async () => {
  const root = directory(), owned = await prepared(root), ready = await launch(owned, root);
  let stopped = false;const stopping = owned.stop().then(() => { stopped = true; });
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(present(ready.application)).toBe(true);expect(present(ready.descendant)).toBe(true);
  expect(present(owned.handle.pid)).toBe(true);expect(stopped).toBe(false);expect(owned.proveCessation()).toBe(false);
  await stopping;await owned.closed;expect(owned.proveCessation()).toBe(true);
  expect(present(ready.descendant)).toBe(false);expect(groupPresent(owned.handle.pgid)).toBe(false);
});

it("retains the guardian group identity after graceful application exit while a resistant descendant remains", async () => {
  const root = directory(), owned = await prepared(root), ready = await launch(owned, root, "exit-on-term");
  await owned.send({ command: "exit-root" });await expect.poll(() => present(ready.application)).toBe(false);
  expect(present(ready.descendant)).toBe(true);expect(present(owned.handle.pid)).toBe(true);expect(owned.proveCessation()).toBe(false);
  await owned.stop();expect(present(ready.descendant)).toBe(false);expect(owned.proveCessation()).toBe(true);
});

it("autonomously terminates its captured group after the real owning parent is killed", async () => {
  const root = directory(), parent = await owner(root, Date.now() + 30000), { handle, application } = parent.ready;
  expect(parent.child.kill("SIGKILL")).toBe(true);await parent.closed;
  // This assertion precedes any outer cleanup; no surviving parent timer calls stop.
  await expect.poll(() => groupPresent(handle.pgid), { timeout: 12000 }).toBe(false);
  expect(present(application.descendant)).toBe(false);
});

it("enforces its original absolute deadline while the actual parent event loop is suspended", async () => {
  const root = directory(), parent = await owner(root, Date.now() + 8000), { handle, application, deadline } = parent.ready;
  expect(parent.child.kill("SIGSTOP")).toBe(true);
  try {
    await expect.poll(() => execFileSync("ps", ["-o", "state=", "-p", String(parent.child.pid)], { encoding: "utf8" }).trim().startsWith("T")).toBe(true);
    // A suspended owner cannot reap its dead guardian. Observe autonomous
    // cessation without treating Darwin's zombie-group EPERM as absence.
    await expect.poll(() => groupMembers(handle.pgid), { timeout: 15000 }).toEqual([
      { pid: handle.pid, parent: parent.child.pid, group: handle.pgid, state: expect.stringMatching(/^Z/) },
    ]);
    expect(start(handle.pid)).toBe(handle.pidStartedAt);expect(handle.bootIdentity).toBe(processBootIdentity());
    expect(Date.now()).toBeGreaterThanOrEqual(deadline);
    expect(present(application.application)).toBe(false);expect(present(application.descendant)).toBe(false);
    // No parent timer has resumed or released physical ownership at this point.
    expect(execFileSync("ps", ["-o", "state=", "-p", String(parent.child.pid)], { encoding: "utf8" }).trim()).toMatch(/^T/);
  } finally { parent.child.kill("SIGCONT"); }
  // The fixture close command awaits actual OwnedProcess.dispose(), including
  // guardian child close/reap and strict proveCessation(), before exiting zero.
  parent.child.send({ command: "close" });await parent.closed;expect(parent.child.exitCode).toBe(0);
  expect(groupPresent(handle.pgid)).toBe(false);expect(groupMembers(handle.pgid)).toEqual([]);
  expect(JSON.parse(readFileSync(join(root, "application.json"), "utf8"))).toMatchObject({ pid: application.application });
});

it("refuses an oversized launch without starting an application or leaving an unhandled startup rejection", async () => {
  const root = directory(), owned = await prepared(root), unhandled: unknown[] = [];
  const rejection = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", rejection);
  try {
    await expect(owned.launch({ command: process.execPath, args: ["--import", loader, fixture, "application", root, "resist"], cwd: root,
      env: { PATH: process.env.PATH ?? "", TMPDIR: tmpdir(), OVERSIZED_FIXTURE_VALUE: "x".repeat(1024 * 1024 + 1) } })).rejects.toThrow("budget");
    await owned.closed;
    await new Promise<void>(resolve => setImmediate(resolve));await new Promise<void>(resolve => setImmediate(resolve));
    expect(unhandled).toEqual([]);expect(existsSync(join(root, "application.json"))).toBe(false);expect(existsSync(join(root, "descendant.json"))).toBe(false);
    expect(owned.proveCessation()).toBe(true);expect(groupPresent(owned.handle.pgid)).toBe(false);
  } finally { process.off("unhandledRejection", rejection); }
});

it("bounds stop observation for a suspended inert guardian without inventing cessation", async () => {
  const root = directory(), owned = await prepared(root), handle = owned.handle;
  // The handle is a freshly captured live child owned by this fixture, not a
  // recovered PID. Restore it before cleanup so its real guardian can drain.
  process.kill(handle.pid, "SIGSTOP");
  try {
    await expect.poll(() => execFileSync("ps", ["-o", "state=", "-p", String(handle.pid)], { encoding: "utf8" }).trim().startsWith("T")).toBe(true);
    const began = Date.now();
    await expect(owned.stop()).rejects.toThrow("cessation remains unknown");
    expect(Date.now() - began).toBeLessThan(7200);
    expect(present(handle.pid)).toBe(true);expect(groupPresent(handle.pgid)).toBe(true);expect(owned.proveCessation()).toBe(false);
    expect(existsSync(join(root, "application.json"))).toBe(false);
  } finally { process.kill(handle.pid, "SIGCONT");await owned.dispose(); }
  expect(owned.proveCessation()).toBe(true);expect(groupPresent(handle.pgid)).toBe(false);
}, 12000);

it("refuses to claim cessation after root exit while a detached new-session descendant remains live", async () => {
  const root = directory(), owned = await prepared(root);
  const readyPath = join(root, "detached-ready.json");
  const childCode = `import {writeFileSync} from "node:fs";writeFileSync(${JSON.stringify(readyPath)},JSON.stringify({pid:process.pid}));setTimeout(()=>process.exit(0),2500);`;
  const appCode = `import {spawn} from "node:child_process";import {existsSync} from "node:fs";const child=spawn(process.execPath,["--input-type=module","-e",${JSON.stringify(childCode)}],{detached:true,stdio:"ignore"});child.unref();while(!existsSync(${JSON.stringify(readyPath)}))await new Promise(r=>setTimeout(r,20));process.exit(0);`;
  await owned.launch({ command: process.execPath, args: ["--input-type=module", "-e", appCode], cwd: root, env: { PATH: process.env.PATH ?? "", TMPDIR: tmpdir() } });
  await owned.closed;
  const { pid: detachedPid } = JSON.parse(readFileSync(readyPath, "utf8")) as { pid: number };
  expect(present(detachedPid)).toBe(true);
  expect(group(detachedPid)).toBe(detachedPid);
  expect(owned.proveCessation()).toBe(false);
  await expect(owned.stop()).rejects.toThrow("cessation remains unknown");
  await expect.poll(() => present(detachedPid), { timeout: 5000 }).toBe(false);
  expect(owned.proveCessation()).toBe(true);
}, 12000);
