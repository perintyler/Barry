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
});


describe("identity extensions", () => {
  it("parses the nested form with extensions after their parent", () => {
    expect(parseIdentityBags([{ sessions: { extensions: ["search"] } }]).bags).toEqual(["sessions", "sessions/search"]);
  });
  it.each(["sessions/search", { "sessions/search": {} }, { "sessions/search": { tools: [] } }])("refuses a flat file entry %j with the correct form", (entry) => {
    expect(() => parseIdentityBags([entry])).toThrow(/sessions: \{ extensions: \[search\]/);
  });
  it("folds extensions under a parent and supplies a missing parent", () => {
    const expected = [{ sessions: { extensions: ["search"] } }];
    expect(serializeIdentityBags(["sessions", "sessions/search"])).toEqual(expected);
    expect(serializeIdentityBags(["sessions/search"])).toEqual(expected);
  });
  it("keeps the parent's stores and tools beside extensions", () => {
    const configs = { sessions: { stores: { default: { filepath: "/sessions.db" } }, tools: { search: "deferred" as const } } };
    const bags = ["sessions", "sessions/search", "artifacts"];
    const serialized = serializeIdentityBags(bags, configs);
    expect(serialized).toContainEqual({ sessions: { store: { filepath: "/sessions.db" }, tools: [{ search: "deferred" }], extensions: ["search"] } });
    const parsed = parseIdentityBags(serialized);
    expect(new Set(parsed.bags)).toEqual(new Set(bags));
    expect(parsed.bag_configs.sessions).toEqual(configs.sessions);
  });
  it("refuses extension configuration and orphan changes", () => {
    expect(() => serializeIdentityBags(["sessions", "sessions/search"], { "sessions/search": {} })).toThrow(/parent sessions/);
    expect(() => IdentityChangesSchema.parse({ bags: ["sessions/search"] })).toThrow(/parent sessions/);
    expect(() => IdentityChangesSchema.parse({ bag_configs: { "sessions/search": {} } })).toThrow(/parent sessions/);
    expect(IdentityChangesSchema.parse({ bags: ["sessions", "sessions/search"] }).bags).toEqual(["sessions", "sessions/search"]);
  });
  it("round-trips multiple extensions without changing the selected set", () => {
    const bags = ["sessions/search", "artifacts", "sessions", "sessions/archive"];
    expect(new Set(parseIdentityBags(serializeIdentityBags(bags)).bags)).toEqual(new Set(bags));
  });
});
