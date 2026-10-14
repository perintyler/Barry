import { z } from "zod";
import { randomUUID } from "node:crypto";
import { advertisementSchema, encodeEnvelope as encode, identifier, outcomeSchema, type Outcome, type OwnerConnection } from "./types.js";
import type { WorkflowOwner } from "./workflow-owner.js";

const requestSchema = z.discriminatedUnion("operation", [
  z.strictObject({ version: z.literal(1), operation: z.literal("advertise"), advertisement: advertisementSchema }),
  z.strictObject({ version: z.literal(1), operation: z.literal("claim") }),
  z.strictObject({ version: z.literal(1), operation: z.literal("heartbeat"), token: identifier }),
  z.strictObject({ version: z.literal(1), operation: z.literal("complete"), token: identifier, outcome: outcomeSchema }),
]);
const sessionFields = { version: z.literal(2), session: identifier, epoch: identifier };
const v2Schema = z.discriminatedUnion("operation", [
  z.strictObject({ version: z.literal(2), operation: z.literal("probe") }),
  z.strictObject({ version: z.literal(2), operation: z.literal("hello"), session: identifier }),
  z.strictObject({ ...sessionFields, operation: z.literal("advertise"), advertisement: advertisementSchema }),
  z.strictObject({ ...sessionFields, operation: z.literal("claim"), requestId: identifier }),
  z.strictObject({ ...sessionFields, operation: z.literal("heartbeat"), token: identifier }),
  z.strictObject({ ...sessionFields, operation: z.literal("decline"), token: identifier }),
  z.strictObject({ ...sessionFields, operation: z.literal("settle"), token: identifier }),
  z.strictObject({ ...sessionFields, operation: z.literal("complete"), token: identifier, outcome: outcomeSchema }),
]);

export function dispatchWorkerRequest(owner: WorkflowOwner, authenticatedWorker: string, request: unknown): unknown {
  const json: unknown = JSON.parse(encode(request));
  if (json && typeof json === "object" && "version" in json && json.version === 2) {
    const message = v2Schema.parse(json);
    if (message.operation === "probe") return { version: 2, owner: owner.id };
    if (message.operation === "hello") {
      owner.openSession(authenticatedWorker, message.session);
      return { version: 2, owner: owner.id, epoch: owner.epoch, features: ["claim-receipts", "decline", "session-fencing"], maxEnvelopeBytes: 1_048_576 };
    }
    owner.assertSession(authenticatedWorker, message.session, message.epoch);
    switch (message.operation) {
      case "advertise": owner.advertise(authenticatedWorker, message.advertisement); return null;
      case "claim": return owner.claim(authenticatedWorker, message.requestId);
      case "heartbeat": return owner.heartbeat(authenticatedWorker, message.token);
      case "decline": return owner.decline(authenticatedWorker, message.token);
      case "settle": return owner.settlePhysical(authenticatedWorker, message.token);
      case "complete": return { status: owner.completeStatus(authenticatedWorker, message.token, message.outcome) };
    }
  }
  const parsed = requestSchema.parse(JSON.parse(encode(request)));
  if (owner.asynchronous && (parsed.operation === "advertise" || parsed.operation === "claim")) throw new Error("protocol v2 negotiation required for new work");
  switch (parsed.operation) {
    case "advertise": owner.advertise(authenticatedWorker, parsed.advertisement); return null;
    case "claim": return owner.claim(authenticatedWorker);
    case "heartbeat": return owner.heartbeat(authenticatedWorker, parsed.token);
    case "complete": return owner.complete(authenticatedWorker, parsed.token, parsed.outcome);
  }
}

export function connectOwnerV2(ownerId: string, call: (request: unknown) => Promise<unknown>): OwnerConnection {
  const session = randomUUID();
  let epoch = "";
  const hello = async () => {
    const response = z.object({ version: z.literal(2), owner: identifier, epoch: identifier, features: z.array(z.string()), maxEnvelopeBytes: z.number().int() }).parse(await call({ version: 2, operation: "hello", session }));
    if (response.owner !== ownerId || response.maxEnvelopeBytes < 1_048_576 || !response.features.includes("claim-receipts")) throw new Error("incompatible workflow owner");
    epoch = response.epoch;
  };
  const send = async (body: object) => { if (!epoch) await hello(); return call(JSON.parse(encode({ version: 2, session, epoch, ...body }))); };
  return {
    advertise: async advertisement => { await hello(); await send({ operation: "advertise", advertisement }); },
    claim: async (requestId = randomUUID()) => {
      const task = z.nullable(taskSchema).parse(await send({ operation: "claim", requestId }));
      if (task && task.owner !== ownerId) throw new Error("owner identity mismatch");
      return task;
    },
    heartbeat: async token => z.boolean().parse(await send({ operation: "heartbeat", token })),
    decline: async token => z.boolean().parse(await send({ operation: "decline", token })),
    settlePhysical: async token => z.boolean().parse(await send({ operation: "settle", token })),
    complete: async (token, outcome) => {
      const result = z.object({ status: z.enum(["accepted", "alreadyAccepted", "stale", "conflict"]) }).parse(await send({ operation: "complete", token, outcome }));
      return result.status === "accepted" || result.status === "alreadyAccepted";
    },
  };
}

const taskSchema = z.strictObject({
  owner: identifier, runId: identifier, activityId: identifier, idempotencyKey: identifier,
  type: identifier, input: z.json(), attempt: z.number().int().positive(), token: identifier,
  artifact: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  grantRevision: z.number().int().positive().optional(),
  deadline: z.number().int().nonnegative(), timeoutMs: z.number().int().positive(), heartbeatMs: z.number().int().positive(),
});

export function connectOwner(ownerId: string, call: (request: unknown) => Promise<unknown>): OwnerConnection {
  return {
    advertise: async advertisement => { await call({ version: 1, operation: "advertise", advertisement }); },
    claim: async () => {
      const task = z.nullable(taskSchema).parse(JSON.parse(encode(await call({ version: 1, operation: "claim" }))));
      if (task && task.owner !== ownerId) throw new Error("owner identity mismatch");
      return task;
    },
    heartbeat: async token => z.boolean().parse(await call({ version: 1, operation: "heartbeat", token })),
    complete: async (token: string, outcome: Outcome) => z.boolean().parse(await call({ version: 1, operation: "complete", token, outcome })),
  };
}
