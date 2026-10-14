import { parseArgs } from "node:util";
import { readBoundedFile } from "./read-bounded.js";
import { inspectArtifact } from "./artifacts.js";
import { snapshotWorkflows, restoreWorkflows } from "./recovery.js";

const { positionals, values } = parseArgs({ allowPositionals: true, options: {
  owner: { type: "string" }, database: { type: "string" }, snapshot: { type: "string" },
  destination: { type: "string" }, manifest: { type: "string" }, "old-owner-fenced": { type: "boolean" },
} });
if (!values.owner || !values.destination) throw new Error("--owner and --destination (new absolute directory) are required");
let result;
if (positionals[0] === "snapshot" && values.database && values.manifest) {
  const manifest = JSON.parse(readBoundedFile(values.manifest, 262_144).toString("utf8")) as { workflows: { path: string; type: string; version: string }[]; activities: { path: string; type: string; version: string }[] };
  const artifacts = [...manifest.workflows.map(item => inspectArtifact(item.path, item.type, item.version)), ...manifest.activities.map(item => inspectArtifact(item.path, item.type, item.version, false))];
  result = await snapshotWorkflows(values.database, values.destination, values.owner, artifacts);
} else if (positionals[0] === "restore" && values.snapshot) {
  result = await restoreWorkflows(values.snapshot, values.destination, values.owner, values["old-owner-fenced"] === true);
} else throw new Error("usage: snapshot --database PATH --manifest PATH | restore --snapshot DIR --old-owner-fenced; both require --owner ID --destination DIR");
process.stdout.write(`${JSON.stringify({ ...result, recoveryNotice: "Snapshot restore loses acknowledged work after createdAt. Restored runs are paused. Reconcile destination effect keys, install bundled artifacts, then explicitly resume. Never activate alongside an unfenced old owner." }, null, 2)}\n`);
