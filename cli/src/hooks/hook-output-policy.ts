/**
 * What a bag hook is allowed to say back to the agent harness.
 *
 * Bag hooks run beside Barry's own tool gate (the PreToolUse policy hook the
 * adapters install). A bag's hook stdout flows straight to the provider, which
 * on a `pre-tool` event reads a `permissionDecision` (Claude) or `permission`
 * (Cursor) and lets it ALLOW or DENY the call. The dispatcher is otherwise
 * fail-open — a resolution failure prints `{}` and exits 0 — so a bag that
 * returned `permissionDecision: "allow"` from a pre-tool hook could wave a call
 * past Barry's gate, and one that merely crashed would do so silently (ADP-11).
 *
 * The authorization decision is Barry's, never a bag's. This module strips any
 * permission verdict a `pre-tool` bag hook tries to return, leaving the rest of
 * the hook's output (context additions, `continue`, logging) intact. Tracking
 * and context hooks — the only pre-tool hooks that exist — are unaffected; a
 * future policy hook cannot quietly become the gate.
 */

/** The neutral event name the dispatcher fires with, matching AGENT_HOOK_EVENTS. */
export type HookEventName = string;

export interface HookOutputPolicyResult {
  /** The output to forward to the provider. */
  output: string;
  /** A permission verdict was present and removed. */
  strippedPermissionDecision: boolean;
}

/**
 * Keys through which a provider accepts a permission verdict from a pre-tool
 * hook. Claude nests it under `hookSpecificOutput.permissionDecision` (with a
 * paired `permissionDecisionReason`); Cursor reads a top-level `permission`.
 */
function stripPermissionFromObject(value: Record<string, unknown>): boolean {
  let stripped = false;

  if ("permission" in value) {
    delete value.permission;
    stripped = true;
  }

  const hookSpecific = value.hookSpecificOutput;
  if (hookSpecific && typeof hookSpecific === "object" && !Array.isArray(hookSpecific)) {
    const nested = hookSpecific as Record<string, unknown>;
    if ("permissionDecision" in nested) {
      delete nested.permissionDecision;
      delete nested.permissionDecisionReason;
      stripped = true;
    }
  }

  return stripped;
}

/**
 * Enforce the pre-tool permission ban on a bag hook's raw stdout.
 *
 * Only `pre-tool` is policed — every other event's output is returned
 * unchanged, since a verdict there means nothing to the gate. Output that is
 * not a single JSON object is passed through untouched: a hook that prints
 * nothing, or non-JSON diagnostics, cannot carry a verdict anyway, and the
 * dispatcher's own fail-open `{}` must survive.
 */
export function enforceHookOutputPolicy(
  event: HookEventName,
  raw: string,
): HookOutputPolicyResult {
  if (event !== "pre-tool") return { output: raw, strippedPermissionDecision: false };

  const trimmed = raw.trim();
  if (!trimmed) return { output: raw, strippedPermissionDecision: false };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Not JSON: it cannot be a verdict the provider reads, so leave it be.
    return { output: raw, strippedPermissionDecision: false };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { output: raw, strippedPermissionDecision: false };
  }

  const value = parsed as Record<string, unknown>;
  const stripped = stripPermissionFromObject(value);
  if (!stripped) return { output: raw, strippedPermissionDecision: false };

  // Re-serialize without the verdict. A trailing newline is kept so the shape
  // matches the dispatcher's `{}\n` and a provider reading a line gets one.
  const newline = raw.endsWith("\n") ? "\n" : "";
  return { output: `${JSON.stringify(value)}${newline}`, strippedPermissionDecision: true };
}
