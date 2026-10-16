import { expect, it } from "vitest";
import { mergeVendorFactories, type VendorFactories } from "./models.js";

it("combines separate providers and retains each kind for a shared vendor", () => {
  const completion = () => { throw new Error("fixture completion"); };
  const decision = () => { throw new Error("fixture decision"); };
  const sources: VendorFactories[] = [{ completion: { anthropic: completion } }, { decision: { anthropic: decision } }];
  const result = mergeVendorFactories(...sources);
  expect(result.completion?.anthropic).toBe(completion);
  expect(result.decision?.anthropic).toBe(decision);
  expect(sources[0].decision).toBeUndefined();
});
it("refuses a colliding provider registration instead of selecting by import order", () => {
  const factory = () => { throw new Error("unused"); };
  expect(() => mergeVendorFactories({ completion: { ollama: factory } }, { completion: { ollama: factory } }))
    .toThrow("duplicate completion factory for vendor ollama");
});
it("refuses colliding discovery and health hooks", () => {
  const discover = async () => [];
  expect(() => mergeVendorFactories({ listModels: { ollama: discover } }, { listModels: { ollama: discover } })).toThrow("duplicate listModels");
  expect(() => mergeVendorFactories({ check: { ollama: discover } }, { check: { ollama: discover } })).toThrow("duplicate check");
});
