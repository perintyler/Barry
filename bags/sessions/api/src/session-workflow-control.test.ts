import { beforeEach, afterEach, expect, it, vi } from "vitest";
import express, { type Request } from "express";
import { verifyWorkflowActor } from "@barry-rocks/sdk/internal/auth";
import { boundFingerprint } from "@barry-rocks/sdk/bounds";
const f = vi.hoisted(() => ({
  row: {} as Record<string, unknown>,
  resolveBounds: vi.fn(), authorize: vi.fn(), secrets: vi.fn(), get: vi.fn(), identity: vi.fn(),
  toolsList: [{ namespace: "workflows", toolName: "cancel", access: "write", contractHash: "a".repeat(64) }],
}));
vi.mock("./workflow-installed-bounds.js", async original => ({
  ...await original<typeof import("./workflow-installed-bounds.js")>(),
  resolveWorkflowSessionBounds: (_identityId: unknown, selection: unknown) => f.resolveBounds(selection),
}));
vi.mock("@barry-rocks/sdk/internal/nodes", () => ({ installationRegistry: () => ({ identityId: f.identity, id: "local-node" }) }));
vi.mock("@barry-rocks/sdk/internal/services", () => ({ installationSecrets: f.secrets }));
vi.mock("@barry-rocks/sdk/internal/tools", () => ({ collectToolDefinitions: async () => f.toolsList }));
vi.mock("@barry-rocks/sessions-bag/client", async original => ({ ...await original<typeof import("@barry-rocks/sessions-bag/client")>(), getSession: f.get }));
vi.mock("@barry-rocks/sessions-bag/execution-authorization", () => ({ authorizeSessionExecution: f.authorize }));
import { actionWorkflowAuthority, sessionWorkflowActor } from "./session-workflow-control.js";
const key = "declared-session-workflow-key-longer-than-thirty-two", identity = "identity-uuid", path = "/api/v2/work/work-one/stop";
const principal = { kind: "installation" as const, actorId: 1, credentialId: "installation" as const };
const body = { version: 2, request_id: "fixture", expected_revision: 1 };
function request(query: Request["query"] = {}): Request {
  const value = Object.create(express.request) as Request;
  Object.defineProperties(value, { body: { value: {} }, url: { value: "/api/v1/actions/runs/fixture/cancel" }, query: { value: query }, authPrincipal: { value: principal } });
  return value;
}
function evidence(tools: Record<string, "write"> = { "workflows:cancel": "write" }, contracts = { "workflows:cancel": "a".repeat(64) }) {
  const value = { identity, bags: ["work"], bound: null, tools, contracts };
  return { ...value, fingerprint: boundFingerprint(value) };
}
beforeEach(() => {
  vi.resetAllMocks();
  f.row = { id: "session-one", state: "open", ended_at: null, user_id: 1, identity_id: 7, bags: ["work"], bounds: [], bound: null, metadata: {} };
  f.get.mockImplementation(async () => structuredClone(f.row)); f.identity.mockReturnValue(identity);
  f.authorize.mockResolvedValue(principal); f.secrets.mockResolvedValue({ BARRY_WORKFLOW_ACTOR_KEY: key });
  f.resolveBounds.mockResolvedValue({ bags: ["work"], bound: null, tools: [{ namespace: "workflows", name: "cancel", access: "write" }], skills: [], instructions: [] });
});
afterEach(() => vi.unstubAllEnvs());
it("signs the actual session identity and request after authorization and declared-key resolution", async () => {
  const token = await sessionWorkflowActor("session-one", principal, identity)(path, body);
  expect(verifyWorkflowActor(token, key, path, body)).toMatchObject({ principal: identity, operation: "cancel" });
  expect(() => verifyWorkflowActor(token, key, path, { ...body, expected_revision: 2 })).toThrow();
  expect(f.authorize).toHaveBeenCalledWith(principal, { sessionId: "session-one" });
  expect(f.identity).toHaveBeenCalledWith(7);
  expect(f.secrets).toHaveBeenCalledWith(["BARRY_WORKFLOW_ACTOR_KEY"], { optionalNames: ["BARRY_WORKFLOW_ACTOR_KEY"] });
});
it("rechecks current bounds and declared key on every call through the same signer", async () => {
  const sign = sessionWorkflowActor("session-one", principal, identity);
  await sign(path, body);
  const rotated = key + "-rotated"; f.secrets.mockResolvedValue({ BARRY_WORKFLOW_ACTOR_KEY: rotated });
  expect(verifyWorkflowActor(await sign(path, body), rotated, path, body).principal).toBe(identity);
  f.resolveBounds.mockResolvedValue({ bags: [], bound: null, tools: [], skills: [], instructions: [] });
  await expect(sign(path, body)).rejects.toThrow(/outside the execution bound|tool access denied/);
});
it.each(["missing", "ended", "identity-free", "wrong-partition", "foreign-owner"])("refuses %s authority without signing", async kind => {
  if (kind === "missing") f.get.mockResolvedValue(undefined);
  if (kind === "ended") f.row.ended_at = "2026-10-15T00:00:00Z";
  if (kind === "identity-free") f.row.identity_id = null;
  if (kind === "wrong-partition") f.identity.mockReturnValue("other");
  if (kind === "foreign-owner") f.authorize.mockRejectedValue(new Error("Session execution ownership mismatch"));
  await expect(sessionWorkflowActor("session-one", principal, identity)(path, body)).rejects.toThrow();
  expect(f.secrets).not.toHaveBeenCalled();
});
it("rejects devices, missing authentication and unsupported routes before loading authority", async () => {
  const device = { kind: "device" as const, credentialId: "paired", actorId: 1, identityIds: [7], scopes: [] };
  for (const actor of [undefined, device]) await expect(sessionWorkflowActor("session-one", actor, identity)(path, body)).rejects.toThrow();
  await expect(sessionWorkflowActor("session-one", principal, identity)("/api/runs", body)).rejects.toThrow();
  expect(f.authorize).not.toHaveBeenCalled();
});
it("intersects a validated original workflow bound and disables defaults and identity bag union", async () => {
  f.row.metadata = { workflow_bound: evidence(), workflow_identity_id: 7 };
  await sessionWorkflowActor("session-one", principal, identity)(path, body);
  expect(f.resolveBounds.mock.calls[0][0]).toMatchObject({ defaults: false, identityDefaults: false });
  f.row.metadata = { workflow_bound: evidence({}), workflow_identity_id: 7 };
  await expect(sessionWorkflowActor("session-one", principal, identity)(path, body)).rejects.toThrow(/outside the execution bound|tool access denied/);
});
it("refuses changed workflow bound fingerprints, identity binding and tool contracts", async () => {
  for (const metadata of [
    { workflow_bound: { ...evidence(), bags: [] }, workflow_identity_id: 7 },
    { workflow_bound: evidence(), workflow_identity_id: 8 },
    { workflow_bound: evidence({ "workflows:cancel": "write" }, { "workflows:cancel": "b".repeat(64) }), workflow_identity_id: 7 },
  ]) {
    f.row.metadata = metadata;
    await expect(sessionWorkflowActor("session-one", principal, identity)(path, body)).rejects.toThrow();
  }
});
it("retains an older execution context's tool and bound ceilings", async () => {
  f.row.metadata = { execution_context: { bags: ["work"], bound: null, allowedToolIds: [] } };
  await expect(sessionWorkflowActor("session-one", principal, identity)(path, body)).rejects.toThrow(/outside the execution bound|tool access denied/);
  f.row.metadata = { execution_context: { bags: ["work"], bound: { tools: { deny: ["workflows:*"] } }, allowedToolIds: ["workflows:cancel"] } };
  await expect(sessionWorkflowActor("session-one", principal, identity)(path, body)).rejects.toThrow();
});
it("refuses a session closed while credentials are being resolved", async () => {
  f.secrets.mockImplementation(async () => { f.row.state = "ended"; return { BARRY_WORKFLOW_ACTOR_KEY: key }; });
  await expect(sessionWorkflowActor("session-one", principal, identity)(path, body)).rejects.toThrow("selected session");
});
it("does not confuse unrelated activity updates with an authority change", async () => {
  f.secrets.mockImplementation(async () => { f.row.last_message_at = "2026-10-15T01:00:00Z"; return { BARRY_WORKFLOW_ACTOR_KEY: key }; });
  await expect(sessionWorkflowActor("session-one", principal, identity)(path, body)).resolves.toBeTypeOf("string");
});
it("ignores an ambient key when the installation has no declared signing key", async () => {
  vi.stubEnv("BARRY_WORKFLOW_ACTOR_KEY", key); f.secrets.mockResolvedValue({});
  await expect(sessionWorkflowActor("session-one", principal, identity)(path, body)).rejects.toThrow("not configured");
});
it("keeps explicit invalid and identity-free selections from operator fallback", () => {
  for (const query of [{ session_id: "missing" }, { session_id: ["one", "two"] }]) {
    const authority = actionWorkflowAuthority(request(query), undefined);
    expect(authority.operator).toBe(false); expect(authority.actor).toBeTypeOf("function");
  }
  const sign = vi.fn();
  expect(actionWorkflowAuthority(request(), { workflowActor: sign })).toEqual({ operator: false, actor: sign });
});

it("checks current bounds after a delayed declared-key read", async () => {
  f.secrets.mockImplementation(async () => { f.resolveBounds.mockResolvedValue({ bags: [], bound: null, tools: [], skills: [], instructions: [] }); return { BARRY_WORKFLOW_ACTOR_KEY: key }; });
  await expect(sessionWorkflowActor("session-one", principal, identity)(path, body)).rejects.toThrow("tool access denied");
});
it.each([{ deny: ["local-node"] }, { allow: ["other-node"] }])("enforces the selected session node bound %j", async nodes => {
  f.resolveBounds.mockResolvedValue({ bags: ["work"], bound: { nodes }, tools: [{ namespace: "workflows", name: "cancel", access: "write" }], skills: [], instructions: [] });
  await expect(sessionWorkflowActor("session-one", principal, identity)(path, body)).rejects.toThrow("node access denied");
});
