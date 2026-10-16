import { isBarryError } from "@barry-rocks/sdk";
import { createRunAuthorization, createRunBoundRefresh, createWorkScopeRefresh, WorkPolicyDispatcher, type InstalledJob, type RunBoundSources } from "@barry-rocks/sdk/internal/workflows";
import { collectToolDefinitions } from "@barry-rocks/sdk/internal/tools";
import { mergeBounds, type Bound } from "@barry-rocks/sdk/bounds";
import { jobScope } from "./common-work.js";
import { bounds, identityRecords, resolve } from "@barry-rocks/identities-bag";
import type { NodeRegistry } from "@barry-rocks/sdk/internal/nodes";

/** Concrete installation wiring stays in the application, outside standalone workflows. */
export function instanceRunAuthorization(peers: NodeRegistry) {
  return createRunAuthorization(instanceBoundSources(peers));
}
export function instanceRunScopeRefresh(peers: NodeRegistry) {
  return createRunBoundRefresh(instanceBoundSources(peers));
}
export const instanceRunBoundRefresh = instanceRunScopeRefresh;
function instanceBoundSources(peers: NodeRegistry): RunBoundSources {
  return {
    operator: principal => principal === "local-operator",
    mayRunAs: async (principal, identity) => principal === "local-operator" || identity === undefined || identity === principal,
    catalog: async () => ({ traits: {}, tools: await collectToolDefinitions() }),
    identity: async id => {
      try {
        // The identity's own restrictions, its named and inline bounds; its bags are the run's to select.
        const { record } = await identityRecords.find(peers.legacyIdentityId(id));
        const bound = await resolve.bound(record, { defaults: false });
        return { bound };
      } catch (error) {
        if (isBarryError(error) && error.reason === "not_found") return undefined;
        throw error;
      }
    },
    boundByName: async name => await bounds.get(name),
  };
}

export function instanceWorkPolicy(peers: NodeRegistry, jobs: readonly InstalledJob[] = []) {
  const refresh = createWorkScopeRefresh(instanceBoundSources(peers));
  const registered = new Map(jobs.map(job => [job.type, job]));
  return new WorkPolicyDispatcher(async (work, grant) => {
    const scope = await refresh(work, grant);
    if (!scope || !work.plan.node_job) return scope;
    const job = registered.get(work.plan.node_job.activity_type);
    if (!job || job.contract.digest !== work.plan.node_job.source_digest) return null;
    const current = await currentJobBound(job);
    return current ? jobScope(scope, current) : null;
  });
}

export async function currentJobBound(job: InstalledJob): Promise<Bound | null> {
  if (!job.boundNames?.length) return job.bound;
  let current: Bound | null = null;
  for (const name of job.boundNames) {
    const value = await bounds.get({ name }); if (!value) return null;
    current = mergeBounds(current, value);
  }
  return current;
}
