import type { OneOff } from "./one-offs.js";

const isoOrNull = (d: Date | null) => (d ? d.toISOString() : null);

export function serializeOneOff(o: OneOff) {
  return {
    id: o.id,
    bag: o.bag,
    action: o.action,
    job: o.job,
    inputs: o.inputs,
    permissions: o.permissions,
    dueAt: o.dueAt.toISOString(),
    createdAt: o.createdAt.toISOString(),
    updatedAt: o.updatedAt.toISOString(),
    status: o.status,
    reason: o.reason,
    idempotencyKey: o.idempotencyKey,
    timeoutS: o.timeoutS,
    retryAttempts: o.retryAttempts,
    failures: o.failures,
    recoveries: o.recoveries,
    ...(o.attempts
      ? {
          attempts: o.attempts.map((a) => ({
            id: a.id,
            number: a.number,
            runId: a.runId,
            startedAt: a.startedAt.toISOString(),
            finishedAt: isoOrNull(a.finishedAt),
            outcome: a.outcome,
            exitCode: a.exitCode,
          })),
        }
      : {}),
  };
}
