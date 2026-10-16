import { readFileSync } from "node:fs";
import { createProcessWorkWorker, connectWorkOwnerV3 } from "../../dist/workflows/index.js";
const configuration = JSON.parse(readFileSync(process.argv[2], "utf8"));
const client = connectWorkOwnerV3("owner", async request => {
  const response = await fetch(configuration.owner, { method: "POST", headers: { authorization: "Bearer delivery-fixture", "content-type": "application/json" }, body: JSON.stringify(request) });
  if (!response.ok) throw new Error(`owner unavailable: ${response.status}`);
  return response.json();
});
const processWorker = createProcessWorkWorker({ installation: "owner", journalPath: configuration.journal, artifactRoot: configuration.artifacts,
  connections: [{ owner: "owner", client }], advertisement: { types: ["echo"], artifacts: { echo: configuration.digest } }, capacity: 1,
  onError: error => process.stderr.write(String(error) + "\n") });
let stopping = false;
const timer = setInterval(() => { if (!stopping) void processWorker.worker.tick(); }, 25);
process.once("SIGTERM", () => { stopping = true; clearInterval(timer); void processWorker.close().then(() => process.exit(0)); });
process.stdout.write("ready\n");
