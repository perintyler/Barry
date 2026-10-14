import { jobsRoutes } from "@barry-rocks/sdk/internal/routes";
import { serve } from "@barry-rocks/sdk/services/http";
/**
 * /api/v1/jobs — run a bag's job, read a run, cancel one.
 *
 * Every run becomes a one-off in the scheduler: durable before the caller is
 * answered, deduplicated by `key`, run at least once. A code job (`node`,
 * `process`) runs in the scheduler's process (job-runner.ts); an action job's
 * one-off is posted back here to run its action detached, as any agent
 * one-off is.
 *
 * Authority. A run with `callerSessionId` acts for that session: the session
 * must exist and not itself be a detached run, a job that declares secrets is
 * refused (the bag's credentials are not the session's to spend), and a code
 * job needs the session's own policy to allow a raw process — Bash, and no
 * bound — because a process cannot be held to a bound the way a guarded tool
 * is. A run without a caller acts with its bag's authority.
 *
 * HONEST LIMIT. Over HTTP the caller is self-asserted: this route sits behind
 * BARRY_SECRET, and whoever holds that already has installation authority, so
 * naming a session only ever NARROWS what a run gets. The enforced path is MCP,
 * where the tools take the session from the connection itself rather than
 * from the request: run_action, and begin_action on a `job:` action, both name
 * the connection's session as the caller.
 */

import { ActionRuns } from "@barry-rocks/actions-bag";
import { cancelOneOff, getOneOff } from "@barry-rocks/schedules-bag";
import { createLogger } from "@barry-rocks/sdk/logging";
import { Router } from "express";
import { parseRequestBody, sendProblem } from "../http.js";
import { acceptJobRun, awaitJobRun, serializeJobRun } from "../job-runs.js";
import { stopDetachedRun } from "./actions.js";

const log = createLogger("barry-server");

export const jobsRouter = Router();
const routes = serve(jobsRouter, "/jobs");

routes.route(jobsRoutes.startJobRun, async (req, res) => {
  const body = parseRequestBody(req, res, jobsRoutes.startJobRun.body);
  if (!body) return;
  const ref = req.params.ref;
  try {
    const accepted = await acceptJobRun({
      ref,
      ...(body.inputs ? { inputs: body.inputs } : {}),
      ...(body.key ? { key: body.key } : {}),
      ...(body.timeoutS ? { timeoutS: body.timeoutS } : {}),
      ...(body.callerSessionId ? { callerSessionId: body.callerSessionId } : {}),
    });
    if ("refused" in accepted) {
      const refused = accepted.refused;
      return "body" in refused ? res.status(refused.status).json(refused.body) : sendProblem(req, res, refused.status, refused.title, refused.detail);
    }
    const oneOff = await awaitJobRun(accepted.oneOff.id, body.waitS);
    return res.status(accepted.created ? 201 : 200).json({ run: await serializeJobRun(oneOff ?? accepted.oneOff) });
  } catch (error) {
    log.error("jobs.run_error", { job: ref, error: error instanceof Error ? error.message : String(error) });
    return sendProblem(req, res, 503, "Job store unavailable", error instanceof Error ? error.message : String(error));
  }
});

routes.route(jobsRoutes.getJobRun, async (req, res) => {
  const raw = Number(req.query.waitS ?? req.query.wait_s);
  const oneOff = await awaitJobRun(req.params.id, Number.isFinite(raw) && raw > 0 ? Math.min(raw, 600) : undefined);
  if (!oneOff?.job) return sendProblem(req, res, 404, "Unknown job run", req.params.id);
  return res.json({ run: await serializeJobRun(oneOff) });
});

routes.route(jobsRoutes.cancelJobRun, async (req, res) => {
  const found = getOneOff(req.params.id);
  if (!found?.job) return sendProblem(req, res, 404, "Unknown job run", req.params.id);
  // A code job's process group is killed by cancelOneOff; an action job's
  // agent runs here, in the API, and is stopped here.
  const result = cancelOneOff(req.params.id);
  if (!result) return sendProblem(req, res, 404, "Unknown job run", req.params.id);
  if (result.cancelRequested) {
    for (const run of await ActionRuns.list({ schedule_id: found.id, active: true })) await stopDetachedRun(run.id, "cancelled");
  }
  return res.json({ id: req.params.id, ...result });
});
