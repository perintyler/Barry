import { expect, it } from "vitest";
import { ActivityWorker } from "./activity-worker.js";
import { WorkerCredentialRejected } from "./worker-client.js";
import type { ActivityTask, OwnerConnection } from "./types.js";

const task: ActivityTask = { owner: "owner", runId: "run", activityId: "a1", idempotencyKey: "run/a1", type: "slow", input: null, attempt: 1, token: "t1", deadline: Date.now() + 60_000, timeoutMs: 60_000, heartbeatMs: 1 };

it("aborts a running activity and drops it once the owner rejects this worker's credential", async () => {
  let revoked = false, claimed = false, completions = 0, aborted = false;
  const connection: OwnerConnection = {
    advertise: async () => { if (revoked) throw new WorkerCredentialRejected(401); },
    claim: async () => { if (claimed) return null; claimed = true; return { ...task }; },
    heartbeat: async () => { if (revoked) throw new WorkerCredentialRejected(401); return true; },
    decline: async () => true,
    complete: async () => { completions++; return true; },
  };
  const errors: unknown[] = [];
  const worker = new ActivityWorker({
    connections: [connection], capacity: 1, onError: error => errors.push(error),
    activities: { slow: async (_input, context) => new Promise((_resolve, reject) => context.signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); })) },
  });
  await expect.poll(async () => { await worker.tick(); return claimed; }).toBe(true);
  revoked = true;
  await expect.poll(async () => { await worker.tick(); return aborted; }).toBe(true);
  await worker.tick(); await worker.tick();
  expect(completions).toBe(0);
  expect(errors.some(error => error instanceof WorkerCredentialRejected)).toBe(true);
  expect(await worker.drain(500)).toBe(true);
});
