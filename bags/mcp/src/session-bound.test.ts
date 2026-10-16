import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { Barry, type Bound, type Identities, type Tool } from "@barry-rocks/sdk";
import { fakeIdentities } from "@barry-rocks/sdk/testing";
import {
  approveWorkflowBounds,
  assertNodeAllowed,
  filterToolObjects,
} from "@barry-rocks/sdk/bounds";
import { baseIdentitySelection, discoverBuiltinBags } from "@barry-rocks/sdk/internal/bags";
import { parseManifest } from "@barry-rocks/sdk/bags";
import { getSession, type SessionRecord } from "@barry-rocks/sessions-bag/client";
import { sessionBound, ANONYMOUS_SESSION_ID } from "./session-bound.js";

function sessionRecord(overrides: Partial<SessionRecord>): SessionRecord {
  return {
    id: "fixture",
    active: true,
    state: "open",
    user_id: null,
    agent_token: null,
    identity_id: null,
    workflow_credential_id: null,
    status: "pending",
    system_prompt: null,
    summary: null,
    bags: [],
    bounds: [],
    bound: null,
    metadata: {},
    created_at: "2026-01-01T00:00:00.000Z",
    started_at: null,
    completed_at: null,
    ended_at: null,
    last_message_at: null,
    ...overrides,
  };
}

vi.mock("@barry-rocks/sessions-bag/client", () => ({
  getSession: vi.fn(async () => undefined),
}));

function repoRoot(): string {
  let dir = import.meta.dirname;
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`no pnpm-workspace.yaml above ${import.meta.dirname}`);
    dir = parent;
  }
}

describe("the base identity's default bags", () => {
  const builtinDir = () => join(repoRoot(), "bags");
  const defaults = () => baseIdentitySelection(builtinDir()).bags;

  it("names builtin bags only (core and the coding composite are retired)", () => {
    expect(defaults()).toEqual(
      expect.arrayContaining(["bash", "filesystem", "sessions", "instructions"]),
    );
    expect(defaults()).not.toContain("core");
    expect(defaults()).not.toContain("coding");
  });

  it("defines every default bag in what ships", () => {
    const shipped = discoverBuiltinBags(builtinDir());
    expect(
      Object.keys(shipped.local).length,
      "no bags discovered — is the builtin directory where this test looks?",
    ).toBeGreaterThan(0);
    const undefinedDefaults = defaults().filter((b) => !(b in shipped.local));
    expect(
      undefinedDefaults,
      `default bags no shipped bag defines: ${undefinedDefaults.join(", ")}`,
    ).toEqual([]);
  });

  it("packs the deferred builtin bags so tool_search can reach them", () => {
    expect(defaults()).toContain("instructions");
  });

  it("reaches the bags every session uses", () => {
    const everySessionUses = [
      "sessions",
      "tracker",
      "bash",
      "events",
      "actions",
      "instructions",
    ];
    const shipped = discoverBuiltinBags(builtinDir()).local;
    const manifestOf = (bag: string) => parseManifest(join(builtinDir(), shipped[bag]));
    const ownNamespaces = (bag: string): Set<string> => {
      const manifest = manifestOf(bag);
      const own = new Set<string>([
        ...(manifest?.tools ?? []).map((t) => t.namespace),
        ...Object.keys(manifest?.mcpServers ?? {}),
      ]);
      if (own.size === 0 && (!manifest || manifest.toolsEntry)) own.add(bag);
      return own;
    };

    const activeNamespaces = new Set<string>();
    const visited = new Set<string>();
    const queue = [...defaults()];
    while (queue.length > 0) {
      const bag = queue.shift() as string;
      if (visited.has(bag) || !(bag in shipped)) continue;
      visited.add(bag);
      for (const ns of ownNamespaces(bag)) activeNamespaces.add(ns);
      queue.push(...(manifestOf(bag)?.bags ?? []));
    }
    expect(
      activeNamespaces.size,
      "the defaults enable no namespace — this guard proves nothing",
    ).toBeGreaterThan(0);

    const notShipped = everySessionUses.filter((b) => !(b in shipped));
    expect(notShipped, `bags every session uses that do not ship: ${notShipped.join(", ")}`).toEqual([]);
    const unreachable = everySessionUses.filter(
      (b) => ![...ownNamespaces(b)].some((ns) => activeNamespaces.has(ns)),
    );
    expect(
      unreachable,
      `bags every session uses whose namespace no default bag reaches: ${unreachable.join(", ")}`,
    ).toEqual([]);
  });
});

const tool = (namespace: string, name: string, access: Tool["access"]): Tool => ({
  id: `${namespace}:${name}`,
  name,
  namespace,
  bag: namespace,
  access,
});
const BASH = tool("bash", "Bash", "write");
const COMMENTS = tool("bdiff", "list_comments", "read");
const toolMeta = [
  { namespace: "bash", toolName: "Bash", access: "write" as const },
  { namespace: "bdiff", toolName: "list_comments", access: "read" as const },
];

const boundMock = vi.fn<NonNullable<Identities["bound"]>>(async (_ref, selectedBounds) => {
  const names = (selectedBounds ?? []).filter((b): b is string => typeof b === "string");
  if (names.includes("readonly")) {
    return { name: "readonly", tools: { deny: ["*:write"] } };
  }
  return {};
});

const toolsMock = vi.fn<NonNullable<Identities["tools"]>>(async (_ref, selection) => {
  const bagNames = [
    "bash",
    ...(selection.bags ?? []).map((b) => (typeof b === "string" ? b : b.name)),
  ];
  const candidateTools = [BASH, COMMENTS].filter((t) => bagNames.includes(t.namespace));
  const pinnedBound =
    selection.bounds && !Array.isArray(selection.bounds)
      ? (selection.bounds as Bound)
      : null;
  return filterToolObjects(candidateTools, pinnedBound);
});

beforeEach(() => {
  vi.mocked(getSession).mockClear();
  boundMock.mockClear();
  toolsMock.mockClear();
  Barry.use(fakeIdentities({ bound: boundMock, tools: toolsMock }));
});
afterEach(() => Barry.reset());

it("applies a workflow ceiling with explicit current bags and a stable identity binding", async () => {
  const approved = await approveWorkflowBounds({
    identity: "identity",
    bags: ["bdiff"],
    tools: toolMeta,
    boundByName: async () => undefined,
  });
  const session = sessionRecord({
    id: "workflow-session",
    identity_id: 1,
    bags: ["bdiff"],
    bound: null,
    metadata: { workflow_bound: approved },
  });
  const resolved = await sessionBound(session.id, toolMeta, {
    session,
    identity: "identity",
  });
  // The base default (Bash) is not in the workflow's approved ceiling: the ceiling keeps it out.
  expect([...resolved.allowedToolIds]).toEqual(["bdiff:list_comments"]);
  expect(toolsMock).toHaveBeenCalledWith(
    1,
    expect.objectContaining({ bags: ["bdiff"] }),
    { kind: "owner" },
  );
  await expect(
    sessionBound(session.id, toolMeta, { session, identity: "other" }),
  ).rejects.toThrow("identity binding");
  const revoked = await sessionBound(session.id, toolMeta, {
    session: { ...session, bags: [] },
    identity: "identity",
  });
  expect([...revoked.allowedToolIds]).toEqual([]);
  expect(getSession).not.toHaveBeenCalled();
});

it("refuses a session whose pinned bound violates the Bound schema, rather than serving it unscoped", async () => {
  const malformedBound: Record<string, unknown> = { network: { allowDomains: ["example.com"] } };
  const session = sessionRecord({
    id: "inert-allowlist",
    identity_id: null,
    bags: ["bash"],
    bound: malformedBound,
    metadata: {},
  });
  await expect(
    sessionBound(session.id, toolMeta, { session }),
  ).rejects.toThrow("allowDomains");
});

describe("sessionBound — unknown session fails CLOSED to the base identity defaults", () => {
  it("serves the base-identity default bags, not the unfiltered toolset", async () => {
    const resolved = await sessionBound("no-such-session", toolMeta);

    expect(resolved.allowedTools.has("Bash")).toBe(true);
    expect(resolved.allowedTools.has("list_comments")).toBe(false);
    expect(boundMock).toHaveBeenCalledWith(null, [], { kind: "owner" });
    expect(toolsMock).toHaveBeenCalledWith(
      null,
      expect.objectContaining({ bags: [] }),
      { kind: "owner" },
    );
  });
});

describe("sessionBound — anonymous connections get the base identity defaults", () => {
  it("resolves ANONYMOUS_SESSION_ID to the base identity defaults without a store lookup", async () => {
    const resolved = await sessionBound(ANONYMOUS_SESSION_ID, toolMeta);

    expect(resolved.allowedTools.has("Bash")).toBe(true);
    expect(resolved.allowedTools.has("list_comments")).toBe(false);
    expect(getSession).not.toHaveBeenCalled();
  });
});

it("resolves a selected stdio identity without creating a persistent session", async () => {
  boundMock.mockResolvedValueOnce({
    tools: { deny: ["bash:Bash"] },
    nodes: { deny: ["forbidden-node"] },
  });
  toolsMock.mockResolvedValueOnce([
    COMMENTS,
    tool("elsewhere", "search", "read"),
  ]);
  const served = [
    ...toolMeta,
    { namespace: "ungranted", toolName: "list_comments", access: "read" as const },
  ];
  const scope = await sessionBound(ANONYMOUS_SESSION_ID, served, {
    identityId: 17,
    identity: "stable-identity",
  });
  expect(boundMock).toHaveBeenCalledWith(17, [], { kind: "owner" });
  expect(toolsMock).toHaveBeenCalledWith(
    17,
    expect.objectContaining({
      bags: [],
      bounds: {
        tools: { deny: ["bash:Bash"] },
        nodes: { deny: ["forbidden-node"] },
      },
    }),
    { kind: "owner" },
  );
  expect([...scope.allowedToolIds]).toEqual(["bdiff:list_comments"]);
  expect(getSession).not.toHaveBeenCalled();
  expect(() => assertNodeAllowed("forbidden-node", scope.bound)).toThrow(
    "node access denied",
  );
});

it("passes a session's pinned bound directly to Barry.tools without re-calling Barry.bound", async () => {
  const pinnedBound: Bound = { tools: { deny: ["*:write"] } };
  const session = sessionRecord({
    id: "pinned-session",
    identity_id: 17,
    bags: ["bdiff"],
    bounds: ["readonly"],
    bound: pinnedBound as Bound & Record<string, unknown>,
    metadata: { harness: "claude-code" },
  });
  const resolved = await sessionBound(session.id, toolMeta, { session });
  expect(boundMock).not.toHaveBeenCalled();
  expect(toolsMock).toHaveBeenCalledWith(
    17,
    expect.objectContaining({
      bags: ["bdiff"],
      bounds: pinnedBound,
    }),
    { kind: "owner" },
  );
  expect([...resolved.allowedToolIds]).toEqual(["bdiff:list_comments"]);
  expect(resolved.harness).toBe("claude-code");
});

it("preserves proxied MCP server tools in toolMeta when their bag is selected on the session and enforces bounds", async () => {
  const proxiedMeta = [
    ...toolMeta,
    { namespace: "linear", toolName: "list_issues", access: "read" as const },
    { namespace: "linear", toolName: "create_issue", access: "write" as const },
    { namespace: "ungranted", toolName: "secret_tool", access: "read" as const },
  ];
  const session = sessionRecord({
    id: "proxied-session",
    identity_id: 17,
    bags: ["linear"],
    bound: { tools: { deny: ["linear:write"] } } as Bound & Record<string, unknown>,
    metadata: { explicit_bags: true },
  });
  toolsMock.mockResolvedValueOnce([]);
  const resolved = await sessionBound(session.id, proxiedMeta, { session });
  expect(toolsMock).toHaveBeenCalledWith(
    null,
    expect.objectContaining({ bags: ["linear"] }),
    { kind: "owner" },
  );
  expect([...resolved.allowedToolIds]).toEqual(["linear:list_issues"]);
});

