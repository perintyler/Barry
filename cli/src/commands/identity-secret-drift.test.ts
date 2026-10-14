import { describe, it, expect } from "vitest";
import { diffSecretNames, diffSecretBindings } from "./identity.js";

// Authored references and cached references may differ after manual edits.
describe("diffSecretNames", () => {
  it("reports nothing when both sources agree", () => {
    const out = diffSecretNames(["A", "B"], ["B", "A"]);
    expect(out.missingAtRuntime).toEqual([]);
    expect(out.runtimeOnly).toEqual([]);
  });

  it("flags a config-only key — the case that breaks sessions silently", () => {
    // Added to identity.yaml, never synced. `check` used to call this
    // configured while every session came up without it.
    const out = diffSecretNames(["A", "NEW_KEY"], ["A"]);
    expect(out.missingAtRuntime).toEqual(["NEW_KEY"]);
    expect(out.runtimeOnly).toEqual([]);
  });

  it("notes a database-only key without treating it as a failure", () => {
    // e.g. a DB-only identity with no directory at all, or a row edited
    // directly rather than through any CLI command. Sessions DO see it;
    // only this command (which reads the directory) was blind to it.
    const out = diffSecretNames(["A"], ["A", "DB_ONLY"]);
    expect(out.missingAtRuntime).toEqual([]);
    expect(out.runtimeOnly).toEqual(["DB_ONLY"]);
  });

  it("separates the two directions when both drift at once", () => {
    const out = diffSecretNames(["SHARED", "CONFIG_ONLY"], ["SHARED", "DB_ONLY"]);
    expect(out.missingAtRuntime).toEqual(["CONFIG_ONLY"]);
    expect(out.runtimeOnly).toEqual(["DB_ONLY"]);
  });

  it("treats an empty database row as everything missing at runtime", () => {
    // A barry whose row was never synced: nothing reaches a session.
    const out = diffSecretNames(["A", "B"], []);
    expect(out.missingAtRuntime).toEqual(["A", "B"]);
  });

  it("does not invent drift when config is empty", () => {
    const out = diffSecretNames([], ["A"]);
    expect(out.missingAtRuntime).toEqual([]);
    expect(out.runtimeOnly).toEqual(["A"]);
  });

  it("compares keys exactly, without case folding", () => {
    // Env var names are case-sensitive; folding would hide a real mismatch.
    const out = diffSecretNames(["Api_Key"], ["API_KEY"]);
    expect(out.missingAtRuntime).toEqual(["Api_Key"]);
    expect(out.runtimeOnly).toEqual(["API_KEY"]);
  });

  it("preserves input order so output is stable across runs", () => {
    const out = diffSecretNames(["Z", "A", "M"], []);
    expect(out.missingAtRuntime).toEqual(["Z", "A", "M"]);
  });
});

// Shared names still require structural reference and provenance comparison.
describe("diffSecretBindings", () => {
  it("reports nothing when a shared key's reference is identical", () => {
    const disk = { API_KEY: { reference: { in: "keychain" as const, item: "barry", account: "a-api-key" } } };
    const db = { API_KEY: { reference: { in: "keychain" as const, item: "barry", account: "a-api-key" } } };
    expect(diffSecretBindings(disk, db)).toEqual([]);
  });

  it("flags a shared key whose source discriminator changed", () => {
    const disk = { API_KEY: { reference: { in: "keychain" as const, item: "barry", account: "a-api-key" } } };
    const db = { API_KEY: { reference: { in: "vault" as const, item: "API_KEY", field: "password" as const } } };
    expect(diffSecretBindings(disk, db)).toEqual(["API_KEY"]);
  });

  it("flags a shared key whose reference field changed within the same source", () => {
    const disk = { API_KEY: { reference: { in: "vault" as const, item: "API_KEY", field: "password" as const } } };
    const db = { API_KEY: { reference: { in: "vault" as const, item: "API_KEY", field: "username" as const } } };
    expect(diffSecretBindings(disk, db)).toEqual(["API_KEY"]);
  });

  it("is not fooled by key order — disk and DB do not promise the same order", () => {
    // YAML (disk) and stored JSON (db) round-trip through different
    // serializers; two structurally-equal objects can differ in key order.
    // A naive JSON.stringify comparison would report this as drift.
    const disk = { API_KEY: { reference: { in: "keychain" as const, item: "barry", account: "a-api-key" } } };
    const db = { API_KEY: { reference: { account: "a-api-key", in: "keychain" as const, item: "barry" } } };
    expect(diffSecretBindings(disk, db)).toEqual([]);
  });

  it("ignores keys present on only one side — that is diffSecretNames' job", () => {
    const disk = { DISK_ONLY: { reference: { in: "keychain" as const, item: "x" } } };
    const db = { DB_ONLY: { reference: { in: "keychain" as const, item: "y" } } };
    expect(diffSecretBindings(disk, db)).toEqual([]);
  });
});
