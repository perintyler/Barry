import type { PermissionDecision, PermissionRequest } from "./index.js";

/**
 * The ruling for a session whose only per-call policy is its denied tools: a
 * tool denied by name is refused, and everything else runs — what the session
 * got before its harness asked. A hosted session given no ruling refuses
 * every call, so a caller with nothing to deny still passes this.
 */
export function refuseDeniedTools(
  deniedTools: readonly string[] = [],
): (request: PermissionRequest) => Promise<PermissionDecision> {
  return async (request) =>
    deniedTools.includes(request.tool)
      ? { allow: false, reason: `${request.tool} is denied in this session` }
      : { allow: true };
}
