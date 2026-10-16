/** Scratch-only fault gates after real spool commit or before real approved effect closure. */
import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { parseWorkflowHarnessMessage, workflowHarnessBindingSchema, workflowHarnessPermissionRequestSchema } from "../../../bags/sessions/api/src/workflow-harness-protocol.js";

const directory = realpathSync(process.argv.at(-1)!);
const root = dirname(dirname(directory));
assert.equal(dirname(root), realpathSync(tmpdir()));
assert.match(basename(root), /^workflow-agent-physical-[A-Za-z0-9]+$/);
assert.equal(dirname(directory), join(root, "spool"));
const gate = JSON.parse(readFileSync(join(root, "recovery-gate.json"), "utf8")) as { outcome?: string; disconnect: boolean; holdEffect: boolean; effect: { id: string; path: string; content: string } };
const binding = workflowHarnessBindingSchema.parse(JSON.parse(readFileSync(join(directory, "binding.json"), "utf8")));
const effects = new Set<string>();
const original = process.send;
assert.ok(original);
process.send = function (...args: Parameters<NonNullable<typeof process.send>>) {
  const message: unknown = args[0];
  const decoded: unknown = typeof message === "string" ? JSON.parse(message) : message;
  if (gate.holdEffect && decoded && typeof decoded === "object" && "kind" in decoded && decoded.kind === "request" && "method" in decoded && decoded.method === "execute") {
    const request = parseWorkflowHarnessMessage(decoded, binding);
    assert.ok(request.kind === "request" && request.value && typeof request.value === "object" && "call" in request.value && "effectId" in request.value);
    const call = workflowHarnessPermissionRequestSchema.parse(request.value.call);
    assert.equal(call.id, gate.effect.id);assert.equal(call.tool, "write");assert.deepEqual(call.input, { path: gate.effect.path, content: gate.effect.content });
    const effectId = request.value.effectId;assert.equal(typeof effectId, "string");assert.match(String(effectId), /^[0-9a-f]{8}-[0-9a-f-]{27}$/);
    effects.add(String(effectId));
  }
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

const originalEmit = process.emit;
process.emit = function (event: string | symbol, ...args: unknown[]): boolean {
  if (gate.holdEffect && event === "message") {
    const decoded: unknown = typeof args[0] === "string" ? JSON.parse(args[0]) as unknown : args[0];
    if (decoded && typeof decoded === "object" && "kind" in decoded && decoded.kind === "request" && "method" in decoded && decoded.method === "effect") {
      const request = parseWorkflowHarnessMessage(decoded, binding);
      assert.ok(request.kind === "request" && request.value && typeof request.value === "object" && "effectId" in request.value);
      assert.deepEqual(Object.keys(request.value), ["effectId"]);
      const effectId = request.value.effectId;assert.equal(typeof effectId, "string");assert.ok(effects.has(String(effectId)));
      assert.equal(existsSync(gate.effect.path), false);
      writeFileSync(join(root, "effect-pending.json"), JSON.stringify({ binding, effectId, pid: process.pid }), { mode: 0o600 });
      // Parent journal has committed executing before it sends this RPC. Hold
      // the real request before production dispatch can invoke its closure.
      return true;
    }
  }
  return Reflect.apply(originalEmit, process, [event, ...args]);
} as typeof process.emit;
