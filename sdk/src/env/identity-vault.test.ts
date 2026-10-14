import { afterEach, expect, it, vi } from "vitest";
import * as vaultAccount from "../vault/account.js";
import { bindSecretReferences } from "../identities/secrets.js";
import { identityEnvironment } from "./identity.js";

const identity = {
  bags: [], vault: "identity-owned",
  secrets: bindSecretReferences({ API_KEY: { in: "vault", item: "api", field: "password" } }),
};
afterEach(() => vi.restoreAllMocks());

function session(password: string) {
  return { getItem: vi.fn(async () => ({ password })), close: vi.fn(async () => {}) };
}

it("closes a resolver-owned vault after credentials are read", async () => {
  const vault = session("identity-credential");
  const open = vi.spyOn(vaultAccount, "openVault").mockResolvedValue(vault as never);
  expect((await identityEnvironment(identity)).vars).toEqual({ API_KEY: "identity-credential" });
  expect(open).toHaveBeenCalledWith("identity-owned");
  expect(vault.getItem).toHaveBeenCalledWith("api");
  expect(vault.close).toHaveBeenCalledOnce();
});

it("closes a resolver-owned vault after an unreadable credential", async () => {
  const vault = session("");
  vi.spyOn(vaultAccount, "openVault").mockResolvedValue(vault as never);
  await expect(identityEnvironment(identity)).rejects.toThrow("absent or empty");
  expect(vault.close).toHaveBeenCalledOnce();
});

it("leaves injected sessions open and skips opening a vault for empty selections", async () => {
  const vault = session("caller-credential");
  const open = vi.spyOn(vaultAccount, "openVault");
  expect((await identityEnvironment(identity, { vault: vault as never })).vars).toEqual({ API_KEY: "caller-credential" });
  expect((await identityEnvironment(identity, { names: [] })).vars).toEqual({});
  expect(vault.close).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
});

it("reports a vault opening failure without leaking backend credentials", async () => {
  vi.spyOn(vaultAccount, "openVault").mockRejectedValue(new Error("backend-canary-credential"));
  const error = await identityEnvironment(identity).catch(error => error);
  expect(error.message).toBe("$API_KEY: could not open the declared vault");
  expect(error.cause).toBeUndefined();
});


it("rejects inline identity connections before opening the backend", async () => {
  const open = vi.spyOn(vaultAccount, "openVault");
  await expect(identityEnvironment({ ...identity, vault: { email: "private", serverUrl: "private-endpoint", credentials: {} } } as never)).rejects.toThrow("inline vault connections are retired");
  expect(open).not.toHaveBeenCalled();
});
