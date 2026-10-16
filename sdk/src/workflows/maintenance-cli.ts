import { isAbsolute } from "node:path";
import { existsSync, lstatSync } from "node:fs";
import { readRecoveryAdmission, readRecoveryActivation, activateRecoveryAdmission, recoveryActivationSchema } from "./recovery-admission.js";
import { WorkflowStore } from "./workflow-store.js";
import { workRecoveryInventorySchema } from "./work-recovery.js";
import { parseArgs } from "node:util";
import { readBoundedFile } from "./read-bounded.js";
import { inspectArtifact } from "./artifacts.js";
import { snapshotWorkflows, restoreWorkflows } from "./recovery.js";

const { positionals, values } = parseArgs({ allowPositionals: true, options: {
  epoch: { type: "string" }, "request-id": { type: "string" }, reason: { type: "string" }, "residual-risk": { type: "string" }, "effect-paths-fenced": { type: "boolean" }, "post-snapshot-work-reviewed": { type: "boolean" },
  owner: { type: "string" }, database: { type: "string" }, snapshot: { type: "string" },
  "work-recovery-inventory": { type: "string" }, "old-executors-fenced": { type: "boolean" }, "work-artifact-root": { type: "string" }, destination: { type: "string" }, manifest: { type: "string" }, "old-owner-fenced": { type: "boolean" },
} });
if (!values.owner) throw new Error("--owner is required");
let result;
if (["recovery-status", "activate-admission"].includes(positionals[0]) && values.database) {
  if (!isAbsolute(values.database) || !existsSync(values.database) || !lstatSync(values.database).isFile()) throw new Error("recovery administration requires an existing absolute regular database path");
  const store = new WorkflowStore(values.database, values.owner);
  try {
    result = positionals[0] === "recovery-status" ? { recovery: readRecoveryAdmission(store), activation: readRecoveryActivation(store) } : activateRecoveryAdmission(store, recoveryActivationSchema.parse({ request_id: values["request-id"], expected_epoch: values.epoch, reason: values.reason, residual_risk: values["residual-risk"], effect_paths_fenced: values["effect-paths-fenced"], post_snapshot_work_reviewed: values["post-snapshot-work-reviewed"] }), "local-operator", Date.now());
  } finally { store.close(); }
} else if (positionals[0] === "snapshot" && values.database && values.manifest && values.destination) {
  const manifest = JSON.parse(readBoundedFile(values.manifest, 262_144).toString("utf8")) as { workflows: { path: string; type: string; version: string }[]; activities: { path: string; type: string; version: string }[] };
  const artifacts = [...manifest.workflows.map(item => inspectArtifact(item.path, item.type, item.version)), ...manifest.activities.map(item => inspectArtifact(item.path, item.type, item.version, false))];
  result = await snapshotWorkflows(values.database, values.destination, values.owner, artifacts, values["work-artifact-root"], values["work-recovery-inventory"] ? workRecoveryInventorySchema.parse(JSON.parse(readBoundedFile(values["work-recovery-inventory"], 65536).toString())) : undefined);
} else if (positionals[0] === "restore" && values.snapshot && values.destination) {
  result = await restoreWorkflows(values.snapshot, values.destination, values.owner, values["old-owner-fenced"] === true, values["old-executors-fenced"] === true);
} else throw new Error("usage: snapshot --database PATH --manifest PATH [--work-artifact-root PATH] [--work-recovery-inventory PATH] | restore --snapshot DIR --old-owner-fenced [--old-executors-fenced]; snapshot/restore require --owner ID --destination DIR; recovery-status and activate-admission require --owner ID --database PATH; activation also needs --epoch UUID --request-id UUID --reason TEXT --residual-risk TEXT --effect-paths-fenced --post-snapshot-work-reviewed");
const restoreNotice = ["snapshot", "restore"].includes(positionals[0]) ? { recoveryNotice: "Snapshot restore loses acknowledged work after createdAt. Restored runs are paused. Reconcile destination effect keys, install bundled artifacts, then explicitly resume. External signing keys and service configuration must be restored separately. Coordinated stores remain evidence, not permission to signal stored PIDs or relaunch unknown stages. Never activate alongside an unfenced old owner or executor/resource broker. New admission is paused until an audited activation; activation does not resume existing runs or permit old invocation keys." } : {};
process.stdout.write(`${JSON.stringify({ ...result, ...restoreNotice }, null, 2)}\n`);
