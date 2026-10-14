import { describe, expect, it, vi } from "vitest";
import { PI_OFFERED_MODELS, listPiModels } from "./offered-models.js";

describe("Pi Offered Models", () => {
  it("declares non-empty offered models in provider/model format", () => {
    expect(PI_OFFERED_MODELS.length).toBeGreaterThan(5);
    for (const m of PI_OFFERED_MODELS) {
      expect(m.id).toContain("/");
      expect(m.label).toBeTruthy();
    }
  });

  it("reads the SDK catalog with isolated credentials and no model profile", async () => {
    const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
    const { InMemoryCredentialStore } = await import("@earendil-works/pi-ai");
    const create = vi.spyOn(ModelRuntime, "create");
    const list = await listPiModels();
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((id) => id.includes("/"))).toBe(true);
    expect(create).toHaveBeenCalledWith({ credentials: expect.any(InMemoryCredentialStore), modelsPath: null });
    create.mockRestore();
  });
});
