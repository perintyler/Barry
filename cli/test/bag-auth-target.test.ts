import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { Barry, type Identities, type IdentityReference, type Tool } from "@barry-rocks/sdk";
import { fakeIdentities } from "@barry-rocks/sdk/testing";
import { resolveSessionBagNamespaces } from "../src/commands/start.js";
import { filterBagsNeedingAuthForSession } from "@barry-rocks/sdk/internal/vault";

vi.mock("@barry-rocks/sdk/internal/sessions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@barry-rocks/sdk/internal/sessions")>()),
  resolveSessionNamespaces: vi.fn(async () => ["git"]),
}));

const getIdentity = vi.fn<Identities["get"]>(async (ref: IdentityReference) => ({
  id: typeof ref === "number" ? ref : 7,
  token: "tok",
  name: "bux",
  displayName: null,
  bags: ref === 7 ? ["notion", "sentry"] : [],
  bounds: [],
  adapters: {},
  envKeys: [],
  vaultEmail: null,
  isDefault: false,
  createdAt: null,
  lastUsedAt: null,
}));

const resolveTools = vi.fn<Identities["tools"]>(async (ref, selection) => {
  const bags = (selection?.bags ?? []).map((b) => (typeof b === "string" ? b : b.name));
  const namespaces = new Set<string>(
    bags.filter((bag) => bag === "notion" || bag === "sentry"),
  );
  if (ref === 7) {
    for (const namespace of ["notion", "sentry"]) namespaces.add(namespace);
  }
  return [...namespaces].map(
    (namespace) =>
      ({
        name: `${namespace}_tool`,
        namespace,
        access: "read",
      }) as Tool,
  );
});

beforeEach(() => {
  getIdentity.mockClear();
  resolveTools.mockClear();
  Barry.use(fakeIdentities({ get: getIdentity, tools: resolveTools }));
});
afterEach(() => Barry.reset());

describe("resolveSessionBagNamespaces", () => {
  const unauthorized = [
    { name: "notion", url: "https://notion.example/mcp" },
    { name: "sentry", url: "https://sentry.example/mcp" },
  ];

  it("includes namespaces from selected bags even when active tools don't have them yet", async () => {
    const activeNamespaces = await resolveSessionBagNamespaces({
      sessionId: "sess-1",
      identityId: null,
      sessionBags: ["notion"],
      isAll: false,
      harness: "claude",
    });

    expect(resolveTools).toHaveBeenCalledWith(
      null,
      expect.objectContaining({ bags: ["notion"] }),
      expect.anything(),
    );
    expect(activeNamespaces).toContain("notion");
    expect(activeNamespaces).toContain("git"); // from active namespaces
    expect(activeNamespaces).not.toContain("sentry");

    const needsAuth = filterBagsNeedingAuthForSession(unauthorized, activeNamespaces);
    expect(needsAuth.map((b) => b.name)).toEqual(["notion"]);
  });

  it("returns undefined when isAll is true, matching all unauthorized bags", async () => {
    const activeNamespaces = await resolveSessionBagNamespaces({
      sessionId: "sess-1",
      identityId: null,
      sessionBags: [],
      isAll: true,
    });

    expect(activeNamespaces).toBeUndefined();
    expect(resolveTools).not.toHaveBeenCalled();
    const needsAuth = filterBagsNeedingAuthForSession(unauthorized, activeNamespaces);
    expect(needsAuth.map((b) => b.name)).toEqual(["notion", "sentry"]);
  });

  // An identity's own bags count even when the session selects nothing extra.
  it("includes the namespaces configured on the identity itself", async () => {
    const activeNamespaces = await resolveSessionBagNamespaces({
      sessionId: "sess-1",
      identityId: 7,
      sessionBags: [],
      isAll: false,
    });

    expect(resolveTools).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ bags: [] }),
      expect.anything(),
    );
    expect(activeNamespaces).toContain("notion");
    expect(activeNamespaces).toContain("sentry");
    const needsAuth = filterBagsNeedingAuthForSession(unauthorized, activeNamespaces);
    expect(needsAuth.map((b) => b.name)).toEqual(["notion", "sentry"]);
  });

  it("does not prompt for unselected bags when the session has no bags and no identity includes them", async () => {
    const activeNamespaces = await resolveSessionBagNamespaces({
      identityId: null,
      sessionBags: [],
      isAll: false,
    });

    expect(activeNamespaces).toEqual([]);
    const needsAuth = filterBagsNeedingAuthForSession(unauthorized, activeNamespaces);
    expect(needsAuth).toEqual([]);
  });
});
