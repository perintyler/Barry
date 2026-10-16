/** Accepted profiles remain recoverable independently of the current catalog. */
import { existsSync } from "node:fs";
import { SqliteDatabase } from "../stores/sqlite-connection.js";
import { boundFingerprint } from "../bounds/workflow-bounds.js";
import { workAdmissionSchema } from "./work-contracts.js";
import type { WorkArtifactStore } from "./work-artifacts.js";
import { verifyWorkAgentProfile, workAgentCatalogSchema, type WorkAgentCatalog, type InstalledWorkAgent } from "./work-agent-profile.js";

export function retainedWorkAgents(path: string, artifacts: WorkArtifactStore, activeOnly = false): InstalledWorkAgent[] {
  if (!existsSync(path)) return [];
  const db = new SqliteDatabase(path, { readOnly: true });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workflow_work_admissions'").get()) return [];
    const query = activeOnly
      ? "SELECT w.record FROM workflow_work_admissions w JOIN workflow_runs r ON r.id=w.run_id WHERE r.status IN ('running','blocked') ORDER BY w.run_id"
      : "SELECT record FROM workflow_work_admissions ORDER BY run_id";
    const retained = new Map<string, InstalledWorkAgent>();
    // Complete verification precedes pinning/publication, so a partial archive
    // cannot advertise a generation whose accepted custody is unavailable.
    const references = new Map<string, Parameters<WorkArtifactStore["verify"]>[0]>();
    for (const row of db.prepare(query).iterate()) {
      const work = workAdmissionSchema.parse(JSON.parse(String(row.record))), program = work.plan.agent_program;
      if (!program) continue;
      if (program.installation !== work.namespace.installation || program.scope.identity !== work.namespace.identity_id
        || !work.plan.source_closure.some(reference => boundFingerprint(reference) === boundFingerprint(program.profile)))
        throw new Error("RetainedWorkAgentBindingConflict");
      const agent = verifyWorkAgentProfile(program.profile, artifacts);
      if (agent.profile.installation !== program.installation || agent.sources.some(reference =>
        !work.plan.source_closure.some(accepted => boundFingerprint(accepted) === boundFingerprint(reference))))
        throw new Error("RetainedWorkAgentBindingConflict");
      for (const reference of [...work.plan.source_closure, ...agent.sources]) {
        artifacts.verify(reference);
        const old = references.get(reference.digest);
        if (old && boundFingerprint(old) !== boundFingerprint(reference)) throw new Error("RetainedWorkAgentArtifactConflict");
        references.set(reference.digest, reference);
      }
      const old = retained.get(program.source_digest);
      if (old && boundFingerprint(old) !== boundFingerprint(agent)) throw new Error("RetainedWorkAgentProfileConflict");
      retained.set(program.source_digest, agent);
    }
    for (const reference of references.values()) artifacts.retainExecutor(reference);
    return [...retained.values()];
  } finally { db.close(); }
}

/** Restore deployment custody from accepted records, not a replacement catalog.
 * Historical agent records without this explicit deployment contract refuse. */
export function retainedWorkAgentCatalogs(path: string, artifacts: WorkArtifactStore): WorkAgentCatalog[] {
  if (!existsSync(path)) return [];
  const db = new SqliteDatabase(path, { readOnly: true });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workflow_work_admissions'").get()) return [];
    const retained = new Map<string, { reference: Parameters<WorkArtifactStore["verify"]>[0]; catalog: WorkAgentCatalog }>();
    for (const row of db.prepare("SELECT record FROM workflow_work_admissions ORDER BY run_id").iterate()) {
      const work = workAdmissionSchema.parse(JSON.parse(String(row.record))), program = work.plan.agent_program;
      if (!program) continue;
      const deployments = work.plan.source_closure.filter(reference => reference.media_type === "application/vnd.barry.agent-deployment+json");
      if (deployments.length !== 1 || deployments[0].purpose !== "source" || deployments[0].owner_identity !== null)
        throw new Error("RetainedWorkAgentDeploymentMissing");
      const reference = deployments[0], catalog = workAgentCatalogSchema.parse(JSON.parse(artifacts.verify(reference).toString("utf8")));
      const endpoint = work.plan.resources.endpoint;
      if (catalog.installation !== work.namespace.installation || program.installation !== catalog.installation
        || !catalog.profiles.some(profile => boundFingerprint(profile) === boundFingerprint(program.profile))
        || !endpoint || endpoint.broker !== catalog.endpoint_broker.id || catalog.endpoint_broker.limits[endpoint.endpoint]?.kind !== "endpoint")
        throw new Error("RetainedWorkAgentDeploymentConflict");
      const profile = verifyWorkAgentProfile(program.profile, artifacts).profile;
      if (profile.installation !== catalog.installation || endpoint.endpoint !== profile.endpoint_resource || endpoint.model !== profile.model)
        throw new Error("RetainedWorkAgentDeploymentConflict");
      const old = retained.get(reference.digest);
      if (old && (boundFingerprint(old.reference) !== boundFingerprint(reference) || boundFingerprint(old.catalog) !== boundFingerprint(catalog)))
        throw new Error("RetainedWorkAgentDeploymentConflict");
      retained.set(reference.digest, { reference, catalog });
    }
    for (const { reference } of retained.values()) artifacts.retainExecutor(reference);
    return [...retained.values()].map(value => value.catalog);
  } finally { db.close(); }
}
