import { describe, expect, it } from "vitest";
import { PI_CAPABILITIES } from "./capabilities.js";

describe("Pi Capabilities", () => {
  it("declares native capabilities matching Pi SDK", () => {
    expect(PI_CAPABILITIES.mcpTransports).toEqual(["stdio", "http"]);
    expect(PI_CAPABILITIES.toolDenial).toBe("native");
    expect(PI_CAPABILITIES.systemPromptFormat).toBe("preset-append");
    expect(PI_CAPABILITIES.skillsMount).toBe("plugin");
    expect(PI_CAPABILITIES.withoutKey).toBe("unauthenticated");
    expect(PI_CAPABILITIES.endpoint).toBe("configurable");
  });
});
