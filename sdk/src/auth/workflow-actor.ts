import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { ToolCallBounds } from "../bounds/resolve-bound.js";
import { z } from "zod";
import { BoundSchema, type Bound } from "../bounds/types.js";

export interface WorkflowActorContext {
  identity?: string;
  bags: string[];
  bounds?: string[];
  bound: Bound | null;
  allowedToolIds: string[];
  harness?: string;
}

const executionSchema = z.preprocess(
  (val) => {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const rec = { ...(val as Record<string, unknown>) };
      if (!Array.isArray(rec.bags) && Array.isArray(rec.traits)) {
        rec.bags = rec.traits;
      }
      delete rec.traits;
      return rec;
    }
    return val;
  },
  z.strictObject({
    identity: z.string().min(1).max(200).optional(),
    bags: z.array(z.string().max(200)).max(100),
    bounds: z.array(z.string().max(200)).max(100).optional(),
    bound: BoundSchema.nullable(),
    allowedToolIds: z.array(z.string().max(200)).max(1000),
    harness: z.string().max(200).optional(),
  }),
);

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value ?? null);
}
function operation(path: string, body: unknown): string {
  const url = new URL(path, "http://workflows.invalid");
  if (url.pathname === "/api/v2/runs" || url.pathname === "/api/v2/work") return "list";
  if (
    /^\/api\/v2\/work\/[^/]+(?:\/(?:result|reconciliation))?$/.test(url.pathname) &&
    body === undefined
  )
    return "get";
  if (/^\/api\/v2\/work\/[^/]+\/reconciliation$/.test(url.pathname) && body !== undefined)
    return "resume";
  if (/^\/api\/v2\/work\/[^/]+\/stop$/.test(url.pathname) && body !== undefined) return "cancel";
  if (url.pathname === "/api/runs") return body === undefined ? "list" : "start";
  if (/^\/api\/runs\/[^/]+$/.test(url.pathname)) return "get";
  const action =
    /^\/api\/runs\/[^/]+\/(history|signal|cancel|resume|reauthorize|permissions|resources|payloads|command|receipt|eligibility)$/.exec(
      url.pathname,
    )?.[1];
  if (!action) throw new Error("unsupported workflow actor operation");
  return ["payloads", "command", "receipt", "eligibility", "permissions", "resources"].includes(
    action,
  )
    ? "get"
    : action;
}
export interface WorkflowActor {
  principal: string;
  operation: string;
  policyHash: string;
  expiresAt: number;
  execution?: WorkflowActorContext;
}
/** Called by the engine after tool/bound authorization, never by application executors. */
export function workflowActorSigner(
  context: WorkflowActorContext | ToolCallBounds,
  key: string | undefined,
): (path: string, body?: unknown) => string {
  return (path, body) => {
    if (!context.identity || !key || key.length < 32)
      throw new Error("verified workflow identity signing is not configured");
    const action = operation(path, body);
    if (!context.allowedToolIds.includes(`workflows:${action}`))
      throw new Error("workflow operation is outside the execution bound");
    const execution = JSON.parse(
      JSON.stringify(executionSchema.parse(context)),
    ) as WorkflowActorContext;
    const actor = {
      audience: "workflows.runtime",
      principal: context.identity,
      operation: action,
      policyHash: createHash("sha256").update(canonical(execution)).digest("hex"),
      expiresAt: Date.now() + 30_000,
      requestHash: createHash("sha256").update(canonical({ path, body })).digest("hex"),
      ...(["start", "reauthorize"].includes(action) ? { execution } : {}),
    };
    const encoded = Buffer.from(JSON.stringify(actor)).toString("base64url");
    const token = `${encoded}.${createHmac("sha256", key).update(encoded).digest("base64url")}`;
    if (token.length > 8192) throw new Error("workflow actor exceeds safe HTTP header budget");
    return token;
  };
}
/**
 * Parse the base64url actor payload, mapping a malformed body to the SAME
 * "invalid workflow actor" message every other failure in this verifier
 * returns. An unguarded `JSON.parse` here leaked a raw `SyntaxError` through a
 * verification API that is otherwise uniform — the sibling
 * `verifyWorkflowSessionCredential` already guards its parse the same way.
 */
function parseActorPayload(
  payload: string,
): WorkflowActor & { audience: string; requestHash: string } {
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as WorkflowActor & {
      audience: string;
      requestHash: string;
    };
  } catch {
    throw new Error("invalid workflow actor");
  }
}

export function verifyWorkflowActor(
  token: string,
  key: string,
  path: string,
  body?: unknown,
): WorkflowActor {
  if (token.length > 8192 || key.length < 32) throw new Error("invalid workflow actor");
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) throw new Error("invalid workflow actor");
  const expected = createHmac("sha256", key).update(payload).digest(),
    actual = Buffer.from(signature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw new Error("invalid workflow actor");
  const actor = parseActorPayload(payload);
  if (
    actor.audience !== "workflows.runtime" ||
    typeof actor.principal !== "string" ||
    !actor.principal ||
    actor.principal.length > 200 ||
    !Number.isSafeInteger(actor.expiresAt) ||
    actor.expiresAt <= Date.now() ||
    actor.expiresAt > Date.now() + 30_000 ||
    actor.operation !== operation(path, body) ||
    actor.requestHash !== createHash("sha256").update(canonical({ path, body })).digest("hex")
  )
    throw new Error("workflow actor binding or expiry mismatch");
  if (actor.execution) {
    actor.execution = executionSchema.parse(actor.execution);
    if (
      actor.execution.identity !== actor.principal ||
      actor.policyHash !== createHash("sha256").update(canonical(actor.execution)).digest("hex")
    )
      throw new Error("workflow actor execution mismatch");
  }
  return actor;
}
