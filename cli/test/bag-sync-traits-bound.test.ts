import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `barry bag sync-traits` must forward a manifest trait's INLINE bound.
 *
 * The failure this covers is not "the restriction fails to arrive" — it is
 * worse than that. `Traits.ensureTraits` writes `trait.bound ?? {}`, so a
 * projection that omits the key does not leave the stored bound alone: it
 * OVERWRITES it with `{}`. A trait that `barry pack` had restricted came back
 * from a *successful* sync as an unrestricted grant, with a zero exit and
 * nothing in the output to suggest anything had changed.
 *
 * Asserted at the PROJECTION, not at the storage layer. the identities store's
 * traits-inline-bound.test.ts already covers the write, but it hands
 * `ensureTraits` a bound directly and so cannot see a caller that never passes
 * one — which is exactly where the bug lived. Two layers, two tests: the
 * storage test proves the column survives a round trip, this one proves the
 * command actually fills it.
 *
 * The assertion names a SPECIFIC denial rather than checking the bound is
 * non-empty, for the reason the storage test gives: "non-empty" is satisfied by
 * a bound that denies the wrong thing, and a restriction that exists but does
 * not restrict is the bug being hunted.
 */

/** A denial no default carries, so a match cannot be coincidence. */
const DENY_GIT = { bash: { denyPrograms: ["git"] } };

/**
 * The shape this test reads back off the mock — the projection's output, not
 * ensureTraits' full input type. Declared rather than asserted through
 * `unknown`: a double assertion would erase exactly the type safety that makes
 * `trait.bound` meaningful here, and the rule forbidding it is right to.
 */
type TraitInput = { name: string; bound?: unknown };

const ensureTraits = vi.fn(async (_inputs: TraitInput[], _options?: { namespaceMode?: string }) => []);
const getAllTraits = vi.fn(() => []);
const loadAllBags = vi.fn(async () => []);

// Partial mock via importOriginal rather than a hand-listed surface. A full
// replacement has to enumerate every export the command touches, and goes red
// with an unrelated "No X export is defined on the mock" the moment the module
// grows one — a failure that looks like this test's subject and is not.
// One mock per subpath the subject imports — mocking the "@barry-rocks/sdk/bags"
// root would be a SILENT no-op now that bag.ts reaches modules directly.
vi.mock("@barry-rocks/sdk/internal/bags", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/internal/bags")>(),

  loadAllBags,

  getAllTraits,
}));


// The trait catalog is what this test watches; bounds stay real, as before.
vi.mock("@barry-rocks/identities-bag", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@barry-rocks/identities-bag")>();
  return {
    ...actual,
    traits: { ...actual.traits, list: vi.fn(async () => []), assertOwnership: vi.fn(async () => undefined), ensure: ensureTraits, syncBags: vi.fn() },
  };
});
vi.mock("../src/bags/registration.js", () => ({
  getBag: vi.fn(async (name: string) => ({ name, source: { type: "local" }, builtin: true })),
  upsertBag: vi.fn(),
  deleteBag: vi.fn(async () => true),
  listBags: vi.fn(async () => []),
  writeRegistrySnapshot: vi.fn(async () => "/tmp/snapshot.json"),
}));
vi.mock("../src/lib/current-user.js", () => ({
  getCurrentUser: vi.fn(async () => ({ id: 1, settings: {} })),
  getActiveIdentity: vi.fn(() => "default"),
}));

const { bagSyncTraitsCommand } = await import("../src/commands/bag.js");

describe("bag sync-traits forwards the inline bound", () => {
  beforeEach(() => {
    ensureTraits.mockClear();
    loadAllBags.mockResolvedValue([{ name: "demo", manifest: {} }] as never);
    getAllTraits.mockReturnValue([
      {
        name: "demo:restricted",
        description: "a restricted trait",
        bags: ["demo"],
        access: "read",
        skills: [],
        instructions: [],
        boundNames: [],
        bound: DENY_GIT,
      },
    ] as never);
  });

  it("passes the trait's bound through to ensureTraits", async () => {
    await bagSyncTraitsCommand();

    expect(ensureTraits).toHaveBeenCalled();
    const [inputs] = ensureTraits.mock.calls[0];
    const trait = inputs.find((t) => t.name === "demo:restricted");

    expect(trait, "the trait reached ensureTraits at all").toBeDefined();
    // The specific denial, not merely "a bound exists".
    expect(trait!.bound).toEqual(DENY_GIT);
  });

  it("does not send undefined, which ensureTraits would store as {}", async () => {
    await bagSyncTraitsCommand();

    const [inputs] = ensureTraits.mock.calls[0];
    const trait = inputs.find((t) => t.name === "demo:restricted");

    // Stated separately from the equality above because this is the failure
    // mode: `bound: undefined` and an absent key both reach `?? {}` and erase
    // a stored restriction. An assertion that only checked "toEqual(DENY_GIT)"
    // would catch it too, but naming it keeps the reason visible to whoever
    // edits this projection next.
    expect(trait!.bound).not.toBeUndefined();
  });
});

/**
 * `sync-traits` prunes stored namespaces no loaded bag provides. A bag whose
 * tool code failed to load provides namespaces nobody can see, so pruning
 * then would strip every grant it backs. ensureTraits' own guard only covers
 * the case where nothing loaded at all.
 */
describe("bag sync-traits while a bag's tools are unknown", () => {
  beforeEach(() => {
    ensureTraits.mockClear();
    getAllTraits.mockReturnValue([
      { name: "demo", description: "", bags: ["demo"], access: "readwrite", skills: [], instructions: [], boundNames: [] },
    ] as never);
  });

  it("prunes when every bag's tools loaded", async () => {
    loadAllBags.mockResolvedValue([{ name: "demo", manifest: {}, mcpServers: {}, tools: [] }] as never);
    await bagSyncTraitsCommand();
    expect(ensureTraits.mock.calls[0][1]?.namespaceMode).toBe("reconcile");
  });

  it("keeps every stored namespace instead, and says which bags blocked pruning", async () => {
    loadAllBags.mockResolvedValue([
      { name: "demo", manifest: {}, mcpServers: {}, tools: [] },
      { name: "github", manifest: {}, mcpServers: {}, tools: [], toolsError: "Could not resolve x" },
    ] as never);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await bagSyncTraitsCommand();
      expect(ensureTraits.mock.calls[0][1]?.namespaceMode).toBe("keep");
      expect(warn.mock.calls.map(([message]) => String(message)).join("\n")).toMatch(/Not pruning.*github/);
    } finally {
      warn.mockRestore();
    }
  });
});
