import { expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fork, execFileSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

it("runs two owners and two invited workers over HTTPS /api/worker with lost claim, heartbeat, effect and completion acknowledgements", async () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-peer-acceptance-")), cert = join(root, "cert.pem"), key = join(root, "key.pem");
  const children: ChildProcess[] = [];
  const destination = new DatabaseSync(join(root, "effects.db"));
  destination.exec("CREATE TABLE effects(key TEXT PRIMARY KEY,value INTEGER NOT NULL)");
  let physicalCalls = 0, dropped = false;
  const effects = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { key: string; value: number };
    physicalCalls++;
    destination.prepare("INSERT OR IGNORE INTO effects VALUES(?,?)").run(body.key, body.value);
    if (!dropped) { dropped = true; res.destroy(); return; }
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(destination.prepare("SELECT value FROM effects WHERE key=?").get(body.key)));
  });
  await new Promise<void>(resolve => effects.listen(0, "127.0.0.1", resolve));
  const start = async (role: string, name: string) => {
    const child = fork(fileURLToPath(new URL("./peer-process-fixture.ts", import.meta.url)), [role, join(root, name), cert, key], { execArgv: ["--import", "tsx"], env: { ...process.env, BARRY_HOME: join(root, name, "home"), NODE_EXTRA_CA_CERTS: cert }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    children.push(child);
    let stderr = ""; child.stderr?.on("data", data => { stderr += String(data); });
    const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    const ready = await new Promise<{ node: string; address: string }>((resolve, reject) => {
      child.once("exit", () => reject(new Error(`fixture exited: ${stderr}`)));
      child.on("message", (message: { event?: string; node: string; address: string; id?: string; result: unknown; error?: string }) => {
        if (message.event === "ready") resolve(message);
        if (message.id) { const request = pending.get(message.id); pending.delete(message.id); if (message.error) request?.reject(new Error(message.error)); else request?.resolve(message.result); }
      });
    });
    const call = (operation: string, args: Record<string, unknown> = {}) => new Promise<unknown>((resolve, reject) => {
      const id = randomUUID(), timer = setTimeout(() => { pending.delete(id); reject(new Error(`fixture command timed out: ${operation}; ${stderr}`)); }, 10_000);
      pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      child.send({ id, operation, args });
    });
    return { ...ready, call };
  };
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1", "-days", "1"], { stdio: "ignore" });
    const owners = await Promise.all([start("owner", "o1"), start("owner", "o2")]);
    const workers = await Promise.all([start("worker", "w1"), start("worker", "w2")]);
    const assigned = new Map<string, string>();
    for (const [index, worker] of workers.entries()) {
      const peers = await Promise.all(owners.map(async owner => {
        const invited = await owner.call("invite", { name: `w${index + 1}` }) as { worker: string; credential: string };
        assigned.set(invited.worker, `w${index + 1}`);
        return { id: owner.node, address: owner.address, credential: invited.credential };
      }));
      await worker.call("connect", { owners: peers });
    }
    await owners[0].call("drop-ack", { operation: "complete" });
    await owners[0].call("drop-ack", { operation: "claim" });
    await owners[1].call("drop-ack", { operation: "heartbeat" });
    const url = `http://127.0.0.1:${(effects.address() as { port: number }).port}`;
    for (const [index, owner] of owners.entries()) await owner.call("start", { run: "job", destination: url, value: index + 1 });
    let runs: { status: string }[] = [];
    for (let attempt = 0; attempt < 200; attempt++) {
      runs = await Promise.all(owners.map(owner => owner.call("get", { run: "job" }))) as { status: string }[];
      if (runs.every(run => run.status === "completed")) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    expect(runs.map(run => run.status)).toEqual(["completed", "completed"]);
    expect(destination.prepare("SELECT count(*) n FROM effects").get()?.n).toBe(2);
    expect(physicalCalls).toBeGreaterThan(2);
    // Attempts are attributed to the worker ids the owners assigned at invite time, never to the workers' own installation ids.
    for (const owner of owners) {
      const attemptWorkers = await owner.call("attempts", { run: "job" }) as string[];
      expect(attemptWorkers.length).toBeGreaterThan(0);
      for (const id of attemptWorkers) expect(assigned.has(id)).toBe(true);
      for (const worker of workers) expect(attemptWorkers).not.toContain(worker.node);
    }
  } finally {
    for (const child of children) child.kill("SIGKILL");
    await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise<void>(resolve => child.once("exit", () => resolve()))));
    await new Promise<void>(resolve => { effects.closeAllConnections(); effects.close(() => resolve()); });
    destination.close(); rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
