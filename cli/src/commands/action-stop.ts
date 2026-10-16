import { randomUUID } from "node:crypto";
import { z } from "zod";
import { assertToolAllowed, filterToolsQualified, mergeBounds } from "@barry-rocks/sdk/bounds";
import { currentStoreContext } from "@barry-rocks/sdk/internal/stores";
import { Sessions } from "@barry-rocks/sessions-bag/client";
import { currentTarget } from "../target.js";
import { authorizeIdentityTool } from "../tool-bounds.js";

/** Identity CLI control stays within its selected session and never uses legacy Stop. */
export async function actionStopCommand(runId: string, options: { session: string; revision: string; reason: string; requestId?: string }): Promise<void> {
  let requestId: string | undefined;
  try {
    const target = currentTarget();
    if (target.kind !== "identity") throw new Error("Use an identity CLI and an explicit --session for action Stop. Operator control remains in barry work stop.");
    const sessionId = z.string().min(1).max(500).parse(options.session);
    const expectedRevision = z.number().int().positive().safe().parse(/^\d+$/.test(options.revision) ? Number(options.revision) : NaN);
    const reason = z.string().trim().min(1).max(2000).parse(options.reason);
    requestId = z.uuid().parse(options.requestId ?? randomUUID());
    const selected = await Sessions.get(sessionId);
    if (!selected || selected.identity_id !== target.binding.id || selected.state !== "open" || selected.ended_at !== null)
      throw new Error("The selected session must be open and belong to this identity.");
    const callerBounds = await authorizeIdentityTool({ namespace: "workflows", name: "cancel", access: "write" });
    const context = currentStoreContext(), ceiling = context?.execution;
    if (context?.identity && context.identity !== callerBounds.identity || ceiling?.identity && ceiling.identity !== callerBounds.identity)
      throw new Error("The selected control identity differs from the caller.");
    const mergedBounds = { ...callerBounds, bound: mergeBounds(callerBounds.bound, ceiling?.bound ?? null),
      allowedToolIds: callerBounds.allowedToolIds.filter(id => !ceiling || ceiling.allowedToolIds.includes(id)) };
    const tool = { namespace: "workflows", toolName: "cancel", access: "write" as const };
    assertToolAllowed(mergedBounds, tool, callerBounds.node);
    if (!filterToolsQualified([tool], mergedBounds.bound ?? undefined).includes("workflows:cancel"))
      throw new Error("Workflow Stop is outside the caller's bound.");
    // Recover the same intent after an ambiguous reply; print before resolving credentials or sending requests.
    console.error(`Stop request: ${requestId}. Keep this ID, session, revision and reason for retry.`);
    const [{ localConnection }, { BarryClient }] = await Promise.all([
      import("@barry-rocks/sdk/services"), import("@barry-rocks/sdk/internal/client"),
    ]);
    const client = new BarryClient(await localConnection());
    const ack = await client.actions.stopWorkflowRun(runId, { reason, requestId, expectedRevision }, { sessionId });
    console.log(JSON.stringify(ack, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    if (requestId) console.error(`Stop is unconfirmed. Preserve request ${requestId} and the same session, revision and reason; no fallback was attempted.`);
    process.exitCode = 1;
  }
}
