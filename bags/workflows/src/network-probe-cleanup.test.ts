import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, it } from "vitest";
import { probeChildrenExitedCleanly, stopProbeChild } from "./network-probe-cleanup.js";

it("recognizes an already-signaled real child without waiting for a lost exit event", async () => {
  const child = spawn(process.execPath, ["-e", "process.send('ready');setInterval(()=>{},1000)"], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  await once(child, "message");
  const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
  expect(child.exitCode).toBeNull(); expect(child.signalCode).toBe("SIGKILL");
  const outcome = await stopProbeChild(child, "owner", 10, 10);
  expect(outcome.exited).toBe(true); expect(outcome.signalCode).toBe("SIGKILL");
  expect(probeChildrenExitedCleanly([outcome, { ...outcome, role: "worker" }])).toBe(false);
});

it("accepts only two distinct graceful zero exits and refuses actual forced cleanup", async () => {
  const child = spawn(process.execPath, ["-e", "const timer=setInterval(()=>{},1000);process.on('SIGTERM',()=>{clearInterval(timer);process.disconnect()});process.send('ready')"], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  await once(child, "message");
  const outcome = await stopProbeChild(child, "owner", 1000, 1000);
  const second = spawn(process.execPath, ["-e", "const timer=setInterval(()=>{},1000);process.on('SIGTERM',()=>{clearInterval(timer);process.disconnect()});process.send('ready')"], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  await once(second, "message");
  const worker = await stopProbeChild(second, "worker", 1000, 1000);
  expect(probeChildrenExitedCleanly([outcome, worker])).toBe(true);
  for (const patch of [{ pid: outcome.pid }, { pid: null }, { exitCode: 1 }, { forcedKill: true }, { exited: false }, { signalCode: "SIGTERM" as const }]) expect(probeChildrenExitedCleanly([outcome, { ...worker, ...patch }])).toBe(false);
  expect(probeChildrenExitedCleanly([outcome, outcome])).toBe(false);
  const stubborn = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},1000)"], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  await once(stubborn, "message");
  const forced = await stopProbeChild(stubborn, "worker", 10, 1000);
  expect(forced.forcedKill).toBe(true); expect(forced.signalCode).toBe("SIGKILL");
  expect(probeChildrenExitedCleanly([outcome, forced])).toBe(false);
});
