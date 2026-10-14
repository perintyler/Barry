import { describe, expect, it } from "vitest";
import { mergeStoreOptions, resolveStoreBinding } from "./bindings.js";
import type { StoreDeclaration } from "./registry.js";

const declaration: StoreDeclaration = { owned_by: "identity", engine: "sqlite", migrations: "./migrations" };
const stores = { default: declaration };
const context = { node: "desktop", identity: "alice", root: "/scratch/generations/active" };

describe("resolved store bindings", () => {
  it("isolates identities under the active generation and freezes the result", () => {
    const alice = resolveStoreBinding("artifacts", stores, context);
    const bob = resolveStoreBinding("artifacts", stores, { ...context, identity: "bob" });
    expect(alice.filepath).toBe("/scratch/generations/active/identities/alice/artifacts/default.db");
    expect(bob.filepath).toBe("/scratch/generations/active/identities/bob/artifacts/default.db");
    expect(Object.isFrozen(alice)).toBe(true);
    expect(() => resolveStoreBinding("artifacts", stores, { ...context, root: "relative" })).toThrow("root must be absolute");
    expect(() => resolveStoreBinding("artifacts", stores, { ...context, identity: undefined })).toThrow("execution identity");
    expect(() => resolveStoreBinding("artifacts", stores, { ...context, identity: "../bob" })).toThrow("unsafe store identifier");
  });
  it("does not attach identity ownership to a node store", () => {
    const binding = resolveStoreBinding("config", { catalog: { ...declaration, owned_by: "node" } }, context);
    expect(binding.identity).toBeUndefined();
    expect(binding.filepath).toBe("/scratch/generations/active/node/config/catalog.db");
  });
  it("requires an unambiguous declaration or an explicit name", () => {
    expect(() => resolveStoreBinding("test", {}, context)).toThrow("found 0");
    const multiple = { catalog: declaration, index: declaration };
    expect(() => resolveStoreBinding("test", multiple, context)).toThrow("found 2");
    expect(resolveStoreBinding("test", multiple, { ...context, name: "index" }).store).toBe("index");
    expect(() => resolveStoreBinding("test", multiple, { ...context, name: "missing" })).toThrow("unknown store");
  });
  it("honors an exact local filepath and validates identity overrides", () => {
    expect(resolveStoreBinding("artifacts", stores, { ...context, overrides: { default: { filepath: "/custom/files.db" } } }).filepath).toBe("/custom/files.db");
    expect(() => resolveStoreBinding("artifacts", stores, { ...context, overrides: { default: { filepath: "relative.db" } } })).toThrow("absolute");
    expect(() => resolveStoreBinding("artifacts", stores, { ...context, overrides: { default: { filepath: "/files.db", url: "https://files.example" } } })).toThrow("mutually exclusive");
    expect(() => resolveStoreBinding("artifacts", stores, { ...context, overrides: { missing: {} } })).toThrow("unknown store");
  });
  it("accepts remote bindings only when the owning adapter supports them", () => {
    const remote = { ...context, overrides: { default: { url: "https://files.example", app_url: "https://viewer.example" } } };
    expect(() => resolveStoreBinding("artifacts", stores, remote)).toThrow("no installed store adapter");
    const binding = resolveStoreBinding("artifacts", stores, { ...remote, remoteProtocols: ["https:"] });
    expect(binding.url).toBe("https://files.example");
    expect(binding.filepath).toBeUndefined();
    expect(binding.app_url).toBe("https://viewer.example");
    expect(() => resolveStoreBinding("artifacts", stores, { ...remote, remoteProtocols: ["https:"], overrides: { default: { url: "https://secret@files.example" } } })).toThrow("embed credentials");
  });
  it("replaces inherited transport choices without mixing both", () => {
    expect(mergeStoreOptions({ filepath: "/parent.db", app_url: "https://viewer.example" }, { url: "https://files.example" })).toEqual({ url: "https://files.example", app_url: "https://viewer.example" });
    expect(mergeStoreOptions({ url: "https://files.example" }, { filepath: "/child.db" })).toEqual({ filepath: "/child.db" });
    expect(() => mergeStoreOptions({}, { filepath: "/bad.db", url: "https://files.example" })).toThrow("mutually exclusive");
  });
});
