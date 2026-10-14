import { Barry, isBarryError, requestCaller } from "@barry-rocks/sdk";
import { AuthPrincipalSchema, type AuthPrincipal } from "@barry-rocks/sdk/internal/auth";
import { getSession as getSessionRecord } from "./client/index.js";

export class SessionExecutionResourceUnavailable extends Error {
  constructor() { super("Session execution resource is unavailable"); this.name = "SessionExecutionResourceUnavailable"; }
}

/** Only trusted server callers supply a principal; request configuration cannot carry it. */
export async function authorizeSessionExecution(principal: AuthPrincipal, selection: { sessionId?: string; identityId?: number | null }): Promise<AuthPrincipal> {
  const verified = AuthPrincipalSchema.parse(principal);
  // Device turns also need tool, credential and execution-bound enforcement.
  if (verified.kind === "device") throw new Error("Device session execution is not available");
  const owner = await Barry.as({ kind: "owner" }).owner().catch((error: unknown) => {
    if (isBarryError(error) && error.reason === "not_found") return undefined;
    throw error;
  });
  if (!owner || owner.id !== verified.actorId) throw new Error("Session execution owner is unavailable");
  const session = selection.sessionId ? await getSessionRecord(selection.sessionId) : undefined;
  if (selection.sessionId && !session) throw new SessionExecutionResourceUnavailable();
  if (session?.user_id != null && session.user_id !== verified.actorId) throw new Error("Session execution ownership mismatch");
  const identityIds = new Set([session?.identity_id, selection.identityId]);
  const asked = Barry.as(requestCaller(verified));
  for (const id of identityIds) {
    if (id == null) continue;
    // An identity reads back only for the user who owns it.
    try {
      await asked.identity(id).get();
    } catch (error) {
      if (isBarryError(error) && (error.reason === "not_found" || error.reason === "forbidden")) throw new Error("Session execution ownership mismatch");
      throw error;
    }
  }
  return verified;
}
