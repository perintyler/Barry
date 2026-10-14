import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Barry, type Identities } from "@barry-rocks/sdk";
import { fakeIdentities } from "@barry-rocks/sdk/testing";
import type { McpServerConfig, Session, SessionConfig, SessionEvent } from "@barry-rocks/sdk/sessions";
import type { Bound } from "@barry-rocks/sdk/bounds";
import { defaultTraits } from "@barry-rocks/sdk/internal/bags";
import { FALLBACK_HARNESS } from "@barry-rocks/sdk/internal/identities";
import { writeServiceRegistry } from "@barry-rocks/sdk/services";

// A run reaches Barry's tools through this instance's engine, which it finds in
// the instance's registry: give it one.
process.env.BARRY_HOME = mkdtempSync(join(tmpdir(), "barry-run-agent-"));
writeServiceRegistry({
  version: 2,
  generated: new Date().toISOString(),
  resources: {
    "mcp.server": { bag: "mcp", name: "server", kind: "service", url: "http://127.0.0.1:4901" },
    "sessions.api": { bag: "sessions", name: "api", kind: "service", url: "http://127.0.0.1:4854" },
  },
});

// `barry session run` goes through runQuery. What matters to the user is which
// harness the run starts (the default used to be "claude-sdk", an id the
// registry retired, so every run failed with "Unknown agent: claude-sdk"), and
// which Barry tools the agent can reach (none, until runQuery stopped reading a
// config.json nothing wrote).
const requested: string[] = [];
const agentConfigs: SessionConfig[] = [];

// The run's session: one turn that answers "ok", then ends.
function answeringSession(): Session {
  const events: SessionEvent[] = [{ type: "result", result: "ok" }, { type: "done" }];
  return {
    id: "run",
    harnessSessionId: null,
    harnessVersion: null,
    mode: "hosted",
    guarantees: { capture: "total", delivery: "wake", steer: false, interrupt: true, gating: "static", keepsVendorUi: false, identity: "inherent" },
    events: () => ({
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          const value = events.shift();
          return value ? { done: false, value } : { done: true, value: undefined };
        },
      }),
    }),
    deliver: async () => ({ messageId: "m1", status: "started" }),
    interrupt: async () => {},
    answer: async () => {},
    status: () => "idle",
    close: async () => {},
  };
}

// A harness with no hosted mode, which a one-shot run cannot start.
const INTERACTIVE_ONLY = "interactive-only";

vi.mock("../src/adapters/installed.js", () => ({
  adapterStore: async () => ({ adapters: { installed: () => [FALLBACK_HARNESS, "claude", "codex"].map(id => ({ id, aliases: id === FALLBACK_HARNESS ? ["claude"] : [], nativeTools: ["Bash", "Read"], modes: { hosted: { native: { grantable: ["Read"] } } }, defaultMode: "hosted" })) } }),
  harnessAdapter: async (id: string) => {
    requested.push(id);
    return {
      id,
      nativeTools: ["Bash", "Read"],
      // What routing reads: a bare id is this vendor's, and Barry can point
      // the harness at another's endpoint.
      vendor: id === "codex" ? "openai" : "anthropic",
      capabilities: { endpoint: id === "codex" ? "fixed" : "configurable", withoutKey: "subscription-oauth" },
      modes: id === INTERACTIVE_ONLY ? {} : {
        hosted: {
          structuredOutput: "native",
          start: async (config: SessionConfig) => {
            agentConfigs.push(config);
            return answeringSession();
          },
        },
      },
    };
  },
}));

vi.mock("../src/config.js", () => ({
  useInstanceSecret: () => {},
  PATHS: { identityDir: "/repo" },
}));

vi.mock("@barry-rocks/sdk/internal/bags", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/internal/bags")>(),
  loadBags: async () => [],
  expandCompositionFromSnapshot: async () => [],
  loadBagRegistrySnapshot: async () => ({ bags: [] }),
}));

vi.mock("@barry-rocks/sdk/internal/mcp", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/internal/mcp")>(),
  installRemoteBagLoader: () => {},
}));

const createSession = vi.fn(async (_input: { id: string; traits: string[]; identity_id?: number }) => undefined);
vi.mock("@barry-rocks/sessions-bag/client", () => ({
  Sessions: { create: createSession, updateMetadata: vi.fn(async () => undefined), end: vi.fn(async () => undefined) },
  createProviderSession: vi.fn(async () => undefined),
  appendMessage: vi.fn(async () => null),
}));

// The identity records the CLI hosts: one identity, "bux", whose row is 7; and
// the servers every session reaches.
vi.mock("@barry-rocks/identities-bag", async () => {
  const { BarryError } = await import("@barry-rocks/sdk");
  return {
    identityRecords: {
      find: async (name: string) => {
        if (name !== "bux") throw new BarryError("not_found", `Identity "${name}" not found`);
        return { record: { id: 999_000_001, name, actor_id: 1, metadata: {} }, source: "file", dir: null, isDefault: false };
      },
      config: () => ({ bags: [], secrets: {}, adapters: {} }),
      rowId: async () => 7,
    },
    traits: { alwaysOn: ["barry", "session", "media-viewer"] },
  };
});

// The identities subject: a run is granted the installation's defaults and the
// traits it selects, each trait granting its own namespace, under whatever
// bound a test sets.
const grantedBound = vi.fn(async (): Promise<Bound | null> => null);
const grants = vi.fn<Identities["grants"]>(async (_ref, selection) => {
  const traits = [...defaultTraits(), ...(selection.traits ?? [])];
  return { traits, bound: await grantedBound(), namespaces: traits, tools: [], skills: [], instructions: [] };
});

// The engine answers which namespaces a session is granted; here, the traits
// themselves, so the assertion is about wiring rather than grant rules.
vi.mock("@barry-rocks/sdk/internal/sessions", async (importOriginal) => ({
  ...await importOriginal<typeof import("@barry-rocks/sdk/internal/sessions")>(),
  resolveSessionNamespaces: async (sessionId: string | undefined, options: { fallback?: string[] } = {}) =>
    sessionId ? (options.fallback ?? []) : [],
}));

vi.mock("../src/lib/current-user.js", () => ({ getCurrentUser: async () => ({ id: 1 }) }));

const { runQuery } = await import("../src/sdk.js");
const { shippedVendors } = await import("./helpers/shipped-vendors.js");
const VENDORS = await shippedVendors();
const { createModels, installModels } = await import("@barry-rocks/sdk/adapters/models");
// The vendor catalog the CLI installs at startup, which routing reads.
installModels(createModels(VENDORS));

/** Where an HTTP server in the run's MCP config points; undefined for a stdio one. */
const urlOf = (server: McpServerConfig | undefined) => (server && "url" in server ? server.url : undefined);

beforeEach(() => {
  requested.length = 0;
  agentConfigs.length = 0;
  Barry.use(fakeIdentities({ grants }));
  grants.mockClear();
  grantedBound.mockReset();
  grantedBound.mockResolvedValue(null);
  createSession.mockClear();
  createSession.mockImplementation(async () => undefined);
});

describe("runQuery agent selection", () => {
  it("defaults to a harness that is installed", async () => {
    const out = await runQuery({ prompt: "hi" });
    expect(requested).toEqual([FALLBACK_HARNESS]);
    expect(out.result).toBe("ok");
  });

  it.each([
    ["claude-sdk", "claude"],
    ["codex-sdk", "codex"],
    ["codex", "codex"],
  ])("maps a caller's %s to the harness id %s", async (given, expected) => {
    await runQuery({ prompt: "hi", provider: given });
    expect(requested).toEqual([expected]);
  });
});

describe("the Barry tools a headless run can reach", () => {
  it("connects the agent to Barry's servers for the run's own session", async () => {
    await runQuery({ prompt: "hi", traits: ["actions"] });

    const created = createSession.mock.calls[0]?.[0] as { id: string; traits: string[] } | undefined;
    expect(created?.traits).toEqual([...defaultTraits(), "actions"]);
    const servers = agentConfigs[0]?.mcpServers ?? {};
    // One endpoint per granted namespace, scoped to this run's session...
    expect(urlOf(servers.actions)).toMatch(new RegExp(`/mcp/ns/actions\\?sessionId=${created?.id}$`));
    // ...and the aggregate, told which namespaces moved to their own entries.
    expect(urlOf(servers.barry)).toContain(`sessionId=${created?.id}`);
    expect(new URL(urlOf(servers.barry) ?? "http://fixture").searchParams.get("split")?.split(",")).toContain("actions");
  });

  it("attaches the barry named with --name to the session", async () => {
    await runQuery({ prompt: "hi", barry: "bux" });
    expect(grants).toHaveBeenCalledWith(7, expect.objectContaining({ traits: [] }), expect.anything());
    expect(createSession.mock.calls[0]?.[0]).toMatchObject({ identity_id: 7 });
  });

  it("refuses an untracked one-shot when the Barry store is unreachable", async () => {
    createSession.mockRejectedValue(new Error("store unreachable"));
    await expect(runQuery({ prompt: "hi", traits: ["actions"] })).rejects.toThrow("store unreachable");
    expect(agentConfigs).toHaveLength(0);
  });
});

afterEach(() => {
  Barry.reset();
  vi.unstubAllEnvs();
});
it("applies hosted restrictions before a native tool can execute", async () => {
  grantedBound.mockResolvedValue({ nativeTools: { claude: ["Bash"] } });
  await runQuery({ prompt: "hi" });
  expect(agentConfigs[0].deniedTools).toContain("Bash");
  expect(await agentConfigs[0].decide!({ id: "call-1", tool: "Bash", input: { command: "touch forbidden" } })).toMatchObject({ allow: false });
});
it("keeps provider environment changes local to the query", async () => {
  vi.stubEnv("ANTHROPIC_API_KEY", "ambient-test-only");
  await runQuery({ prompt: "hi" });
  expect(agentConfigs[0].env?.ANTHROPIC_API_KEY).toBeUndefined();
  expect(process.env.ANTHROPIC_API_KEY).toBe("ambient-test-only");
});
it("fails closed when a generated identity cannot record its session", async () => {
  vi.stubEnv("BARRY_IDENTITY_BINDING", "fixture");
  createSession.mockRejectedValue(new Error("store unreachable"));
  await expect(runQuery({ prompt: "hi", barry: "bux" })).rejects.toThrow("store unreachable");
  expect(agentConfigs).toHaveLength(0);
});
it("does not silently replace a missing identity with an anonymous run", async () => {
  await expect(runQuery({ prompt: "hi", barry: "missing" })).rejects.toThrow("not found");
  expect(agentConfigs).toHaveLength(0);
});

it("ends a recorded one-shot session when preparation fails before the harness starts", async () => {
  const { Sessions } = await import("@barry-rocks/sessions-bag/client");
  await expect(runQuery({ prompt: "hi", provider: INTERACTIVE_ONLY })).rejects.toThrow("has no hosted mode");
  expect(Sessions.end).toHaveBeenCalledWith(createSession.mock.calls[0][0].id, "cli-run-complete");
  expect(agentConfigs).toHaveLength(0);
});

// The grants are what the session is recorded with, so a run they refuse is never recorded.
it("records no session when the run's grants cannot be resolved", async () => {
  grantedBound.mockRejectedValue(new Error("missing required bound"));
  await expect(runQuery({ prompt: "hi" })).rejects.toThrow("missing required bound");
  expect(createSession).not.toHaveBeenCalled();
  expect(agentConfigs).toHaveLength(0);
});
