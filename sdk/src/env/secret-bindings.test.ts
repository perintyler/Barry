import { describe, expect, it, vi } from "vitest";
import { bindSecretReferences } from "../identities/secrets.js";
import { readSecretBindings } from "./secret-bindings.js";
import { identityEnvironment } from "./identity.js";
import { EnvReadError } from "./types.js";
import { VaultItemNotFoundError } from "../vault/client.js";

describe("declared secret resolution", () => {
  it("reads only named file entries from their declaring identity", async () => {
    const readFile = vi.fn(async () => 'API_KEY="parent value"\nUNDECLARED=hidden\n');
    const bindings = bindSecretReferences({ API_KEY: { in: ".env" } }, "/identities/parent");
    const result = await readSecretBindings(bindings, { readFile });
    expect(readFile).toHaveBeenCalledWith("/identities/parent/.env");
    expect(result).toEqual({ vars: { API_KEY: "parent value" }, sources: { API_KEY: "file" } });
  });
  // A file reference may explicitly bind a differently named source key.
  // Rationale: docs/decisions/0032-sdk-contract-regression-history.md.
  it("reads a differently named file entry when the reference names its key", async () => {
    const readFile = vi.fn(async () => "SENTRY_WEB_DSN=the-dsn\nSENTRY_DSN=wrong\n");
    const bindings = bindSecretReferences({ SENTRY_DSN: { in: ".env", key: "SENTRY_WEB_DSN" } }, "/instance");
    expect((await readSecretBindings(bindings, { readFile })).vars).toEqual({ SENTRY_DSN: "the-dsn" });
  });
  it("preserves exact keychain account names and omits an unspecified account", async () => {
    const readKeychain = vi.fn(async () => "resolved");
    await readSecretBindings(bindSecretReferences({
      FIRST: { in: "keychain", item: "first", account: "Exact_Account" },
      SECOND: { in: "keychain", item: "second" },
    }), { readKeychain });
    expect(readKeychain.mock.calls).toEqual([["first", "Exact_Account"], ["second", undefined]]);
  });
  it("fails closed without including backend credential material in errors", async () => {
    const bindings = bindSecretReferences({ API_KEY: { in: "keychain", item: "api" } });
    await expect(readSecretBindings(bindings, {
      readKeychain: async () => { throw new Error("private credential material"); },
    })).rejects.toThrow("$API_KEY: could not read declared keychain secret");
    await expect(readSecretBindings(bindings, { readKeychain: async () => null })).rejects.toThrow("absent or empty");
  });
  it("does not use legacy definitions or ambient credentials for explicit empty bindings", async () => {
    const identity = { bags: [], secrets: {}, env: { API_KEY: "legacy" } };
    const result = await identityEnvironment(identity);
    expect(result.vars).toEqual({});
  });
  it("requires an open vault for a declared vault field, and says the identity names none", async () => {
    const bindings = bindSecretReferences({ API_KEY: { in: "vault", item: "api", field: "password" } });
    await expect(readSecretBindings(bindings)).rejects.toThrow("$API_KEY: could not read declared vault secret: the identity names no vault of its own");
  });
  it("says which item is not in the vault, and nothing the vault said", async () => {
    const bindings = bindSecretReferences({ API_KEY: { in: "vault", item: "API_ITEM", field: "password" } });
    const vault = { getItem: async (item: string) => { throw new VaultItemNotFoundError(item); } };
    await expect(readSecretBindings(bindings, { vault })).rejects.toThrow('$API_KEY: could not read declared vault secret: item "API_ITEM" is not in the identity\'s vault');
    const failing = { getItem: async () => { throw new Error("private credential material"); } };
    await expect(readSecretBindings(bindings, { vault: failing })).rejects.toThrow(/^\$API_KEY: could not read declared vault secret$/);
  });
  // One at a time, an identity missing nineteen secrets took nineteen launches
  // to learn which.
  it("names every secret that cannot be read, in one error", async () => {
    const bindings = bindSecretReferences({
      FIRST: { in: "vault", item: "FIRST", field: "password" },
      SECOND: { in: "vault", item: "SECOND", field: "password" },
      PRESENT: { in: "vault", item: "PRESENT", field: "password" },
      THIRD: { in: "keychain", item: "third" },
    });
    const vault = { getItem: async (item: string) => { if (item === "PRESENT") return { password: "ok" } as never; throw new VaultItemNotFoundError(item); } };
    const failure = await readSecretBindings(bindings, { vault, readKeychain: async () => null }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(EnvReadError);
    expect(String((failure as Error).message)).toBe('$FIRST: could not read declared vault secret: item "FIRST" is not in the identity\'s vault — and 2 more cannot be read: $SECOND, $THIRD');
  });
  it("does not open unrelated vault references for a scoped invocation", async () => {
    const environment = await identityEnvironment({
      bags: [], vault: "unreachable-vault",
      secrets: bindSecretReferences({ OTHER: { in: "vault", item: "other", field: "password" } }),
    }, { names: [] });
    expect(environment.vars).toEqual({});
  });
  it("rejects a requested credential absent from the selected identity", async () => {
    await expect(identityEnvironment({ bags: [], secrets: {} }, { names: ["API_KEY"] }))
      .rejects.toThrow("secret is not declared by the selected identity");
  });
});
