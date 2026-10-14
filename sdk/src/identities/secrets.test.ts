import { describe, expect, it } from "vitest";
import { bindSecretReferences, mergeInheritedIdentity, type IdentityDefinition, resolveIdentityConfig, SecretReferenceSchema } from "./index.js";
describe("secret reference inheritance", () => {
  it("keeps a parent's file reference attached to the declaring directory", () => {
    const parent = { secrets: bindSecretReferences({ BARRY_SECRET: { in: ".env" } }, "/identities/parent") };
    const child = { inherits: "parent", secrets: bindSecretReferences({ API_KEY: { in: "vault", item: "api", field: "password" } }, "/identities/child") };
    const config = resolveIdentityConfig(child, { resolveParent: () => parent });
    expect(config.secrets.BARRY_SECRET.directory).toBe("/identities/parent");
    expect(config.secrets.API_KEY.reference).toEqual({ in: "vault", item: "api", field: "password" });
  });
  it("replaces a reference atomically without carrying the parent's backend fields", () => {
    const parent = { secrets: bindSecretReferences({ API_KEY: { in: "vault", item: "api", field: "password" } }) };
    const child = { inherits: "parent", secrets: bindSecretReferences({ API_KEY: { in: "keychain", item: "personal-api" } }) };
    expect(resolveIdentityConfig(child, { resolveParent: () => parent }).secrets.API_KEY.reference).toEqual({ in: "keychain", item: "personal-api" });
  });
  it("rejects inline secrets, retired source aliases and unbound file references", () => {
    expect(() => SecretReferenceSchema.parse({ in: "vault", item: "api", field: "password", value: "inline" })).toThrow();
    expect(() => SecretReferenceSchema.parse({ source: "keychain", service: "api" })).toThrow();
    expect(() => bindSecretReferences({ API_KEY: { in: ".env" } })).toThrow(/declaring directory/);
  });
});


describe("retired credential configuration", () => {
  it.each(["env", "env_file"])("rejects %s on direct and inherited configuration without exposing values", (key) => {
    const legacy = { [key]: { API_KEY: "private-value" } } as IdentityDefinition;
    expect(() => resolveIdentityConfig(legacy)).toThrow(`Identity ${key} is retired`);
    expect(() => resolveIdentityConfig({ inherits: "legacy" }, { resolveParent: () => legacy })).toThrow(`Identity ${key} is retired`);
    expect(() => mergeInheritedIdentity(legacy, {})).toThrow(`Identity ${key} is retired`);
    expect(() => mergeInheritedIdentity({}, legacy)).toThrow(`Identity ${key} is retired`);
    try { resolveIdentityConfig(legacy); } catch (error) { expect(String(error)).not.toContain("private-value"); }
  });
});


describe("named vault selection", () => {
  it.each(["", "invalid/name", { email: "private-account", serverUrl: "private-endpoint", credentials: { value: "private-credential" } }])("rejects invalid and inline vault declarations", (vault) => {
    const metadata = { vault } as IdentityDefinition;
    expect(() => resolveIdentityConfig(metadata)).toThrow("vault must be a name");
    expect(() => resolveIdentityConfig({ inherits: "parent" }, { resolveParent: () => metadata })).toThrow("vault must be a name");
  });
  // Secret declarations are inherited; the vault they are read from is the
  // identity's own. An identity that names none has none, rather than
  // silently opening its parent's.
  it("never inherits the vault, only the secret declarations", () => {
    const parent = { vault: "shared", secrets: bindSecretReferences({ TOKEN: { in: "vault", item: "TOKEN", field: "password" } }) };
    expect(resolveIdentityConfig({ inherits: "parent" }, { resolveParent: () => parent }).vault).toBeUndefined();
    expect(resolveIdentityConfig({ inherits: "parent", vault: "personal" }, { resolveParent: () => parent }).vault).toBe("personal");
    expect(mergeInheritedIdentity(parent, { vault: "personal" }).secrets?.TOKEN?.reference).toEqual({ in: "vault", item: "TOKEN", field: "password" });
  });
});
