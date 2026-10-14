import { describe, expect, it } from "vitest";
import { ModelRefused, asModelRef, piModel } from "./model-id.js";

describe("Pi Model ID parsing", () => {
  it("parses valid provider/model refs", () => {
    expect(piModel("anthropic/claude-sonnet-5")).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-5",
    });
    expect(piModel("openai/gpt-6-astra")).toEqual({
      provider: "openai",
      model: "gpt-6-astra",
    });
  });

  it("refuses bare model ids with no provider", () => {
    expect(() => piModel("claude-sonnet-5")).toThrow(ModelRefused);
  });

  it("constructs ModelRef using asModelRef", () => {
    const ref = asModelRef("google", "gemini-3.8-flash");
    expect(ref).toBe("google/gemini-3.8-flash");
  });
});
