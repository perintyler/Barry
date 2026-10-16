import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { boundFingerprint } from "../../bounds/workflow-bounds.js";
import type { WorkOwnerConnection } from "../work-activity-worker.js";
import { workAgentProfileSchema } from "../work-agent-profile.js";
import { WorkArtifactStore, type WorkArtifactRef } from "../work-artifacts.js";
import { workGrantSchema, workPlanHash, workPlanSchema } from "../work-contracts.js";
import {
  workExecutionDelegationSchema,
  type WorkExecutionDelegation,
} from "../work-execution-delegation.js";
import {
  OwnerStoreArtifactPort,
  RemoteArtifactCoordinator,
} from "./work-remote-artifacts.js";
import type { ExecutionAccessV1, RemoteArtifactPortV1 } from "./work-remote-transport.js";

const roots: string[] = [];
const stores: WorkArtifactStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createTempRoot(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "work-remote-artifacts-test-")));
  roots.push(dir);
  return dir;
}

function mockConnection(effectAllowed = true): WorkOwnerConnection {
  return {
    advertise: async () => {},
    claim: async () => null,
    heartbeat: async () => effectAllowed,
    effect: async () => effectAllowed,
    observe: async () => ({ status: "accepted" }),
    complete: async () => ({ status: "accepted" }),
  };
}

function buildProcessDelegation(
  sourceRef: WorkArtifactRef,
  runtimeRef: WorkArtifactRef,
  now = Date.now(),
): WorkExecutionDelegation {
  const rawScope = {
    identity: "id-1",
    traits: ["work-control"],
    bound: null,
    tools: { "bash:Bash": "write" as const },
    contracts: { "bash:Bash": "b".repeat(64) },
  };
  const scope = { ...rawScope, fingerprint: boundFingerprint(rawScope) };
  const namespace = {
    installation: "owner-1",
    principal_kind: "identity" as const,
    principal_id: "actor-1",
    identity_id: "id-1",
    caller_session_id: "sess-1",
  };
  const origin = {
    entry_point: "api",
    trigger: "invocation" as const,
    caller_session_id: "sess-1",
  };
  const grant = workGrantSchema.parse({
    version: 2,
    grant_ref: "grant-1",
    revision: 1,
    namespace,
    authorizer: "actor-1",
    created_by: "actor-1",
    approved_at: now,
    original_caller_ceiling: scope,
    effective_scope: scope,
    definition_bounds_digest: "2".repeat(64),
    policy_revision: "pol-1",
  });
  const processProgram = {
    activity_type: "proc-act",
    source_digest: sourceRef.digest,
    installation: "owner-1",
    scope,
    runtime: runtimeRef,
    credential_owner: { kind: "none" as const },
    argv: [{ source: true as const }],
    source_name: "entry.js",
    cwd: { path: "/tmp", device: 1, inode: 1 },
    env: {},
    secret_names: [],
    output: "json" as const,
  };
  const plan = workPlanSchema.parse({
    version: 2,
    definition: { kind: "job", reference: "proc-act" },
    workflow: {
      type: "proc-wf",
      version: "1",
      artifact_digest: sourceRef.digest,
      runtime_abi: "v1",
      input_digest: "3".repeat(64),
    },
    source_closure: [sourceRef, runtimeRef],
    grant_ref: "grant-1",
    grant_revision: 1,
    executor_generation: "v2",
    grant_digest: boundFingerprint(grant),
    execution_profile: "portable",
    effect_policy: { class: "non-repeatable", max_attempts: 1 },
    validation: { mode: "none" },
    process_program: processProgram,
    resources: {
      executor: "process",
      lane: "unscheduled",
      logical_reservation: "logical-1",
      host_reservation: null,
      endpoint: null,
    },
    workspace: { kind: "none" },
    selection: {
      requested_model: null,
      resolved_model: null,
      endpoint: null,
      requested_harness: null,
      resolved_harness: null,
      provenance: "default",
    },
    execution_budget_ms: 60_000,
    dispatch_budget_ms: 60_000,
  });
  const planDigest = workPlanHash(plan);
  const admissionRequestHash = "1".repeat(64);
  const inputs = { arg: 1 };
  const requestHash = boundFingerprint({
    admission: admissionRequestHash,
    activity: "act-1",
    type: "proc-act",
    input: inputs,
  });

  return workExecutionDelegationSchema.parse({
    version: 1,
    admission_request_hash: admissionRequestHash,
    namespace,
    origin,
    grant,
    plan,
    start: {
      version: 2,
      owner: "owner-1",
      work_id: "work-1",
      workflow_id: "wf-1",
      activity_id: "act-1",
      attempt_id: "att-1",
      request_hash: requestHash,
      plan_digest: planDigest,
      grant_ref: "grant-1",
      grant_revision: 1,
      source: sourceRef,
      execution_fence: 1,
      deadline: now + 60_000,
      launch_authorized: true,
      inputs,
      effect_policy: plan.effect_policy,
      resources: { ...plan.resources, host_reservation: "host-1" },
      executor_generation: "v2",
      validation: { mode: "none" },
      process_program: processProgram,
      activity_type: "proc-act",
      output_identity: "id-1",
    },
  });
}

describe("work-remote-artifacts", () => {
  it("downloads and pins accepted closure artifacts into worker CAS, and stages outputs back to owner CAS", async () => {
    const root = createTempRoot();
    const ownerStore = new WorkArtifactStore(join(root, "owner-cas"));
    const workerStore = new WorkArtifactStore(join(root, "worker-cas"));
    stores.push(ownerStore, workerStore);

    const sourceBytes = Buffer.from("#!/usr/bin/env node\nconsole.log(JSON.stringify({ok:true}));\n");
    const runtimeBytes = Buffer.from("fake-runtime-binary-payload-bytes");
    const sourceRef = ownerStore.stage(sourceBytes, {
      purpose: "source",
      owner_identity: null,
      media_type: "application/octet-stream",
    });
    const runtimeRef = ownerStore.stage(runtimeBytes, {
      purpose: "source",
      owner_identity: null,
      media_type: "application/octet-stream",
    });

    const delegation = buildProcessDelegation(sourceRef, runtimeRef);
    const port = new OwnerStoreArtifactPort({ ownerStore, chunkBytes: 16 });
    const coordinator = new RemoteArtifactCoordinator({
      localArtifacts: workerStore,
      port,
      chunkBytes: 16,
    });

    const access: ExecutionAccessV1 = {
      version: 1,
      delegation,
      connection: mockConnection(true),
      signal: new AbortController().signal,
    };

    const resolved = await coordinator.ensureExecutionClosure(access);
    expect(resolved.get(sourceRef.digest)?.equals(sourceBytes)).toBe(true);
    expect(resolved.get(runtimeRef.digest)?.equals(runtimeBytes)).toBe(true);
    expect(workerStore.verify(sourceRef).equals(sourceBytes)).toBe(true);
    expect(workerStore.verify(runtimeRef).equals(runtimeBytes)).toBe(true);

    // Even when cached in worker CAS, online authority is still required on subsequent access
    const fencedAccess: ExecutionAccessV1 = {
      version: 1,
      delegation,
      connection: mockConnection(false),
      signal: new AbortController().signal,
    };
    await expect(coordinator.ensureLocalArtifact(fencedAccess, sourceRef)).rejects.toThrow(
      /Online owner rejected/,
    );

    // Stage output artifact from worker to owner
    const outputBytes = Buffer.from(JSON.stringify({ status: "done" }));
    const stagedRef = await coordinator.stageExecutionArtifact(
      access,
      "execution",
      outputBytes,
      {
        purpose: "output",
        mediaType: "application/json",
      },
    );
    expect(ownerStore.verify(stagedRef).equals(outputBytes)).toBe(true);
    expect(workerStore.verify(stagedRef).equals(outputBytes)).toBe(true);
    expect(stagedRef.owner_identity).toBe("id-1");
  });

  it("does not publish partial or corrupted downloads into worker CAS on mid-stream abort", async () => {
    const root = createTempRoot();
    const ownerStore = new WorkArtifactStore(join(root, "owner-cas"));
    const workerStore = new WorkArtifactStore(join(root, "worker-cas"));
    stores.push(ownerStore, workerStore);

    const sourceBytes = Buffer.alloc(65536, "X");
    const sourceRef = ownerStore.stage(sourceBytes, {
      purpose: "source",
      owner_identity: null,
      media_type: "application/octet-stream",
    });
    const delegation = buildProcessDelegation(sourceRef, sourceRef);
    const abortController = new AbortController();

    const abortingPort: RemoteArtifactPortV1 = {
      async *download() {
        yield sourceBytes.subarray(0, 1024);
        abortController.abort();
        yield sourceBytes.subarray(1024, 2048);
      },
      async stage() {
        throw new Error("not used");
      },
    };

    const coordinator = new RemoteArtifactCoordinator({
      localArtifacts: workerStore,
      port: abortingPort,
    });
    const access: ExecutionAccessV1 = {
      version: 1,
      delegation,
      connection: mockConnection(true),
      signal: abortController.signal,
    };

    await expect(coordinator.ensureLocalArtifact(access, sourceRef)).rejects.toThrow(/aborted/);
    expect(() => workerStore.verify(sourceRef)).toThrow();
  });

  it("resolves structured-agent profile and all nested runtime chunks via verifyWorkAgentProfile", async () => {
    const root = createTempRoot();
    const ownerStore = new WorkArtifactStore(join(root, "owner-cas"));
    const workerStore = new WorkArtifactStore(join(root, "worker-cas"));
    stores.push(ownerStore, workerStore);

    const chunk1Bytes = Buffer.from("pi-runtime-chunk-1");
    const chunk1Ref = ownerStore.stage(chunk1Bytes, {
      purpose: "source",
      owner_identity: null,
      media_type: "application/octet-stream",
    });
    const manifestObj = {
      version: 2,
      protocol: 1,
      harness: "pi",
      chunks: [{ digest: chunk1Ref.digest, bytes: chunk1Ref.bytes }],
      files: [
        { path: "a", storage: { chunk: chunk1Ref.digest } },
        { path: "b", storage: { chunk: chunk1Ref.digest } },
        { path: "c", storage: { chunk: chunk1Ref.digest } },
        { path: "d", storage: { chunk: chunk1Ref.digest } },
      ],
    };
    const manifestBytes = Buffer.from(JSON.stringify(manifestObj), "utf8");
    const manifestRef = ownerStore.stage(manifestBytes, {
      purpose: "source",
      owner_identity: null,
      media_type: "application/octet-stream",
    });

    const profileObj = workAgentProfileSchema.parse({
      version: 1,
      installation: "owner-1",
      reference: "bag:agent",
      title: "Test Agent",
      harness: "pi",
      model: "openai/gpt",
      endpoint: "http://127.0.0.1:4200/v1",
      generation: "00000000-0000-4000-8000-000000000001",
      record_hash: "a".repeat(64),
      runtime: {
        version: 1,
        digest: manifestRef.digest,
        bytes: manifestRef.bytes,
        protocol: 1,
      },
      provider: {},
      cwd: { path: "/tmp", device: 1, inode: 1 },
      validation: { mode: "none" },
      prompt: "Say hello",
      max_turns: 1,
      execution_budget_ms: 60_000,
      budget_policy: "reservation-only",
      endpoint_resource: "ep-1",
      max_input_tokens: 1000,
      max_output_tokens: 4096,
      max_cost: 0.1,
      sources: [manifestRef, chunk1Ref],
    });
    const profileRef = ownerStore.stage(Buffer.from(JSON.stringify(profileObj), "utf8"), {
      purpose: "source",
      owner_identity: null,
      media_type: "application/json",
    });

    const now = Date.now();
    const rawScope = {
      identity: "id-1",
      traits: ["work-control"],
      bound: null,
      tools: {},
    };
    const scope = { ...rawScope, fingerprint: boundFingerprint(rawScope) };
    const namespace = {
      installation: "owner-1",
      principal_kind: "identity" as const,
      principal_id: "actor-1",
      identity_id: "id-1",
      caller_session_id: "sess-1",
    };
    const origin = {
      entry_point: "api",
      trigger: "invocation" as const,
      caller_session_id: "sess-1",
    };
    const grant = workGrantSchema.parse({
      version: 2,
      grant_ref: "grant-1",
      revision: 1,
      namespace,
      authorizer: "actor-1",
      created_by: "actor-1",
      approved_at: now,
      original_caller_ceiling: scope,
      effective_scope: scope,
      definition_bounds_digest: "2".repeat(64),
      policy_revision: "pol-1",
    });
    const agentProgram = {
      activity_type: `agents:${profileRef.digest}@1`,
      source_digest: profileRef.digest,
      installation: "owner-1",
      scope,
      profile: profileRef,
    };
    const plan = workPlanSchema.parse({
      version: 2,
      definition: { kind: "action", reference: "bag:agent", catalog_namespace: "bag" },
      workflow: {
        type: "agent-wf",
        version: "1",
        artifact_digest: profileRef.digest,
        runtime_abi: "v1",
        input_digest: "3".repeat(64),
      },
      source_closure: [profileRef],
      grant_ref: "grant-1",
      grant_revision: 1,
      executor_generation: "v2",
      grant_digest: boundFingerprint(grant),
      execution_profile: "portable",
      effect_policy: { class: "non-repeatable", max_attempts: 1 },
      validation: { mode: "none" },
      agent_program: agentProgram,
      resources: {
        executor: "agent",
        lane: "unscheduled",
        logical_reservation: "logical-1",
        host_reservation: null,
        endpoint: {
          broker: "broker-1",
          endpoint: "ep-1",
          reservation: null,
          model: "openai/gpt",
          max_input_tokens: 1000,
          max_output_tokens: 4096,
          max_cost: 0.1,
        },
      },
      workspace: { kind: "none" },
      selection: {
        requested_model: "openai/gpt",
        resolved_model: "openai/gpt",
        endpoint: "ep-1",
        requested_harness: "pi",
        resolved_harness: "pi",
        provenance: "profile",
      },
      execution_budget_ms: 60_000,
      dispatch_budget_ms: 60_000,
    });
    const planDigest = workPlanHash(plan);
    const admissionRequestHash = "4".repeat(64);
    const inputs = {};
    const requestHash = boundFingerprint({
      admission: admissionRequestHash,
      activity: "act-1",
      type: agentProgram.activity_type,
      input: inputs,
    });
    const delegation = workExecutionDelegationSchema.parse({
      version: 1,
      admission_request_hash: admissionRequestHash,
      namespace,
      origin,
      grant,
      plan,
      start: {
        version: 2,
        owner: "owner-1",
        work_id: "work-1",
        workflow_id: "wf-1",
        activity_id: "act-1",
        attempt_id: "att-1",
        request_hash: requestHash,
        plan_digest: planDigest,
        grant_ref: "grant-1",
        grant_revision: 1,
        source: profileRef,
        execution_fence: 1,
        deadline: now + 60_000,
        launch_authorized: true,
        inputs,
        effect_policy: plan.effect_policy,
        resources: {
          ...plan.resources,
          host_reservation: "host-1",
          endpoint: { ...plan.resources.endpoint!, reservation: "ep-res-1" },
        },
        executor_generation: "v2",
        validation: { mode: "none" },
        agent_program: agentProgram,
        activity_type: agentProgram.activity_type,
        output_identity: "id-1",
      },
    });

    const port = new OwnerStoreArtifactPort({
      ownerStore,
      supplementalClosure: [manifestRef, chunk1Ref],
    });
    const coordinator = new RemoteArtifactCoordinator({
      localArtifacts: workerStore,
      port,
    });
    const access: ExecutionAccessV1 = {
      version: 1,
      delegation,
      connection: mockConnection(true),
      signal: new AbortController().signal,
    };

    const resolved = await coordinator.ensureExecutionClosure(access);
    expect(resolved.has(profileRef.digest)).toBe(true);
    expect(resolved.has(manifestRef.digest)).toBe(true);
    expect(resolved.has(chunk1Ref.digest)).toBe(true);
    expect(workerStore.verify(chunk1Ref).equals(chunk1Bytes)).toBe(true);
  });
});
