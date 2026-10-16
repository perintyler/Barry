/** Concrete common-work admission composition with real issuers/owner/SQLite.
 * Policy refresh is controlled; this is not HTTP, installed identity policy,
 * credential resolution or native execution qualification. No worker tick or
 * owner pump is invoked. These controls exercise the trusted issuer roles
 * wired into localCommonWork's verifier.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { approveWorkflowBounds } from "@barry-rocks/sdk/bounds";
import { WorkDelegationIssuer, WorkflowOwner, ProcessExecutor, WorkPolicyDispatcher, inspectArtifact,
  type WorkAuthority, type WorkSubmission, type DelegationKey } from "@barry-rocks/sdk/internal/workflows";
import { SqliteDatabase } from "@barry-rocks/sdk/internal/stores";
import { builtinArtifact } from "../../src/index.js";
import { localCommonWork } from "./common-work.js";

const identityIssuerName = "workflows.sessions.identity", operatorIssuerName = "workflows.runtime.operator", cliIssuerName = "workflows.cli.operator";
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  const failures: unknown[] = [];
  for (const close of cleanup.splice(0).reverse()) try { await close(); } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, "Runtime issuer fixture cleanup failed");
});

async function fixture(kind: "identity" | "operator", signerName = identityIssuerName) {
  const root = mkdtempSync(join(tmpdir(), "runtime-review-issuer-")), now = Date.now(), installation = "review-installation";
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const key = (secret: string): DelegationKey => ({ id: "key-1", secret, not_before: now - 1000, not_after: now + 600000 });
  const identityKey = key("fixture-only-runtime-identity-issuer-key-0000"), operatorKey = key("fixture-only-runtime-operator-issuer-key-0000");
  const cliKey = key("fixture-only-runtime-cli-issuer-key-00000000");
  const ring = { [identityIssuerName]: [identityKey], [operatorIssuerName]: [operatorKey], [cliIssuerName]: [cliKey] };
  const keyRingPath = join(root, "delegation-keys.json");writeFileSync(keyRingPath, JSON.stringify(ring), { mode: 0o600 });
  const scope = await approveWorkflowBounds({ ...(kind === "identity" ? { identity: "legacy-alice" } : {}), bags: [], tools: [], bounds: [], boundByName: async () => undefined });
  const refreshPrincipals: string[] = [], credentialReads: string[] = [], workerErrors: unknown[] = [];
  const common = localCommonWork({ installation, directory: root, builtin: builtinArtifact, capacity: 1, labels: {}, keyRingPath,
    // Real verifier/admission composition, controlled policy/catalog port. This
    // deliberately does not manufacture AuthPrincipal or call identity stores.
    refresh: async (_request: unknown, principal: string) => { refreshPrincipals.push(principal);return scope; },
    policy: new WorkPolicyDispatcher(async () => scope),
    resolveProcessSecrets: async () => { credentialReads.push("installation-secret-resolver");throw new Error("This fixture must not resolve credentials"); },
    checkProcessSecrets: async () => { credentialReads.push("script-secret-check");throw new Error("This fixture must not check credentials"); },
    onError: error => { workerErrors.push(error); } });
  const attachment: { value?: ReturnType<typeof common.attach> } = {};
  cleanup.push(async () => {
    const attached = attachment.value;
    if (attached) {
      try { await attached.worker.close(); } finally { attached.close(); }
    } else {
      for (const broker of common.resources.brokers.values()) broker.close();common.artifacts.close();
    }
  });
  const database = join(root, "owner.db"), artifact = inspectArtifact(builtinArtifact, "echo", "1");
  const owner = new WorkflowOwner({ id: installation, path: database, artifacts: [artifact], executor: new ProcessExecutor(),
    workArtifacts: common.artifacts, workResources: common.resources });
  cleanup.push(() => owner.close());
  const attached = common.attach(owner);attachment.value = attached;
  const admission = attached.admission;
  if (!admission || !attached.start) throw new Error("Actual common-work admission must be configured");
  const origin = kind === "identity"
    ? { entry_point: "sessions-agent-work-api", trigger: "invocation" as const, caller_session_id: "owned-session" }
    : { entry_point: signerName === cliIssuerName ? "work-cli" : "work-api", trigger: "manual" as const };
  const request: WorkSubmission = { version: 2, request_id: randomUUID(), idempotency_key: "runtime-review/" + randomUUID(), authority_ref: "runtime-review-grant",
    definition: { kind: "workflow", reference: "echo", version: "1" }, inputs: { message: "issuer authority" }, origin };
  const authority: WorkAuthority = { namespace: { installation, principal_kind: kind,
    principal_id: kind === "identity" ? "legacy-alice" : "local-operator", identity_id: kind === "identity" ? "canonical-alice-id" : null,
    caller_session_id: kind === "identity" ? "owned-session" : null }, origin, caller_ceiling: scope, run_identity: kind === "identity" ? "legacy-alice" : null };
  const signerKey = signerName === identityIssuerName ? identityKey : signerName === cliIssuerName ? cliKey : operatorKey;
  const issuer = new WorkDelegationIssuer({ path: join(root, "caller-issuer.db"), issuer: signerName, signingKey: () => signerKey });
  cleanup.push(() => issuer.close());
  issuer.register(request, authority, { kind: kind === "identity" ? "session" : "operator", definition_owner_session: kind === "identity" ? "owned-session" : null, background_parent: false });
  const credentials = issuer.issue(request, authority);
  const rows = () => { const db = new SqliteDatabase(database);try { return db.prepare("SELECT record FROM workflow_work_admissions").all() as { record: string }[]; } finally { db.close(); } };
  return { root, common, attached, admission, issuer, request, authority, credentials, rows, refreshPrincipals, credentialReads, workerErrors };
}

it("runtime issuer policy admits a legitimate selected identity without equating legacy and canonical IDs", async () => {
  const f = await fixture("identity");
  const result = await f.admission.submitWithReceipt(f.request, f.credentials);
  expect(result.created).toBe(true);expect(result.work.namespace).toEqual(f.authority.namespace);
  expect(f.rows()).toHaveLength(1);expect(f.refreshPrincipals.length).toBeGreaterThan(0);
  expect(f.refreshPrincipals.every(principal => principal === "legacy-alice")).toBe(true);
  expect(f.credentialReads).toEqual([]);expect(f.workerErrors).toEqual([]);
});

it("runtime issuer policy preserves the actual dedicated local operator start path", async () => {
  const f = await fixture("operator", operatorIssuerName);
  const result = await f.attached.start!({ version: 2, request_id: randomUUID(), idempotency_key: "legitimate-operator", definition: f.request.definition, inputs: f.request.inputs });
  expect(result.created).toBe(true);expect(result.work.namespace).toMatchObject({ principal_kind: "operator", principal_id: "local-operator", identity_id: null });
  expect(f.rows()).toHaveLength(1);expect(f.refreshPrincipals.every(principal => principal === "local-operator")).toBe(true);
  expect(f.credentialReads).toEqual([]);expect(f.workerErrors).toEqual([]);
});

it("runtime issuer policy refuses identity-signed operator work before policy refresh or owner persistence", async () => {
  const f = await fixture("operator", identityIssuerName);
  // Valid operator-shaped origin/authority and valid identity-service HMAC.
  // Existing common-work accepts it: this is the intended missing-policy red.
  await expect(f.admission.submitWithReceipt(f.request, f.credentials)).rejects.toMatchObject({ code: "InvalidDelegation", status: 403 });
  expect(f.refreshPrincipals).toEqual([]);expect(f.rows()).toEqual([]);
  expect(f.credentialReads).toEqual([]);expect(f.workerErrors).toEqual([]);
});

it("runtime issuer policy rejects a public record relabelled as another configured issuer", async () => {
  const f = await fixture("identity");
  const changed = { ...f.credentials, record: { ...f.credentials.record, issuer: operatorIssuerName } };
  await expect(f.admission.submitWithReceipt(f.request, changed)).rejects.toMatchObject({ code: "InvalidDelegation", status: 403 });
  expect(f.refreshPrincipals).toEqual([]);expect(f.rows()).toEqual([]);
  expect(f.credentialReads).toEqual([]);expect(f.workerErrors).toEqual([]);
});

it("runtime issuer policy preserves the dedicated CLI operator issuer", async () => {
  const f = await fixture("operator", cliIssuerName);
  const result = await f.admission.submitWithReceipt(f.request, f.credentials);
  expect(result.created).toBe(true);expect(result.work.namespace).toEqual(f.authority.namespace);
  expect(f.rows()).toHaveLength(1);expect(f.refreshPrincipals.every(principal => principal === "local-operator")).toBe(true);
  expect(f.credentialReads).toEqual([]);expect(f.workerErrors).toEqual([]);
});
