/** Fault injection only after the production worker has committed its real spool. */
import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";

const directory = realpathSync(process.argv.at(-1)!);
const root = dirname(dirname(directory));
assert.equal(dirname(root), realpathSync(tmpdir()));
assert.match(basename(root), /^workflow-agent-recovery-[A-Za-z0-9]+$/);
assert.equal(dirname(directory), join(root, "spool"));
const gate = JSON.parse(readFileSync(join(root, "recovery-gate.json"), "utf8")) as { outcome: string; disconnect: boolean };
const original = process.send;
assert.ok(original);
process.send = function (...args: Parameters<NonNullable<typeof process.send>>) {
  const message: unknown = args[0];
  const decoded: unknown = typeof message === "string" ? JSON.parse(message) : message;
  if (decoded && typeof decoded === "object" && "kind" in decoded && decoded.kind === "response" && "value" in decoded
    && decoded.value && typeof decoded.value === "object" && "type" in decoded.value && decoded.value.type === gate.outcome) {
    assert.ok(existsSync(join(directory, "result.json")), "Fault must follow actual production spool commit");
    const retained = JSON.parse(readFileSync(join(directory, "result.json"), "utf8"));
    assert.deepEqual(retained.outcome, decoded.value);
    writeFileSync(join(root, "outcome-committed.json"), JSON.stringify({ binding: retained.binding, type: retained.outcome.type, pid: process.pid }), { mode: 0o600 });
    if (gate.disconnect) process.disconnect!();
    // The response and its callback remain pending. The real guardian owns
    // disconnect/deadline cleanup; the test does not supply an outcome.
    return true;
  }
  return original.apply(process, args);
} as NonNullable<typeof process.send>;
