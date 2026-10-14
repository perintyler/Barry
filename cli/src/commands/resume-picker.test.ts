import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `barry session resume` with no id must ASK which session to carry forward, on
 * every agent — never infer one from the working directory.
 *
 * The inference it replaced (`getMostRecentSession(process.cwd())`) attached a
 * DIFFERENT project's session id, traits and model whenever the cwd was a parent
 * of where sessions actually ran. Measured on the live store before removal: from
 * `~/repos` it picked a `~/repos/barry` session; from `~/repos/bags` it picked one
 * under `an external coding action`. Since resume carries traits, that silently
 * granted another project's capabilities.
 *
 * These assert on the SEAM CALLS rather than on rendered output: the observable
 * contract is "lists candidates, never asks the store for a directory's most
 * recent", and that is what regressing would break.
 */
const listSessions = vi.fn();
const getSession = vi.fn();
const getProviderSessionsBySession = vi.fn();
const select = vi.fn();
const startCommand = vi.fn();

vi.mock("@barry-rocks/sessions-bag/client", () => ({
  // Deliberately NOT exporting getMostRecentSession. If resume.ts reaches for it
  // again, the import fails loudly instead of silently reintroducing inference.
  listSessions: (...args: unknown[]) => listSessions(...args),
  getSession: (...args: unknown[]) => getSession(...args),
  getProviderSessionsBySession: (...args: unknown[]) => getProviderSessionsBySession(...args),
}));
vi.mock("@inquirer/prompts", () => ({ select: (...args: unknown[]) => select(...args) }));
vi.mock("../lib/harness-flags.js", () => ({ installedHarnesses: async () => [{ id: "claude-code", aliases: ["claude"] }, { id: "codex" }, { id: "opencode" }] }));
vi.mock("./start.js", () => ({ startCommand: (...args: unknown[]) => startCommand(...args) }));

const { resumeCommand } = await import("./resume.js");

function sessionRow(over: Record<string, unknown> = {}) {
  return {
    id: "sess_picked",
    state: "closed",
    status: "completed",
    traits: ["coding"],
    created_at: new Date().toISOString(),
    system_prompt: "a previous session",
    metadata: { working_directory: process.cwd(), name: "picked one" },
    ...over,
  };
}

describe("barry session resume, with no session id", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listSessions.mockResolvedValue([sessionRow()]);
    getSession.mockResolvedValue(sessionRow());
    select.mockResolvedValue("sess_picked");
    getProviderSessionsBySession.mockResolvedValue([{ provider: "claude", provider_session_id: "conv-picked" }]);
    startCommand.mockResolvedValue(undefined);
  });

  it("forwards an explicit llama.cpp provider to start without restoring the recorded provider", async () => {
    getSession.mockResolvedValue(sessionRow({ metadata: { working_directory: process.cwd(), model_provider: "ollama", model: "old" } }));
    await resumeCommand("sess_picked", { llamacpp: true });
    expect(startCommand.mock.calls[0][1]).toMatchObject({ llamacpp: true });
    expect(startCommand.mock.calls[0][1].modelProvider).toBeUndefined();
    expect(startCommand.mock.calls[0][1].model).toBeUndefined();
  });

  it("asks the user to choose, and carries the chosen session's id and traits", async () => {
    await resumeCommand(undefined, {});

    expect(select).toHaveBeenCalledTimes(1);
    const [, opts] = startCommand.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(opts._resumeSessionId).toBe("sess_picked");
    expect(opts._resumeTraits).toEqual(["coding"]);
  });

  /**
   * The candidate query, pinned.
   *
   * `active: false` excludes sessions that are still running — resuming one would
   * open the same transcript twice, which the agents' own resume locks reject.
   * A `directory` filter appearing here would be the inference creeping back.
   */
  it("offers non-active sessions and does NOT filter by the working directory", async () => {
    await resumeCommand(undefined, {});

    expect(listSessions).toHaveBeenCalledWith({ limit: 60, active: false });
    const [query] = listSessions.mock.calls[0] as [Record<string, unknown>];
    expect(query).not.toHaveProperty("directory");
  });

  it("excludes archived sessions from the choices", async () => {
    listSessions.mockResolvedValue([sessionRow(), sessionRow({ id: "sess_archived", state: "archived" })]);

    await resumeCommand(undefined, {});

    const [{ choices }] = select.mock.calls[0] as [{ choices: { value: string }[] }];
    expect(choices.map((c) => c.value)).toEqual(["sess_picked"]);
  });

  it("refuses when no Barry session exists instead of opening another conversation", async () => {
    listSessions.mockResolvedValue([]);
    await expect(resumeCommand(undefined, {})).rejects.toThrow(/No resumable/);
    expect(select).not.toHaveBeenCalled();
    expect(startCommand).not.toHaveBeenCalled();
  });

  /**
   * `--last` keeps its own meaning and must NOT resurrect directory inference.
   * It maps to the agent's "continue last conversation" flag (`--continue` in
   * Claude's adapter, `anthropic-compatible/launch.ts`), which is about the
   * AGENT's transcript, not about which Barry session to carry.
   */
  it("still asks which session to carry when --last is passed", async () => {
    await resumeCommand(undefined, { last: true });

    expect(select).toHaveBeenCalledTimes(1);
    const [, opts] = startCommand.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(opts._resume).toEqual({ providerSessionId: "conv-picked" });
  });
  it.each(["claude", "codex", "opencode", "cursor", "pi", "antigravity"])("resumes the exact recorded %s conversation with a newer decoy present", async (provider) => {
    getSession.mockResolvedValue(sessionRow({ metadata: { provider, working_directory: process.cwd() } }));
    getProviderSessionsBySession.mockResolvedValue([{ provider: "unrelated", provider_session_id: "decoy" }, { provider, provider_session_id: "older-target" }]);
    await resumeCommand("sess_picked", {});
    expect(select).not.toHaveBeenCalled();
    expect(startCommand).toHaveBeenCalledWith([], expect.objectContaining({ _resumeSessionId: "sess_picked", _resume: { providerSessionId: "older-target" }, harness: provider === "claude" ? "claude-code" : provider }));
  });

  it("refuses a missing conversation link instead of creating a replacement", async () => {
    getProviderSessionsBySession.mockResolvedValue([]);
    await expect(resumeCommand("sess_picked", { harness: "opencode" })).rejects.toThrow(/No opencode conversation/);
    expect(startCommand).not.toHaveBeenCalled();
  });

  it("refuses a nonexistent Barry ID", async () => {
    getSession.mockResolvedValue(undefined);
    await expect(resumeCommand("absent", {})).rejects.toThrow(/Session not found/);
    expect(startCommand).not.toHaveBeenCalled();
  });

});
