import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { boundFingerprint } from "@barry-rocks/sdk/bounds";
import { readBoundedFile, workProjectionDigest, WorkflowError, type WorkflowOwner, type WorkNamespace, type WorkProjectionTarget } from "@barry-rocks/sdk/internal/workflows";
import { openActionWorkProjectionStore, createActionWorkProjection, prepareActionWorkProjectionGeneration } from "@barry-rocks/actions-bag";

const configuration = z.strictObject({ version: z.literal(1), routes: z.array(z.strictObject({
  owner: z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("operator") }), z.strictObject({ kind: z.literal("identity"), identity_id: z.string().min(1).max(200) })]),
  path: z.string().refine(isAbsolute),
})).min(1).max(100) });
const ownerKey = (namespace: WorkNamespace) => namespace.identity_id !== null ? `identity:${namespace.identity_id}` : namespace.principal_kind === "operator" && namespace.principal_id === "local-operator" ? "operator" : null;

/** Trusted composition-root configuration selects stores; requests never supply paths. */
export function actionProjectionPublication(options: { owner: WorkflowOwner; path?: string; onError(error: unknown): void }) {
  if (!options.path) return null;
  if (!isAbsolute(options.path)) throw new Error("Action projection configuration path must be absolute.");
  // Keep the bounded reader as the only configuration input; no mutable catalog lookup.
  const config = configuration.parse(JSON.parse(readBoundedFile(options.path, 65536).toString("utf8")));
  const stores = new Map<string, ReturnType<typeof openActionWorkProjectionStore>>(), paths = new Set<string>();
  const targets = new Map<string, WorkProjectionTarget>(), owner = options.owner, generation = owner.epoch;
  try {
    for (const route of config.routes) {
      const key = route.owner.kind === "operator" ? "operator" : `identity:${route.owner.identity_id}`, path = resolve(route.path);
      if (stores.has(key) || paths.has(path)) throw new Error("Duplicate Actions projection route or database.");
      paths.add(path); const store = openActionWorkProjectionStore(path); stores.set(key, store);
      const identity = route.owner.kind === "identity" ? route.owner.identity_id : null;
      prepareActionWorkProjectionGeneration({ database: store.database, generation, namespace: { installation: owner.id,
        principal_kind: identity ? "identity" : "operator", principal_id: identity ?? "local-operator", identity_id: identity, caller_session_id: null } });
    }
    // Replaying only publication acknowledgements also repairs a missing target
    // database. Bounded batches are safe to repeat after interrupted startup.
    let progress = { after: "", complete: false };
    while (!progress.complete) progress = owner.requeueWorkProjections(generation, progress.after);
  } catch (error) { for (const store of stores.values()) store.close(); throw error; }
  let closing = false, inflight: Promise<void> | null = null;
  const status: { enabled: boolean; routes: number; last_attempt_at: number | null; error: string | null } = { enabled: true, routes: stores.size, last_attempt_at: null, error: null };
  const target: WorkProjectionTarget = { apply: work => {
    if (owner.epoch !== generation) throw new WorkflowError("ProjectionEpochChanged", "Owner recovery generation changed.", 409);
    if (work.plan.definition.kind !== "action") return { work_id: work.work_id, revision: work.revision, digest: workProjectionDigest(work) };
    const key = ownerKey(work.namespace), store = key ? stores.get(key) : undefined;
    if (!store) throw new WorkflowError("ActionProjectionRouteUnavailable", "No trusted Actions store is configured for this work owner.", 503);
    const namespace = boundFingerprint(work.namespace); let selected = targets.get(namespace);
    if (!selected) {
      selected = createActionWorkProjection({ database: store.database, namespace: work.namespace, generation,
        result: value => owner.workResult({ kind: "namespace", namespace: work.namespace }, value.work_id) });
      if (targets.size >= 256) targets.delete(targets.keys().next().value!);
      targets.set(namespace, selected);
    }
    return selected.apply(work);
  } };
  return {
    status: () => ({ ...status }),
    tick(): Promise<void> {
      if (closing) return Promise.resolve();
      if (inflight) return inflight;
      inflight = (async () => {
        status.last_attempt_at = Date.now();
        try { await owner.publishWorkProjections(target); status.error = null; }
        catch (error) { status.error = error instanceof WorkflowError ? error.code : "ProjectionUnavailable"; options.onError(error); }
      })().finally(() => { inflight = null; });
      return inflight;
    },
    async close() { closing = true; await inflight; for (const store of stores.values()) store.close(); },
  };
}
