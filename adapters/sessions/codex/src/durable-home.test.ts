import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { defaultCodexHome, prepareCodexRuntime } from "./runtime.js";
import { codexTranscript } from "./transcript.js";

const cleanup: string[] = [];
afterEach(() => { for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true }); vi.unstubAllEnvs(); });
function scratch() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "barry-codex-durable-"))); cleanup.push(root); vi.stubEnv("BARRY_HOME", root);
  const sessionId = `durable-${root}`;
  const alias = defaultCodexHome(sessionId); cleanup.push(alias);
  return { root, sessionId, alias };
}
it("keeps rollout data when temporary aliases disappear and recreates the same home", async () => {
  const { root, sessionId, alias } = scratch();
  prepareCodexRuntime({ barrySessionId: sessionId });
  const threadId = "a1111111-1111-4111-8111-111111111111";
  mkdirSync(join(alias, "sessions"));
  writeFileSync(join(alias, "sessions", `rollout-${threadId}.jsonl`), '{"role":"user","text":"resume me"}\n');
  const durable = realpathSync(alias);
  expect(durable.startsWith(root)).toBe(true);
  rmSync(alias, { recursive: true, force: true });
  expect(existsSync(join(durable, "sessions", `rollout-${threadId}.jsonl`))).toBe(true);
  // Discovery must work before another launch has rebuilt CODEX_HOME.
  const located = await codexTranscript.locate({ harnessSessionId: threadId });
  expect(located).not.toBeNull();
  expect(readFileSync(located!, "utf8")).toContain("resume me");
  expect(prepareCodexRuntime({ barrySessionId: sessionId }).codexHome).toBe(alias);
  expect(realpathSync(alias)).toBe(durable);
});
it("migrates an existing managed temporary home without losing its conversation", () => {
  const { root, sessionId, alias } = scratch();
  mkdirSync(alias, { recursive: true });
  writeFileSync(join(alias, "conversation.jsonl"), "kept");
  prepareCodexRuntime({ barrySessionId: sessionId });
  expect(realpathSync(alias).startsWith(root)).toBe(true);
  expect(readFileSync(join(alias, "conversation.jsonl"), "utf8")).toBe("kept");
});
