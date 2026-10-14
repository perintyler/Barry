/**
 * List recorded action runs for the `list-action-runs` action. Inputs arrive
 * on stdin; the listing is printed as JSON matching the action's output_schema.
 */
import { Barry } from "@barry-rocks/sdk";
import { getServiceUrl, instanceEnvValue } from "@barry-rocks/sdk/services";

import { readFileSync } from "node:fs";
import { ActionRuns } from "../../src/action-runs.js";
import { abandonOrphanedActionRuns } from "../../src/orphaned-runs.js";

/**
 * Summaries run to thousands of characters (a report kept as one), and a
 * listing of a hundred of them would pass the run output cap. A listing is
 * for finding runs; the full summary is one `check_action_run` away.
 */
const SUMMARY_CHARS = 200;

interface Inputs {
  active?: boolean | null;
  action?: string;
  limit?: number;
}

const inputs = JSON.parse(readFileSync(0, "utf8") || "{}") as Inputs;
// A script receives only what the caller sent, so the schema's defaults are
// applied here. `null` is the explicit "open and closed alike".
const active = inputs.active === undefined ? true : inputs.active;
const limit = inputs.limit ?? 25;
// This listing's own run is open while it runs. Reporting it would put noise
// at the top of every "what is still open" answer.
const self = process.env.BARRY_ACTION_RUN_ID;

// A run whose session has ended can never complete. Closing those first is
// what lets "still open" mean "still working". Best-effort: the listing is
// what was asked for, and the next one tries again.
await Promise.resolve().then(() => {
  Barry.connect({ baseUrl: getServiceUrl("api"), secret: instanceEnvValue("BARRY_SECRET") });
  return abandonOrphanedActionRuns();
}).catch((error: unknown) => {
  process.stderr.write(`Runs left by ended sessions were not closed: ${error instanceof Error ? error.message : String(error)}\n`);
});

const runs = (
  await ActionRuns.list({
    ...(active !== null ? { active } : {}),
    ...(inputs.action ? { action: inputs.action } : {}),
    limit: self ? limit + 1 : limit,
  })
)
  .filter((run) => run.id !== self)
  .slice(0, limit);

// stdout is the action's output: Barry validates it against the output_schema.
process.stdout.write(
  JSON.stringify({
    count: runs.length,
    runs: runs.map((run) => ({
      run_id: run.id,
      action: run.action,
      status: run.status,
      session_id: run.session_id,
      started_at: run.started_at.toISOString(),
      completed_at: run.completed_at?.toISOString() ?? null,
      summary: run.summary === null ? null : run.summary.slice(0, SUMMARY_CHARS),
    })),
  }) + "\n",
);
