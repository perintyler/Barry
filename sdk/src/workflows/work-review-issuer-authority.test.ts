/** Desired issuer-role contract from review F3; not an HTTP/runtime reproduction.
 * Uses real persisted issuers and verifier with the concrete installation issuer
 * names/key lookup and an explicit trusted issuer-role policy. Production
 * composition is covered separately by the runtime regression. Do not implement
 * this by equating legacy principal names with canonical identity IDs.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { approveWorkflowBounds } from "../bounds/workflow-bounds.js";
import { WorkDelegationIssuer, WorkDelegationVerifier, type DelegationKey } from "./work-delegation.js";
import type { WorkAuthority } from "./work-authority.js";
import type { WorkSubmission } from "./work-contracts.js";

const identityIssuer = "workflows.sessions.identity", operatorIssuer = "workflows.runtime.operator";
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

async function fixture(kind: "identity" | "operator", signer = kind === "identity" ? identityIssuer : operatorIssuer, wrongKey = false) {
  const root = mkdtempSync(join(tmpdir(), "work-review-issuer-authority-")), now = Date.now();
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const key = (secret: string): DelegationKey => ({ id: "key-1", secret, not_before: now - 1000, not_after: now + 600000 });
  const identityKey = key("fixture-only-identity-issuer-key-0000000000"), operatorKey = key("fixture-only-operator-issuer-key-0000000000");
  const keys: Record<string, DelegationKey[]> = { [identityIssuer]: [identityKey], [operatorIssuer]: [operatorKey] };
  const scope = await approveWorkflowBounds({ ...(kind === "identity" ? { identity: "legacy-alice" } : {}), traitNames: [], traits: {}, tools: [], bounds: [], boundByName: async () => undefined });
  const origin = kind === "identity"
    ? { entry_point: "sessions-agent-work-api", trigger: "invocation" as const, caller_session_id: "owned-session" }
    : { entry_point: "work-api", trigger: "manual" as const };
  const request: WorkSubmission = { version: 2, request_id: randomUUID(), idempotency_key: "review/" + randomUUID(), authority_ref: "review-grant",
    definition: { kind: "workflow", reference: "echo", version: "1" }, inputs: { message: "issuer contract" }, origin };
  const authority: WorkAuthority = { namespace: { installation: "review-installation", principal_kind: kind,
    principal_id: kind === "identity" ? "legacy-alice" : "local-operator", identity_id: kind === "identity" ? "canonical-alice-id" : null,
    caller_session_id: kind === "identity" ? "owned-session" : null }, origin, caller_ceiling: scope, run_identity: kind === "identity" ? "legacy-alice" : null };
  const issuer = new WorkDelegationIssuer({ path: join(root, "issuer.db"), issuer: signer, now: () => now,
    signingKey: () => wrongKey ? operatorKey : keys[signer]![0]! });
  cleanup.push(() => issuer.close());
  issuer.register(request, authority, { kind: kind === "identity" ? "session" : "operator", definition_owner_session: kind === "identity" ? "owned-session" : null, background_parent: false });
  let policyReads = 0;
  const verifier = new WorkDelegationVerifier({ installation: "review-installation", now: () => now,
    keys: name => Object.hasOwn(keys, name) ? keys[name]! : [],
    authorizeIssuer: record => record.issuer === identityIssuer
      ? record.source_kind === "session" && record.authority.namespace.principal_kind === "identity"
      : record.issuer === operatorIssuer && record.source_kind === "operator" && record.authority.namespace.principal_kind === "operator",
    currentPolicy: async () => { policyReads++;return scope; } });
  const verifierWithPolicy = (authorizeIssuer: ConstructorParameters<typeof WorkDelegationVerifier>[0]["authorizeIssuer"] | undefined,
    currentPolicy: ConstructorParameters<typeof WorkDelegationVerifier>[0]["currentPolicy"] = async () => authority.caller_ceiling) => new WorkDelegationVerifier({ installation: "review-installation", now: () => now,
      keys: name => Object.hasOwn(keys, name) ? keys[name]! : [],
      // Exercise missing policy from a JS/untyped consumer as a runtime refusal.
      authorizeIssuer: authorizeIssuer!, currentPolicy });
  return { request, authority, issuer, verifier, verifierWithPolicy, credentials: issuer.issue(request, authority), get policyReads() { return policyReads; } };
}

it("issuer principal policy preserves a legitimate identity with distinct legacy and canonical IDs", async () => {
  const f = await fixture("identity");
  const authenticated = await f.verifier.authenticate(f.request, f.credentials, "admit");
  expect(authenticated.namespace).toEqual(f.authority.namespace);
  expect(authenticated.run_identity).toBe("legacy-alice");
  expect(authenticated.delegation?.issuer).toBe(identityIssuer);expect(f.policyReads).toBe(1);
});

it("issuer principal policy preserves the dedicated operator issuer", async () => {
  const f = await fixture("operator");
  const authenticated = await f.verifier.authenticate(f.request, f.credentials, "admit");
  expect(authenticated.namespace).toEqual(f.authority.namespace);
  expect(authenticated.delegation?.issuer).toBe(operatorIssuer);expect(f.policyReads).toBe(1);
});

it.each(["lookup", "admit"] as const)("issuer principal policy refuses an identity issuer asserting operator authority during %s", async operation => {
  const f = await fixture("operator", identityIssuer);
  // Valid HMAC, audience, origin, record and intent. Signer role is the only
  // intended refusal: issuer role must be checked before current caller policy.
  await expect(f.verifier.authenticate(f.request, f.credentials, operation)).rejects.toMatchObject({ code: "InvalidDelegation", status: 403 });
  expect(f.policyReads).toBe(0);
});

it("issuer principal policy rejects another configured issuer's key despite a matching key ID", async () => {
  const f = await fixture("identity", identityIssuer, true);
  await expect(f.verifier.authenticate(f.request, f.credentials, "admit")).rejects.toMatchObject({ code: "InvalidDelegation", status: 403 });
  expect(f.policyReads).toBe(0);
});

it("issuer principal policy rejects substituting another configured issuer in public retained evidence", async () => {
  const f = await fixture("identity");
  const changed = { ...f.credentials, record: { ...f.credentials.record, issuer: operatorIssuer } };
  await expect(f.verifier.authenticate(f.request, changed, "admit")).rejects.toMatchObject({ code: "InvalidDelegation", status: 403 });
  expect(f.policyReads).toBe(0);
});

it.each(["missing", "false", "throw"] as const)("fails closed for a %s trusted issuer policy", async kind => {
  const f = await fixture("identity");let reads = 0;
  const policy = kind === "missing" ? undefined : kind === "false" ? () => false : () => { throw new Error("private policy detail"); };
  const verifier = f.verifierWithPolicy(policy, async () => { reads++;return f.authority.caller_ceiling; });
  await expect(verifier.authenticate(f.request, f.credentials, "admit")).rejects.toMatchObject({ code: "InvalidDelegation", status: 403,
    message: "Delegation issuer is not authorized for this principal or source." });
  expect(reads).toBe(0);
});

it("rechecks trusted issuer permission after asynchronous current policy evaluation", async () => {
  const f = await fixture("identity");let allowed = true, reads = 0;
  const verifier = f.verifierWithPolicy(() => allowed, async () => { await Promise.resolve();allowed = false;reads++;return f.authority.caller_ceiling; });
  await expect(verifier.authenticate(f.request, f.credentials, "admit")).rejects.toMatchObject({ code: "InvalidDelegation", status: 403 });
  expect(reads).toBe(1);
});

it("does not let policy callbacks rewrite authenticated issuer or caller evidence", async () => {
  const f = await fixture("identity");
  const verifier = f.verifierWithPolicy(record => {
    record.authority.namespace.principal_id = "rewritten-by-role-policy";return true;
  }, async record => {
    record.authority.namespace.principal_id = "rewritten-by-current-policy";return f.authority.caller_ceiling;
  });
  const result = await verifier.authenticate(f.request, f.credentials, "admit");
  expect(result.namespace).toEqual(f.authority.namespace);
  expect(result.delegation?.issuer).toBe(identityIssuer);
  expect(result.delegation?.evidence).toEqual(f.credentials.record);
});
