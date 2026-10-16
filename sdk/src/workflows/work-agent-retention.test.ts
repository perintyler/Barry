import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { approveWorkflowBounds, boundFingerprint } from "../bounds/workflow-bounds.js";
import { SqliteDatabase } from "../stores/sqlite-connection.js";
import { inspectArtifact } from "./artifacts.js";
import { ProcessExecutor } from "./executor.js";
import { WorkAdmissionService, type WorkResolution } from "./work-admission.js";
import type { WorkAuthority } from "./work-authority.js";
import { WorkArtifactStore } from "./work-artifacts.js";
import { importWorkAgentCatalog, type WorkAgentCatalog, type WorkAgentProfile } from "./work-agent-profile.js";
import { retainedWorkAgents, retainedWorkAgentCatalogs } from "./work-agent-retention.js";
import { WorkflowOwner } from "./workflow-owner.js";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const metadata = { owner_identity: null, purpose: "source" as const, media_type: "application/octet-stream" };
/** Archive/store qualification only. Trusted test authentication/resolution feed
 * actual WorkAdmissionService/owner acceptance; no native/model/grant issuer
 * authentication or executor receipt is claimed by this fixture. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "retained-work-agents-"));cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const from = new WorkArtifactStore(join(root, "producer")), artifacts = new WorkArtifactStore(join(root, "owner-artifacts"));
  cleanup.push(() => { artifacts.close();from.close(); });
  const path = join(root, "owner.db"), wrapperPath = fileURLToPath(new URL("./execution-fixture.mjs", import.meta.url));
  const wrapper = inspectArtifact(wrapperPath, "echo", "1"), wrapperSource = artifacts.stage(readFileSync(wrapperPath), { ...metadata, media_type: "text/javascript" });
  const scope = await approveWorkflowBounds({ identity: "alice", traitNames: [], traits: {}, tools: [], boundByName: async () => undefined });
  const owner = new WorkflowOwner({ id: "installation", path, artifacts: [wrapper], activityArtifacts: {}, executor: new ProcessExecutor(), workArtifacts: artifacts, authorizeWork: () => scope });
  cleanup.push(() => owner.close());
  const chunks = [from.stage(Buffer.from("retained runtime chunk"), metadata)];
  const runtime = from.stage(Buffer.from(JSON.stringify({ version: 2, protocol: 1, harness: "pi", chunks: chunks.map(({ digest, bytes }) => ({ digest, bytes })),
    files: Array.from({ length: 4 }, () => ({ storage: { chunk: chunks[0].digest } })) })), metadata);
  const make = (title: string) => {
    const profile: WorkAgentProfile = { version: 1, installation: "installation", reference: "fixture:agent", title, harness: "pi", model: "fixture/model", endpoint: "http://127.0.0.1:12345/v1",
      generation: randomUUID(), record_hash: "a".repeat(64), runtime: { version: 1, protocol: 1, digest: runtime.digest, bytes: runtime.bytes }, provider: {},
      cwd: { path: root, device: 1, inode: 1 }, validation: { mode: "none" }, prompt: "A retained tool-free prompt", max_turns: 1, execution_budget_ms: 1000,
      budget_policy: "reservation-only", endpoint_resource: "endpoint", max_input_tokens: 100, max_output_tokens: 4096, max_cost: 0, sources: [runtime, ...chunks] };
    const source = from.stage(Buffer.from(JSON.stringify(profile)), metadata);
    const catalog: WorkAgentCatalog = { version: 1, installation: "installation", worker_id: randomUUID(), artifact_root: from.root,
      endpoint_broker: { id: "broker", path: join(root, "endpoint.db"), limits: { endpoint: { kind: "endpoint", concurrency: 1, input_tokens: 1000, output_tokens: 8192, cost_micros: 1000 } } }, profiles: [source] };
    const catalogPath = join(root, "current-catalog.json");writeFileSync(catalogPath, JSON.stringify(catalog));
    return { agent: importWorkAgentCatalog(catalog, from, artifacts)[0], catalogPath, catalog };
  };
  const admit = async (agent: ReturnType<typeof make>["agent"], key: string, deployment?: WorkAgentCatalog, additional?: WorkAgentCatalog) => {
    const deployments = [deployment, additional].filter((value): value is WorkAgentCatalog => value !== undefined).map(value => artifacts.stage(Buffer.from(JSON.stringify(value)),
      { ...metadata, media_type: "application/vnd.barry.agent-deployment+json" }));
    const namespace = { installation: "installation", principal_kind: "identity" as const, principal_id: "alice", identity_id: "alice", caller_session_id: null };
    const origin = { entry_point: "archive-spec", trigger: "manual" as const };
    const authority: WorkAuthority = { namespace, caller_ceiling: scope, run_identity: "alice", origin };
    const grant = { version: 2 as const, grant_ref: randomUUID(), revision: 1, namespace, authorizer: "alice", created_by: "alice", approved_at: Date.now(),
      original_caller_ceiling: scope, effective_scope: scope, definition_bounds_digest: boundFingerprint(scope.bound), policy_revision: "test-catalog" };
    const service = new WorkAdmissionService({ owner, authenticate: async () => authority, resolve: async (): Promise<WorkResolution> => ({ title: agent.profile.title, grant, workflow_input: {}, plan: {
      version: 2, definition: { kind: "action", reference: "fixture:agent", catalog_namespace: "fixture" },
      workflow: { type: "echo", version: "1", artifact_digest: wrapper.digest, runtime_abi: wrapper.abi, input_digest: boundFingerprint({}) },
      source_closure: [wrapperSource, ...agent.sources, ...deployments], grant_ref: grant.grant_ref, grant_revision: 1, grant_digest: boundFingerprint(grant), executor_generation: "sessions-v1",
      execution_profile: "portable", effect_policy: { class: "non-repeatable", max_attempts: 1 }, validation: { mode: "none" },
      agent_program: { activity_type: "agent:" + agent.source.digest, source_digest: agent.source.digest, installation: "installation", scope, profile: agent.source },
      resources: { executor: "agent", lane: "unscheduled", logical_reservation: "owner-assigned", host_reservation: null, endpoint: deployment ? { broker: deployment.endpoint_broker.id, endpoint: agent.profile.endpoint_resource, reservation: null,
        model: agent.profile.model, max_input_tokens: agent.profile.max_input_tokens, max_output_tokens: agent.profile.max_output_tokens, max_cost: agent.profile.max_cost } : null }, workspace: { kind: "none" },
      selection: { requested_model: null, resolved_model: "fixture/model", endpoint: agent.profile.endpoint, requested_harness: null, resolved_harness: "pi", provenance: "test-catalog" }, execution_budget_ms: 1000, dispatch_budget_ms: 1000,
    } }) });
    return (await service.submit({ version: 2, request_id: randomUUID(), idempotency_key: key, authority_ref: "trusted-fixture", definition: { kind: "action", reference: "fixture:agent", catalog_namespace: "fixture" }, inputs: {}, origin }, "trusted-fixture"));
  };
  return { root, path, owner, from, artifacts, chunks, runtime, make, admit };
}

it("does not create a missing owner store and ignores an existing unrelated database", async () => {
  const f = await fixture(), absent = join(f.root, "absent.db"), unrelated = join(f.root, "other.db");
  expect(retainedWorkAgents(absent, f.artifacts)).toEqual([]);expect(existsSync(absent)).toBe(false);
  const db = new SqliteDatabase(unrelated);db.exec("CREATE TABLE unrelated(id TEXT)");db.close();
  expect(retainedWorkAgents(unrelated, f.artifacts)).toEqual([]);
});

it("restores distinct accepted versions after catalog removal and deduplicates repeated admissions", async () => {
  const f = await fixture(), first = f.make("First"), second = f.make("Replacement");
  const old = await f.admit(first.agent, "old"), duplicate = await f.admit(first.agent, "duplicate-profile"), replacement = await f.admit(second.agent, "new");
  rmSync(second.catalogPath);f.owner.cancel(old.workflow_id);
  expect(retainedWorkAgents(f.path, f.artifacts).map(item => item.source.digest).sort()).toEqual([first.agent.source.digest, second.agent.source.digest].sort());
  // Another old-profile admission is still running, so it remains advertised.
  expect(retainedWorkAgents(f.path, f.artifacts, true)).toHaveLength(2);
  f.owner.cancel(duplicate.workflow_id);f.owner.cancel(replacement.workflow_id);
  expect(retainedWorkAgents(f.path, f.artifacts, true)).toEqual([]);
  expect(retainedWorkAgents(f.path, f.artifacts)).toHaveLength(2);
});

it("restores a lost public chunk link from actual executor custody and refuses corrupted retained bytes", async () => {
  const f = await fixture(), current = f.make("Accepted");await f.admit(current.agent, "accepted");
  const chunk = f.chunks[0], original = f.artifacts.verify(chunk), publicPath = f.artifacts.path(chunk);
  const namespace = createHash("sha256").update(JSON.stringify(chunk.owner_identity)).digest("hex");
  const pinPath = join(f.artifacts.root, ".executor-retained", namespace, chunk.digest);
  expect(statSync(pinPath).ino).toBe(statSync(publicPath).ino);
  rmSync(publicPath);expect(existsSync(publicPath)).toBe(false);
  expect(retainedWorkAgents(f.path, f.artifacts, true).map(agent => agent.source)).toEqual([current.agent.source]);
  expect(existsSync(publicPath)).toBe(true);
  expect(readFileSync(publicPath).equals(original)).toBe(true);
  // Explicit corruption of the isolated retained inode, not merely unlinking
  // the public alias: verify must reject the same-length digest mismatch.
  rmSync(publicPath);writeFileSync(pinPath, Buffer.alloc(chunk.bytes, 0));
  expect(() => retainedWorkAgents(f.path, f.artifacts, true)).toThrow();
});

it.each(["missing-accepted-chunk", "conflicting-shared-reference"] as const)("rejects a structurally valid corrupted archive: %s", async corruption => {
  const f = await fixture(), current = f.make("Accepted");
  await f.admit(current.agent, "first");const second = await f.admit(current.agent, "second");
  // Explicit persisted-record corruption, not a fabricated admission/grant.
  // The plan hash is recomputed to exercise custody checks beyond hash parsing.
  const record = structuredClone(second);
  if (corruption === "missing-accepted-chunk") record.plan.source_closure = record.plan.source_closure.filter(reference => reference.digest !== f.chunks[0].digest);
  else record.plan.source_closure[0] = { ...record.plan.source_closure[0], media_type: "application/changed-metadata" };
  const { workPlanHash } = await import("./work-contracts.js");
  record.plan_digest = workPlanHash(record.plan);
  const db = new SqliteDatabase(f.path);
  try {
    expect(() => db.prepare("UPDATE workflow_work_admissions SET record=? WHERE run_id=?").run(JSON.stringify(record), record.workflow_id)).toThrow(/immutable/);
  } finally { db.close(); }
  expect(retainedWorkAgents(f.path, f.artifacts)).toHaveLength(1);
  // A separate untrusted inspection archive contains corrupted serialized rows.
  // It is not an authoritative owner or an alternate admission writer. Keep
  // the real owner's immutable trigger intact while testing read-side refusal.
  const archivePath = join(f.root, "untrusted-inspection.db"), archive = new SqliteDatabase(archivePath);
  try {
    archive.exec("CREATE TABLE workflow_work_admissions(run_id TEXT PRIMARY KEY,record TEXT NOT NULL)");
    archive.prepare("INSERT INTO workflow_work_admissions(run_id,record) VALUES(?,?)").run(second.workflow_id, JSON.stringify(second));
    archive.prepare("INSERT INTO workflow_work_admissions(run_id,record) VALUES(?,?)").run("corrupt-record", JSON.stringify(record));
  } finally { archive.close(); }
  expect(() => retainedWorkAgents(archivePath, f.artifacts)).toThrow(/RetainedWorkAgent(Binding|Artifact)Conflict/);
});


it("restores exact accepted worker and endpoint deployment after mutable configuration removal", async () => {
  const f = await fixture(), first = f.make("First"), second = f.make("Replacement");
  await f.admit(first.agent, "old", first.catalog);await f.admit(first.agent, "same-deployment", first.catalog);
  await f.admit(second.agent, "new", second.catalog);rmSync(second.catalogPath);
  expect(retainedWorkAgentCatalogs(f.path, f.artifacts).sort((a, b) => a.worker_id.localeCompare(b.worker_id)))
    .toEqual([first.catalog, second.catalog].sort((a, b) => a.worker_id.localeCompare(b.worker_id)));
});

it("refuses accepted agents lacking exactly one explicit retained deployment artifact", async () => {
  const f = await fixture(), current = f.make("Accepted");await f.admit(current.agent, "without-deployment");
  expect(() => retainedWorkAgentCatalogs(f.path, f.artifacts)).toThrow("RetainedWorkAgentDeploymentMissing");
});

it.each(["installation", "profile", "endpoint", "multiple"] as const)("refuses accepted deployment %s mismatch", async mismatch => {
  const f = await fixture(), current = f.make("Accepted"), altered = structuredClone(current.catalog);
  if (mismatch === "installation") altered.installation = "foreign-installation";
  if (mismatch === "profile") altered.profiles = [f.make("Other profile").agent.source];
  if (mismatch === "endpoint") altered.endpoint_broker.limits = { another: { kind: "endpoint", concurrency: 1, input_tokens: 1000, output_tokens: 8192, cost_micros: 1000 } };
  if (mismatch === "multiple") altered.worker_id = randomUUID();
  await f.admit(current.agent, "corrupt-deployment", mismatch === "multiple" ? current.catalog : altered, mismatch === "multiple" ? altered : undefined);
  expect(() => retainedWorkAgentCatalogs(f.path, f.artifacts)).toThrow(/RetainedWorkAgentDeployment(Missing|Conflict)/);
});
