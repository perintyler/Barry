import { IdentityChangesSchema } from "./changes.js";
import { describe, expect, it } from "vitest";
import { parseIdentityBags, serializeIdentityBags, resolveIdentityConfig } from "./index.js";

describe("identity bag configuration", () => {
  it("merges keyed inheritance and replaces the inherited transport atomically", () => {
    const parent = parseIdentityBags([{ artifacts: { store: { engine: "sqlite", filepath: "/data/artifacts.db", app_url: "https://local.example" }, tools: [{ get: "deferred" }] } }]);
    const child = parseIdentityBags([{ artifacts: { store: { url: "https://remote.example" }, tools: [{ get: "enabled" }] } }]);
    const resolved = resolveIdentityConfig({ inherits: "barry", ...child }, { resolveParent: () => parent });
    expect(resolved.bags).toEqual(["artifacts"]);
    expect(resolved.bag_configs.artifacts).toEqual({ stores: { default: { engine: "sqlite", url: "https://remote.example", app_url: "https://local.example" } }, tools: { get: "enabled" } });
    expect(parseIdentityBags(serializeIdentityBags(resolved.bags, resolved.bag_configs))).toEqual({ bags: resolved.bags, bag_configs: resolved.bag_configs });
  });
  it("retains configuration when a child simply selects the same bag", () => {
    const parent = parseIdentityBags({ artifacts: { store: { filepath: "/data/artifacts.db" } } });
    const resolved = resolveIdentityConfig({ inherits: "barry", bags: ["artifacts"] }, { resolveParent: () => parent });
    expect(resolved.bag_configs).toEqual(parent.bag_configs);
  });
  it("rejects ownership changes, mixed transports and unselected configuration", () => {
    expect(() => parseIdentityBags({ artifacts: { store: { owned_by: "node" } } })).toThrow();
    expect(() => parseIdentityBags({ artifacts: { store: { filepath: "/data/a.db", url: "https://remote.example" } } })).toThrow();
    expect(() => serializeIdentityBags([], { artifacts: {} })).toThrow(/unselected/);
  });
  it("rejects retired slash bag names and nested extensions", () => {
    expect(() => parseIdentityBags(["sessions/search"])).toThrow();
    expect(() => parseIdentityBags([{ sessions: { extensions: ["search"] } }])).toThrow();
    expect(() => IdentityChangesSchema.parse({ bags: ["sessions/search"] })).toThrow();
    expect(() => IdentityChangesSchema.parse({ bag_configs: { "sessions/search": {} } })).toThrow();
  });
});
