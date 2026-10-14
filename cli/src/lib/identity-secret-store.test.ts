import { describe, it, expect, vi, beforeEach } from "vitest";

// The shared-vault overwrite guard reads identities; this suite is about the
// write-and-verify sequence, so the guard is a pass-through here.
vi.mock("./vault-sharing.js", () => ({ guardSharedOverwrite: vi.fn(async () => {}) }));

const keychain = vi.hoisted(() => ({ store: new Map<string, string>(), dropWrites: false }));
vi.mock("@barry-rocks/sdk/internal/env", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/internal/env")>(),

  KeychainProvider: class {
    async set(account: string, value: string) {
      if (!keychain.dropWrites) keychain.store.set(account, value);
    }
    async get(_service: string, account: string) {
      return keychain.store.get(account) ?? null;
    }
  },
}));

import { storeKeychainSecret, storeVaultSecret, type OpenVault } from "./identity-secret-store.js";
import type { VaultAccount } from "@barry-rocks/sdk/internal/vault";

const vaultAccount: VaultAccount = {
  email: "x@example.com",
  serverUrl: "unix:///tmp/unused.sock",
  credentials: {
    clientId: { service: "barry", account: "a" },
    clientSecret: { service: "barry", account: "b" },
    masterPassword: { service: "barry", account: "c" },
  },
};

/** An in-memory vault, shaped like the session handle. `readBack` lets a test make the store lie. */
function fakeVault(opts: { readBack?: (written: string) => string } = {}): OpenVault & { items: Map<string, string> } {
  const items = new Map<string, string>();
  const session = {
    async getItem(name: string) {
      const written = items.get(name) ?? "";
      return { id: name, name, username: null, password: opts.readBack ? opts.readBack(written) : written, uri: null, notes: null };
    },
    async putItem(name: string, fields?: { password?: string }) {
      items.set(name, fields?.password ?? "");
    },
    async deleteItem(name: string) {
      items.delete(name);
    },
    async listItems() {
      return [...items.keys()].map((name) => ({ id: name, name, type: 1 }));
    },
    async searchItems(q: string) {
      return [...items.keys()].filter((n) => n === q).map((name) => ({ id: name, name, type: 1 }));
    },
    async close() {},
    email: vaultAccount.email,
    serverUrl: vaultAccount.serverUrl,
  };
  return { items, vault: session };
}

beforeEach(() => {
  keychain.store.clear();
  keychain.dropWrites = false;
});

describe("storeVaultSecret", () => {
  it("creates, then updates, and returns the reference", async () => {
    const vault = fakeVault();
    const target = { vaultAccount, identityName: "bux" };
    expect(await storeVaultSecret(vault, target, "API_KEY", "v1")).toEqual({ in: "vault", item: "API_KEY", field: "password" });
    await storeVaultSecret(vault, target, "API_KEY", "v2");
    expect(vault.items.get("API_KEY")).toBe("v2");
  });

  it("refuses to return a reference when the value read back is not what was written", async () => {
    // Before this, only `env migrate` read back. `identity env set/import`
    // recorded a reference to whatever was — or was not — actually stored.
    const vault = fakeVault({ readBack: () => "something-else" });
    await expect(storeVaultSecret(vault, { vaultAccount, identityName: "bux" }, "API_KEY", "v1")).rejects.toThrow(
      /Vault verification failed for API_KEY/,
    );
  });
});

describe("storeKeychainSecret", () => {
  it("files the secret under <identity>-<key> and returns the reference", async () => {
    expect(await storeKeychainSecret("bux", "LINEAR_API_KEY", "lin")).toEqual({
      in: "keychain",
      item: "barry",
      account: "bux-linear-api-key",
    });
    expect(keychain.store.get("bux-linear-api-key")).toBe("lin");
  });

  it("refuses when the Keychain did not keep the write", async () => {
    keychain.dropWrites = true;
    await expect(storeKeychainSecret("bux", "LINEAR_API_KEY", "lin")).rejects.toThrow(
      /Keychain verification failed for LINEAR_API_KEY/,
    );
  });
});
