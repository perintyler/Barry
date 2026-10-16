import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { WorkflowOwner, WorkArtifactStore, WorkResourceBroker, ProcessExecutor, dispatchWorkerRequest } from "../../dist/workflows/index.js";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const artifacts = new WorkArtifactStore(config.artifacts);
const broker = new WorkResourceBroker({ path: config.broker, broker: "local-host", limits: { local: { kind: "host" } } });
const owner = new WorkflowOwner({ id: "owner", path: config.database, artifacts: [config.workflow], activityArtifacts: { echo: config.workflow.digest }, executor: new ProcessExecutor(),
  workArtifacts: artifacts, workResources: { host: () => ({ broker: broker.id, resource: "local" }), brokers: new Map([[broker.id, broker]]) },
  authorizeWork: () => config.scope });
const token = readFileSync(config.credential_file, "utf8").trim();
const server = createServer(async (request, response) => {
  if (request.url !== "/api/worker" || request.method !== "POST" || request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401).end(); return; }
  try {
    const chunks = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const message = JSON.parse(Buffer.concat(chunks).toString()).request;
    response.end(JSON.stringify(dispatchWorkerRequest(owner, "owner", message)));
  } catch (error) { process.stderr.write(String(error) + "\n"); response.writeHead(409).end(); }
});
await owner.pump();
await new Promise(resolve => server.listen(config.port ?? 0, "127.0.0.1", resolve));
const timer = setInterval(() => { void owner.pump().catch(() => {}); owner.reconcileWorkResources(); }, 50);
let stopping = false;
process.on("SIGTERM", async () => {
  if (stopping) return; stopping = true; clearInterval(timer);
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await owner.drain(); owner.close(); broker.close(); artifacts.close();
});
process.stdout.write(JSON.stringify({ port: server.address().port }) + "\n");
