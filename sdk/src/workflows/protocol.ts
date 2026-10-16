import { z } from "zod";
import { randomUUID } from "node:crypto";
import { advertisementSchema, encodeEnvelope as encode, identifier, outcomeSchema, type Outcome, type OwnerConnection } from "./types.js";
import type { WorkflowOwner } from "./workflow-owner.js";
import { executorFeaturesSchema, executorStartSchema, executorObservationSchema, workReceiptSchema } from "./work-contracts.js";
import { boundFingerprint } from "../bounds/workflow-bounds.js";
import { workExecutionDelegationSchema } from "./work-execution-delegation.js";
const workSession = { version: z.literal(3), session: identifier, epoch: identifier };
export const workWorkerSchema = z.discriminatedUnion("operation", [
  z.strictObject({ version: z.literal(3), operation: z.literal("hello"), session: identifier }),
  z.strictObject({ ...workSession, operation: z.literal("advertise"), advertisement: advertisementSchema, features: executorFeaturesSchema }),
  z.strictObject({ ...workSession, operation: z.literal("claim"), requestId: identifier }),
  z.strictObject({ ...workSession, operation: z.literal("heartbeat"), token: identifier }),
  z.strictObject({ ...workSession, operation: z.literal("effect"), token: identifier }),
  z.strictObject({ ...workSession, operation: z.literal("begin"), token: identifier }),
  z.strictObject({ ...workSession, operation: z.literal("delegation"), token: identifier }),
  z.strictObject({ ...workSession, operation: z.literal("inspect"), token: identifier }),
  z.strictObject({ ...workSession, operation: z.literal("observe"), token: identifier, observation: executorObservationSchema }),
  z.strictObject({ ...workSession, operation: z.literal("complete"), token: identifier, receipt: workReceiptSchema }),
]);

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
  if (json && typeof json === "object" && "version" in json && json.version === 3) {
    const message = workWorkerSchema.parse(json);
    if (message.operation === "hello") {
      owner.openSession(authenticatedWorker, message.session);
      return { version: 3, owner: owner.id, epoch: owner.epoch, features: ["work-receipts", "work-observations", "online-effects", "launch-authorizations", "execution-delegations"], maxEnvelopeBytes: 1_048_576 };
    }
    owner.assertSession(authenticatedWorker, message.session, message.epoch);
    switch (message.operation) {
      case "advertise": owner.advertiseWork(authenticatedWorker, message.advertisement, message.features); return null;
      case "claim": return owner.claimWork(authenticatedWorker, message.requestId);
      case "heartbeat": return owner.heartbeat(authenticatedWorker, message.token);
      case "effect": return owner.assertWorkEffect(authenticatedWorker, message.token);
      case "begin": return owner.beginWork(authenticatedWorker, message.token);
      case "delegation": return owner.executionDelegation(authenticatedWorker, message.token);
      case "inspect": return owner.inspectWork(authenticatedWorker, message.token);
      case "observe": return { status: owner.observeWork(authenticatedWorker, message.token, message.observation) };
      case "complete": return { status: owner.completeWorkReceipt(authenticatedWorker, message.token, message.receipt) };
    }
  }
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
  work: executorStartSchema.optional(),
  owner: identifier, runId: identifier, activityId: identifier, idempotencyKey: identifier,
  type: identifier, input: z.json(), attempt: z.number().int().positive(), token: identifier,
  artifact: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  grantRevision: z.number().int().positive().optional(),
  deadline: z.number().int().nonnegative(), timeoutMs: z.number().int().positive(), heartbeatMs: z.number().int().positive(),
});
export const workTaskSchema = taskSchema;
export function connectWorkOwnerV3(ownerId: string, call: (request: unknown) => Promise<unknown>) {
  const session = randomUUID(); let epoch = ""; let executionDelegations = false;
  const hello = async () => {
    const response = z.strictObject({ version: z.literal(3), owner: identifier, epoch: identifier, features: z.array(identifier), maxEnvelopeBytes: z.number().int() })
      .parse(await call({ version: 3, operation: "hello", session }));
    if (response.owner !== ownerId || response.maxEnvelopeBytes < 1048576 || !["work-receipts", "work-observations", "online-effects", "launch-authorizations"].every(feature => response.features.includes(feature)))
      throw new Error("incompatible common-work owner");
    epoch = response.epoch;
    executionDelegations = response.features.includes("execution-delegations");
  };
  const send = async (body: object) => { if (!epoch) await hello(); return call(JSON.parse(encode({ version: 3, session, epoch, ...body }))); };
  return {
    advertise: async (advertisement: z.input<typeof advertisementSchema>, features: z.infer<typeof executorFeaturesSchema>) => { await hello(); await send({ operation: "advertise", advertisement, features }); },
    claim: async (requestId: string) => {
      const task = z.nullable(taskSchema).parse(await send({ operation: "claim", requestId }));
      if (task && (!task.work || task.owner !== ownerId || task.work.owner !== ownerId || task.work.attempt_id !== task.token || task.work.activity_id !== task.activityId || task.work.workflow_id !== task.runId || task.work.deadline !== task.deadline || task.work.source.digest !== task.artifact || task.work.execution_fence !== task.attempt || task.work.grant_revision !== task.grantRevision || boundFingerprint(task.work.inputs) !== boundFingerprint(task.input)))
        throw new Error("common-work task binding mismatch");
      return task;
    },
    heartbeat: async (token: string) => z.boolean().parse(await send({ operation: "heartbeat", token })),
    begin: async (token: string) => {
      const start = executorStartSchema.parse(await send({ operation: "begin", token }));
      if (!start.launch_authorized || start.owner !== ownerId || start.attempt_id !== token) throw new Error("invalid launch authorization binding");
      return start;
    },
    effect: async (token: string) => z.boolean().parse(await send({ operation: "effect", token })),
    delegation: async (token: string) => {
      if (!epoch) await hello();
      if (!executionDelegations) throw new Error("common-work owner does not support execution delegations");
      const evidence = workExecutionDelegationSchema.parse(await send({ operation: "delegation", token }));
      if (evidence.start.owner !== ownerId || evidence.start.attempt_id !== token)
        throw new Error("execution delegation binding mismatch");
      return evidence;
    },
    inspect: async (token: string) => z.strictObject({ observation: executorObservationSchema, stop_requested: z.boolean() }).parse(await send({ operation: "inspect", token })),
    observe: async (token: string, observation: z.infer<typeof executorObservationSchema>) => z.strictObject({ status: z.enum(["accepted", "duplicate", "stale"]) }).parse(await send({ operation: "observe", token, observation })),
    complete: async (token: string, receipt: z.infer<typeof workReceiptSchema>) => z.strictObject({ status: z.enum(["accepted", "alreadyAccepted", "stale"]) }).parse(await send({ operation: "complete", token, receipt })),
  };
}

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
