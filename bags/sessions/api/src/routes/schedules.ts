import { identityRecords } from "@barry-rocks/identities-bag";
import { runScript } from "@barry-rocks/scheduler-service";
import { resolveAtScheduleAccess, resolveScheduleAccess } from "@barry-rocks/schedules-bag";
import { schedulesRoutes } from "@barry-rocks/sdk/internal/routes";
import { serve } from "@barry-rocks/sdk/services/http";
/**
 * /api/v1/schedules — see schedules, run one now, pause, and manage runtime
 * schedules.
 *
 * The scheduler service owns WHEN things fire; this is where a fire becomes an
 * agent run (the scheduler posts here for agent actions, since the API owns
 * sessions and agent spawns) and where people and tools act on schedules.
 */

import { ActionRuns } from "@barry-rocks/actions-bag";
import {
	IdempotencyConflictError,
	MAX_INPUT_BYTES,
	cancelAtSchedule, deleteRuntimeSchedule, findSchedule, getAtSchedule, insertRuntimeSchedule, listAtSchedules, listSchedules, listStates, parseRuntimeSpec, resolveAtScheduleAction, resolveScheduleAction, runScheduledJob, scheduleAt, schedulerHealth, serializeAtSchedule, summarizeSchedule, updateState
} from "@barry-rocks/schedules-bag";
import { isBarryError } from "@barry-rocks/sdk";
import { isScriptAction } from "@barry-rocks/sdk/internal/actions";
import { loadBagRegistrySnapshot } from "@barry-rocks/sdk/internal/bags";
import { createLogger } from "@barry-rocks/sdk/logging";
import { AtScheduleStatusSchema } from "@barry-rocks/sdk/internal/schedules";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { parseRequestBody, sendProblem } from "../http.js";
import { executeDetached } from "./actions.js";

const log = createLogger("barry-server");

export const schedulesRouter = Router();
const routes = serve(schedulesRouter, "/schedules");

const RunBodySchema = z.strictObject({
  /** Set by the scheduler, so its fires are recorded as `schedule` rather than a manual `api` run. */
  trigger: z.enum(["schedule", "api"]).optional(),
});

const CreateBodySchema = z.strictObject({
  name: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "kebab-case"),
  spec: z.record(z.string(), z.unknown()),
});

function describeHealth() {
  const health = schedulerHealth();
  return {
    status: health.status,
    ...("reason" in health ? { reason: health.reason } : {}),
    heartbeat_at: health.heartbeat?.at.toISOString() ?? null,
  };
}

async function resolveNumericIdentityId(identifier?: string): Promise<number | undefined> {
  if (!identifier) return undefined;
  return (await identityRecords.byReference(identifier))?.id;
}

// ── One-offs: an action once, later ─────────────────────────────────────────
// camelCase (the SDK contract), and registered before /:bag/:name so "once"
// is never read as a bag name.

/** Store trouble is a 503: work must not be accepted without a durable record. */
function withStore<T>(req: Request, res: Response, fn: () => T): T | undefined {
  try {
    return fn();
  } catch (error) {
    if (error instanceof IdempotencyConflictError) {
      sendProblem(req, res, 409, "Idempotency key conflict", error.message);
      return undefined;
    }
    log.error("schedules.store_error", { error: error instanceof Error ? error.message : String(error) });
    sendProblem(req, res, 503, "Schedule store unavailable", error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

routes.route(schedulesRoutes.createOneOffSchedule, async (req, res) => {
  const body = parseRequestBody(req, res, schedulesRoutes.createOneOffSchedule.body);
  if (!body) return;
  if (Buffer.byteLength(JSON.stringify(body.inputs ?? {})) > MAX_INPUT_BYTES) {
    return sendProblem(req, res, 413, "Payload too large", `inputs are limited to ${MAX_INPUT_BYTES} bytes of JSON`);
  }
  try {
    const identityId = await resolveNumericIdentityId(body.identity);
    const { schedule, created } = await scheduleAt(body, identityId);
    res.status(created ? 201 : 200).json({ schedule: serializeAtSchedule(schedule) });
  } catch (error) {
    if (!isBarryError(error)) throw error;
    const status = error.reason === "not_found" ? 404 : error.reason === "conflict" ? 409
      : error.reason === "invalid" ? 422 : error.reason === "forbidden" ? 403 : 503;
    sendProblem(req, res, status, "Cannot schedule action", error.message);
  }
});

routes.route(schedulesRoutes.listOneOffSchedules, (req, res) => {
  const status = typeof req.query.status === "string" ? AtScheduleStatusSchema.safeParse(req.query.status) : undefined;
  if (status && !status.success) return sendProblem(req, res, 400, "Invalid status", String(req.query.status));
  const limit = Number(req.query.limit ?? 50);
  withStore(req, res, () => {
    const found = listAtSchedules({
      ...(typeof req.query.bag === "string" ? { bag: req.query.bag } : {}),
      ...(status?.success ? { status: status.data } : {}),
      limit: Number.isFinite(limit) ? limit : 50,
    });
    res.json({ schedules: found.map(serializeAtSchedule) });
  });
});

routes.route(schedulesRoutes.getOneOffSchedule, (req, res) => {
  withStore(req, res, () => {
    const found = getAtSchedule(req.params.id);
    if (!found) return sendProblem(req, res, 404, "Unknown schedule", req.params.id);
    return res.json({ schedule: serializeAtSchedule(found) });
  });
});

routes.route(schedulesRoutes.cancelOneOffSchedule, (req, res) => {
  withStore(req, res, () => {
    const result = cancelAtSchedule(req.params.id);
    if (!result) return sendProblem(req, res, 404, "Unknown schedule", req.params.id);
    return res.json(result);
  });
});

/**
 * Run one attempt of an at-schedule's agent action — posted by the scheduler,
 * which owns the attempt; the API owns agent spawns. Answers with the
 * executor's body, like POST /actions/:name/run.
 */
schedulesRouter.post("/once/:id/run", async (req, res) => {
  const scheduleItem = getAtSchedule(req.params.id);
  if (!scheduleItem) return res.status(404).json({ error: "unknown_schedule" });
  if (scheduleItem.status !== "running") {
    return res.status(409).json({ error: "not_running", message: `schedule ${scheduleItem.id} is ${scheduleItem.status}` });
  }
  try {
    const resolved = await resolveAtScheduleAction(scheduleItem);
    if ("unavailable" in resolved) return res.status(404).json({ error: "unavailable", message: resolved.unavailable });
    if (isScriptAction(resolved.action)) return res.status(422).json({ error: "script_requires_scheduler", message: "Script attempts run through the scheduler permission checks" });
    const { bags } = await loadBagRegistrySnapshot();
    // Whom the run acts for. A job a session started acts for that session,
    // exactly as run_action's subagent does. A schedule with an identity or
    // bags runs under them. A JOB asked for with neither
    // acts with its bag's authority; an action schedule still must name them.
    const scheduled = Boolean(scheduleItem.permissions.identity || scheduleItem.permissions.bags?.length) || !scheduleItem.job;
    const identityId = scheduleItem.callerSessionId ? undefined : scheduleItem.permissions.identityId ?? (await resolveNumericIdentityId(scheduleItem.permissions.identity));
    const result = await executeDetached(
      { ...resolved.action, timeout: scheduleItem.timeoutS },
      {
        inputs: scheduleItem.inputs,
        ...(scheduleItem.callerSessionId
          ? { caller_session_id: scheduleItem.callerSessionId }
          : {
              ...(scheduleItem.permissions.identity ? { identity: scheduleItem.permissions.identity } : {}),
              ...(identityId !== undefined ? { identity_id: identityId } : {}),
              ...(scheduled ? { executionContext: await resolveAtScheduleAccess(scheduleItem, resolved.action.agent?.agent) } : {}),
            }),
        schedule_id: scheduleItem.id,
        trigger: scheduleItem.job ? "job" : "schedule",
      },
      bags,
      req.authPrincipal,
    );
    return res.status(result.status).json(result.body);
  } catch (error) {
    log.error("schedules.once_run_error", { schedule: scheduleItem.id, error: error instanceof Error ? error.message : String(error) });
    return res.status(500).json({ error: "internal_error", message: error instanceof Error ? error.message : String(error) });
  }
});


routes.route(schedulesRoutes.listSchedules, async (_req, res) => {
  const { schedules, errors } = await listSchedules();
  const states = listStates();
  res.json({
    scheduler: describeHealth(),
    ...(errors.length ? { load_errors: errors } : {}),
    schedules: schedules.map((s) => summarizeSchedule(s, states.get(s.id))),
  });
});

schedulesRouter.get("/health", (_req, res) => {
  res.json(describeHealth());
});

schedulesRouter.get("/:bag/:name", async (req, res) => {
  const id = `${req.params.bag}/${req.params.name}`;
  const entry = await findSchedule(id);
  if (!entry) return res.status(404).json({ error: "unknown_schedule" });
  const runs = await ActionRuns.list({ schedule_id: id, limit: 20 });
  return res.json({
    ...summarizeSchedule(entry, listStates().get(id)),
    runs: runs.map((r) => ({
      run_id: r.id,
      status: r.status,
      trigger: r.trigger,
      summary: r.summary,
      started_at: r.started_at.toISOString(),
      completed_at: r.completed_at?.toISOString() ?? null,
      exit_code: r.process?.exit_code ?? null,
      duration_ms: r.process?.duration_ms ?? null,
      log_path: r.process?.log_path ?? null,
    })),
  });
});

schedulesRouter.post("/:bag/:name/run", async (req, res) => {
  const parsed = RunBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(422).json({ error: "invalid_body", details: parsed.error.issues.map((i) => i.message) });
  const id = `${req.params.bag}/${req.params.name}`;
  try {
    const entry = await findSchedule(id);
    if (!entry) return res.status(404).json({ error: "unknown_schedule" });
    if (entry.schedule.payload.kind === "job") {
      // A job run like the scheduler's fire, keyed apart from any fire so
      // "run now" never collides with one; the scheduler service runs it.
      const now = new Date();
      const outcome = await runScheduledJob(entry, now, `${entry.id}@run-${now.toISOString()}`);
      return res.json({ run_id: outcome.runId, status: outcome.status, summary: outcome.summary });
    }
    const action = await resolveScheduleAction(entry);
    if (isScriptAction(action)) {
      const outcome = await runScript(action, entry);
      return res.json({ run_id: outcome.runId, status: outcome.status, summary: outcome.summary });
    }
    const { bags } = await loadBagRegistrySnapshot();
    const identityId = await resolveNumericIdentityId(entry.schedule.identity);
    const result = await executeDetached(
      action,
      {
        ...(entry.schedule.inputs ? { inputs: entry.schedule.inputs } : {}),
        ...(entry.schedule.identity ? { identity: entry.schedule.identity } : {}),
        ...(identityId !== undefined ? { identity_id: identityId } : {}),
        executionContext: await resolveScheduleAccess(entry, action.agent?.agent),
        schedule_id: id,
        trigger: parsed.data.trigger ?? "api",
      },
      bags,
      req.authPrincipal,
    );
    return res.status(result.status).json(result.body);
  } catch (error) {
    log.error("schedules.run_error", { schedule: id, error: error instanceof Error ? error.message : String(error) });
    return res.status(500).json({ error: "internal_error", message: error instanceof Error ? error.message : String(error) });
  }
});

for (const [verb, paused] of [["pause", true], ["resume", false]] as const) {
  schedulesRouter.post(`/:bag/:name/${verb}`, async (req, res) => {
    const id = `${req.params.bag}/${req.params.name}`;
    if (!(await findSchedule(id))) return res.status(404).json({ error: "unknown_schedule" });
    // Resuming clears the trigger key so the next due time is computed from
    // now: a schedule paused for a week does not catch up on resume.
    updateState(id, paused ? { paused } : { paused, trigger_key: null });
    return res.json({ id, paused });
  });
}

schedulesRouter.post("/", async (req, res) => {
  const parsed = CreateBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(422).json({ error: "invalid_body", details: parsed.error.issues.map((i) => i.message) });
  const { name, spec } = parsed.data;
  if (spec.at !== undefined) {
    // One way to make a one-off over HTTP, with its guarantees (idempotency,
    // retry, recovery) — not a second, weaker one.
    return res.status(422).json({ error: "one_off", message: "an `at` schedule is a one-off: POST /schedules/once" });
  }
  try {
    parseRuntimeSpec(name, spec);
  } catch (error) {
    return res.status(422).json({ error: "invalid_schedule", message: error instanceof Error ? error.message : String(error) });
  }
  const identityId = typeof spec.identity === "string" ? await resolveNumericIdentityId(spec.identity) : undefined;
  try {
    insertRuntimeSchedule(name, spec, "api", identityId);
  } catch (error) {
    if (String(error).includes("UNIQUE")) return res.status(409).json({ error: "exists", message: `runtime/${name} already exists` });
    throw error;
  }
  return res.status(201).json({ id: `runtime/${name}` });
});

schedulesRouter.delete("/runtime/:name", (req, res) => {
  if (!deleteRuntimeSchedule(req.params.name)) return res.status(404).json({ error: "unknown_schedule" });
  return res.json({ deleted: `runtime/${req.params.name}` });
});
