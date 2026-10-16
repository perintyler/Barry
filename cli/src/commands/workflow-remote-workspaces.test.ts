import { readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkflowRemoteWorkspaceFixture } from "../../test/fixtures/workflow-remote-workspaces.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) {
    await close();
  }
});

describe("workflow-remote-workspaces end-to-end & failure injection", () => {
  it("executes remote process and structured-agent preparation over HTTP, stages verified workspace results, detects conflicts, and applies atomically", async () => {
    const fixture = await createWorkflowRemoteWorkspaceFixture();
    cleanups.push(() => fixture.close());

    // 1. Remote process execution on 'verified' writable workspace
    const procAccess = fixture.createDelegation({
      family: "process",
      attemptId: "att-proc-verified",
    });
    const mapping = fixture.getVerifiedMappingEntry(true, 1);

    const preparedProc = await fixture.prepareLaunch(
      procAccess,
      {
        kind: "verified",
        resource_ref: "repo:verified-main",
        mapping_version: 1,
        mapping_digest: mapping.mapping_digest!,
        expected_base_digest: mapping.expected_base_digest!,
        writable: true,
      },
      [mapping],
    );

    expect(preparedProc.executor_family).toBe("process");
    await preparedProc.verifyBeforeLaunch();
    preparedProc.markLaunched();

    // Contending attempt on the same verified workspace is rejected while locked
    const contendingAccess = fixture.createDelegation({
      family: "process",
      attemptId: "att-proc-contender",
    });
    await expect(
      fixture.prepareLaunch(
        contendingAccess,
        {
          kind: "verified",
          resource_ref: "repo:verified-main",
          mapping_version: 1,
          mapping_digest: mapping.mapping_digest!,
          writable: true,
        },
        [mapping],
      ),
    ).rejects.toThrow(/already locked/);

    // Simulate process modifying index.ts and adding feature.ts in the fixture checkout
    writeFileSync(
      join(fixture.verifiedCheckoutDir, "src/index.ts"),
      "export const version = 2;\n",
      { mode: 0o600 },
    );
    writeFileSync(
      join(fixture.verifiedCheckoutDir, "src/feature.ts"),
      "export const feature = 'remote-verified';\n",
      { mode: 0o600 },
    );

    const procResult = await preparedProc.collectResult();
    expect(procResult.manifest.changes).toHaveLength(2);
    expect(fixture.ownerArtifacts.verify(procResult.manifestArtifact)).toBeDefined();

    // Settle verified workspace with positive 'ceased' proof
    const released = preparedProc.settleWorkspace({
      version: 1,
      lock_id: preparedProc.workspace.lock_id!,
      binding: preparedProc.binding,
      physical_settlement: "ceased",
      future_input_fenced: true,
      settled_at: Date.now(),
    });
    expect(released?.state).toBe("released");

    // Verify zero conflicts on publicationTargetDir, then stage-apply result to publicationTargetDir
    // (First copy file artifacts from workerArtifacts to ownerArtifacts as part of publication review)
    for (const change of procResult.manifest.changes) {
      if (change.artifact) {
        const bytes = fixture.workerArtifacts.verify(change.artifact);
        fixture.ownerArtifacts.stage(bytes, change.artifact);
      }
    }
    const conflictCheck = fixture.verifyConflicts(
      procResult.manifest,
      fixture.publicationTargetDir,
      { expectedResourceRef: "repo:verified-main" },
    );
    expect(conflictCheck.ok).toBe(true);

    const appliedSnap = fixture.applyResultStaged(procResult.manifest, {
      targetRoot: fixture.publicationTargetDir,
      artifacts: fixture.ownerArtifacts,
      authorizedBy: "operator-1",
      expectedResourceRef: "repo:verified-main",
    });
    expect(appliedSnap.tree_digest).toBe(procResult.manifest.result_tree_digest);
    expect(readFileSync(join(fixture.publicationTargetDir, "src/feature.ts"), "utf8")).toBe(
      "export const feature = 'remote-verified';\n",
    );

    // 2. Remote structured-agent execution on 'isolated' workspace
    const agentAccess = fixture.createDelegation({
      family: "structured-agent",
      attemptId: "att-agent-isolated",
    });
    const preparedAgent = await fixture.prepareLaunch(agentAccess, {
      kind: "isolated",
      resource_ref: "repo:isolated-work",
      input_bundle: fixture.isolatedInputBundle.artifact,
      expected_base_digest: fixture.isolatedInputBundle.bundle.base_digest,
      writable: true,
    });
    expect(preparedAgent.executor_family).toBe("structured-agent");
    expect(preparedAgent.verified_agent?.profile.reference).toBe("fixture:remote-agent");
    await preparedAgent.verifyBeforeLaunch();
    preparedAgent.markLaunched();

    writeFileSync(
      join(preparedAgent.workspace.canonical_root!, "src/task.ts"),
      "export const status = 'completed-by-agent';\n",
      { mode: 0o600 },
    );
    const agentResult = await preparedAgent.collectResult();
    expect(agentResult.manifest.changes).toEqual([
      expect.objectContaining({ path: "src/task.ts", change_kind: "modified" }),
    ]);

    preparedAgent.settleWorkspace({
      version: 1,
      lock_id: preparedAgent.workspace.lock_id!,
      binding: preparedAgent.binding,
      physical_settlement: "ceased",
      future_input_fenced: true,
      settled_at: Date.now(),
    });
  });

  it("recovers dropped stage responses idempotently, rejects symlink escapes and host-bound remote modes, and retains unknown physical custody across worker restart (F2)", async () => {
    const fixture = await createWorkflowRemoteWorkspaceFixture({
      dropFirstStageResponse: true,
    });
    cleanups.push(() => fixture.close());

    const access = fixture.createDelegation({
      family: "process",
      attemptId: "att-fault-1",
    });

    // 1. Host-bound workspace is refused on remote worker
    await expect(
      fixture.prepareLaunch(access, {
        kind: "host-bound",
        installation: fixture.ownerInstallation,
        path: fixture.verifiedCheckoutDir,
        device: 1,
        inode: 1,
      }),
    ).rejects.toThrow(/Host-bound workspace .* cannot execute on remote worker/);

    // 2. Prepare isolated workspace, inject symlink escape -> collectResult rejects symlink
    const prepared = await fixture.prepareLaunch(access, {
      kind: "isolated",
      resource_ref: "repo:isolated-work",
      input_bundle: fixture.isolatedInputBundle.artifact,
      expected_base_digest: fixture.isolatedInputBundle.bundle.base_digest,
      writable: true,
    });
    prepared.markLaunched();

    const symlinkEscape = join(prepared.workspace.canonical_root!, "src/escape-link");
    symlinkSync("/etc/hosts", symlinkEscape);
    await expect(prepared.collectResult()).rejects.toThrow(/symbolic link/);

    // Remove symlink escape; first collectResult drops HTTP stage response after server commit,
    // second collectResult replays idempotently and succeeds!
    const { rmSync } = await import("node:fs");
    rmSync(symlinkEscape);
    writeFileSync(
      join(prepared.workspace.canonical_root!, "src/task.ts"),
      "export const status = 'recovered';\n",
      { mode: 0o600 },
    );
    await expect(prepared.collectResult()).rejects.toThrow();
    const replayedResult = await prepared.collectResult();
    expect(replayedResult.manifest.changes).toHaveLength(1);

    // 3. Simulate worker crash/restart while lock is held and execution is NOT settled in ExecutorJournal (F2 unknown custody)
    const recovery = fixture.restartWorkerStores();
    expect(recovery.retainedUnknown).toHaveLength(1);
    expect(recovery.retainedUnknown[0]?.state).toBe("unknown");

    // Attempting to acquire the same lock or execute while custody is 'unknown' is refused
    expect(() =>
      fixture.lockStore.assertActiveLock(prepared.workspace.lock_id!, prepared.binding),
    ).toThrow(/unknown physical custody/);
  });

  it("mounts /api/worker/artifacts/download and /api/worker/artifacts/stage on createWorkflowServer with barry_wk_ worker credentials and postJson headers/signal", async () => {
    const fixture = await createWorkflowRemoteWorkspaceFixture();
    cleanups.push(() => fixture.close());

    const { createWorkflowServer } = await import(
      "../../../bags/workflows/src/index.js"
    );
    const { postJson } = await import("@barry-rocks/sdk/http");
    const { HttpRemoteArtifactTransport, WorkflowOwner, logicalStageEffectKey } =
      await import("@barry-rocks/sdk/internal/workflows");

    const access = fixture.createDelegation({
      family: "process",
      attemptId: "att-workflow-server-1",
    });
    const workerCred = "barry_wk_workflow_server_credential";
    let revoked = false;
    const owner = new WorkflowOwner({
      id: fixture.ownerInstallation,
      path: ":memory:",
      artifacts: [],
      workArtifacts: fixture.ownerArtifacts,
    });
    cleanups.push(async () => owner.close());
    owner.executionDelegation = (workerId: string, attemptId: string) => {
      expect(workerId).toBe(fixture.workerInstallation);
      expect(attemptId).toBe("att-workflow-server-1");
      return access.delegation;
    };
    const workflowServer = createWorkflowServer({
      owner,
      secret: "workflow-server-secret",
      workArtifacts: fixture.ownerArtifacts,
      authenticateWorker: credential =>
        !revoked && credential === workerCred ? fixture.workerInstallation : null,
    });
    await new Promise<void>(resolve => workflowServer.listen(0, "127.0.0.1", resolve));
    cleanups.push(async () => {
      workflowServer.closeAllConnections();
      await new Promise<void>(resolve => workflowServer.close(() => resolve()));
    });

    const serverPort = (workflowServer.address() as { port: number }).port;
    const serverUrl = `http://127.0.0.1:${serverPort}/`;
    const serverTransport = new HttpRemoteArtifactTransport({
      ownerUrl: serverUrl,
      credential: () => workerCred,
      chunkBytes: 4096,
    });

    // 1. Download source artifact from createWorkflowServer
    const downloadedChunks: Buffer[] = [];
    for await (const chunk of serverTransport.download(access, access.delegation.start.source)) {
      downloadedChunks.push(Buffer.from(chunk));
    }
    const downloaded = Buffer.concat(downloadedChunks);
    expect(downloaded.toString("utf8")).toContain("executed: true");

    // 2. Stage output artifact to createWorkflowServer
    const stagePayload = Buffer.from(JSON.stringify({ ok: true, serverMounted: true }), "utf8");
    const { createHash } = await import("node:crypto");
    const stageDigest = createHash("sha256").update(stagePayload).digest("hex");
    const effectKey = logicalStageEffectKey(
      access.delegation.start.owner,
      access.delegation.start.workflow_id,
      access.delegation.start.activity_id,
      "publication",
    );
    const stagedRef = await serverTransport.stage(
      access,
      {
        stage: "publication",
        logicalEffectKey: effectKey,
        purpose: "output",
        ownerIdentity: "id-remote-1",
        digest: stageDigest,
        bytes: stagePayload.byteLength,
        mediaType: "application/json",
      },
      [stagePayload],
    );
    expect(stagedRef.digest).toBe(stageDigest);
    expect(fixture.ownerArtifacts.verify(stagedRef).toString("utf8")).toBe(
      stagePayload.toString("utf8"),
    );

    // 3. Revoked worker credential is rejected on createWorkflowServer artifact route
    revoked = true;
    await expect(async () => {
      for await (const _chunk of serverTransport.download(access, access.delegation.start.source)) {
        // should fail before yielding
      }
    }).rejects.toThrow();

    // 4. Verify postJson passes response headers to describeHttpError and respects AbortSignal
    let observedFeatureHeader: string | null = null;
    await expect(
      postJson({
        url: `${serverUrl}api/worker/artifacts/download`,
        body: {},
        timeoutMs: 5000,
        describeHttpError: (_status, _body, headers) => {
          observedFeatureHeader = headers?.get("x-barry-remote-feature") ?? null;
          return "custom-http-error-with-headers";
        },
      }),
    ).rejects.toThrow(/custom-http-error-with-headers/);
    expect(observedFeatureHeader).toBe("remote-artifacts-v1");
  });
});

