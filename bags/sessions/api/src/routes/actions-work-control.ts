import { z } from "zod";
import { serviceAddress } from "@barry-rocks/sdk/services";
import { installationSecrets } from "@barry-rocks/sdk/internal/services";
import { WorkflowError } from "@barry-rocks/sdk/internal/workflows";
import { actionWorkflowView, type ActionRunRecord } from "@barry-rocks/actions-bag";

export function actionWorkflowLink(run: ActionRunRecord) {
  const reference = actionWorkflowView(run); if (!reference) return undefined;
  const view = { ...reference, stop_protocol: "work-stop-v1" as const };
  try {
    const url = new URL(serviceAddress("workflows.runtime"));
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return view;
    url.pathname = `${url.pathname.replace(/\/$/, "")}/work`; url.search = ""; url.hash = `work/${encodeURIComponent(view.work_id)}`;
    return { ...view, url: url.href };
  } catch { return view; }
}
export const actionStopRequest = z.strictObject({ reason: z.string().trim().min(1).max(2000), request_id: z.uuid(), expected_revision: z.number().int().positive() });
/** Trusted host supplies caller context. Scope can never be selected by this body. */
export async function stopWorkflowAction(run: ActionRunRecord, input: unknown, authority: {
  operator: boolean; actor?: (path: string, body?: unknown) => string | Promise<string>;
}) {
  const work = run.workflow; if (!work) throw new WorkflowError("ActionWorkUnavailable", "This action is not owned by Work.", 409);
  if (!work.projection_current) throw new WorkflowError("ActionWorkStale", "This history belongs to an older recovery generation. Inspect Background work before requesting Stop.", 409);
  const parsed = actionStopRequest.safeParse(input);
  if (!parsed.success) throw new WorkflowError("InvalidInputs", "Workflow Stop needs a reason, a stable request_id and the inspected expected_revision.", 422);
  if (!authority.operator && !authority.actor) throw new WorkflowError("WorkControlDenied", "A verified workflow control signer is required for this caller. Operator fallback is forbidden.", 403);
  const body = parsed.data, path = `/api/v2/work/${encodeURIComponent(work.work_id)}/stop`;
  let actor: string | undefined;
  if (authority.actor) {
    try { actor = await authority.actor(path, body); }
    catch { throw new WorkflowError("WorkControlDenied", "Current workflow control authority does not permit this Stop.", 403); }
    if (typeof actor !== "string" || actor.length === 0 || actor.length > 8192) throw new WorkflowError("WorkControlDenied", "Verified workflow control authority is unavailable.", 403);
  }
  const address = serviceAddress("workflows.runtime"), base = new URL(address.endsWith("/") ? address : `${address}/`);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) throw new WorkflowError("WorkControlUnavailable", "Configured workflow address is invalid.", 503, true);
  const secret = process.env.BARRY_SECRET ?? (await installationSecrets(["BARRY_SECRET"])).BARRY_SECRET;
  if (!secret) throw new WorkflowError("WorkControlUnavailable", "Workflow service credentials are unavailable.", 503, true);
  const headers = { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" };
  try {
    const metadata = await fetch(new URL("api/metadata", base), { headers, signal: AbortSignal.timeout(5000) });
    if (!metadata.ok || (await metadata.json()).installation !== work.owner) throw new WorkflowError("WorkOwnerMismatch", "Configured workflow service does not own this action.", 409);
    const response = await fetch(new URL(path.slice(1), base), { method: "POST", headers: { ...headers, ...(actor ? { "X-Workflow-Actor": actor } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    const value = await response.json();
    if (!response.ok) throw new WorkflowError(typeof value.code === "string" ? value.code : "WorkStopRejected", typeof value.error === "string" ? value.error : "Workflow Stop was not confirmed.", response.status, Boolean(value.retryable));
    const ack = z.strictObject({ version: z.literal(2), work_id: z.literal(work.work_id), request_id: z.literal(body.request_id), applied_revision: z.number().int().min(body.expected_revision), applied_at: z.number().int().nonnegative(), stop_requested: z.literal(true) }).parse(value);
    return { run_id: run.id, work_id: work.work_id, request_id: ack.request_id, applied_revision: ack.applied_revision, stop_requested: true as const,
      status: "stop_requested" as const };
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    throw new WorkflowError("WorkStopUnknown", `Stop reply is unconfirmed. Retry request ${body.request_id} with the same revision and reason.`, 503, true);
  }
}

/** Legacy strict readers keep their original shape unless they opt in. */
export function wantsWorkflowReference(accept: string | undefined): boolean {
  return Boolean(accept && /\bprofile="?barry-action-work-v1"?(?:\s*[,;]|$)/.test(accept));
}
