import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  entries: new Map<string, string>(),
  registrations: [] as string[],
  options: [] as { registrationSecret?: string }[],
  dropEmail: false,
}));
const installation = vi.hoisted(() => vi.fn(async (_names: string[]) => ({ VAULT_REGISTRATION_SECRET: "configured-bootstrap" })));
vi.mock("@barry-rocks/sdk/internal/services", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/internal/services")>(),
  installationSecrets: installation,
}));
vi.mock("@barry-rocks/sdk/internal/env", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/internal/env")>(),
  KeychainProvider: class {
    async set(name: string, value: string) { if (!state.dropEmail || !name.endsWith("-email")) state.entries.set(name, value); }
    async get(_service: string, name: string) { return state.entries.get(name) ?? null; }
  },
}));
vi.mock("@barry-rocks/sdk/internal/vault", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/internal/vault")>(),
  VaultClient: class {
    constructor(_url: string, options: { registrationSecret?: string }) { state.options.push(options); }
    async register(email: string) {
      state.registrations.push(email);
      return { clientId: "client-id", clientSecret: "client-secret", masterPassword: "master-password" };
    }
  },
}));
import { provisionVaultAccount } from "./identity.js";

beforeEach(() => {
  state.entries.clear(); state.registrations.length = 0; state.options.length = 0; state.dropEmail = false;
  installation.mockClear();
  vi.stubEnv("VAULT_REGISTRATION_SECRET", "unrelated-shell-bootstrap");
});
afterEach(() => vi.unstubAllEnvs());

describe("named vault provisioning", () => {
  it("returns a name and stores all verified credentials and normalized login email", async () => {
    expect(await provisionVaultAccount("personal", " User@Example.com ")).toBe("personal");
    expect(state.registrations).toEqual(["user@example.com"]);
    expect(state.options).toEqual([{ registrationSecret: "configured-bootstrap" }]);
    expect(installation).toHaveBeenCalledWith(["VAULT_REGISTRATION_SECRET"]);
    expect(Object.fromEntries(state.entries)).toEqual({
      "vault-personal-client-id": "client-id",
      "vault-personal-client-secret": "client-secret",
      "vault-personal-master-password": "master-password",
      "vault-personal-email": "user@example.com",
    });
  });
  it("refuses to report success when the stored login email cannot be read back", async () => {
    state.dropEmail = true;
    await expect(provisionVaultAccount("personal", "user@example.com")).rejects.toThrow("verification failed for vault-personal-email");
  });
  it("validates the vault name before accessing credentials or registering an account", async () => {
    await expect(provisionVaultAccount("invalid/name", "user@example.com")).rejects.toThrow("vault name");
    expect(installation).not.toHaveBeenCalled();
    expect(state.registrations).toEqual([]);
    expect(state.entries.size).toBe(0);
  });
});
