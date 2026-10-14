/** Sweep runs from the actions bag only when the sessions subject proves their session ended; absence or age alone is insufficient; see docs/decisions/0012-credentials-action-runs-and-traits.md. */
import { Barry } from "@barry-rocks/sdk";
import { sessionIdentity } from "@barry-rocks/sdk/stores";
import { abandonActionRuns, listStartedActionRunsWithSession } from "./action-runs.js";

/**
 * Close the open runs whose session has ended, or only `runId` when named;
 * how many it closed. Idempotent: a closed run is never a candidate again.
 */
export async function abandonOrphanedActionRuns(runId?: string): Promise<number> {
  const candidates = (await listStartedActionRunsWithSession()).filter((run) => runId === undefined || run.id === runId);
  if (candidates.length === 0) return 0;

  const ended: string[] = [];
  for (const candidate of candidates) {
    const session = await Promise.resolve().then(async () => {
      const identity = sessionIdentity(candidate.session_id);
      return identity ? Barry.identity(identity).session(candidate.session_id).get() : null;
    }).catch(() => null);
    // Only an explicit `ended_at` closes a run. A session the store has never
    // heard of is NOT evidence of abandonment -- it is equally consistent with
    // a store that is unreachable or pointed at the wrong path, and treating
    // "no answer" as "ended" would fail live runs. Absence leaves the run
    // alone.
    if (session && session.endedAt != null) ended.push(candidate.id);
  }

  const swept = await abandonActionRuns(ended);
  return swept.length;
}
