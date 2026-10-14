import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { Barry, BarryError, type Grants, type Identities, type Tool } from "@barry-rocks/sdk";
import { fakeIdentities } from "@barry-rocks/sdk/testing";
import { ALLOW_DOMAINS_NEEDS_SANDBOX, approveExecutionScope, assertToolAllowed } from "@barry-rocks/sdk/bounds";
import { baseIdentitySelection, discoverBuiltinBags } from "@barry-rocks/sdk/internal/bags";
import { parseManifest } from "@barry-rocks/sdk/bags";
import { getSession, type SessionRecord } from "@barry-rocks/sessions-bag/client";
import { resolveSessionBound, ANONYMOUS_SESSION_ID } from "./session-bound.js";

function sessionRecord(overrides: Partial<SessionRecord>): SessionRecord {
  return {
    id: "fixture", active: true, state: "open", user_id: null, agent_token: null,
    identity_id: null, workflow_credential_id: null, status: "pending", system_prompt: null,
    summary: null, traits: [], bounds: [], bound: null, bound_id: null, metadata: {},
    created_at: "2026-01-01T00:00:00.000Z", started_at: null, completed_at: null,
    ended_at: null, last_message_at: null, ...overrides,
  };
}

vi.mock("@barry-rocks/sessions-bag/client", () => ({
  getSession: vi.fn(async () => undefined),
}));

/**
 * The repo root, found by searching for the workspace marker.
 *
 * These tests read shipped YAML and cli/ source as fixtures. That used to be a
 * fixed three-level climb from this directory, which broke the moment the
 * package moved (servers/mcp/src -> the MCP host source, two levels) — and would have
 * broken by throwing ENOENT on a path that looks plausible, rather than saying
 * the climb was wrong.
 */
function repoRoot(): string {
  let dir = import.meta.dirname;
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`no pnpm-workspace.yaml above ${import.meta.dirname}`);
    dir = parent;
  }
}

describe("the base identity's default traits", () => {
  const builtinDir = () => join(repoRoot(), "bags");
  const defaults = () => baseIdentitySelection(builtinDir()).traits;

  it("names builtin bags only (core and the coding composite are retired)", () => {
    expect(defaults()).toEqual(expect.arrayContaining(["bash", "filesystem", "sessions", "instructions"]));
    expect(defaults()).not.toContain("core");
    // `coding` is the external coding bag's auto-trait. As a default it is the
    // name whose collision stripped Bash from every session.
    expect(defaults()).not.toContain("coding");
  });

  // Asserting a name is present in the list it came from cannot fail. Read
  // what ships instead: a default no shipped bag defines is a dead name, and
  // resolveSessionBound warns only when EVERY default is missing.
  it("defines every default trait in what ships", () => {
    const shipped = discoverBuiltinBags(builtinDir());
    expect(Object.keys(shipped.local).length, "no bags discovered — is the builtin directory where this test looks?")
      .toBeGreaterThan(0);
    const undefinedDefaults = defaults().filter((t) => !(t in shipped.local));
    expect(
      undefinedDefaults,
      `default traits no shipped bag defines (every session would ask for these and get nothing): ${undefinedDefaults.join(", ")}`,
    ).toEqual([]);
  });

  // `instructions` is hidden from the CLI capability picker with every other
  // builtin bag, so the default grant is the only thing keeping it reachable:
  // filterTools fails closed, and tool_search only finds registered tools.
  it("grants the deferred builtin bags so tool_search can reach them", () => {
    expect(defaults()).toContain("instructions");
  });

  // Loading is not granting: every session loads the base identity's bags,
  // and only its traits grant tools. The bags every session is assumed to use
  // (session lookup, change tracking, host access, progress events, the action
  // catalog and its instructions) must be reachable through the defaults, or
  // a session gets them loaded with zero tools and nothing says so.
  it("reaches the bags every session uses", () => {
    const everySessionUses = ["sessions", "tracker", "bash", "events", "actions", "instructions"];
    const shipped = discoverBuiltinBags(builtinDir()).local;
    const manifestOf = (bag: string) => parseManifest(join(builtinDir(), shipped[bag]));
    // Mirrors ownNamespaces() in @barry-rocks/sdk/bags: tool metadata and MCP
    // servers, falling back to the bag name for an undeclared tools entry.
    const ownNamespaces = (bag: string): Set<string> => {
      const manifest = manifestOf(bag);
      const own = new Set<string>([
        ...(manifest?.tools ?? []).map((t) => t.namespace),
        ...Object.keys(manifest?.mcpServers ?? {}),
      ]);
      if (own.size === 0 && (!manifest || manifest.toolsEntry)) own.add(bag);
      return own;
    };

    // A default's grant, as generateAutoTraits derives it: the bag's own
    // namespaces plus every sub-bag its `bags:` composes, transitively.
    const grantedNamespaces = new Set<string>();
    const visited = new Set<string>();
    const queue = [...defaults()];
    while (queue.length > 0) {
      const bag = queue.shift() as string;
      if (visited.has(bag) || !(bag in shipped)) continue;
      visited.add(bag);
      for (const ns of ownNamespaces(bag)) grantedNamespaces.add(ns);
      queue.push(...(manifestOf(bag)?.bags ?? []));
    }
    expect(grantedNamespaces.size, "the defaults grant no namespace — this guard proves nothing").toBeGreaterThan(0);

    const notShipped = everySessionUses.filter((b) => !(b in shipped));
    expect(notShipped, `bags every session uses that do not ship: ${notShipped.join(", ")}`).toEqual([]);
    const unreachable = everySessionUses.filter((b) => ![...ownNamespaces(b)].some((ns) => grantedNamespaces.has(ns)));
    expect(unreachable, `bags every session uses whose namespace no default trait grants: ${unreachable.join(", ")}`).toEqual([]);
  });
});

const tool = (namespace: string, name: string, access: Tool["access"]): Tool => ({ name, namespace, bag: namespace, access });
const BASH = tool("bash", "Bash", "write");
const COMMENTS = tool("bdiff", "list_comments", "read");
const toolMeta = [
  { namespace: "bash", toolName: "Bash", access: "write" as const },
  { namespace: "bdiff", toolName: "list_comments", access: "read" as const },
];

function grantsOf(traits: string[], tools: Tool[], bound: Grants["bound"] = null): Grants {
  return { traits, bound, namespaces: [...new Set(tools.map((t) => t.namespace))], tools, skills: [], instructions: [] };
}

/**
 * The shared composition, faked: `bash` is the installation's default trait,
 * and each selected trait grants its namespace's tool.
 */
const grants = vi.fn<Identities["grants"]>(async (_ref, selection) => {
  const traits = [...(selection.defaults === false ? [] : ["bash"]), ...(selection.traits ?? [])];
  return grantsOf(traits, [BASH, COMMENTS].filter((t) => traits.includes(t.namespace)), selection.inlineBound ?? null);
});

beforeEach(() => {
  vi.mocked(getSession).mockClear();
  grants.mockClear();
  Barry.use(fakeIdentities({ grants }));
});
afterEach(() => Barry.reset());

it("applies a workflow ceiling with explicit current traits and a stable identity binding", async () => {
  const approved = await approveExecutionScope({ identity: "identity", traitNames: ["bdiff"], traits: { bdiff: { name: "bdiff", namespaces: ["bdiff"], access: "read" } }, tools: toolMeta, boundByName: async () => undefined });
  const session = sessionRecord({ id: "workflow-session", identity_id: 1, traits: ["bdiff"], bound: null, bound_id: null, metadata: { workflow_scope: approved } });
  const resolved = await resolveSessionBound(session.id, toolMeta, { session, identity: "identity" });
  // The default grant (Bash) is the session's, not the workflow's: the ceiling keeps it out.
  expect([...resolved.allowedToolIds]).toEqual(["bdiff:list_comments"]);
  expect(grants).toHaveBeenCalledWith(null, expect.objectContaining({ traits: ["bdiff"], defaults: false, identityTraits: false }), { kind: "owner" });
  await expect(resolveSessionBound(session.id, toolMeta, { session, identity: "other" })).rejects.toThrow("identity binding");
  const revoked = await resolveSessionBound(session.id, toolMeta, { session: { ...session, traits: [] }, identity: "identity" });
  expect([...revoked.allowedToolIds]).toEqual([]);
  expect(getSession).not.toHaveBeenCalled();
});

it("refuses a session the composition refuses, rather than serving it unscoped", async () => {
  // e.g. a stored inline bound naming allowDomains without the sandbox, which never met the schema.
  grants.mockRejectedValueOnce(new BarryError("invalid", ALLOW_DOMAINS_NEEDS_SANDBOX));
  const session = sessionRecord({ id: "inert-allowlist", identity_id: null, traits: ["bash"], bound: { network: { allowDomains: ["example.com"] } }, bound_id: null, metadata: {} });
  await expect(resolveSessionBound(session.id, toolMeta, { session })).rejects.toThrow(/enforced only by the egress sandbox/);
});

describe("resolveSessionBound — unknown session fails CLOSED to the default grant", () => {
  it("serves the default-trait grant, not the unfiltered toolset", async () => {
    const resolved = await resolveSessionBound("no-such-session", toolMeta);

    // Null used to make the caller skip filtering entirely, so a typo'd or
    // reaped session id was served ~360 unscoped tools — MORE capability than
    // any real session. The default grant is the fail-closed answer.
    expect(resolved.allowedTools.has("Bash")).toBe(true); // bash is a DEFAULT trait
    expect(resolved.allowedTools.has("list_comments")).toBe(false); // bdiff is not
    expect(grants).toHaveBeenCalledWith(null, expect.objectContaining({ traits: [], defaults: true }), { kind: "owner" });
  });
});

describe("resolveSessionBound — anonymous connections get the default grant", () => {
  it("resolves ANONYMOUS_SESSION_ID to the default traits without a store lookup", async () => {
    const resolved = await resolveSessionBound(ANONYMOUS_SESSION_ID, toolMeta);

    expect(resolved.allowedTools.has("Bash")).toBe(true);
    expect(resolved.allowedTools.has("list_comments")).toBe(false);
    // Anonymous is EXPECTED to have no row — a store round-trip per anonymous
    // initialize would be pure waste, and the not-found warn would be noise.
    expect(getSession).not.toHaveBeenCalled();
  });
});

it("resolves a selected stdio identity without creating a persistent session", async () => {
  // The identity grants bdiff, denies Bash, and grants a tool this server does not serve.
  grants.mockResolvedValueOnce(grantsOf(["bdiff"], [COMMENTS, tool("elsewhere", "search", "read")], { deniedTools: ["Bash"], nodes: { deny: ["forbidden-node"] } }));
  const scope = await resolveSessionBound(ANONYMOUS_SESSION_ID, [
    ...toolMeta,
    { namespace: "ungranted", toolName: "list_comments", access: "read" },
  ], { identityId: 17, identity: "stable-identity" });
  expect(grants).toHaveBeenCalledWith(17, expect.objectContaining({ traits: [] }), { kind: "owner" });
  expect([...scope.allowedToolIds]).toEqual(["bdiff:list_comments"]);
  expect(getSession).not.toHaveBeenCalled();
  const execution = { traits: scope.traits ?? [], bound: scope.bound, allowedToolIds: [...scope.allowedToolIds] };
  expect(() => assertToolAllowed(execution, { namespace: "bdiff", toolName: "list_comments" }, "forbidden-node")).toThrow("node access denied");
});
