/** Pure retained-bound/data tests. No identity authentication, vault access,
 * target request or native execution is simulated by these fixtures. */
import { expect, it, vi } from "vitest";
import type { Bound, Tool } from "@barry-rocks/sdk";
import type { Vendor } from "@barry-rocks/sdk/adapters/models";
import type { NativeHarness } from "@barry-rocks/sdk/bounds";
import { boundFingerprint } from "@barry-rocks/sdk/bounds";
import { selectionOf } from "@barry-rocks/sessions-bag";
import type { getSession } from "@barry-rocks/sessions-bag/client";
import { immutableWorkflowOrigin, freezeWorkflowProvider, assertWorkflowProviderCurrent, workflowNativeCeiling } from "./workflow-installed-bounds.js";

type Origin = NonNullable<Awaited<ReturnType<typeof getSession>>>;
function origin(): Origin {
  return { id: "origin-session", active: true, state: "open", user_id: 7, agent_token: null, identity_id: 42,
    workflow_credential_id: null, status: "pending", system_prompt: null, summary: null, bags: ["selected-bag"],
    bounds: [], bound: null, metadata: { provider: "pi", mode: "hosted", source: "ordinary-session", model: "openai/probe" },
    created_at: "2026-10-15T00:00:00.000Z", started_at: null, completed_at: null, ended_at: null, last_message_at: null };
}
function vendor(): Vendor {
  return { id: "openai", label: "Static vendor", baseUrl: "https://provider.invalid/v1",
    credential: { env: "OPENAI_API_KEY", item: "selected-provider-key", field: "password" },
    models: [{ id: "probe", label: "Probe completion", kind: "completion" }, { id: "embedding", label: "Embedding", kind: "embedding" }] };
}
const endpoint = "https://provider.invalid/v1";
const harness: NativeHarness = { id: "pi", tools: ["read", "write", "edit"], defaultMode: "hosted",
  modes: { hosted: { native: { controllable: ["read", "write", "edit"] } } } };
function tool(name: string, access: Tool["access"] = name === "read" ? "read" : "write", extra: Partial<Tool> = {}): Tool {
  return { namespace: "pi", name, access, bag: null, ...extra };
}
function resolvedTools(tools: Tool[], bound: Bound | null = null): { bound: Bound | null; tools: Tool[] } { return { tools, bound }; }

it("retains exactly the durable originating ownership/selection projection as normalized JSON", () => {
  const row = origin();
  const expected = JSON.parse(JSON.stringify({ id: row.id, user_id: row.user_id, identity_id: row.identity_id,
    selection: selectionOf(row), workflow_bound: row.metadata.workflow_bound, workflow_identity_id: row.metadata.workflow_identity_id,
    execution_context: row.metadata.execution_context, source: row.metadata.source }));
  expect(immutableWorkflowOrigin(row)).toBe(boundFingerprint(expected));
  expect(immutableWorkflowOrigin(structuredClone(row))).toBe(immutableWorkflowOrigin(row));
});

it("allows ordinary closure and bookkeeping changes without replacing the retained originating authority", () => {
  const row = origin(), closed = structuredClone(row);
  closed.active = false;closed.state = "closed";closed.ended_at = "2026-10-15T01:00:00.000Z";
  closed.status = "completed";closed.summary = "Later summary";closed.last_message_at = "2026-10-15T00:30:00.000Z";
  closed.completed_at = closed.ended_at;closed.metadata.name = "Renamed display";closed.metadata.summary_watermark_seq = 12;
  expect(immutableWorkflowOrigin(closed)).toBe(immutableWorkflowOrigin(row));
});

it.each(["session", "actor", "identity", "bag", "harness", "bound", "source", "execution-ceiling", "workflow-ceiling", "workflow-identity"] as const)("detects an originating %s rebind", kind => {
  const row = origin(), changed = structuredClone(row);
  if (kind === "session") changed.id = "another-session";
  if (kind === "actor") changed.user_id = 8;
  if (kind === "identity") changed.identity_id = 43;
  if (kind === "bag") changed.bags.push("extra-authority");
  if (kind === "harness") changed.metadata.provider = "codex";
  if (kind === "bound") changed.bound = { tools: { deny: ["*:write"] } };
  if (kind === "source") changed.metadata.source = "action-executor";
  if (kind === "execution-ceiling") changed.metadata.execution_context = { identity: "changed", bags: [], bound: null, allowedToolIds: [] };
  if (kind === "workflow-ceiling") changed.metadata.workflow_bound = { identity: "changed", bags: [], bound: null, tools: {}, fingerprint: "changed" };
  if (kind === "workflow-identity") changed.metadata.workflow_identity_id = 43;
  expect(immutableWorkflowOrigin(changed)).not.toBe(immutableWorkflowOrigin(row));
});

it("freezes nonsecret vendor data and declared credential names without invoking or retaining ordinary call factories", () => {
  const selected = vendor(), completion = vi.fn(() => { throw new Error("must never call a vendor while freezing bound"); });
  selected.completion = completion;selected.check = vi.fn(async () => []);
  const frozen = freezeWorkflowProvider(selected, "probe", endpoint);
  expect(frozen).toMatchObject({ version: 1, model: "probe", endpoint, credentialNames: ["OPENAI_API_KEY"] });
  expect(frozen.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(frozen.fingerprint).toBe(boundFingerprint({ version: frozen.version, vendor: frozen.vendor,
    model: frozen.model, endpoint: frozen.endpoint, credentialNames: frozen.credentialNames }));
  expect(frozen.vendor).not.toHaveProperty("completion");expect(frozen.vendor).not.toHaveProperty("check");
  expect(completion).not.toHaveBeenCalled();expect(selected.check).not.toHaveBeenCalled();
  const retained = JSON.stringify(frozen);
  selected.label = "Changed caller object";selected.models[0].label = "Changed model";
  expect(JSON.stringify(frozen)).toBe(retained);
  const equivalent = vendor();equivalent.completion = () => { throw new Error("different function identity is not vendor-data drift"); };
  expect(() => assertWorkflowProviderCurrent(frozen, equivalent)).not.toThrow();
});

it("retains a data-only endpoint reference independently from the resolved endpoint and credential name", () => {
  const selected = vendor();selected.baseUrl = { env: "PROVIDER_ENDPOINT", fallback: "https://fallback.invalid", path: "/v1" };
  const frozen = freezeWorkflowProvider(selected, "probe", endpoint);
  expect(frozen.vendor).toMatchObject({ baseUrl: selected.baseUrl });expect(frozen.endpoint).toBe(endpoint);
  expect(frozen.credentialNames).toEqual(["OPENAI_API_KEY"]);
  expect(() => assertWorkflowProviderCurrent(frozen, structuredClone(selected))).not.toThrow();
});

it.each([null, { placeholder: "declared-noncredential-placeholder" }])("does not invent credential names for an explicitly keyless vendor: %j", credential => {
  const selected = vendor();selected.credential = credential;
  const frozen = freezeWorkflowProvider(selected, "probe", endpoint);
  expect(frozen.credentialNames).toEqual([]);expect(frozen.vendor.credential).toEqual(credential);
});

it.each(["missing", "embedding"])("refuses a %s completion model before any callable vendor code", model => {
  const selected = vendor();selected.completion = vi.fn(() => { throw new Error("vendor must not run"); });
  expect(() => freezeWorkflowProvider(selected, model, endpoint)).toThrow();expect(selected.completion).not.toHaveBeenCalled();
});

it.each(["file:///private/key", "unix:///tmp/provider.sock", "ftp://provider.invalid", "https://user:password@provider.invalid/v1", "https://provider.invalid/v1?api_key=secret", "https://provider.invalid/v1#secret", "not-a-url"])("refuses unsafe endpoint %s", url => {
  expect(() => freezeWorkflowProvider(vendor(), "probe", url)).toThrow();
});

it("refuses a list-backed dynamic model list without fetching its models", () => {
  const selected = vendor();selected.listModels = vi.fn(async () => [{ id: "probe" }]);
  expect(() => freezeWorkflowProvider(selected, "probe", endpoint)).toThrow();expect(selected.listModels).not.toHaveBeenCalled();
});

it.each(["id", "credential-name", "credential-reference", "base-url", "model-kind", "removed-model", "dynamic-list"] as const)("rejects current vendor %s drift against retained data", kind => {
  const frozen = freezeWorkflowProvider(vendor(), "probe", endpoint), changed = vendor();
  if (kind === "id") changed.id = "different-vendor";
  if (kind === "credential-name") changed.credential = { env: "OTHER_KEY", item: "selected-provider-key", field: "password" };
  if (kind === "credential-reference") changed.credential = { env: "OPENAI_API_KEY", item: "another-account-item", field: "password" };
  if (kind === "base-url") changed.baseUrl = "https://different.invalid/v1";
  if (kind === "model-kind") changed.models[0].kind = "decision";
  if (kind === "removed-model") changed.models = changed.models.slice(1);
  if (kind === "dynamic-list") changed.listModels = vi.fn(async () => []);
  expect(() => assertWorkflowProviderCurrent(frozen, changed)).toThrow();
});

it.each(["vendor", "credential-names", "endpoint", "model", "fingerprint"] as const)("rejects tampered retained vendor %s even when the current vendor still matches the original fingerprint", field => {
  const frozen = freezeWorkflowProvider(vendor(), "probe", endpoint);
  if (field === "vendor") frozen.vendor.credential = { env: "FOREIGN_KEY", item: "other-identity-item", field: "password" };
  if (field === "credential-names") frozen.credentialNames = ["FOREIGN_KEY"];
  if (field === "endpoint") frozen.endpoint = "https://different.invalid/v1";
  if (field === "model") frozen.model = "embedding";
  if (field === "fingerprint") frozen.fingerprint = "0".repeat(64);
  expect(() => assertWorkflowProviderCurrent(frozen, vendor())).toThrow();
});

it("does not treat unrelated newly selected native tools as authority inherited from the parent", () => {
  expect(workflowNativeCeiling(resolvedTools([tool("read")]), resolvedTools([tool("read"), tool("write")]), harness))
    .toEqual({ allowed: ["read"], denied: ["write", "edit"] });
  expect(workflowNativeCeiling(resolvedTools([tool("read"), tool("write")]), resolvedTools([tool("write")]), harness))
    .toEqual({ allowed: ["write"], denied: ["read", "edit"] });
});

it.each([
  { name: "different namespace", parent: tool("write", "write", { namespace: "other" }) },
  { name: "bag-provided homonym", parent: tool("write", "write", { bag: "fixture-bag" }) },
  { name: "read-to-write widening", parent: tool("write", "read") },
  { name: "unavailable parent native tool", parent: tool("write", "write", { unavailable: "not available here" }) },
  { name: "uncontrolled parent native tool", parent: tool("write", "write", { uncontrolled: "outside hosted gate" }) },
])("does not match $name to a selected native write tool", ({ parent }) => {
  expect(workflowNativeCeiling(resolvedTools([parent]), resolvedTools([tool("write")]), harness)).toEqual({ allowed: [], denied: [...(harness.tools ?? [])] });
});

it("applies both parent and selected native bounds before intersecting allowed tools", () => {
  const all = [tool("read"), tool("write"), tool("edit")];
  expect(workflowNativeCeiling(resolvedTools(all, { tools: { deny: ["pi:write"] } }), resolvedTools(all, { tools: { deny: ["pi:edit"] } }), harness))
    .toEqual({ allowed: ["read"], denied: ["write", "edit"] });
});

it("resolves inseparable hosted native groups after the parent ceiling removes one member", () => {
  const inseparable: NativeHarness = { ...harness, modes: { hosted: { native: { controllable: ["read", "write", "edit"], inseparable: [["write", "edit"]] } } } };
  expect(workflowNativeCeiling(resolvedTools([tool("read"), tool("write")]), resolvedTools([tool("read"), tool("write"), tool("edit")]), inseparable))
    .toEqual({ allowed: ["read"], denied: ["write", "edit"] });
});

it.each(["none", "parent", "selected"] as const)("refuses an uncontrolled hosted native tool with %s bound restriction instead of claiming it is denied", restricted => {
  const uncontrollable: NativeHarness = { ...harness, modes: { hosted: { native: { controllable: ["read"], uncontrolled: { write: "hosted adapter cannot disable write" } } } } };
  const parent = resolvedTools([tool("read")], restricted === "parent" ? { tools: { deny: ["pi:write"] } } : null);
  const selected = resolvedTools([tool("read")], restricted === "selected" ? { tools: { deny: ["pi:write"] } } : null);
  expect(() => workflowNativeCeiling(parent, selected, uncontrollable)).toThrow("WorkflowNativePolicyUnsupported");
});
