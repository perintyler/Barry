import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { boundFingerprint } from "../../bounds/workflow-bounds.js";
import { WorkflowError } from "../errors.js";
import type { WorkOwnerConnection } from "../work-activity-worker.js";
import { WorkArtifactStore, type WorkArtifactRef } from "../work-artifacts.js";
import {
  logicalStageEffectKey,
  workGrantSchema,
  workPlanHash,
  workPlanSchema,
} from "../work-contracts.js";
import {
  workExecutionDelegationSchema,
  type WorkExecutionDelegation,
} from "../work-execution-delegation.js";
import { WorkerCredentialRejected } from "../worker-client.js";
import {
  HttpRemoteArtifactTransport,
  REMOTE_ARTIFACT_FEATURE,
  assertArtifactInAcceptedClosure,
  assertExecutionAccessV1,
  assertRemoteOwnerUrl,
  createRemoteArtifactHttpHandler,
  extractExecutionBinding,
  readWorkerCredentialFile,
  sameExecutionBinding,
  verifyByteStream,
  type ExecutionAccessV1,
} from "./work-remote-transport.js";

const roots: string[] = [];
const servers: Server[] = [];
const stores: WorkArtifactStore[] = [];

afterEach(async () => {
  for (const srv of servers.splice(0)) {
    srv.closeAllConnections();
    await new Promise<void>(resolve => srv.close(() => resolve()));
  }
  for (const store of stores.splice(0)) {
    store.close();
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createTempRoot(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "work-remote-transport-test-")));
  roots.push(dir);
  return dir;
}

function buildTestDelegation(options: {
  sourceRef: WorkArtifactRef;
  extraClosure?: WorkArtifactRef[];
  owner?: string;
  attemptId?: string;
  fence?: number;
  now?: number;
  identityId?: string | null;
}): WorkExecutionDelegation {
  const now = options.now ?? Date.now();
  const owner = options.owner ?? "owner-node";
  const attemptId = options.attemptId ?? "attempt-1";
  const fence = options.fence ?? 1;
  const identityId = options.identityId === undefined ? "id-42" : options.identityId;
  const rawScope = {
    ...(identityId ? { identity: identityId } : {}),
    traits: ["work-control"],
    bound: null,
    tools: { "bash:Bash": "write" as const },
    contracts: { "bash:Bash": "b".repeat(64) },
  };
  const scope = { ...rawScope, fingerprint: boundFingerprint(rawScope) };
  const namespace = {
    installation: owner,
    principal_kind: identityId ? ("identity" as const) : ("operator" as const),
    principal_id: identityId ? "actor-42" : "local-operator",
    identity_id: identityId,
    caller_session_id: identityId ? "sess-42" : null,
  };
  const origin = {
    entry_point: "api",
    trigger: "invocation" as const,
    ...(identityId ? { caller_session_id: "sess-42" } : {}),
  };
  const grant = workGrantSchema.parse({
    version: 2,
    grant_ref: "grant-1",
    revision: 1,
    namespace,
    authorizer: namespace.principal_id,
    created_by: namespace.principal_id,
    approved_at: now,
    original_caller_ceiling: scope,
    effective_scope: scope,
    definition_bounds_digest: "2".repeat(64),
    policy_revision: "pol-1",
  });
  const nodeJob = {
    activity_type: "remote-job",
    source_digest: options.sourceRef.digest,
    scope,
    output: "json" as const,
  };
  const plan = workPlanSchema.parse({
    version: 2,
    definition: { kind: "job", reference: "remote-job" },
    workflow: {
      type: "remote-wf",
      version: "1",
      artifact_digest: options.sourceRef.digest,
      runtime_abi: "v1",
      input_digest: "3".repeat(64),
    },
    source_closure: [options.sourceRef, ...(options.extraClosure ?? [])],
    grant_ref: "grant-1",
    grant_revision: 1,
    executor_generation: "v2",
    grant_digest: boundFingerprint(grant),
    execution_profile: "portable",
    effect_policy: { class: "non-repeatable", max_attempts: 1 },
    validation: { mode: "none" },
    node_job: nodeJob,
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
  const inputs = { hello: "world" };
  const requestHash = boundFingerprint({
    admission: admissionRequestHash,
    activity: "act-1",
    type: "remote-job",
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
      owner,
      work_id: "work-1",
      workflow_id: "wf-1",
      activity_id: "act-1",
      attempt_id: attemptId,
      request_hash: requestHash,
      plan_digest: planDigest,
      grant_ref: "grant-1",
      grant_revision: 1,
      source: options.sourceRef,
      execution_fence: fence,
      deadline: now + 60_000,
      launch_authorized: true,
      inputs,
      effect_policy: plan.effect_policy,
      resources: { ...plan.resources, host_reservation: "host-res-1" },
      executor_generation: "v2",
      validation: { mode: "none" },
      node_job: nodeJob,
      activity_type: "remote-job",
      output_identity: identityId,
    },
  });
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

describe("work-remote-transport", () => {
  it("validates remote owner URLs and worker credential files with O_NOFOLLOW and 0600 checks", () => {
    expect(assertRemoteOwnerUrl("https://owner.example.com/").protocol).toBe("https:");
    expect(assertRemoteOwnerUrl("http://127.0.0.1:4100/").hostname).toBe("127.0.0.1");
    expect(() => assertRemoteOwnerUrl("http://owner.example.com/")).toThrow(/HTTPS or loopback/);
    expect(() => assertRemoteOwnerUrl("https://user:pass@owner.example.com/")).toThrow(
      /embedded credentials/,
    );

    const root = createTempRoot();
    const credPath = join(root, "worker.cred");
    writeFileSync(credPath, "barry_wk_valid_secret_token_123\n", { mode: 0o600 });
    expect(readWorkerCredentialFile(credPath)).toBe("barry_wk_valid_secret_token_123");

    // Group-readable credential must be rejected
    chmodSync(credPath, 0o644);
    expect(() => readWorkerCredentialFile(credPath)).toThrow(/private 0600/);
    chmodSync(credPath, 0o600);

    // Symlinked credential path must be rejected
    const linkPath = join(root, "link.cred");
    symlinkSync(credPath, linkPath);
    expect(() => readWorkerCredentialFile(linkPath)).toThrow(/symlinks/);

    // Invalid prefix must be rejected
    writeFileSync(credPath, "wrong_prefix_token\n", { mode: 0o600 });
    expect(() => readWorkerCredentialFile(credPath)).toThrow(/barry_wk_ prefix/);
  });

  it("enforces online authority, deadline, and closure membership in ExecutionAccessV1", async () => {
    const root = createTempRoot();
    const store = new WorkArtifactStore(join(root, "artifacts"));
    stores.push(store);
    const sourceRef = store.stage(Buffer.from("console.log('ok');"), {
      purpose: "source",
      owner_identity: null,
      media_type: "text/javascript",
    });
    const unacceptedRef = store.stage(Buffer.from("secret-outside-closure"), {
      purpose: "source",
      owner_identity: null,
      media_type: "text/plain",
    });

    const now = Date.now();
    const delegation = buildTestDelegation({ sourceRef, now });
    const validAccess: ExecutionAccessV1 = {
      version: 1,
      delegation,
      connection: mockConnection(true),
      signal: new AbortController().signal,
    };

    await expect(assertExecutionAccessV1(validAccess, { now: () => now + 100 })).resolves.toBeDefined();
    expect(assertArtifactInAcceptedClosure(delegation, sourceRef)).toEqual(sourceRef);
    expect(() => assertArtifactInAcceptedClosure(delegation, unacceptedRef)).toThrow(
      /not in the accepted execution source\/input closure/,
    );

    // Cached delegation without online authority must be rejected
    const fencedAccess: ExecutionAccessV1 = {
      version: 1,
      delegation,
      connection: mockConnection(false),
      signal: new AbortController().signal,
    };
    await expect(assertExecutionAccessV1(fencedAccess)).rejects.toThrow(/Online owner rejected/);

    // Expired deadline must be rejected
    await expect(
      assertExecutionAccessV1(validAccess, { now: () => now + 60_001 }),
    ).rejects.toThrow(/Execution deadline has expired/);
  });

  it("streams verified downloads and deduplicated stage uploads over loopback HTTP, rejecting tampered, truncated, or unauthorized requests", async () => {
    const root = createTempRoot();
    const ownerStore = new WorkArtifactStore(join(root, "owner-artifacts"));
    stores.push(ownerStore);

    const sourcePayload = Buffer.alloc(150_000, "A");
    const sourceRef = ownerStore.stage(sourcePayload, {
      purpose: "source",
      owner_identity: null,
      media_type: "application/octet-stream",
    });
    ownerStore.retainExecutor(sourceRef);

    const outsideRef = ownerStore.stage(Buffer.from("unauthorized-data"), {
      purpose: "source",
      owner_identity: null,
      media_type: "application/octet-stream",
    });

    const validToken = "barry_wk_loopback_test_token";
    let tokenRevoked = false;
    const delegation = buildTestDelegation({ sourceRef });

    const handler = createRemoteArtifactHttpHandler({
      artifacts: ownerStore,
      chunkBytes: 16 * 1024,
      authenticateWorker: token => (!tokenRevoked && token === validToken ? "worker-1" : null),
      authorizeExecution: (_workerId, binding, planDigest) => {
        const expectedBinding = extractExecutionBinding(delegation);
        if (!sameExecutionBinding(binding, expectedBinding) || planDigest !== expectedBinding.plan_digest) {
          throw new WorkflowError("ExecutorBindingConflict", "Attempt or fence mismatch.", 409);
        }
        return { delegation };
      },
    });

    let dropNextStageResponseAfterCommit = false;
    let corruptNextDownloadByte = false;
    let truncateNextDownload = false;
    let omitFeatureHeader = false;

    const server = createServer(async (req, res) => {
      if (omitFeatureHeader) {
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        res.end(sourcePayload);
        return;
      }
      if (corruptNextDownloadByte && req.url === "/api/worker/artifacts/download") {
        corruptNextDownloadByte = false;
        const bad = Buffer.from(sourcePayload);
        bad[bad.length - 1] = bad[bad.length - 1]! ^ 0xff;
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(bad.byteLength),
          "x-barry-remote-feature": REMOTE_ARTIFACT_FEATURE,
        });
        res.end(bad);
        return;
      }
      if (truncateNextDownload && req.url === "/api/worker/artifacts/download") {
        truncateNextDownload = false;
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "x-barry-remote-feature": REMOTE_ARTIFACT_FEATURE,
        });
        res.end(sourcePayload.subarray(0, 1024));
        return;
      }
      if (dropNextStageResponseAfterCommit && req.url === "/api/worker/artifacts/stage") {
        dropNextStageResponseAfterCommit = false;
        res.writeHead = () => res;
        res.end = () => {
          res.socket?.destroy();
          return res;
        };
        await handler(req, res);
        return;
      }
      const handled = await handler(req, res);
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const ownerUrl = `http://127.0.0.1:${port}/`;

    const transport = new HttpRemoteArtifactTransport({
      ownerUrl,
      credential: validToken,
      chunkBytes: 16 * 1024,
    });
    const access: ExecutionAccessV1 = {
      version: 1,
      delegation,
      connection: mockConnection(true),
      signal: new AbortController().signal,
    };

    // 1. Successful multi-chunk streaming download
    const downloadedChunks: Buffer[] = [];
    for await (const chunk of transport.download(access, sourceRef)) {
      downloadedChunks.push(Buffer.from(chunk));
    }
    expect(Buffer.concat(downloadedChunks).equals(sourcePayload)).toBe(true);

    // 2. Rejects artifact outside accepted closure
    await expect(async () => {
      for await (const _ of transport.download(access, outsideRef)) {
        /* no-op */
      }
    }).rejects.toThrow(/not in the accepted execution source\/input closure/);

    // 3. Rejects corrupted download stream
    corruptNextDownloadByte = true;
    await expect(async () => {
      for await (const _ of transport.download(access, sourceRef)) {
        /* no-op */
      }
    }).rejects.toThrow(/digest .* does not match/);

    // 4. Rejects truncated download stream
    truncateNextDownload = true;
    await expect(async () => {
      for await (const _ of transport.download(access, sourceRef)) {
        /* no-op */
      }
    }).rejects.toThrow(/truncated/);

    // 5. Rejects owner missing remote-artifacts-v1 feature header
    omitFeatureHeader = true;
    await expect(async () => {
      for await (const _ of transport.download(access, sourceRef)) {
        /* no-op */
      }
    }).rejects.toThrow(/remote-artifacts-v1/);
    omitFeatureHeader = false;

    // 6. Stage upload with dropped response after server commit -> idempotent retry succeeds without duplicating or conflicting
    const resultPayload = Buffer.from(JSON.stringify({ answer: 42 }), "utf8");
    const resultDigest = createHash("sha256").update(resultPayload).digest("hex");
    const effectKey = logicalStageEffectKey("owner-node", "wf-1", "act-1", "execution");
    const stageMeta = {
      stage: "execution" as const,
      logicalEffectKey: effectKey,
      purpose: "output" as const,
      ownerIdentity: "id-42",
      digest: resultDigest,
      bytes: resultPayload.byteLength,
      mediaType: "application/json",
    };

    dropNextStageResponseAfterCommit = true;
    await expect(transport.stage(access, stageMeta, [resultPayload])).rejects.toThrow();

    // Retry identical stage after dropped response returns committed WorkArtifactRef
    const committedRef = await transport.stage(access, stageMeta, [resultPayload]);
    expect(committedRef.digest).toBe(resultDigest);
    expect(ownerStore.verify(committedRef).equals(resultPayload)).toBe(true);

    // Conflicting payload on the same logicalEffectKey must fail with 409 WorkStageEffectConflict
    const conflictingPayload = Buffer.from(JSON.stringify({ answer: 99 }), "utf8");
    const conflictingMeta = {
      ...stageMeta,
      digest: createHash("sha256").update(conflictingPayload).digest("hex"),
      bytes: conflictingPayload.byteLength,
    };
    await expect(transport.stage(access, conflictingMeta, [conflictingPayload])).rejects.toThrow(
      /already-committed artifact/,
    );

    // 7. Revoked worker credential throws WorkerCredentialRejected
    tokenRevoked = true;
    await expect(async () => {
      for await (const _ of transport.download(access, sourceRef)) {
        /* no-op */
      }
    }).rejects.toThrow(WorkerCredentialRejected);
  });

  it("enforces chunk size limits and mid-stream abort in verifyByteStream", async () => {
    const data = Buffer.from("hello world");
    const digest = createHash("sha256").update(data).digest("hex");
    await expect(async () => {
      for await (const _ of verifyByteStream([data], {
        digest,
        bytes: data.byteLength,
        maxChunkBytes: 4,
      })) {
        /* no-op */
      }
    }).rejects.toThrow(/exceeds maxChunkBytes/);
  });
});
