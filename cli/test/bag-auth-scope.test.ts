import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { Barry, type Grants, type GrantSelection, type Identities, type IdentityReference } from "@barry-rocks/sdk";
import { fakeIdentities } from "@barry-rocks/sdk/testing";
import { resolveGrantedNamespacesForSession } from "../src/commands/start.js";
import { filterBagsNeedingAuthForSession } from "@barry-rocks/sdk/internal/vault";

vi.mock("@barry-rocks/sdk/internal/sessions", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/internal/sessions")>(),
  resolveSessionNamespaces: vi.fn(async () => ["git"]),
}));

/**
 * What the identities subject grants: the "notion" and "sentry" traits each
 * grant their own namespace, and identity 7 is granted both through its own
 * traits, whatever the session selects.
 */
function grantsFor(ref: IdentityReference | null, selection: GrantSelection): Grants {
  const namespaces = new Set<string>((selection.traits ?? []).filter((trait) => trait === "notion" || trait === "sentry"));
  if (ref === 7) for (const namespace of ["notion", "sentry"]) namespaces.add(namespace);
  return { traits: [...(selection.traits ?? [])], bound: null, namespaces: [...namespaces], tools: [], skills: [], instructions: [] };
}
const grants = vi.fn<Identities["grants"]>(async (ref, selection) => grantsFor(ref, selection));

beforeEach(() => {
  grants.mockClear();
  Barry.use(fakeIdentities({ grants }));
});
afterEach(() => Barry.reset());

describe("resolveGrantedNamespacesForSession", () => {
  const unauthorized = [
    { name: "notion", url: "https://notion.example/mcp" },
    { name: "sentry", url: "https://sentry.example/mcp" },
  ];

  it("includes namespaces from granted traits even when active tools don't have them yet", async () => {
    const granted = await resolveGrantedNamespacesForSession({
      sessionId: "sess-1",
      identityId: null,
      sessionTraits: ["notion"],
      isAll: false,
      harness: "claude",
    });

    expect(grants).toHaveBeenCalledWith(null, { traits: ["notion"], harness: "claude" }, expect.anything());
    expect(granted).toContain("notion");
    expect(granted).toContain("git"); // from active namespaces
    expect(granted).not.toContain("sentry");

    const needsAuth = filterBagsNeedingAuthForSession(unauthorized, granted);
    expect(needsAuth.map((b) => b.name)).toEqual(["notion"]);
  });

  it("returns undefined when isAll is true, matching all unauthorized bags", async () => {
    const granted = await resolveGrantedNamespacesForSession({
      sessionId: "sess-1",
      identityId: null,
      sessionTraits: [],
      isAll: true,
    });

    expect(granted).toBeUndefined();
    expect(grants).not.toHaveBeenCalled();
    const needsAuth = filterBagsNeedingAuthForSession(unauthorized, granted);
    expect(needsAuth.map((b) => b.name)).toEqual(["notion", "sentry"]);
  });

  // An identity's own grants count even when the session selects nothing.
  it("includes the namespaces the identity itself is granted", async () => {
    const granted = await resolveGrantedNamespacesForSession({
      sessionId: "sess-1",
      identityId: 7,
      sessionTraits: [],
      isAll: false,
    });

    expect(grants).toHaveBeenCalledWith(7, { traits: [] }, expect.anything());
    expect(granted).toContain("notion");
    expect(granted).toContain("sentry");
    const needsAuth = filterBagsNeedingAuthForSession(unauthorized, granted);
    expect(needsAuth.map((b) => b.name)).toEqual(["notion", "sentry"]);
  });

  it("does not prompt for ungranted bags when the session has no traits and no identity grants them", async () => {
    const granted = await resolveGrantedNamespacesForSession({
      identityId: null,
      sessionTraits: [],
      isAll: false,
    });

    expect(granted).toEqual([]);
    const needsAuth = filterBagsNeedingAuthForSession(unauthorized, granted);
    expect(needsAuth).toEqual([]);
  });
});
