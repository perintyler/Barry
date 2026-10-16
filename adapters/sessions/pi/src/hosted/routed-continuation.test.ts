import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { executionHash, type ContinuationHarness, type SessionConfig } from "@barry-rocks/sdk/sessions";
import adapter from "../adapter.js";
import { NATIVE_TOOLS } from "../native-tools.js";

// Actual adapter factory and bundled Pi SDK; only the local model provider is
// deterministic. No fake AgentSession or manufactured continuation descriptor.
let root: string, server: Server, endpoint: string;
let requests: { authorization: string | undefined; path: string | undefined }[];
let harnesses: ContinuationHarness[];
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "pi-routed-continuation-"));requests = [];harnesses = [];
  vi.stubEnv("HOME", root);vi.stubEnv("BARRY_HOME", join(root, "barry"));vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "pi"));
  vi.stubEnv("OPENAI_API_KEY", "wrong-ambient-key");
  server = createServer((req, res) => {
    let raw = "";req.on("data", bytes => { raw += String(bytes); });req.on("end", () => {
      const body = JSON.parse(raw);requests.push({ authorization: req.headers.authorization, path: req.url });
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: unknown, finish_reason: string | null) => res.write(`data: ${JSON.stringify({ id: "routed", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      chunk({ role: "assistant", content: "actual routed result" }, null);chunk({}, "stop");res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
});
afterEach(async () => {
  const results = await Promise.allSettled(harnesses.map(harness => harness.close()));
  server.closeAllConnections();await new Promise<void>(resolve => server.close(() => resolve()));
  vi.unstubAllEnvs();rmSync(root, { recursive: true, force: true });
  const failed = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failed.length) throw new AggregateError(failed.map(result => result.reason), "Actual Pi continuation cleanup failed");
});
function configuration(): SessionConfig {
  return { sessionId: "routed-session", cwd: root, env: { HOME: root, OPENAI_API_KEY: "wrong-config-key" }, model: "openai/probe",
    endpoint: { baseUrl: endpoint, apiKey: "explicit-endpoint-key" }, mcpServers: {}, allowedNativeTools: [] };
}
async function open(config: SessionConfig) {
  const harness = await adapter.modes.hosted!.openContinuation!(config, async () => { throw new Error("Tool-free fixture cannot start an engine"); });
  harnesses.push(harness);return harness;
}

it("refuses a no-endpoint turn without an identity-declared key despite an ambient key before provider traffic", async () => {
  const { endpoint: _endpoint, ...config } = configuration();
  await expect(open({ ...config, env: { HOME: root } })).rejects.toThrow("declared sources");
  expect(requests).toEqual([]);
});

it("uses the explicit endpoint key instead of both configured identity and ambient provider-key decoys", async () => {
  const harness = await open(configuration());
  const outcome = await harness.begin("Use the selected route", async () => {});
  expect(outcome).toMatchObject({ type: "completed", result: "actual routed result" });
  expect(requests).toEqual([{ authorization: "Bearer explicit-endpoint-key", path: "/v1/chat/completions" }]);
});

it("binds an actual conversation checkpoint to its endpoint while permitting same-endpoint credential rotation", async () => {
  const original = await open(configuration());
  const outcome = await original.begin("Retain this route", async () => {});
  expect(outcome.type).toBe("completed");
  if (outcome.type !== "completed" || !outcome.conversation) throw new Error("Actual Pi did not retain a completed conversation");
  const descriptor = outcome.conversation;
  await original.close();
  const rotated = await open({ ...configuration(), endpoint: { baseUrl: endpoint, apiKey: "rotated-endpoint-key" } });
  expect(() => rotated.validate(descriptor)).not.toThrow();
  const moved = await open({ ...configuration(), endpoint: { baseUrl: endpoint + "/changed", apiKey: "explicit-endpoint-key" } });
  expect(() => moved.validate(descriptor)).toThrow("Incompatible Pi continuation");
  expect(requests).toHaveLength(1);
  expect(JSON.stringify(descriptor)).not.toContain("explicit-endpoint-key");
  expect(JSON.stringify(descriptor)).not.toContain("rotated-endpoint-key");
});

it("preserves the historical no-endpoint configuration fingerprint without making a cloud request", async () => {
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  const { InMemoryCredentialStore } = await import("@earendil-works/pi-ai");
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null });
  const model = runtime.getModels("openai")[0];expect(model).toBeDefined();
  const config: SessionConfig = { sessionId: "historical-session", cwd: root, model: `openai/${model.id}`, env: { HOME: root, OPENAI_API_KEY: "declared-unused-local-key" }, mcpServers: {}, allowedNativeTools: [] };
  const harness = await open(config);
  const historical = executionHash({ sessionId: config.sessionId, cwd: config.cwd, model: config.model, systemPrompt: null,
    deniedTools: [...NATIVE_TOOLS], pluginDirs: [], projectRoots: [], mcpServers: [] });
  // Observe the actual instantiated PiContinuation fingerprint without inventing
  // a checkpoint or beginning a turn against a public provider.
  expect(Reflect.get(harness, "fingerprint")).toBe(historical);
  expect(requests).toEqual([]);
});

it("includes inferencePolicy in continuation fingerprint when configured and rejects policy tampering on restore", async () => {
  const { DEFAULT_PI_IMPLEMENTATION_VERSION, createDefaultExecutionBinding } = await import("../inference-bounds.js");
  const base = configuration();
  const binding = createDefaultExecutionBinding();
  const h1 = await open({
    ...base,
    inferencePolicy: {
      version: 1,
      binding,
      session_id: "routed-session",
      turn_id: "turn-fp-1",
      segment_id: "seg-fp-1",
      accepted_profile_digest: "d".repeat(64),
      endpoint_ref: "endpoint://loopback",
      provider_protocol: "openai-completions",
      implementation_version: DEFAULT_PI_IMPLEMENTATION_VERSION,
      model: "probe",
      deadline: 4_102_444_800_000,
      max_calls: null,
      max_input_tokens: null,
      max_output_tokens: 256,
      max_cost: null,
      fallback_policy: "none",
      accounting_policy: "reconciled",
    },
  } as SessionConfig);

  const outcome = await h1.begin("Route with policy", async () => {});
  expect(outcome.type).toBe("completed");
  if (outcome.type !== "completed" || !outcome.conversation) {
    throw new Error("Expected completed conversation descriptor");
  }

  const h2DifferentPolicy = await open({
    ...base,
    inferencePolicy: {
      version: 1,
      binding,
      session_id: "routed-session",
      turn_id: "turn-fp-1",
      segment_id: "seg-fp-1",
      accepted_profile_digest: "d".repeat(64),
      endpoint_ref: "endpoint://loopback",
      provider_protocol: "openai-completions",
      implementation_version: DEFAULT_PI_IMPLEMENTATION_VERSION,
      model: "probe",
      deadline: 4_102_444_800_000,
      max_calls: null,
      max_input_tokens: null,
      max_output_tokens: 512, // tampered max_output_tokens
      max_cost: null,
      fallback_policy: "none",
      accounting_policy: "reconciled",
    },
  } as SessionConfig);

  expect(() => h2DifferentPolicy.validate(outcome.conversation!)).toThrow(
    "Incompatible Pi continuation",
  );
});

