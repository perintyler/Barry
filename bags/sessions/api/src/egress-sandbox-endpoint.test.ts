import { afterAll, beforeAll, describe, it, expect, vi } from "vitest";
import { Barry } from "@barry-rocks/sdk";
import { fakeIdentities } from "@barry-rocks/sdk/testing";

// The session row is the only source a test needs: the bound on it is merged
// with nothing else when the session has no identity, traits or named bound.
// The guards read it, and so does the sessions bag composing its grants.
type Row = { bounds: string[]; identity_id: number | null; traits: string[]; bound: unknown; bound_id: number | null; metadata: Record<string, unknown> };
const db = vi.hoisted(() => ({ row: undefined as Row | undefined }));
const sessionRow = (overrides: Partial<Row>): Row => ({ identity_id: null, bounds: [], traits: [], bound: null, bound_id: null, metadata: {}, ...overrides });
vi.mock("./db.js", () => ({ getSessionRecord: async () => db.row }));
vi.mock("@barry-rocks/sessions-bag/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@barry-rocks/sessions-bag/client")>()),
  getSession: async () => db.row,
}));

import { resolveEgressSandbox, supportsEgressSandbox } from "./session-agent-guards.js";
import { describeShipped, wireShippedHarnesses } from "./test-helpers/shipped-harnesses.js";
import { grantsOver } from "./test-helpers/identity-policy.js";
import { approveExecutionScope } from "@barry-rocks/sdk/bounds";
import { resolveSessionNetworkScope } from "./session-agent-guards.js";

// The identities subject, composing grants with the real shared resolver over
// a store and a tool universe that hold nothing (see test-helpers/identity-policy).
const store = {
  identityRecords: { row: async (id: number) => ({ id, name: "fixture" }), config: () => ({ bags: [], traits: [], bounds: [] }) },
  traits: { list: async () => [] },
  bounds: { stored: async () => [] },
};

beforeAll(() => {
  wireShippedHarnesses({ createSession: vi.fn(), runStructured: vi.fn() });
  Barry.use(fakeIdentities({ grants: grantsOver(store as never, []) }));
});
afterAll(() => Barry.reset());

/**
 * Whether the egress proxy is enforceable is an ENDPOINT fact, not an agent one.
 *
 * The bug this guards: a session on the claude agent routed to a local Ollama
 * model read claude's own answer — `true` — and declared the network scope
 * enforced. Ollama's endpoint says `false`, and nothing read it. The caller's
 * own comment says a network scope that silently does nothing is worse than
 * none at all; that is exactly what it produced, for the one route where it
 * mattered.
 *
 * The first two cases are the regression proper: they FAIL on an agent-only
 * read, because it cannot distinguish them — same agent, same answer,
 * different endpoint.
 */
describe("supportsEgressSandbox", () => {
  it("refuses for a claude session routed to Ollama", () => {
    // The harness says yes and the endpoint says no. The endpoint wins.
    expect(describeShipped("claude")?.modes.hosted?.egressSandbox).toBe(true);

    expect(supportsEgressSandbox("claude", "qwen3:4b")).toBe(false);
  });

  it("allows a claude session routed to z.ai", () => {
    // The control for the case above, and the reason this cannot just read
    // "is it routed at all": z.ai is a routed endpoint that DOES sit behind
    // the proxy, so routing is not itself the disqualifier.
    expect(supportsEgressSandbox("claude", "glm-5.2")).toBe(true);
  });

  it("falls back to the harness for a model with no routed endpoint", () => {
    // An ordinary claude model reaches claude's own endpoint, so the hosted
    // mode's answer is the right and only one.
    expect(supportsEgressSandbox("claude", "claude-sonnet-4-5-20250929")).toBe(true);
  });

  it("falls back to the harness when no model is named", () => {
    expect(supportsEgressSandbox("claude")).toBe(true);
    expect(supportsEgressSandbox("codex")).toBe(false);
  });
});

/**
 * What a session's harness is handed for its network bound.
 *
 * A neutral policy, not the Claude Agent SDK's settings: the harness adapter
 * builds its own sandbox from it, so the shape here names no vendor.
 */
describe("resolveEgressSandbox", () => {
  const session = { id: "s1" };

  it("hands a sandboxed bound's allowed domains to the harness", async () => {
    db.row = sessionRow({ bound: { network: { enforce: "sandbox", allowDomains: ["github.com"] } } });
    expect(await resolveEgressSandbox(session, { provider: "claude" })).toEqual({ allowDomains: ["github.com"] });
  });

  it("allows nothing, rather than everything, when a sandboxed bound lists no domains", async () => {
    db.row = sessionRow({ bound: { network: { enforce: "sandbox" } } });
    expect(await resolveEgressSandbox(session, { provider: "claude" })).toEqual({ allowDomains: [] });
  });

  it("asks for no sandbox when the bound is enforced by guards alone", async () => {
    db.row = sessionRow({ bound: { network: { enforce: "guard", domains: ["github.com"] } } });
    expect(await resolveEgressSandbox(session, { provider: "claude" })).toBeUndefined();
  });

  it("refuses invalid sandbox-only allowlisting instead of swallowing the policy error", async () => {
    db.row = sessionRow({ bound: { network: { enforce: "guard", allowDomains: ["github.com"] } } });
    await expect(resolveEgressSandbox(session, { provider: "claude" })).rejects.toThrow("enforced only by the egress sandbox");
  });
  it("refuses a requested sandbox on a route that cannot enforce one", async () => {
    db.row = sessionRow({ bound: { network: { enforce: "sandbox", allowDomains: ["github.com"] } } });
    await expect(resolveEgressSandbox(session, { provider: "claude", model: "qwen3:4b" })).rejects.toThrow("cannot enforce");
  });
  it("refuses partial network action enforcement instead of silently downgrading", async () => {
    db.row = sessionRow({ bound: { network: { enforce: "sandbox", actions: ["write"] } } });
    await expect(resolveEgressSandbox(session, { provider: "claude" })).rejects.toThrow("cannot be enforced");
  });
  it("refuses workflow sandbox downgrades and denies the harness native inventory", async () => {
    const harness = describeShipped("claude")!;
    const scope = await approveExecutionScope({ identity: "identity", harness: harness.id, traitNames: [], traits: {}, tools: [], bounds: [{ network: { enforce: "sandbox", allowDomains: ["github.com"] } }], boundByName: async () => undefined });
    db.row = sessionRow({ identity_id: 7, metadata: { workflow_scope: scope, workflow_identity_id: 7 } });
    const scoped = { ...session, provider: "claude", workflowScoped: true };
    const bound = await resolveSessionNetworkScope(scoped);
    expect(bound?.nativeTools?.[harness.id]).toEqual(harness.nativeTools);
    await expect(resolveEgressSandbox(scoped, { provider: "claude", model: "qwen3:4b" })).rejects.toThrow("cannot enforce");
    // A session moved to another identity is no longer the one its workflow approved.
    db.row = sessionRow({ identity_id: 8, metadata: { workflow_scope: scope, workflow_identity_id: 7 } });
    await expect(resolveSessionNetworkScope(scoped)).rejects.toThrow("invalid");
  });
});
