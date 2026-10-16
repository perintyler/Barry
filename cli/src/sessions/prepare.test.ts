import { describe, expect, it, vi } from "vitest";
import { prepareSession, selectSessionCapabilities, type PreparationDependencies } from "./prepare.js";
import { preCreateRequestBody } from "./launch-context.js";
import type { InstalledAdapter } from "@barry-rocks/sdk/adapters/harnesses";
import type { StartOptions } from "../commands/start.js";
import { CliError } from "../lib/cli-error.js";

const identity = { id: 3, name: "bux", bags: ["coding"] };
const harness = { id: "claude-code" } as InstalledAdapter;

function dependencies(): PreparationDependencies {
  return {
    checkKnownCommand: vi.fn(),
    expandComposition: vi.fn(async (names) => names),
    baseBags: () => ["sessions"],
    allBags: vi.fn(async () => ["coding"]),
    pick: vi.fn(async () => ({ bags: ["git"], bounds: [] })),
    directive: vi.fn(async () => "task"),
    model: vi.fn(async () => ({ model: "claude-opus-5" })),
    recallSelection: vi.fn(() => ({ bags: [], bounds: [] })),
    rememberSelection: vi.fn(() => true),
    create: vi.fn(async (input) => ({ ok: true, body: preCreateRequestBody(input) })),
    printHeader: vi.fn(),
    warn: vi.fn(),
    cancelled: (error) => error instanceof Error && error.message === "cancel",
    abandon: vi.fn(async () => {
      throw new Error("abandoned");
    }),
  };
}

describe("shared session preparation", () => {
  it.each([
    [{ none: true }, [], []],
    [{ bag: "git, bash" }, ["git", "bash"], []],
    [{ bag: "linear:read, slack" }, ["linear", "slack"], ["linear:read"]],
    [{ _resumeSessionId: "previous", _resumeBags: ["old"], none: true }, [], []],
    [{ _resumeSessionId: "previous", _resumeBags: ["old"], bag: "git" }, ["git"], []],
    [{ _resumeSessionId: "previous", _resumeBags: ["old"], all: true }, ["coding"], []],
  ] satisfies Array<[StartOptions, string[], string[]]>)("creates one hosted row with the selected bags and bounds (%j)", async (options, bags, bounds) => {
    const deps = dependencies();
    const prepared = await prepareSession([], options, identity, harness, "hosted", deps);
    expect(prepared.sessionBags).toEqual(bags);
    expect(prepared.selectedBounds).toEqual(bounds);
    expect(prepared.tmpDirs).toEqual([]);
    expect(deps.create).toHaveBeenCalledOnce();
    const input = vi.mocked(deps.create).mock.calls[0][0];
    expect(preCreateRequestBody(input)).toMatchObject({
      bags,
      bounds,
      model: "claude-opus-5",
      mode: "hosted",
      provider: "claude-code",
      identityId: 3,
    });
    expect(deps.pick).not.toHaveBeenCalled();
    if (options._resumeSessionId) expect(input.sessionId).toBe("previous");
  });

  it("falls back to POST then PATCH for an older shipped create contract", async () => {
    const deps = dependencies();
    deps.supportsBags = false;
    deps.persistSelection = vi.fn(async () => {});
    const prepared = await prepareSession([], { bag: "git" }, identity, harness, "hosted", deps);
    expect(vi.mocked(deps.create).mock.calls[0][0]).not.toHaveProperty("bags");
    expect(deps.persistSelection).toHaveBeenCalledWith(prepared.sessionId, { bags: ["git"], bounds: [] });
    expect(vi.mocked(deps.create).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(deps.persistSelection).mock.invocationCallOrder[0],
    );
  });

  it("shows previous bags on resume and stores an empty picker selection", async () => {
    const deps = dependencies();
    vi.mocked(deps.pick).mockResolvedValue({ bags: [], bounds: [] });
    const prepared = await prepareSession(
      [],
      { _resumeSessionId: "previous", _resumeBags: ["git"] },
      identity,
      harness,
      "guest",
      deps,
    );
    expect(deps.pick).toHaveBeenCalledWith(
      ["sessions", "coding"],
      { bags: ["git"], bounds: undefined },
      undefined,
      prepared.header,
      3,
    );
    expect(vi.mocked(deps.create).mock.calls[0][0].bags).toEqual([]);
  });

  it("abandons a cancelled picker before creating a row", async () => {
    const deps = dependencies();
    vi.mocked(deps.pick).mockRejectedValue(new Error("cancel"));
    await expect(prepareSession([], {}, identity, harness, "hosted", deps)).rejects.toThrow("abandoned");
    expect(deps.create).not.toHaveBeenCalled();
  });

  it("keeps recorded bags when the picker cannot draw", async () => {
    const deps = dependencies();
    vi.mocked(deps.pick).mockRejectedValue(new Error("not a tty"));
    const selection = await selectSessionCapabilities({ _resumeBags: ["git"] }, [], { sessionId: "old" }, 3, deps);
    expect(selection).toEqual({ sessionBags: ["git"], extraBounds: [], selectionSource: "resume" });
  });

  it("refuses a failed create without handing off an unrecorded session", async () => {
    const deps = dependencies();
    vi.mocked(deps.create).mockResolvedValue({ ok: false, body: {}, warning: "API is down" });
    await expect(prepareSession([], { none: true }, identity, harness, "hosted", deps)).rejects.toThrow("API is down");
  });

  it.each(["guest", "guest-plus"] as const)("continues %s without recording on a thrown fetch, but refuses bounds or :read shorthands", async (mode) => {
    const deps = dependencies();
    vi.mocked(deps.create).mockRejectedValue(new TypeError("fetch failed"));
    const prep = await prepareSession([], { none: true }, identity, harness, mode, deps);
    expect(prep.sessionId).toBeTruthy();
    expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining("continuing without API recording"));
    await expect(prepareSession([], { none: true, bound: "readonly" }, identity, harness, mode, deps)).rejects.toThrow(
      "fetch failed",
    );
    await expect(prepareSession([], { bag: "linear:read" }, identity, harness, mode, deps)).rejects.toThrow(
      "fetch failed",
    );
  });

  it("keeps explicit build-skew refusals fatal even for unbound guests", async () => {
    const deps = dependencies();
    vi.mocked(deps.create).mockRejectedValue(new CliError("API is newer"));
    await expect(prepareSession([], { none: true }, identity, harness, "guest", deps)).rejects.toThrow("API is newer");
  });

  it("preserves bounds, read mode, directive, name and model endpoint", async () => {
    const deps = dependencies();
    vi.mocked(deps.model).mockResolvedValue({ model: "local", modelProvider: "ollama" });
    const prepared = await prepareSession(
      [],
      { read: true, _resumeBounds: ["no-files"], bound: "no-files", directive: "task", sessionName: "run" },
      identity,
      harness,
      "guest",
      deps,
    );
    expect(prepared.selectionSource).toBe("read");
    expect(preCreateRequestBody(vi.mocked(deps.create).mock.calls[0][0])).toMatchObject({
      bounds: ["no-files", "readonly"],
      directive: "task",
      name: "run",
      model_provider: "ollama",
      mode: "guest",
    });
  });
});

describe("remembered session selection", () => {
  it.each([
    [{ last: true }, ["remembered"], ["git:no-push"], "last"],
    [{ last: true, bag: "explicit" }, ["explicit"], [], "flag"],
    [{ last: true, none: true }, [], [], "none"],
    [{ last: true, all: true }, ["coding"], [], "all"],
    [{ _resumeBags: ["session"], last: true }, ["remembered"], ["git:no-push"], "last"],
  ] satisfies Array<[StartOptions, string[], string[], string]>)("honors explicit selection before memory (%j)", async (options, bags, bounds, source) => {
    const deps = dependencies();
    vi.mocked(deps.recallSelection!).mockReturnValue({ bags: ["remembered"], bounds: ["git:no-push"] });
    const result = await prepareSession([], options, identity, harness, "hosted", deps);
    expect(result.sessionBags).toEqual(bags);
    expect(result.selectedBounds).toEqual(bounds);
    expect(result.selectionSource).toBe(source);
    expect(deps.pick).not.toHaveBeenCalled();
    expect(deps.printHeader).toHaveBeenCalled();
    if (source === "flag") expect(deps.rememberSelection).toHaveBeenCalledWith({ bags, bounds });
    else expect(deps.rememberSelection).not.toHaveBeenCalled();
  });

  it("pre-checks memory for new starts, but the session's own bags on resume", async () => {
    const deps = dependencies();
    vi.mocked(deps.recallSelection!).mockReturnValue({ bags: ["remembered"], bounds: ["readonly"] });
    await prepareSession([], {}, identity, harness, "hosted", deps);
    expect(vi.mocked(deps.pick).mock.calls[0][1]).toEqual({ bags: ["remembered"], bounds: ["readonly"] });
    await prepareSession([], { _resumeBags: ["session"], _resumeBounds: ["safe"] }, identity, harness, "hosted", deps);
    expect(vi.mocked(deps.pick).mock.calls[1][1]).toEqual({ bags: ["session"], bounds: ["safe"] });
    expect(deps.rememberSelection).toHaveBeenCalledWith({ bags: ["git"], bounds: [] });
  });

  it("opens the picker with a note when --last has no memory, even with a prompt", async () => {
    const deps = dependencies();
    const result = await prepareSession([], { last: true, prompt: "hi" }, identity, harness, "hosted", deps);
    expect(result.selectionSource).toBe("picker");
    expect(deps.pick).toHaveBeenCalled();
    expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining("No remembered selection"));
  });

  it("supports the BARRY_BAGS=last environment spelling without replacing resumed pre-checks", async () => {
    vi.stubEnv("BARRY_BAGS", "last");
    try {
      const deps = dependencies();
      vi.mocked(deps.recallSelection!).mockReturnValue({ bags: ["remembered"], bounds: [] });
      expect((await prepareSession([], {}, identity, harness, "hosted", deps)).selectionSource).toBe("last");
      await prepareSession([], { _resumeBags: ["session"] }, identity, harness, "hosted", deps);
      expect(vi.mocked(deps.pick).mock.calls[0][1]).toEqual({ bags: ["session"], bounds: undefined });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("never overwrites memory after empty choices or a failed picker", async () => {
    const deps = dependencies();
    vi.mocked(deps.pick)
      .mockResolvedValueOnce({ bags: [], bounds: [] })
      .mockRejectedValueOnce(new Error("no tty"));
    await prepareSession([], {}, identity, harness, "hosted", deps);
    await prepareSession([], {}, identity, harness, "hosted", deps);
    expect(deps.rememberSelection).not.toHaveBeenCalled();
  });
});

it("includes bounds and the builtin hiding summary without removing bags", async () => {
  const deps = dependencies();
  deps.isBuiltinBag = (name) => name === "sessions";
  const result = await prepareSession(
    [],
    { none: true, bound: "readonly" },
    { ...identity, configuration: { bounds: [{ name: "guard" }, { name: "optional", optional: true }] } },
    harness,
    "hosted",
    deps,
  );
  expect(result.identityBagNames).toContain("sessions");
  expect(result.header).toMatchObject({
    bags: "coding; 1 builtin hidden — --show-builtin to show",
    bounds: "readonly",
    identityBounds: "guard",
  });
});

it("does not create a session when the picker is cancelled", async () => {
  const deps = dependencies();
  vi.mocked(deps.pick).mockRejectedValue(new Error("cancel"));
  await expect(prepareSession([], {}, identity, harness, "hosted", deps)).rejects.toThrow("abandoned");
  expect(deps.create).not.toHaveBeenCalled();
});

it("offers retry advice when preference saving is contended", async () => {
  const deps = dependencies();
  vi.mocked(deps.rememberSelection!).mockReturnValue(false);
  await prepareSession([], { bag: "git" }, identity, harness, "hosted", deps);
  expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining("another command may be saving preferences; retry"));
});
