import { randomUUID } from "node:crypto";
import type { Command } from "commander";
import { z } from "zod";
import { assertToolAllowed, boundHasContent, filterToolsQualified, mergeBounds } from "@barry-rocks/sdk/bounds";
import { currentStoreContext } from "@barry-rocks/sdk/internal/stores";
import { Sessions } from "@barry-rocks/sessions-bag/client";
import { currentTarget } from "../target.js";
import { authorizeIdentityTool } from "../tool-bounds.js";
import { formatCliWorkItemHuman, formatCliWorkResultHuman, presentCliWorkItem } from "./work.js";

const PRE_NETWORK_ERROR_CODES = new Set([
  "invalid_request",
  "credential_error",
  "service_unconfigured",
  "cancelled",
]);

export function isUnconfirmedIdentityAdmission(error: unknown, submittedToNetwork: boolean): boolean {
  if (!submittedToNetwork) return false;
  if (!error || typeof error !== "object") return true;
  const err = error as { code?: string; status?: number | null; detail?: unknown };
  if (typeof err.code === "string" && PRE_NETWORK_ERROR_CODES.has(err.code)) return false;
  if (err.detail && typeof err.detail === "object") {
    const disp = (err.detail as { admission_disposition?: string }).admission_disposition;
    if (disp === "refused" || disp === "not-accepted") return false;
  }
  return true;
}

export function isUnconfirmedIdentityStop(error: unknown, submittedToNetwork: boolean): boolean {
  if (!submittedToNetwork) return false;
  if (!error || typeof error !== "object") return true;
  const err = error as { code?: string; status?: number | null; detail?: unknown };
  if (typeof err.code === "string" && PRE_NETWORK_ERROR_CODES.has(err.code)) return false;
  if (err.detail && typeof err.detail === "object") {
    const disp = (err.detail as { stop_disposition?: string }).stop_disposition;
    if (disp === "refused" || disp === "not-accepted") return false;
  }
  if (err.status === 409 && (err.code === "WorkRevisionConflict" || err.code === "WorkStopUnavailable")) return false;
  if (err.status === 404 && err.code === "WorkNotFound") return false;
  if (err.status === 403 && (err.code === "Forbidden" || err.code === "WorkReadDenied" || err.code === "WorkControlDenied")) return false;
  return true;
}

async function authorize(sessionId: string, operation: "start" | "get" | "cancel") {
  const target = currentTarget();
  if (target.kind !== "identity") throw new Error("Use an identity CLI with an explicit selected session.");
  const selected = await Sessions.get(sessionId);
  if (!selected || selected.identity_id !== target.binding.id) {
    throw new Error("The selected session is unavailable to this identity.");
  }
  const sessionEnded = selected.state !== "open" || selected.ended_at !== null;
  if (sessionEnded && operation !== "get") {
    if (operation === "cancel") {
      throw new Error("The selected session has ended; Stop requires an open session belonging to this identity.");
    }
    throw new Error("The selected session is unavailable to this identity.");
  }
  const access = operation === "get" ? ("read" as const) : ("write" as const);
  const callerBounds = await authorizeIdentityTool({ namespace: "workflows", name: operation, access });
  const context = currentStoreContext();
  const ceiling = context?.execution;
  if ((context?.identity && context.identity !== callerBounds.identity) || (ceiling?.identity && ceiling.identity !== callerBounds.identity)) {
    throw new Error("The selected control identity differs from the caller.");
  }
  const mergedBounds = {
    ...callerBounds,
    bound: mergeBounds(callerBounds.bound, ceiling?.bound ?? null),
    allowedToolIds: callerBounds.allowedToolIds.filter(id => !ceiling || ceiling.allowedToolIds.includes(id)),
  };
  assertToolAllowed(mergedBounds, { namespace: "workflows", toolName: operation }, callerBounds.node);
  if (!filterToolsQualified([{ namespace: "workflows", toolName: operation, access }], mergedBounds.bound ?? undefined).includes(`workflows:${operation}`)) {
    throw new Error(operation === "cancel" ? "Workflow Stop is outside the caller's bound." : "Workflow operation is outside the caller's bound.");
  }
  if (operation === "start") {
    assertToolAllowed(mergedBounds, { namespace: "bash", toolName: "Bash" }, callerBounds.node);
    if (boundHasContent(mergedBounds.bound ?? undefined)) {
      throw new Error("Installed scripts require the retained unbounded Bash write permission.");
    }
  }
}

async function client() {
  const [{ localConnection }, { BarryClient }] = await Promise.all([
    import("@barry-rocks/sdk/services"),
    import("@barry-rocks/sdk/internal/client"),
  ]);
  return new BarryClient(await localConnection());
}

/** Separate opt-in command: the existing action run producer retains its owner. */
export async function actionWorkStartCommand(
  name: string,
  options: {
    session: string;
    inputJson: string;
    key?: string;
    requestId?: string;
    recoveryEpoch?: string;
    human?: boolean;
    json?: boolean;
  },
): Promise<void> {
  let key: string | undefined;
  let submitted = false;
  try {
    z.string().min(1).max(200).regex(/^[^:@]+:[^:@]+$/).parse(name);
    const sessionId = z.string().min(1).max(200).parse(options.session);
    const inputs = z.record(z.string(), z.json()).parse(JSON.parse(options.inputJson));
    const requestId = z.uuid().parse(options.requestId ?? randomUUID());
    const recoveryEpoch = options.recoveryEpoch === undefined ? undefined : z.uuid().parse(options.recoveryEpoch);
    key = z.string().min(1).max(200).parse(options.key ?? (recoveryEpoch ? `${recoveryEpoch}:${randomUUID()}` : randomUUID()));
    if (recoveryEpoch && !key.startsWith(`${recoveryEpoch}:`)) {
      throw new Error("A post-restore invocation requires a new key prefixed with its recovery epoch.");
    }
    await authorize(sessionId, "start");
    console.error(`Submission key: ${key}. Preserve this key, session and inputs for lookup or retry.`);
    const api = await client();
    submitted = true;
    const ack = await api.actions.startWorkflowRun(
      name,
      { requestId, idempotencyKey: key, inputs, ...(recoveryEpoch ? { recoveryEpoch } : {}) },
      { sessionId },
    );
    console.log(JSON.stringify(ack, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    if (key && isUnconfirmedIdentityAdmission(error, submitted)) {
      console.error(`Admission is unconfirmed. Preserve key ${key}, the same session and inputs; use action work-lookup or retry the same intent.`);
    } else if (submitted) {
      console.error("Admission was refused before acceptance; correct the request or permissions before starting a new invocation.");
    }
    process.exitCode = 1;
  }
}

export async function actionWorkLookupCommand(
  key: string,
  options: { session: string; human?: boolean; json?: boolean },
): Promise<void> {
  try {
    key = z.string().min(1).max(200).parse(key);
    const sessionId = z.string().min(1).max(200).parse(options.session);
    await authorize(sessionId, "get");
    const result = await (await client()).actions.lookupWorkflowRun(key, { sessionId });
    if (!result) {
      console.error("Operation lookup found no accepted work. An in-flight submission may still commit; preserve its key and inputs.");
    }
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export async function actionWorkShowCommand(
  workId: string,
  options: { session: string; human?: boolean; json?: boolean },
): Promise<void> {
  try {
    const id = z.string().min(1).max(200).parse(workId);
    const sessionId = z.string().min(1).max(200).parse(options.session);
    await authorize(sessionId, "get");
    const item = await (await client()).actions.getWorkflowWork(id, { sessionId });
    if (options.human) {
      console.log(formatCliWorkItemHuman(item));
      return;
    }
    console.log(JSON.stringify(item, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export async function actionWorkResultCommand(
  workId: string,
  options: { session: string; human?: boolean; json?: boolean },
): Promise<void> {
  try {
    const id = z.string().min(1).max(200).parse(workId);
    const sessionId = z.string().min(1).max(200).parse(options.session);
    await authorize(sessionId, "get");
    const result = await (await client()).actions.getWorkflowWorkResult(id, { sessionId });
    if (result.status === "pending" && !result.outcome) {
      console.error("No result yet while work is in progress.");
    }
    if (options.human) {
      console.log(formatCliWorkResultHuman(result));
      return;
    }
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export async function actionWorkStopCommand(
  workId: string,
  options: { session: string; revision: string; reason: string; requestId?: string; json?: boolean },
): Promise<void> {
  let requestId: string | undefined;
  let expectedRevision: number | undefined;
  let submitted = false;
  try {
    const id = z.string().min(1).max(200).parse(workId);
    const sessionId = z.string().min(1).max(200).parse(options.session);
    expectedRevision = z.number().int().positive().safe().parse(/^\d+$/.test(options.revision) ? Number(options.revision) : NaN);
    const reason = z.string().trim().min(1).max(2000).parse(options.reason);
    requestId = z.uuid().parse(options.requestId ?? randomUUID());
    await authorize(sessionId, "cancel");
    console.error(`Stop request: ${requestId}. Keep this ID, session, work ID, revision and reason for retry.`);
    const api = await client();
    submitted = true;
    const ack = await api.actions.stopWorkflowWork(id, { reason, requestId, expectedRevision }, { sessionId });
    console.error(`Stop requested at revision ${ack.applied_revision}. Acknowledgement does not establish physical cessation; inspect work status to confirm cessation.`);
    console.log(JSON.stringify(ack, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    const code = (error as { code?: string })?.code;
    if (code === "WorkRevisionConflict") {
      console.error(`Stop was refused because revision ${expectedRevision ?? options.revision} is stale. Inspect current work state before requesting Stop again.`);
    } else if (requestId && isUnconfirmedIdentityStop(error, submitted)) {
      console.error(`Stop is unconfirmed. Preserve request ${requestId} and the same session, work ID, revision and reason; no fallback was attempted.`);
    } else if (submitted) {
      console.error("Stop was refused before state change; inspect current work state and permissions.");
    }
    process.exitCode = 1;
  }
}

export async function actionWorkWaitCommand(
  workId: string,
  options: { session: string; timeoutMs?: string | number; pollMs?: string | number; untilCeased?: boolean; human?: boolean; json?: boolean },
): Promise<void> {
  try {
    const id = z.string().min(1).max(200).parse(workId);
    const sessionId = z.string().min(1).max(200).parse(options.session);
    const timeoutMs = z.number().int().positive().max(600_000).parse(Number(options.timeoutMs ?? 30_000));
    const pollMs = z.number().int().min(25).max(10_000).parse(Number(options.pollMs ?? 250));
    await authorize(sessionId, "get");
    const api = await client();
    const deadline = Date.now() + timeoutMs;
    let latestState = "unknown";
    while (Date.now() <= deadline) {
      const item = await api.actions.getWorkflowWork(id, { sessionId });
      const presented = presentCliWorkItem(item);
      latestState = presented.state;
      const settledState = ["completed", "failed", "cancelled", "needs-attention", "waiting-for-approval"].includes(presented.state);
      const settledCessation = !options.untilCeased || presented.physicalCessation === "ceased" || presented.physicalCessation === "not-started" || presented.state === "needs-attention";
      if (settledState && settledCessation) {
        if (options.human) {
          console.log(formatCliWorkItemHuman(item));
        } else {
          console.log(JSON.stringify(item, null, 2));
        }
        return;
      }
      if (Date.now() + pollMs > deadline) break;
      await new Promise(resolveTimer => setTimeout(resolveTimer, pollMs));
    }
    throw new Error(`Timed out after ${timeoutMs}ms waiting for work ${id} (last state: ${latestState}).`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export function registerActionWork(actionCommand: Command): void {
  actionCommand
    .command("work-show <work_id>")
    .description("Inspect canonical identity work by work ID using an owned session")
    .requiredOption("--session <id>", "Owned caller session belonging to this identity")
    .option("--human", "Format a task-first human summary")
    .option("--json", "Output as JSON")
    .action(actionWorkShowCommand);

  actionCommand
    .command("work-result <work_id>")
    .description("Read canonical identity work outcome and retained output by work ID")
    .requiredOption("--session <id>", "Owned caller session belonging to this identity")
    .option("--human", "Format a task-first human summary")
    .option("--json", "Output as JSON")
    .action(actionWorkResultCommand);

  actionCommand
    .command("work-stop <work_id>")
    .description("Request cooperative Stop for canonical identity work by work ID; acknowledgement does not prove cessation")
    .requiredOption("--session <id>", "Open caller session belonging to this identity")
    .requiredOption("--revision <revision>", "Inspected canonical work revision")
    .requiredOption("--reason <reason>", "Reason for requesting Stop")
    .option("--request-id <uuid>", "Reuse this UUID after an unconfirmed Stop reply")
    .option("--json", "Output as JSON")
    .action(actionWorkStopCommand);

  actionCommand
    .command("work-wait <work_id>")
    .description("Wait until canonical identity work reaches a terminal or decision-needed state")
    .requiredOption("--session <id>", "Owned caller session belonging to this identity")
    .option("--timeout-ms <ms>", "Maximum time to wait in milliseconds", "30000")
    .option("--poll-ms <ms>", "Poll interval in milliseconds", "250")
    .option("--until-ceased", "Wait until physical execution cessation is also confirmed")
    .option("--human", "Format a task-first human summary")
    .option("--json", "Output as JSON")
    .action(actionWorkWaitCommand);
}
