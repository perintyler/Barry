import { readFileSync } from "node:fs";
import { WorkProcessSupervisor, ProcessExecutor, ExecutorJournal, WorkArtifactStore, connectWorkOwnerV3, executionBindingSchema } from "../../dist/workflows/index.js";

const configuration = JSON.parse(readFileSync(process.argv[2], "utf8"));
const artifacts = new WorkArtifactStore(configuration.artifacts);
const journal = new ExecutorJournal({ path: configuration.journal, installation: "owner", artifacts });
const connection = connectWorkOwnerV3("owner", async request => {
  const response = await fetch(configuration.owner, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer supervisor-fixture" }, body: JSON.stringify(request) });
  if (!response.ok) throw new Error(`owner refused ${response.status}`);
  return response.json();
});
const supervisor = new WorkProcessSupervisor({ installation: "owner", journal, artifacts, executor: new ProcessExecutor(),
  authorize: async start => {
    if (!configuration.authorizationOnly) return await connection.effect(start.attempt_id) ? connection.begin(start.attempt_id) : null;
    const response = await fetch(configuration.owner, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer supervisor-fixture" }, body: JSON.stringify({ start }) });
    if (!response.ok) throw new Error(`owner refused ${response.status}`);
    return response.json();
  }, outputIdentity: () => configuration.identity,
  onError: error => process.stderr.write(String(error) + "\n") });
const binding = executionBindingSchema.parse(Object.fromEntries(Object.keys(executionBindingSchema.shape).map(key => [key, configuration.task.work[key]])));
if (configuration.crashBeforeValidation) {
  const claim = journal.claimStage.bind(journal);
  journal.claimStage = (binding, stage) => {
    if (stage === "validation") process.kill(process.pid, "SIGKILL");
    return claim(binding, stage);
  };
}
await supervisor.start(configuration.task);
process.stdout.write(JSON.stringify({ phase: "started", ...supervisor.inspect(binding) }) + "\n");
await supervisor.wait(binding);
process.stdout.write(JSON.stringify({ phase: "done", ...supervisor.inspect(binding) }) + "\n");
await supervisor.close(); journal.close();
