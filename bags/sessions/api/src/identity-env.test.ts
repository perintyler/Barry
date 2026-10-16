import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const environment = vi.fn();

vi.mock("@barry-rocks/identities-bag", () => ({
  identityRecords: {
    row: (id: number) => get(id),
    config: (row: unknown) => row,
    touch: async () => undefined,
  },
}));
vi.mock("@barry-rocks/sdk/internal/env", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/internal/env")>(),
  identityEnvironmentForId: (id: number, options: unknown) => environment(id, options),
}));

const { IdentityEnvironmentError, resolveEnvForBarry } = await import("./identity-env.js");

describe("resolveEnvForBarry", () => {
  beforeEach(() => {
    get.mockReset();
    environment.mockReset();
  });

  it("returns no environment for a session without an identity", async () => {
    expect((await resolveEnvForBarry(null)).environment).toBeNull();
  });

  it("returns the identity's built environment", async () => {
    get.mockResolvedValue({ id: 7 });
    environment.mockResolvedValue({ vars: { KEY: "v" }, sources: { KEY: "keychain" } });
    expect((await resolveEnvForBarry(7)).environment?.vars).toEqual({ KEY: "v" });
    expect(environment).toHaveBeenCalledWith(7, expect.objectContaining({ cacheTtlMs: 300_000, touch: false }));
  });

  it("refuses when the environment fails to build, instead of running without it", async () => {
    get.mockResolvedValue({ id: 7 });
    environment.mockRejectedValue(new Error("vault is sealed"));
    const result = resolveEnvForBarry(7);
    await expect(result).rejects.toBeInstanceOf(IdentityEnvironmentError);
    await expect(result).rejects.toThrow(/vault is sealed.*barry identity check/);
  });

  it("refuses when the identity no longer exists", async () => {
    environment.mockRejectedValue(new Error("identity 7 not found"));
    await expect(resolveEnvForBarry(7)).rejects.toThrow(/not found/);
    expect(get).not.toHaveBeenCalled();
  });
});
