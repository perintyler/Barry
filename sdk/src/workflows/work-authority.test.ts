import { expect, it } from "vitest";
import { boundFingerprint, type ApprovedBounds } from "../bounds/workflow-bounds.js";
import { validateWorkGrant, type WorkAuthority, type WorkGrant } from "./work-authority.js";
const scope = (fields: Omit<ApprovedBounds, "fingerprint">): ApprovedBounds => ({
  ...fields,
  fingerprint: boundFingerprint(fields),
});
const original = scope({
  identity: "alice",
  traits: ["reader"],
  bound: {
    files: { allow: ["/data"], deny: ["/data/private"] },
    nodes: { allow: ["local"] },
    network: { deny: ["*"] },
    bash: { deny: ["rm"] },
    tools: { deny: ["claude:Bash", "*:write"] },
  },
  tools: { "notes:read": "read" },
  contracts: { "notes:read": "a".repeat(64) },
  harness: "claude",
});
const authority: WorkAuthority = {
  namespace: {
    installation: "owner",
    principal_kind: "identity",
    principal_id: "alice",
    identity_id: "alice",
    caller_session_id: "session",
  },
  caller_ceiling: original,
  origin: { entry_point: "action-run", trigger: "invocation" },
  run_identity: "alice",
};
const grant = (effective_scope = original): WorkGrant => ({
  version: 2,
  grant_ref: "grant",
  revision: 1,
  namespace: authority.namespace,
  authorizer: "alice",
  created_by: "alice",
  approved_at: 1,
  original_caller_ceiling: original,
  effective_scope,
  definition_bounds_digest: boundFingerprint(effective_scope.bound),
  policy_revision: "policy",
});
it("preserves complete caller evidence after JSON persistence and allows narrowing", () => {
  const { fingerprint: _fingerprint, ...fields } = original;
  const narrowed = scope({
    ...fields,
    bound: { ...original.bound, nodes: { allow: [] } },
    tools: {},
    contracts: {},
  });
  expect(
    validateWorkGrant(JSON.parse(JSON.stringify(grant(narrowed))), authority).effective_scope.bound
      ?.nodes?.allow,
  ).toEqual([]);
});
it.each([
  { files: { allow: ["/data", "/other"], deny: ["/data/private"] } },
  { files: { allow: ["/data"] } },
  { nodes: { allow: ["local", "remote"] } },
  { network: { deny: [] } },
  { bash: { deny: [] } },
  { tools: { deny: [] } },
])("refuses widening any persisted bound layer: %j", (patch) => {
  const { fingerprint: _, ...fields } = original;
  expect(() =>
    validateWorkGrant(grant(scope({ ...fields, bound: { ...fields.bound, ...patch } })), authority),
  ).toThrow(/widens/);
});
it("refuses widened traits, tools, changed contracts and unsupported harness translation", () => {
  const { fingerprint: _, ...fields } = original;
  expect(() =>
    validateWorkGrant(grant(scope({ ...fields, traits: ["reader", "writer"] })), authority),
  ).toThrow(/traits/);
  expect(() =>
    validateWorkGrant(grant(scope({ ...fields, tools: { "notes:read": "write" } })), authority),
  ).toThrow(/tool contract/);
  expect(() =>
    validateWorkGrant(
      grant(scope({ ...fields, contracts: { "notes:read": "b".repeat(64) } })),
      authority,
    ),
  ).toThrow(/tool contract/);
  expect(() => validateWorkGrant(grant(scope({ ...fields, harness: "pi" })), authority)).toThrow(
    /native-tool contract/,
  );
});
it("refuses forged fingerprints, ceilings and namespace identity", () => {
  expect(() =>
    validateWorkGrant(
      { ...grant(), effective_scope: { ...original, fingerprint: "f".repeat(64) } },
      authority,
    ),
  ).toThrow(/fingerprint/);
  expect(() =>
    validateWorkGrant(
      { ...grant(), namespace: { ...authority.namespace, principal_id: "operator" } },
      authority,
    ),
  ).toThrow(/authenticated/);
});
