import { z } from "zod";
import { runRequestSchema, type RunRequest } from "./approvals.js";
import type { WorkExecutionStart } from "./work-contracts.js";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export const identifier = z.string().min(1).max(200);
export const duration = z.number().int().positive().max(365 * 24 * 60 * 60 * 1000);
const json: z.ZodType<Json> = z.json();
const labels = z.record(identifier, z.union([z.string().max(200), z.number().finite(), z.boolean()])).refine(value => Object.keys(value).length <= 64, "at most 64 labels");
/** Which installations may run a step: "local" (the owner) or an invited worker, by name or id. */
export const nodeBoundSchema = z.strictObject({ allow: z.array(identifier).max(100).optional(), deny: z.array(identifier).max(100).optional() });
export const placementSchema = z.strictObject({
  node: identifier.optional(), nodes: nodeBoundSchema.optional(), requires: labels.default({}),
  preferNodes: z.array(identifier).max(100).default([]), prefer: labels.default({}),
});
const retrySchema = z.strictObject({
  maxAttempts: z.number().int().min(1).max(100).default(3),
  initialDelayMs: duration.default(1_000), maxDelayMs: duration.default(60_000),
});
export const activitySchema = z.strictObject({
  kind: z.literal("activity"), type: identifier, input: json,
  timeoutMs: duration.default(86_400_000), attemptTimeoutMs: duration.default(60_000),
  heartbeatTimeoutMs: duration.default(15_000),
  retry: retrySchema.default({ maxAttempts: 3, initialDelayMs: 1_000, maxDelayMs: 60_000 }),
  placement: placementSchema.default({ requires: {}, preferNodes: [], prefer: {} }),
});
const leafSchema = z.discriminatedUnion("kind", [
  activitySchema,
  z.strictObject({ kind: z.literal("timer"), delayMs: z.number().int().nonnegative().max(31_536_000_000) }),
  z.strictObject({ kind: z.literal("signal"), name: identifier, timeoutMs: duration }),
  z.strictObject({ kind: z.literal("now") }), z.strictObject({ kind: z.literal("random") }),
]);
export const commandSchema = z.union([leafSchema, z.strictObject({ kind: z.literal("all"), commands: z.array(leafSchema).min(1).max(100) })]);
export type ActivityCommand = z.output<typeof activitySchema>;
export type LeafCommand = z.output<typeof leafSchema>;
export type WorkflowCommand = z.output<typeof commandSchema>;
export type ActivityOptions = Partial<Omit<z.input<typeof activitySchema>, "kind" | "type" | "input">>;
export const activity = (type: string, input: Json, options: ActivityOptions = {}): ActivityCommand => activitySchema.parse({ kind: "activity", type, input, ...options });
export const sleep = (delayMs: number): WorkflowCommand => commandSchema.parse({ kind: "timer", delayMs });
export const signal = (name: string, timeoutMs = 86_400_000): WorkflowCommand => commandSchema.parse({ kind: "signal", name, timeoutMs });
export const now = (): LeafCommand => ({ kind: "now" });
export const random = (): LeafCommand => ({ kind: "random" });
export const all = (commands: WorkflowCommand[]): WorkflowCommand => commandSchema.parse({ kind: "all", commands });

export interface WorkflowDefinition {
  type: string;
  version: string;
  run(input: Json): Generator<WorkflowCommand, Json, Json>;
}
export class ActivityFailure extends Error {
  constructor(message: string, readonly code = "ActivityFailed") { super(message); this.name = "ActivityFailure"; }
}
export type Failure = { message: string; code: string; retryable: boolean };
export type Outcome = { ok: true; value: Json } | { ok: false; error: Failure };
export const outcomeSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), value: json }),
  z.strictObject({ ok: z.literal(false), error: z.strictObject({ message: z.string().max(4096), code: identifier, retryable: z.boolean() }) }),
]);
/**
 * A bag job a worker can run as an activity: its bundle digest and the
 * schemas its input and output must match. `type` is `<bag>:<job>@<version>`.
 */
export const jobContractSchema = z.strictObject({
  type: identifier, digest: z.string().regex(/^[a-f0-9]{64}$/),
  inputSchema: z.record(z.string(), z.unknown()).optional(), outputSchema: z.record(z.string(), z.unknown()).optional(),
  timeoutMs: duration.optional(),
  /** Absent in legacy contracts: owner restricts them to its local worker. */
  nodes: nodeBoundSchema.optional(),
});
export type JobContract = z.infer<typeof jobContractSchema>;
/** Input of the built-in `job@1` workflow: one step that runs one job. */
export const jobRunInputSchema = z.strictObject({ job: identifier, input: json, placement: placementSchema.partial().optional() });
export const startSchema = z.strictObject({
  id: identifier, type: identifier, version: identifier, input: json,
  timeoutMs: duration.default(7 * 86_400_000),
  job: runRequestSchema.optional(),
  recoveryEpoch: z.uuid().optional(),
});
export type StartWorkflow = z.input<typeof startSchema>;
export type WorkflowStatus = "running" | "blocked" | "completed" | "failed" | "cancelled" | "timed_out";
export interface WorkflowRun {
  id: string; owner: string; type: string; version: string; input: Json;
  status: WorkflowStatus; startedAt: number; deadline: number; outcome: Outcome | null; error: string | null;
  revision: number; artifact: string | null; principal: string;
  job?: RunRequest & { grantRevision: number; authorizer: string; createdBy: string };
}
export interface HistoryEvent { sequence: number; at: number; type: string; details: Json }
export const advertisementSchema = z.strictObject({
  types: z.array(identifier).max(1000), labels: labels.default({}),
  artifacts: z.record(identifier, z.string().regex(/^[a-f0-9]{64}$/)).default({}),
  capacity: z.number().int().min(0).max(1000), load: z.number().finite().min(0).max(1).default(0),
});
export type WorkerAdvertisement = z.input<typeof advertisementSchema>;
export interface ActivityTask {
  work?: WorkExecutionStart;
  owner: string; runId: string; activityId: string; idempotencyKey: string;
  type: string; input: Json; attempt: number; token: string; deadline: number; timeoutMs: number; heartbeatMs: number;
  artifact?: string;
  grantRevision?: number;
}
export interface ActivityContext extends ActivityTask { signal: AbortSignal }
export type Activity = (input: Json, context: ActivityContext) => Promise<Json>;
export interface OwnerConnection {
  advertise(advertisement: WorkerAdvertisement): Promise<void>;
  claim(requestId?: string): Promise<ActivityTask | null>;
  heartbeat(token: string): Promise<boolean>;
  complete(token: string, outcome: Outcome): Promise<boolean>;
  decline?(token: string): Promise<boolean>;
  settlePhysical?(token: string): Promise<boolean>;
}

export const limits = Object.freeze({ payload: 262_144, envelope: 1_048_576, record: 2_097_152, replay: 33_554_432, groupPayload: 1_048_576 });
export class PayloadLimit extends Error {}
export function encode(value: unknown, maxBytes: number = limits.payload): string {
  const visit = (item: unknown, ancestors: Set<object>, depth: number): unknown => {
    if (depth > 64) throw new Error("JSON nesting exceeds 64 levels");
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return Object.is(item, -0) ? 0 : item;
    if (typeof item !== "object" || item === null || ancestors.has(item)) throw new Error("expected finite, acyclic JSON");
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new Error("expected plain JSON object");
    ancestors.add(item);
    const normalized = Array.isArray(item)
      ? Array.from(item, child => visit(child, ancestors, depth + 1))
      : Object.fromEntries(Object.keys(item).sort().map(key => [key, visit((item as Record<string, unknown>)[key], ancestors, depth + 1)]));
    ancestors.delete(item);
    return normalized;
  };
  const serialized = JSON.stringify(visit(value, new Set(), 0));
  if (Buffer.byteLength(serialized) > maxBytes) throw new PayloadLimit(`JSON payload exceeds ${maxBytes / 1024} KiB`);
  return serialized;
}
export const encodeRecord = (value: unknown): string => encode(value, limits.record);
export const encodeEnvelope = (value: unknown): string => encode(value, limits.envelope);
export function encodeCommand(value: unknown): string {
  const command = commandSchema.parse(JSON.parse(encodeRecord(value)));
  const leaves = command.kind === "all" ? command.commands : [command];
  let bytes = 0;
  for (const leaf of leaves) if (leaf.kind === "activity") bytes += Buffer.byteLength(encode(leaf.input));
  for (const leaf of leaves) encode(leaf.kind === "activity" ? { ...leaf, input: null } : leaf, 65_536);
  encode(leaves.map(leaf => leaf.kind === "activity" ? { ...leaf, input: null } : leaf), 524_288);
  if (bytes > limits.groupPayload) throw new PayloadLimit("parallel group payload exceeds 1024 KiB");
  return encodeRecord(command);
}
