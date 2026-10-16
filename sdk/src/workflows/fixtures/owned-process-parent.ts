/** Native subprocess fixture. Only explicit scratch-root commands are accepted. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareOwnedProcess } from "../owned-process.js";

const self = fileURLToPath(import.meta.url), loader = import.meta.resolve("tsx");
function scratch(value: string | undefined): string {
  assert.ok(value);const root = realpathSync(value);
  assert.equal(dirname(root), realpathSync(tmpdir()));
  assert.match(basename(root), /^owned-process-test-[A-Za-z0-9]+$/);
  return root;
}
async function send(value: unknown): Promise<void> {
  assert.ok(process.send);
  await new Promise<void>((resolve, reject) => process.send!(value, (error: Error | null) => error ? reject(error) : resolve()));
}
const mode = process.argv[2], root = scratch(process.argv[3]);
if (mode === "descendant") {
  process.on("SIGTERM", () => {});
  writeFileSync(join(root, "descendant.json"), JSON.stringify({ pid: process.pid, parent: process.ppid }));
  setInterval(() => {}, 1000);
} else if (mode === "application") {
  const behavior = process.argv[4];assert.ok(behavior === "resist" || behavior === "exit-on-term");
  writeFileSync(join(root, "application.json"), JSON.stringify({ pid: process.pid, parent: process.ppid }));
  process.on("SIGTERM", () => { if (behavior === "exit-on-term") process.exit(0); });
  const descendant = spawn(process.execPath, ["--import", loader, self, "descendant", root], { cwd: root, env: { PATH: process.env.PATH, TMPDIR: tmpdir() }, stdio: "ignore" });
  descendant.on("error", error => { process.stderr.write(String(error));process.exit(2); });
  while (!existsSync(join(root, "descendant.json"))) await new Promise(resolve => setTimeout(resolve, 10));
  const retained = JSON.parse(readFileSync(join(root, "descendant.json"), "utf8")) as { pid: number };
  assert.equal(retained.pid, descendant.pid);
  process.on("message", value => { if (value && typeof value === "object" && "command" in value && value.command === "exit-root") process.exit(0); });
  await send({ ready: true, application: process.pid, descendant: descendant.pid });
  setInterval(() => {}, 1000);
} else if (mode === "parent") {
  const deadline = Number(process.argv[4]);assert.ok(Number.isSafeInteger(deadline) && deadline > Date.now());
  const owned = await prepareOwnedProcess({ deadline, tempRoot: root });
  const ready = new Promise<unknown>(resolve => { owned.onMessage(message => { if (message && typeof message === "object" && "ready" in message && message.ready === true) resolve(message); }); });
  await owned.launch({ command: process.execPath, args: ["--import", loader, self, "application", root, "resist"], cwd: root, env: { PATH: process.env.PATH ?? "", TMPDIR: tmpdir() } });
  await send({ ready: true, handle: owned.handle, application: await ready, deadline });
  process.on("message", message => {
    if (message && typeof message === "object" && "command" in message && message.command === "close") {
      void owned.dispose().then(() => process.exit(0), error => { process.stderr.write(String(error));process.exit(2); });
    }
  });
  setInterval(() => {}, 1000);
} else throw new Error("Unknown owned-process fixture command");
