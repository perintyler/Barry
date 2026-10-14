import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:https";
import { randomUUID } from "node:crypto";
import { NodeRegistry } from "@barry-rocks/sdk/internal/nodes";
import { WorkflowOwner, ProcessExecutor, inspectArtifact, ActivityWorker, connectOwnerV2, ownerCall } from "@barry-rocks/sdk/internal/workflows";
import { createWorkflowServer } from "./server.js";

// Test-only control plane is process IPC, never an HTTP fault endpoint.
const [role, root, cert, key] = process.argv.slice(2);
const peers = new NodeRegistry(join(root, "peers"));
const executor = new ProcessExecutor({ tempRoot: root });
const activityArtifact = inspectArtifact(fileURLToPath(new URL("./peer-activity-fixture.mjs", import.meta.url)), "effect@1", "1", false);
const activityArtifacts = { "effect@1": activityArtifact.digest };
const owner = role === "owner" ? new WorkflowOwner({ id: peers.id, path: join(root, "workflows.db"), artifacts: [inspectArtifact(fileURLToPath(new URL("./peer-workflow-fixture.mjs", import.meta.url)), "effect", "1")], activityArtifacts, executor }) : null;
// The owner's real workflows server, behind an HTTPS edge that can lose an acknowledgement after the owner acted on it.
const control = owner ? createWorkflowServer({ owner, secret: randomUUID(), authenticateWorker: credential => peers.authenticate(credential) }) : null;
if (control) await new Promise<void>(resolve => control.listen(0, "127.0.0.1", resolve));
const droppedAcks = new Set<string>();
const server = createServer({ cert: readFileSync(cert), key: readFileSync(key) }, (req, res) => { void (async () => {
  if (!control) { res.writeHead(404); res.end(); return; }
  const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
  const body = Buffer.concat(chunks).toString("utf8");
  const response = await fetch(`http://127.0.0.1:${(control.address() as { port: number }).port}${req.url}`, { method: req.method, headers: { "Content-Type": "application/json", ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}) }, ...(req.method === "POST" ? { body } : {}) });
  const text = await response.text();
  const operation = (() => { try { return String((JSON.parse(body) as { request?: { operation?: unknown } }).request?.operation); } catch { return ""; } })();
  if (response.ok && droppedAcks.delete(operation)) { res.destroy(); return; }
  res.writeHead(response.status, { "Content-Type": "application/json" }); res.end(text);
})().catch(() => res.destroy()); });
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
let worker: ActivityWorker | undefined;
const tick = setInterval(() => { void owner?.pump().catch(error => process.send?.({ event: "error", message: String(error) })); void worker?.tick().catch(() => {}); }, 50);
process.on("message", (message: { id: string; operation: string; args: Record<string, unknown> }) => { void (async () => {
  const args = message.args;
  switch (message.operation) {
    case "invite": { const invited = peers.inviteWorker(String(args.name)); return { worker: invited.worker.id, credential: invited.credential }; }
    case "revoke": return peers.revokeWorker(String(args.name)).id;
    case "connect": {
      const owners = args.owners as { id: string; address: string; credential: string }[];
      worker = new ActivityWorker({ capacity: 2, artifacts: activityArtifacts, connections: owners.map(peer => connectOwnerV2(peer.id, ownerCall(peer.address, peer.credential, { timeoutMs: 2000 }))), activities: { "effect@1": executor.activity(activityArtifact) } });
      return true;
    }
    case "start": return owner!.start({ id: String(args.run), type: "effect", version: "1", input: { destination: String(args.destination), value: Number(args.value) } });
    case "get": return owner!.get(String(args.run));
    case "attempts": return owner!.inspect(String(args.run)).commands.flatMap(command => command.attempts.map(attempt => attempt.worker));
    case "drop-ack": droppedAcks.add(String(args.operation)); return true;
    case "stop": {
      clearInterval(tick); await worker?.drain(3000); await executor.close(); await owner?.drain();
      await new Promise<void>(resolve => server.close(() => resolve()));
      if (control) await new Promise<void>(resolve => control.close(() => resolve()));
      owner?.close(); peers.close(); process.disconnect(); return true;
    }
    default: throw new Error("unknown fixture command");
  }
})().then(result => { if (process.connected) process.send?.({ id: message.id, result }); }).catch(error => process.send?.({ id: message.id, error: String(error) })); });
process.send?.({ event: "ready", node: peers.id, address: `https://127.0.0.1:${(server.address() as { port: number }).port}` });
