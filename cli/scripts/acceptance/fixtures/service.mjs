import { createServer } from "node:http";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
const [root, port, drain = "250"] = process.argv.slice(2);
if (!root || !port) throw new Error("fixture requires explicit root and port");
mkdirSync(root, { recursive: true, mode: 0o700 });
const record = (event, extra = {}) => appendFileSync(join(root, "events.jsonl"), JSON.stringify({
  event, pid: process.pid, uid: process.getuid(), at: new Date().toISOString(), ...extra,
}) + "\n");
record("start", { environment: Object.keys(process.env).sort() });
let draining = false;
const server = createServer((req, res) => {
  if (req.url === "/health") { res.writeHead(draining ? 503 : 200); res.end(JSON.stringify({ ready: !draining, pid: process.pid, uid: process.getuid() })); }
  else if (req.url === "/crash" && req.method === "POST") { record("crash"); res.end("crashing"); setImmediate(() => process.exit(19)); }
  else { res.writeHead(404); res.end(); }
});
server.listen(Number(port), "127.0.0.1", () => record("ready"));
process.once("SIGTERM", () => {
  draining = true; record("drain");
  server.close(() => setTimeout(() => { record("exit"); process.exit(0); }, Number(drain)));
  server.closeAllConnections();
});
