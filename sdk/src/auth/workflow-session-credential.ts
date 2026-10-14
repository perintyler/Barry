import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { executionScopeSchema, scopeFingerprint } from "../bounds/execution-scope.js";

const schema = z.strictObject({
  version: z.literal(3),
  credentialId: z.uuid(),
  actorId: z.number().int().positive(),
  identityId: z.number().int().positive(),
  sessionId: z.string().min(1).max(500),
  identity: z.string().min(1).max(200),
  scopeFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.number().int().positive(),
});
export type WorkflowSessionCredential = z.infer<typeof schema>;
const DOMAIN = "barry.workflow-session-mcp.v3\0";
const MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;

function mac(secret: string, payload: string): Buffer {
  return createHmac("sha256", secret).update(DOMAIN).update(payload).digest();
}

/** A bearer limited to one job session, identity, and immutable scope. */
export function mintWorkflowSessionCredential(
  secret: string,
  claims: Omit<WorkflowSessionCredential, "version">,
  now = Date.now(),
): string {
  if (secret.length < 32) throw new Error("workflow session credential signing is not configured");
  const parsed = schema.parse({ version: 3, ...claims });
  if (parsed.expiresAt <= now || parsed.expiresAt > now + MAX_LIFETIME_MS) throw new Error("workflow session credential expiry is invalid");
  const payload = Buffer.from(JSON.stringify(parsed)).toString("base64url");
  return `bws3.${payload}.${mac(secret, payload).toString("base64url")}`;
}

export function verifyWorkflowSessionCredential(
  token: string,
  secret: string,
  now = Date.now(),
): WorkflowSessionCredential {
  if (secret.length < 32 || token.length > 2048) throw new Error("invalid workflow session credential");
  const [version, payload, signature, extra] = token.split(".");
  if (version !== "bws3" || !payload || !signature || extra) throw new Error("invalid workflow session credential");
  const expected = mac(secret, payload), actual = Buffer.from(signature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("invalid workflow session credential");
  let claims: unknown;
  try { claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); }
  catch { throw new Error("invalid workflow session credential"); }
  const parsed = schema.parse(claims);
  if (parsed.expiresAt <= now || parsed.expiresAt > now + MAX_LIFETIME_MS) throw new Error("workflow session credential expired or has an invalid lifetime");
  return parsed;
}

/** Bind a valid credential to the actual Sessions record, not just its URL. */
export function verifyWorkflowSessionCredentialForSession(
  token: string,
  secret: string,
  requestedSessionId: unknown,
  record: { id: string; state: string; ended_at: string | null; workflow_credential_id: string | null; user_id?: number | null; identity_id: number | null; metadata: Record<string, unknown> | null | undefined } | null | undefined,
  now = Date.now(),
): WorkflowSessionCredential {
  const credential = verifyWorkflowSessionCredential(token, secret, now);
  if (requestedSessionId !== credential.sessionId || record?.id !== credential.sessionId || record.user_id !== credential.actorId
    || record.state !== "open" || record.ended_at !== null || record.workflow_credential_id !== credential.credentialId
    || record.identity_id !== credential.identityId || !record.metadata) {
    throw new Error("workflow session credential record binding mismatch");
  }
  const scope = executionScopeSchema.parse(record.metadata.workflow_scope);
  const { fingerprint, ...evidence } = scope;
  if (
    record.metadata.workflow_identity_id !== record.identity_id ||
    credential.identity !== scope.identity ||
    credential.scopeFingerprint !== scope.fingerprint ||
    scopeFingerprint(evidence) !== fingerprint
  ) throw new Error("workflow session credential identity or scope binding mismatch");
  return credential;
}
