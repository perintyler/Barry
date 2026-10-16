import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { workReceiptDigest } from "../executor-journal.js";
import {
  executionBindingSchema,
  executorObservationSchema,
  logicalStageEffectKey,
  workReceiptSchema,
} from "../work-contracts.js";
import {
  WorkspaceLockStore,
  verifyCanonicalDirectoryIdentity,
} from "./workspace-lock.js";

const roots: string[] = [];
const stores: WorkspaceLockStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createTempRoot(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "workspace-lock-test-")));
  roots.push(dir);
  return dir;
}

function makeBinding(attemptId = "attempt-1", fence = 1, now = Date.now()) {
  return executionBindingSchema.parse({
    version: 2,
    owner: "owner-1",
    work_id: "work-1",
    workflow_id: "wf-1",
    activity_id: "act-1",
    attempt_id: attemptId,
    request_hash: "a".repeat(64),
    plan_digest: "b".repeat(64),
    grant_ref: "grant-1",
    grant_revision: 1,
    source: {
      digest: "c".repeat(64),
      bytes: 32,
      media_type: "application/octet-stream",
      owner_identity: null,
      purpose: "source",
    },
    execution_fence: fence,
    deadline: now + 60_000,
  });
}

describe("workspace-lock", () => {
  it("enforces canonical directory identity and rejects symlinked workspace roots", () => {
    const root = createTempRoot();
    const realDir = join(root, "real-workspace");
    mkdirSync(realDir, { mode: 0o700 });
    const linkDir = join(root, "symlink-workspace");
    symlinkSync(realDir, linkDir);

    const verified = verifyCanonicalDirectoryIdentity(realDir);
    expect(verified.canonical_root).toBe(realDir);
    expect(() => verifyCanonicalDirectoryIdentity(linkDir)).toThrow(/symbolic link/);
  });

  it("grants at most one writer lock, survives store reopen across restarts, and requires positive bound settlement proof to release", () => {
    const root = createTempRoot();
    const wsDir = join(root, "repo-checkout");
    mkdirSync(wsDir, { mode: 0o700 });
    const wsStat = statSync(wsDir);
    const dbPath = join(root, "locks/workspace-locks.sqlite");

    const store1 = new WorkspaceLockStore({ path: dbPath, installation: "worker-node-1" });
    stores.push(store1);

    const binding1 = makeBinding("attempt-1", 1);
    const binding2 = makeBinding("attempt-2", 2);

    const lock = store1.acquire({
      resource_ref: "repo:main",
      mapping_version: 1,
      mapping_digest: "d".repeat(64),
      canonical_root: wsDir,
      dev: wsStat.dev,
      ino: wsStat.ino,
      binding: binding1,
    });
    expect(lock.state).toBe("held");

    // Idempotent re-acquire for identical binding + mapping succeeds
    const reacquired = store1.acquire({
      resource_ref: "repo:main",
      mapping_version: 1,
      mapping_digest: "d".repeat(64),
      canonical_root: wsDir,
      dev: wsStat.dev,
      ino: wsStat.ino,
      binding: binding1,
    });
    expect(reacquired.lock_id).toBe(lock.lock_id);

    // Contending writer on same resource_ref or canonical_root is rejected with 409 WorkWorkspaceLocked
    expect(() =>
      store1.acquire({
        resource_ref: "repo:main",
        mapping_version: 1,
        mapping_digest: "d".repeat(64),
        canonical_root: wsDir,
        dev: wsStat.dev,
        ino: wsStat.ino,
        binding: binding2,
      }),
    ).toThrow(/already locked by attempt attempt-1/);

    // Close and reopen store (simulating worker process crash/restart): lock remains held!
    store1.close();
    const store2 = new WorkspaceLockStore({ path: dbPath, installation: "worker-node-1" });
    stores.push(store2);

    expect(store2.listActive()).toHaveLength(1);
    expect(() =>
      store2.acquire({
        resource_ref: "repo:main",
        mapping_version: 1,
        mapping_digest: "d".repeat(64),
        canonical_root: wsDir,
        dev: wsStat.dev,
        ino: wsStat.ino,
        binding: binding2,
      }),
    ).toThrow(/already locked/);

    // Refuses release when physical_settlement is 'unknown' or 'running' or future_input_fenced is false
    expect(() =>
      store2.release({
        version: 1,
        lock_id: lock.lock_id,
        binding: binding1,
        physical_settlement: "unknown",
        future_input_fenced: true,
        settled_at: Date.now(),
      }),
    ).toThrow(/cannot be released while physical_settlement is 'unknown'/);

    expect(() =>
      store2.release({
        version: 1,
        lock_id: lock.lock_id,
        binding: binding1,
        physical_settlement: "ceased",
        future_input_fenced: false,
        settled_at: Date.now(),
      }),
    ).toThrow(/before future input is fenced/);

    // Transition to unknown custody (F2 escaped-descendant scenario) blocks both old and new attempts until positive settlement
    const unknownLock = store2.markUnknownCustody(
      lock.lock_id,
      binding1,
      "PGID kill completed but descendant cessation unproven (F2)",
    );
    expect(unknownLock.state).toBe("unknown");
    expect(() => store2.assertActiveLock(lock.lock_id, binding1)).toThrow(
      /unknown physical custody/,
    );
    expect(() =>
      store2.acquire({
        resource_ref: "repo:main",
        mapping_version: 1,
        mapping_digest: "d".repeat(64),
        canonical_root: wsDir,
        dev: wsStat.dev,
        ino: wsStat.ino,
        binding: binding2,
      }),
    ).toThrow(/unresolved unknown physical custody/);

    // Positive bound 'ceased' settlement with valid receipt releases the lock
    const now = Date.now();
    const observation = executorObservationSchema.parse({
      ...binding1,
      revision: 2,
      observed_at: now,
      stage: "terminal",
      physical_state: "ceased",
      effect_certainty: "known",
      cancel_requested: false,
      reason: null,
      receipt_ref: "rec-1",
      handle: null,
    });
    const unsignedReceipt = {
      ...binding1,
      receipt_ref: "rec-1",
      revision: 2,
      committed_at: now,
      physical_state: "ceased" as const,
      effect_certainty: "known" as const,
      outcome: "complete" as const,
      stages: [
        {
          stage: "execution" as const,
          effect_key: logicalStageEffectKey(
            binding1.owner,
            binding1.workflow_id,
            binding1.activity_id,
            "execution",
          ),
          attempt_id: binding1.attempt_id,
          state: "passed" as const,
          started_at: now - 10,
          completed_at: now - 1,
          result: null,
        },
      ],
      output: null,
      summary: "completed cleanly",
      validation: "skipped" as const,
      validation_failures: null,
    };
    const receipt = workReceiptSchema.parse({
      ...unsignedReceipt,
      receipt_digest: workReceiptDigest(unsignedReceipt),
    });

    const released = store2.release({
      version: 1,
      lock_id: lock.lock_id,
      binding: binding1,
      physical_settlement: "ceased",
      future_input_fenced: true,
      settled_at: now,
      observation,
      receipt,
    });
    expect(released.state).toBe("released");
    expect(released.settlement_state).toBe("ceased");

    // Now binding2 can acquire the workspace lock cleanly
    const lock2 = store2.acquire({
      resource_ref: "repo:main",
      mapping_version: 1,
      mapping_digest: "d".repeat(64),
      canonical_root: wsDir,
      dev: wsStat.dev,
      ino: wsStat.ino,
      binding: binding2,
    });
    expect(lock2.state).toBe("held");
    expect(lock2.binding.attempt_id).toBe("attempt-2");
  });

  it("prevents concurrent writer acquisition from a separate child process against the same SQLite lock store", async () => {
    const root = createTempRoot();
    const wsDir = join(root, "shared-checkout");
    mkdirSync(wsDir, { mode: 0o700 });
    const wsStat = statSync(wsDir);
    const dbPath = join(root, "workspace-locks.sqlite");

    const store = new WorkspaceLockStore({ path: dbPath, installation: "worker-node-1" });
    stores.push(store);
    const binding1 = makeBinding("parent-attempt", 1);
    store.acquire({
      resource_ref: "repo:contended",
      mapping_version: 1,
      mapping_digest: "e".repeat(64),
      canonical_root: wsDir,
      dev: wsStat.dev,
      ino: wsStat.ino,
      binding: binding1,
    });

    const lockModulePath = fileURLToPath(new URL("./workspace-lock.ts", import.meta.url));
    const childBinding = makeBinding("child-attempt", 2);
    const script = `
      import { WorkspaceLockStore } from ${JSON.stringify(lockModulePath)};
      const store = new WorkspaceLockStore({ path: ${JSON.stringify(dbPath)}, installation: "worker-node-1" });
      try {
        store.acquire({
          resource_ref: "repo:contended",
          mapping_version: 1,
          mapping_digest: ${JSON.stringify("e".repeat(64))},
          canonical_root: ${JSON.stringify(wsDir)},
          dev: ${wsStat.dev},
          ino: ${wsStat.ino},
          binding: ${JSON.stringify(childBinding)},
        });
        process.stdout.write("ACQUIRED_UNEXPECTEDLY");
        process.exit(1);
      } catch (err) {
        process.stdout.write(String(err.code || err.message));
        process.exit(0);
      } finally {
        store.close();
      }
    `;

    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => {
      stdout += String(chunk);
    });
    child.stderr.on("data", chunk => {
      stderr += String(chunk);
    });
    const exitCode = await new Promise<number | null>(resolve =>
      child.once("close", code => resolve(code)),
    );
    expect(exitCode, stderr).toBe(0);
    expect(stdout).toContain("WorkWorkspaceLocked");
  });
});
