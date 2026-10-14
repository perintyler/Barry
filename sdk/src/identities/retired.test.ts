import { describe, expect, it } from "vitest";
import { adaptersFromRetired, type RetiredIdentityKeys } from "./retired.js";
import { mergeAdapters, ownAdapters } from "./adapters.js";

const lookups = { harness: (name: string) => name === "claude" || name === "claude-code" ? "claude-code" : name === "codex" ? "codex" : undefined, isVendor: (name: string) => ["zai", "ollama", "llamacpp"].includes(name), runsOn: "codex" };

describe("retired identity settings", () => {
  it.each<[RetiredIdentityKeys, Record<string, unknown>]>([
    [{ default_harness: "codex", default_coding_agent: "claude" }, { codex: { default: true } }],
    [{ default_coding_agent: "claude", default_model: "opus" }, { "claude-code": { default: true, model: "opus" } }],
    [{ default_harness: "unknown" }, { unknown: { default: true } }],
    [{ default_harness: "ollama", default_model: "qwen" }, { "claude-code": { default: true, model: "ollama/qwen" } }],
    [{ default_model: "gpt-5" }, { codex: { model: "gpt-5" } }],
    [{ default_model: "qwen", default_model_provider: "ollama" }, { codex: { model: "ollama/qwen" } }],
    [{ default_model: "ollama/qwen", default_model_provider: "ollama" }, { codex: { model: "ollama/qwen" } }],
  ])("converts %j", (retired, adapters) => {
    expect(adaptersFromRetired(retired, lookups)).toEqual({ adapters, notes: [], problems: [] });
  });
  it.each([{ default_harness: "ollama" }, { default_model_provider: "ollama" }, { default_model: 3 }])("reports a conversion requiring an edit: %j", retired => {
    expect(adaptersFromRetired(retired, lookups).problems.length).toBeGreaterThan(0);
  });
  it("drops the ineffective native tools switch with a note", () => {
    expect(adaptersFromRetired({ allow_native_tools: true }, lookups)).toMatchObject({ adapters: {}, problems: [], notes: [expect.stringContaining("had no effect")] });
  });
  it("migrates bux without copying its settings into bgoode", () => {
    const bux = adaptersFromRetired({ default_coding_agent: "claude", default_model: "claude-opus-5", allow_native_tools: true }, lookups).adapters;
    const child = adaptersFromRetired({ default_coding_agent: "claude" }, { ...lookups, runsOn: "claude-code" }).adapters;
    expect(bux).toEqual({ "claude-code": { default: true, model: "claude-opus-5" } });
    expect(ownAdapters(bux, mergeAdapters(bux, child))).toEqual({});
  });
});
