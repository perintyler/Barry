import { describe, expect, it } from "vitest";
import { parseManifestObject } from "../manifest.js";

const declaration = { owned_by: "identity", engine: "sqlite", migrations: "./migrations" };
const base = { name: "example", description: "Store contract" };

describe("store declarations", () => {
  it("normalizes a singular declaration to the default store", () => {
    expect(parseManifestObject({ ...base, store: declaration }).stores).toEqual({ default: declaration });
  });
  it("preserves meaningful names for multiple stores", () => {
    const stores = { catalog: declaration, index: { ...declaration, owned_by: "node" } };
    expect(parseManifestObject({ ...base, stores }).stores).toEqual(stores);
  });
  it("rejects ambiguous declaration forms", () => {
    expect(() => parseManifestObject({ ...base, store: declaration, stores: {} })).toThrow("either store or stores");
  });
  it.each([
    { ...declaration, engine: "postgres" },
    { ...declaration, owned_by: "user" },
    { ...declaration, filepath: "/tmp/identity.db" },
    { ...declaration, entry: "./provider.ts" },
  ])("rejects unsupported or identity-owned configuration %j", (store) => {
    expect(() => parseManifestObject({ ...base, store })).toThrow();
  });
});

it("declares compiled snapshot hooks separately from SQL storage", () => {
  const snapshots = { default: { entry: "./dist/snapshot.mjs" } };
  const parsed = parseManifestObject({ ...base, store: declaration, snapshots });
  expect(parsed.stores).toEqual({ default: declaration });
  expect(parsed.storeSnapshots).toEqual(snapshots);
  expect(() => parseManifestObject({ ...base, store: declaration, snapshots: { unknown: { entry: "./dist/snapshot.js" } } })).toThrow(/declared store/);
  for (const entry of ["../escape.js", "/absolute.js", "https://example.test/hook.js", "./src/snapshot.ts", "./a/../escape.js", "./a//hook.js"]) {
    expect(() => parseManifestObject({ ...base, store: declaration, snapshots: { default: { entry } } })).toThrow(/compiled JavaScript/);
  }
});
