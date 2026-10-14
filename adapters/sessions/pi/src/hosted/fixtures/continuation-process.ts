import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, Type, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { PiContinuation } from "../continuation.js";

const [directory, phase] = process.argv.slice(2);
if (!directory || !["pause", "resume"].includes(phase)) throw new Error("Expected scratch directory and phase");
const model: Model<"anthropic-messages"> = {
  id: "fixture", name: "fixture", api: "anthropic-messages", provider: "anthropic", baseUrl: "https://invalid.test",
  reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 1024,
};
const execute = async (_id: string, raw: unknown) => {
  const args = raw as { path: string; content: string };
  writeFileSync(join(directory, args.path), args.content);
  return { content: [{ type: "text" as const, text: "Fixture file written" }], details: null };
};
const tool = {
  name: "fixture_write", label: "Fixture write", description: "Write fixture output",
  parameters: Type.Object({ path: Type.String(), content: Type.String() }),
  execute,
};
const answer: AssistantMessage = {
  role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: 1,
  content: phase === "pause"
    ? [{ type: "thinking", thinking: "opaque context", thinkingSignature: "provider-signature" }, { type: "toolCall", id: "original-effect-write", name: "fixture_write", arguments: { path: "effect.txt", content: "Original approved bytes" } }]
    : [{ type: "text", text: "Finished original write" }],
  stopReason: phase === "pause" ? "toolUse" : "stop",
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
};
let providerRequests = 0;
const agent = new Agent({ initialState: { model, tools: [tool] }, streamFn: (_model, context) => {
    providerRequests++;
    if (phase === "resume") {
      const result = context.messages.at(-1);
      if (result?.role !== "toolResult" || result.toolCallId !== "original-effect-write") throw new Error("Original result was not injected before provider continuation");
      const original = context.messages.find((message) => message.role === "assistant");
      if (original?.role !== "assistant" || !original.content.some((part) => part.type === "thinking" && part.thinkingSignature === "provider-signature")) throw new Error("Opaque provider context was lost");
    }
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "done", reason: answer.stopReason as "stop" | "toolUse", message: answer });
    return stream;
} });
const harness = new PiContinuation(agent, "fixture-config", () => {});
const events: unknown[] = [];
const emit = async (event: unknown) => { events.push(event); };
if (phase === "pause") {
  const outcome = await harness.begin("Write the file", emit);
  if (outcome.type !== "interrupted") throw new Error("Expected pending approval");
  writeFileSync(join(directory, "checkpoint.json"), JSON.stringify(outcome.continuation));
  writeFileSync(join(directory, "paused.json"), JSON.stringify({ pid: process.pid, calls: outcome.calls, events }));
} else {
  const checkpoint = JSON.parse(readFileSync(join(directory, "checkpoint.json"), "utf8"));
  const outcome = await harness.restore(checkpoint, new Map([["original-effect-write", { allow: true }]]), {
    authorize: async () => ({ allow: true }), execute: async (_call, effect) => effect(),
  }, emit);
  if (outcome.type !== "completed") throw new Error("Restored turn failed");
  writeFileSync(join(directory, "completed.json"), JSON.stringify({ pid: process.pid, providerRequests, outcome, events }));
}
await harness.close();
