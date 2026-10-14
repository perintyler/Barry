import { describe, expect, it } from "vitest";
import { resumedModelProvider } from "./resume.js";

describe("resuming a session on the model it ran", () => {
  it("returns to the recorded provider AND model", () => {
    const metadata = { model_provider: "ollama", model: "gemma4:26b" };
    expect(resumedModelProvider({}, metadata)).toEqual({ modelProvider: "ollama", model: "gemma4:26b" });
  });

  it("accepts metadata stored as a JSON string", () => {
    const metadata = JSON.stringify({ model_provider: "ollama", model: "gemma4:26b" });
    expect(resumedModelProvider({}, metadata)).toEqual({ modelProvider: "ollama", model: "gemma4:26b" });
  });

  it("preserves the recorded model without a separate model-provider field", () => {
    expect(resumedModelProvider({}, { model: "claude-opus-4" })).toEqual({ model: "claude-opus-4" });
  });

  it("lets an explicit provider flag override what was recorded", () => {
    expect(resumedModelProvider({ llamacpp: true }, { model_provider: "zai", model: "glm-4.6" })).toEqual({});
    expect(resumedModelProvider({ ollama: true }, { model_provider: "zai", model: "glm-4.6" })).toEqual({});
  });
});
