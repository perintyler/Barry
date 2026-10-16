import { beforeEach, expect, it, vi } from "vitest";
import type { Bound } from "@barry-rocks/sdk/bounds";

const fixture = vi.hoisted(() => ({
  bound: null as Bound | null,
  opened: vi.fn(),
  closed: vi.fn(),
  identityId: vi.fn(),
}));

vi.mock("./target.js", () => ({
  currentTarget: () => ({ kind: "identity", name: "selected", binding: { id: 7, home: "/fixture" } }),
}));
vi.mock("@barry-rocks/sdk/internal/nodes", () => ({
  NodeRegistry: class {
    readonly id = "canonical-node";
    constructor() { fixture.opened(); }
    identityId = fixture.identityId;
    close = fixture.closed;
  },
}));
vi.mock("@barry-rocks/sdk/internal/identities", async original => ({
  ...await original<typeof import("@barry-rocks/sdk/internal/identities")>(),
  defaultHarness: () => "fixture-harness", FALLBACK_HARNESS: "fixture-harness",
}));
vi.mock("@barry-rocks/sdk/adapters/harnesses", () => ({
  findInstalled: () => ({ id: "fixture-harness" }),
}));
vi.mock("@barry-rocks/sdk/internal/adapters", () => ({
  loadAdapters: () => ({ installed: () => [] }),
}));
vi.mock("@barry-rocks/sdk/services", async original => ({
  ...await original<typeof import("@barry-rocks/sdk/services")>(), barryAdaptersPath: () => "/fixture/adapters.json",
}));
vi.mock("@barry-rocks/identities-bag", () => ({
  identityRecords: {
    row: async () => ({ id: 7, name: "selected" }),
    config: () => ({ adapters: {}, bag_configs: {} }),
  },
}));
vi.mock("@barry-rocks/sdk", async original => ({
  ...await original<typeof import("@barry-rocks/sdk")>(),
  Barry: {
    tools: async () => [{ namespace: "workflows", name: "cancel", access: "write" }],
    bound: async () => fixture.bound,
  },
}));

import { authorizeIdentityTool } from "./tool-bounds.js";

beforeEach(() => {
  vi.clearAllMocks();
  fixture.bound = null;
  fixture.identityId.mockReturnValue("canonical-identity");
});

it("authorizes a tool on the canonical node permitted by the identity bound and closes its registry", async () => {
  fixture.bound = { nodes: { allow: ["canonical-node"] } };
  await expect(authorizeIdentityTool({ namespace: "workflows", name: "cancel", access: "write" })).resolves.toMatchObject({
    node: "canonical-node", identity: "canonical-identity", allowedToolIds: ["workflows:cancel"],
  });
  expect(fixture.opened).toHaveBeenCalledTimes(1);
  expect(fixture.identityId).toHaveBeenCalledWith(7);
  expect(fixture.closed).toHaveBeenCalledTimes(1);
});

it("rejects a tool on the canonical node denied by the identity bound and closes its registry", async () => {
  fixture.bound = { nodes: { deny: ["canonical-node"] } };
  await expect(authorizeIdentityTool({ namespace: "workflows", name: "cancel", access: "write" })).rejects.toThrow("node access denied: canonical-node");
  expect(fixture.opened).toHaveBeenCalledTimes(1);
  expect(fixture.identityId).not.toHaveBeenCalled();
  expect(fixture.closed).toHaveBeenCalledTimes(1);
});
