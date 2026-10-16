/** Private bounded wire protocol for one immutable Sessions harness segment. */
import { createHash } from "node:crypto";
import { z } from "zod";

export const WORKFLOW_HARNESS_MAX_BYTES = 1_048_576;
export const workflowHarnessBindingSchema = z.strictObject({
  sessionId: z.string().min(1).max(500), turnId: z.string().min(1).max(500),
  segmentId: z.string().min(1).max(500), owner: z.string().min(1).max(500),
});
export type WorkflowHarnessBinding = z.infer<typeof workflowHarnessBindingSchema>;
const common = { version: z.literal(1), binding: workflowHarnessBindingSchema, id: z.uuid() };
export const workflowHarnessMessageSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...common, kind: z.literal("request"), method: z.string().min(1).max(100), value: z.unknown().optional() }),
  z.strictObject({ ...common, kind: z.literal("response"), value: z.unknown().optional(), error: z.string().min(1).max(256).optional() }),
  z.strictObject({ ...common, kind: z.literal("ready"), runtimeDigest: z.string().regex(/^[a-f0-9]{64}$/).optional() }),
]);
export type WorkflowHarnessMessage = z.infer<typeof workflowHarnessMessageSchema>;

/** Reject lossy values; sort plain object keys, with strict depth and wire-size limits. */
export function canonicalWorkflowHarnessJson(value: unknown): string {
  const ancestors = new Set<object>();
  function encode(item: unknown, depth: number): string {
    if (depth > 64) throw new Error("WorkflowHarnessProtocolError");
    if (item === null || typeof item === "boolean" || typeof item === "string") return JSON.stringify(item);
    if (typeof item === "number" && Number.isFinite(item)) return JSON.stringify(item);
    if (!item || typeof item !== "object" || ancestors.has(item) || Object.getOwnPropertySymbols(item).length) throw new Error("WorkflowHarnessProtocolError");
    ancestors.add(item);
    let result: string;
    if (Array.isArray(item)) {
      result = `[${Array.from({ length: item.length }, (_, index) => encode(item[index], depth + 1)).join(",")}]`;
    } else {
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new Error("WorkflowHarnessProtocolError");
      const descriptors = Object.getOwnPropertyDescriptors(item);
      const keys = Object.keys(item).sort();
      if (keys.some(key => descriptors[key].get || descriptors[key].set)) throw new Error("WorkflowHarnessProtocolError");
      result = `{${keys.map(key => `${JSON.stringify(key)}:${encode(descriptors[key].value, depth + 1)}`).join(",")}}`;
    }
    ancestors.delete(item);
    if (Buffer.byteLength(result) > WORKFLOW_HARNESS_MAX_BYTES) throw new Error("WorkflowHarnessProtocolError");
    return result;
  }
  const result = encode(value, 0);
  if (Buffer.byteLength(result) > WORKFLOW_HARNESS_MAX_BYTES) throw new Error("WorkflowHarnessProtocolError");
  return result;
}
export function encodeWorkflowHarnessMessage(value: WorkflowHarnessMessage): string {
  canonicalWorkflowHarnessJson(value);
  const message = workflowHarnessMessageSchema.parse(value);
  if (message.kind === "response" && message.error !== undefined && Object.hasOwn(message, "value")) throw new Error("WorkflowHarnessProtocolError");
  return canonicalWorkflowHarnessJson(message);
}
export function parseWorkflowHarnessMessage(value: unknown, expectedBinding: WorkflowHarnessBinding): WorkflowHarnessMessage {
  const text = typeof value === "string" ? value : canonicalWorkflowHarnessJson(value);
  if (Buffer.byteLength(text) > WORKFLOW_HARNESS_MAX_BYTES) throw new Error("WorkflowHarnessProtocolError");
  const decoded: unknown = JSON.parse(text);
  canonicalWorkflowHarnessJson(decoded);
  const message = workflowHarnessMessageSchema.parse(decoded);
  if (canonicalWorkflowHarnessJson(message.binding) !== canonicalWorkflowHarnessJson(expectedBinding)
    || message.kind === "response" && message.error !== undefined && Object.hasOwn(message, "value")) throw new Error("WorkflowHarnessProtocolError");
  return message;
}
export const workflowHarnessPermissionRequestSchema = z.object({ id: z.string().min(1).max(500), tool: z.string().min(1).max(500), input: z.unknown(), description: z.string().optional() }).strict();
export const workflowHarnessPermissionDecisionSchema = z.discriminatedUnion("allow", [
  z.strictObject({ allow: z.literal(true), persist: z.boolean().optional() }),
  z.strictObject({ allow: z.literal(false), reason: z.string().optional() }),
]);
export const workflowHarnessRecordedResultSchema = z.strictObject({ id: z.string().min(1).max(500), result: z.unknown(), error: z.boolean().optional() });
export const workflowHarnessContinuationSchema = z.strictObject({
  format: z.string().min(1), version: z.number().int().positive(), adapterId: z.string().min(1), adapterVersion: z.string().min(1),
  harnessVersion: z.string().min(1), configFingerprint: z.string().min(1), payload: z.unknown(),
});
export const workflowHarnessOutcomeSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("completed"), result: z.unknown().optional(), conversation: workflowHarnessContinuationSchema.optional() }),
  z.strictObject({ type: z.literal("failed"), error: z.string() }),
  z.strictObject({ type: z.literal("interrupted"), continuation: workflowHarnessContinuationSchema, calls: z.array(workflowHarnessPermissionRequestSchema).max(1000) }),
]);
export const workflowHarnessOutcomeEnvelopeSchema = z.strictObject({
  version: z.literal(1), binding: workflowHarnessBindingSchema, outcome: workflowHarnessOutcomeSchema,
  outcomeHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export function workflowHarnessOutcomeHash(outcome: unknown): string {
  return createHash("sha256").update(canonicalWorkflowHarnessJson(outcome)).digest("hex");
}
