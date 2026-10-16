import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { z } from "zod";
import { SqliteDatabase } from "../../stores/sqlite-connection.js";
import { WorkflowError } from "../errors.js";
import { workReceiptDigest } from "../executor-journal.js";
import {
  executionBindingSchema,
  executorObservationSchema,
  workReceiptSchema,
} from "../work-contracts.js";
import { sameExecutionBinding, type ExecutionBinding } from "./work-remote-transport.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const nonEmptyRef = z.string().min(1).max(200);

export const workspaceLockStateSchema = z.enum(["held", "unknown", "released"]);
export type WorkspaceLockState = z.infer<typeof workspaceLockStateSchema>;

export const workspaceLockRecordSchema = z.strictObject({
  version: z.literal(1),
  lock_id: z.uuid(),
  installation: nonEmptyRef,
  resource_ref: nonEmptyRef,
  mapping_version: z.number().int().positive(),
  mapping_digest: sha256Schema,
  canonical_root: z.string().min(1).max(4096),
  dev: z.number().int().nonnegative(),
  ino: z.number().int().nonnegative(),
  binding: executionBindingSchema,
  state: workspaceLockStateSchema,
  acquired_at: z.number().int().nonnegative(),
  updated_at: z.number().int().nonnegative(),
  released_at: z.number().int().nonnegative().nullable(),
  settlement_state: z.enum(["not-started", "ceased"]).nullable(),
  unknown_reason: z.string().max(500).nullable(),
});
export type WorkspaceLockRecordV1 = z.infer<typeof workspaceLockRecordSchema>;

export const workspaceSettlementProofSchema = z.strictObject({
  version: z.literal(1),
  lock_id: z.uuid(),
  binding: executionBindingSchema,
  physical_settlement: z.enum(["not-started", "running", "stopping", "live", "ceased", "unknown"]),
  future_input_fenced: z.boolean(),
  settled_at: z.number().int().nonnegative(),
  observation: executorObservationSchema.optional(),
  receipt: workReceiptSchema.optional(),
});
export type WorkspaceSettlementProofV1 = z.infer<typeof workspaceSettlementProofSchema>;

export interface AcquireWorkspaceLockInput {
  readonly resource_ref: string;
  readonly mapping_version: number;
  readonly mapping_digest: string;
  readonly canonical_root: string;
  readonly dev: number;
  readonly ino: number;
  readonly binding: ExecutionBinding;
}

export function verifyCanonicalDirectoryIdentity(path: string): {
  canonical_root: string;
  dev: number;
  ino: number;
} {
  if (!isAbsolute(path) || path.includes("\0")) {
    throw new WorkflowError(
      "WorkWorkspacePathInvalid",
      "Workspace path must be an absolute path without NUL bytes.",
      400,
    );
  }
  let lstat;
  try {
    lstat = lstatSync(path);
  } catch {
    throw new WorkflowError(
      "WorkWorkspaceUnavailable",
      `Workspace path ${path} does not exist.`,
      409,
    );
  }
  if (lstat.isSymbolicLink()) {
    throw new WorkflowError(
      "WorkWorkspaceSymlinkDenied",
      `Workspace path ${path} must not be a symbolic link.`,
      403,
    );
  }
  if (!lstat.isDirectory()) {
    throw new WorkflowError(
      "WorkWorkspaceUnavailable",
      `Workspace path ${path} must be a directory.`,
      409,
    );
  }
  let canonical: string;
  try {
    canonical = realpathSync(path);
  } catch {
    throw new WorkflowError(
      "WorkWorkspaceUnavailable",
      `Unable to resolve canonical path for ${path}.`,
      409,
    );
  }
  if (canonical !== path) {
    throw new WorkflowError(
      "WorkWorkspaceSymlinkDenied",
      `Workspace path ${path} traverses a symbolic link component (resolved to ${canonical}).`,
      403,
    );
  }
  const stat = statSync(canonical);
  if (!stat.isDirectory() || stat.dev !== lstat.dev || stat.ino !== lstat.ino) {
    throw new WorkflowError(
      "WorkWorkspaceChanged",
      `Workspace directory identity changed during verification.`,
      409,
    );
  }
  return {
    canonical_root: canonical,
    dev: stat.dev,
    ino: stat.ino,
  };
}

/**
 * Durable SQLite-backed writer lock store for verified and isolated workspaces.
 *
 * Enforces:
 * - At most one active (`held` or `unknown`) writer per `resource_ref`, `canonical_root`,
 *   or `(dev, ino)` across processes and restarts.
 * - Never auto-unlocks on timeout, PID death, error rejection, or worker restart.
 * - Requires positive bound `not-started` or `ceased` physical settlement proof with
 *   `future_input_fenced: true` before releasing a lock. Explicitly refuses release
 *   when `physical_settlement` is `"unknown"`, `"running"`, `"stopping"`, or `"live"`
 *   (preserving custody across F2 detached-descendant uncertainty until reconciled).
 */
export class WorkspaceLockStore {
  private db!: SqliteDatabase;
  private readonly now: () => number;

  constructor(
    private readonly options: {
      readonly path: string;
      readonly installation: string;
      readonly now?: () => number;
    },
  ) {
    if (!isAbsolute(options.path) || options.path.includes("\0")) {
      throw new Error("workspace lock store path must be absolute");
    }
    if (!options.installation || Buffer.byteLength(options.installation, "utf8") > 200) {
      throw new Error("invalid workspace lock store installation");
    }
    this.now = options.now ?? Date.now;
    mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
    this.open();
  }

  private open(): void {
    for (const candidate of [
      this.options.path,
      `${this.options.path}-wal`,
      `${this.options.path}-shm`,
    ]) {
      if (existsSync(candidate)) {
        const stat = lstatSync(candidate);
        if (
          !stat.isFile() ||
          stat.nlink !== 1 ||
          (process.getuid && stat.uid !== process.getuid())
        ) {
          throw new Error("workspace lock store must be a private owned regular file");
        }
      }
    }
    const fd = openSync(
      this.options.path,
      constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      fchmodSync(fd, 0o600);
    } finally {
      closeSync(fd);
    }

    const db = new SqliteDatabase(this.options.path);
    try {
      db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=200;");
      db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS workspace_lock_meta(
          installation TEXT PRIMARY KEY
        );
        CREATE TABLE IF NOT EXISTS workspace_locks(
          lock_id TEXT PRIMARY KEY,
          installation TEXT NOT NULL,
          resource_ref TEXT NOT NULL,
          mapping_version INTEGER NOT NULL,
          mapping_digest TEXT NOT NULL,
          canonical_root TEXT NOT NULL,
          dev INTEGER NOT NULL,
          ino INTEGER NOT NULL,
          binding_json TEXT NOT NULL,
          state TEXT NOT NULL,
          acquired_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          released_at INTEGER,
          settlement_state TEXT,
          unknown_reason TEXT
        );
        CREATE UNIQUE INDEX IF NOT EXISTS workspace_locks_active_resource
          ON workspace_locks(resource_ref) WHERE state IN ('held', 'unknown');
        CREATE UNIQUE INDEX IF NOT EXISTS workspace_locks_active_root
          ON workspace_locks(canonical_root) WHERE state IN ('held', 'unknown');
        CREATE UNIQUE INDEX IF NOT EXISTS workspace_locks_active_inode
          ON workspace_locks(dev, ino) WHERE state IN ('held', 'unknown');
        PRAGMA user_version=1;`);
      const existing = db.prepare("SELECT installation FROM workspace_lock_meta").get();
      if (existing && existing.installation !== this.options.installation) {
        throw new Error("workspace lock store belongs to another installation");
      }
      db.prepare("INSERT OR IGNORE INTO workspace_lock_meta(installation) VALUES(?)").run(
        this.options.installation,
      );
      db.exec("COMMIT");
      const dirFd = openSync(dirname(this.options.path), constants.O_RDONLY);
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
      this.db = db;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* ignore rollback failure */
      }
      db.close();
      throw error;
    }
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* preserve original error */
      }
      throw error;
    }
  }

  private parseRow(row: Record<string, unknown>): WorkspaceLockRecordV1 {
    return workspaceLockRecordSchema.parse({
      version: 1,
      lock_id: String(row.lock_id),
      installation: String(row.installation),
      resource_ref: String(row.resource_ref),
      mapping_version: Number(row.mapping_version),
      mapping_digest: String(row.mapping_digest),
      canonical_root: String(row.canonical_root),
      dev: Number(row.dev),
      ino: Number(row.ino),
      binding: JSON.parse(String(row.binding_json)),
      state: String(row.state),
      acquired_at: Number(row.acquired_at),
      updated_at: Number(row.updated_at),
      released_at:
        row.released_at === null || row.released_at === undefined ? null : Number(row.released_at),
      settlement_state:
        row.settlement_state === null || row.settlement_state === undefined
          ? null
          : String(row.settlement_state),
      unknown_reason:
        row.unknown_reason === null || row.unknown_reason === undefined
          ? null
          : String(row.unknown_reason),
    });
  }

  acquire(input: AcquireWorkspaceLockInput): WorkspaceLockRecordV1 {
    const binding = executionBindingSchema.parse(input.binding);
    const verifiedDir = verifyCanonicalDirectoryIdentity(input.canonical_root);
    if (
      verifiedDir.canonical_root !== input.canonical_root ||
      verifiedDir.dev !== input.dev ||
      verifiedDir.ino !== input.ino
    ) {
      throw new WorkflowError(
        "WorkWorkspaceChanged",
        "Workspace directory inode or canonical path does not match lock input.",
        409,
      );
    }

    return this.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT * FROM workspace_locks
           WHERE state IN ('held', 'unknown')
             AND (resource_ref = ? OR canonical_root = ? OR (dev = ? AND ino = ?))`,
        )
        .all(input.resource_ref, input.canonical_root, input.dev, input.ino);

      if (rows.length > 0) {
        const active = this.parseRow(rows[0]!);
        if (active.state === "unknown") {
          throw new WorkflowError(
            "WorkWorkspaceCustodyUnknown",
            `Workspace ${input.resource_ref} (${input.canonical_root}) has unresolved unknown physical custody from attempt ${active.binding.attempt_id}.`,
            409,
          );
        }
        if (
          rows.length === 1 &&
          sameExecutionBinding(active.binding, binding) &&
          active.resource_ref === input.resource_ref &&
          active.mapping_version === input.mapping_version &&
          active.mapping_digest === input.mapping_digest &&
          active.canonical_root === input.canonical_root &&
          active.dev === input.dev &&
          active.ino === input.ino
        ) {
          return active;
        }
        throw new WorkflowError(
          "WorkWorkspaceLocked",
          `Workspace ${input.resource_ref} (${input.canonical_root}) is already locked by attempt ${active.binding.attempt_id}.`,
          409,
        );
      }

      const now = this.now();
      const record: WorkspaceLockRecordV1 = workspaceLockRecordSchema.parse({
        version: 1,
        lock_id: randomUUID(),
        installation: this.options.installation,
        resource_ref: input.resource_ref,
        mapping_version: input.mapping_version,
        mapping_digest: input.mapping_digest,
        canonical_root: input.canonical_root,
        dev: input.dev,
        ino: input.ino,
        binding,
        state: "held",
        acquired_at: now,
        updated_at: now,
        released_at: null,
        settlement_state: null,
        unknown_reason: null,
      });

      this.db
        .prepare(
          `INSERT INTO workspace_locks(
            lock_id, installation, resource_ref, mapping_version, mapping_digest,
            canonical_root, dev, ino, binding_json, state, acquired_at, updated_at,
            released_at, settlement_state, unknown_reason
          ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.lock_id,
          record.installation,
          record.resource_ref,
          record.mapping_version,
          record.mapping_digest,
          record.canonical_root,
          record.dev,
          record.ino,
          JSON.stringify(record.binding),
          record.state,
          record.acquired_at,
          record.updated_at,
          record.released_at,
          record.settlement_state,
          record.unknown_reason,
        );

      return record;
    });
  }

  inspect(lockId: string): WorkspaceLockRecordV1 | null {
    const row = this.db.prepare("SELECT * FROM workspace_locks WHERE lock_id = ?").get(lockId);
    return row ? this.parseRow(row) : null;
  }

  listActive(): WorkspaceLockRecordV1[] {
    return this.db
      .prepare(
        "SELECT * FROM workspace_locks WHERE state IN ('held', 'unknown') ORDER BY acquired_at ASC",
      )
      .all()
      .map(row => this.parseRow(row));
  }

  assertActiveLock(lockId: string, expectedBinding: ExecutionBinding): WorkspaceLockRecordV1 {
    const record = this.inspect(lockId);
    if (!record) {
      throw new WorkflowError(
        "WorkWorkspaceLockMissing",
        `Workspace lock ${lockId} does not exist.`,
        409,
      );
    }
    if (!sameExecutionBinding(record.binding, expectedBinding)) {
      throw new WorkflowError(
        "WorkWorkspaceLockBindingMismatch",
        `Workspace lock ${lockId} is bound to attempt ${record.binding.attempt_id}, not ${expectedBinding.attempt_id}.`,
        409,
      );
    }
    if (record.state === "unknown") {
      throw new WorkflowError(
        "WorkWorkspaceCustodyUnknown",
        `Workspace lock ${lockId} is in unknown physical custody and cannot authorize execution.`,
        409,
      );
    }
    if (record.state !== "held") {
      throw new WorkflowError(
        "WorkWorkspaceLockReleased",
        `Workspace lock ${lockId} is already released.`,
        409,
      );
    }
    const dir = verifyCanonicalDirectoryIdentity(record.canonical_root);
    if (dir.dev !== record.dev || dir.ino !== record.ino) {
      throw new WorkflowError(
        "WorkWorkspaceChanged",
        `Workspace directory ${record.canonical_root} inode changed while lock ${lockId} was held.`,
        409,
      );
    }
    return record;
  }

  /**
   * Transition an active lock to `unknown` physical custody (for example on worker
   * restart recovery or when PGID termination cannot prove escaped-descendant cessation).
   * The lock remains held on disk against new writers until positive bound settlement arrives.
   */
  markUnknownCustody(
    lockId: string,
    binding: ExecutionBinding,
    reason: string,
  ): WorkspaceLockRecordV1 {
    return this.transaction(() => {
      const record = this.inspect(lockId);
      if (!record) {
        throw new WorkflowError(
          "WorkWorkspaceLockMissing",
          `Workspace lock ${lockId} does not exist.`,
          409,
        );
      }
      if (!sameExecutionBinding(record.binding, binding)) {
        throw new WorkflowError(
          "WorkWorkspaceLockBindingMismatch",
          `Workspace lock ${lockId} binding mismatch on markUnknownCustody.`,
          409,
        );
      }
      if (record.state === "released") {
        throw new WorkflowError(
          "WorkWorkspaceLockReleased",
          `Cannot mark already-released workspace lock ${lockId} as unknown.`,
          409,
        );
      }
      const now = this.now();
      const boundedReason = reason.slice(0, 500);
      this.db
        .prepare(
          "UPDATE workspace_locks SET state = 'unknown', updated_at = ?, unknown_reason = ? WHERE lock_id = ?",
        )
        .run(now, boundedReason, lockId);
      return this.inspect(lockId)!;
    });
  }

  /**
   * Release a workspace lock ONLY when presented with validated positive bound
   * `not-started` or `ceased` physical settlement proof and `future_input_fenced === true`.
   */
  release(proof: WorkspaceSettlementProofV1): WorkspaceLockRecordV1 {
    const parsedProof = workspaceSettlementProofSchema.parse(proof);
    if (
      parsedProof.physical_settlement !== "not-started" &&
      parsedProof.physical_settlement !== "ceased"
    ) {
      throw new WorkflowError(
        "WorkWorkspaceCustodyUnknown",
        `Workspace lock ${parsedProof.lock_id} cannot be released while physical_settlement is '${parsedProof.physical_settlement}'.`,
        409,
      );
    }
    if (!parsedProof.future_input_fenced) {
      throw new WorkflowError(
        "WorkWorkspaceFutureInputUnfenced",
        `Workspace lock ${parsedProof.lock_id} cannot be released before future input is fenced.`,
        409,
      );
    }

    if (parsedProof.observation) {
      const obs = parsedProof.observation;
      const obsBinding = executionBindingSchema.parse({
        version: obs.version,
        owner: obs.owner,
        work_id: obs.work_id,
        workflow_id: obs.workflow_id,
        activity_id: obs.activity_id,
        attempt_id: obs.attempt_id,
        request_hash: obs.request_hash,
        plan_digest: obs.plan_digest,
        grant_ref: obs.grant_ref,
        grant_revision: obs.grant_revision,
        source: obs.source,
        execution_fence: obs.execution_fence,
        deadline: obs.deadline,
      });
      if (
        !sameExecutionBinding(obsBinding, parsedProof.binding) ||
        obs.physical_state !== parsedProof.physical_settlement
      ) {
        throw new WorkflowError(
          "WorkWorkspaceSettlementMismatch",
          "Settlement observation does not match workspace release proof.",
          409,
        );
      }
    }

    if (parsedProof.receipt) {
      const rec = parsedProof.receipt;
      const { receipt_digest, ...body } = rec;
      if (workReceiptDigest(body) !== receipt_digest) {
        throw new WorkflowError(
          "WorkWorkspaceSettlementMismatch",
          "Settlement receipt digest is invalid.",
          409,
        );
      }
      const receiptBinding = executionBindingSchema.parse({
        version: rec.version,
        owner: rec.owner,
        work_id: rec.work_id,
        workflow_id: rec.workflow_id,
        activity_id: rec.activity_id,
        attempt_id: rec.attempt_id,
        request_hash: rec.request_hash,
        plan_digest: rec.plan_digest,
        grant_ref: rec.grant_ref,
        grant_revision: rec.grant_revision,
        source: rec.source,
        execution_fence: rec.execution_fence,
        deadline: rec.deadline,
      });
      if (
        !sameExecutionBinding(receiptBinding, parsedProof.binding) ||
        rec.physical_state !== parsedProof.physical_settlement
      ) {
        throw new WorkflowError(
          "WorkWorkspaceSettlementMismatch",
          "Settlement receipt binding or physical_state does not match workspace release proof.",
          409,
        );
      }
    }

    return this.transaction(() => {
      const record = this.inspect(parsedProof.lock_id);
      if (!record) {
        throw new WorkflowError(
          "WorkWorkspaceLockMissing",
          `Workspace lock ${parsedProof.lock_id} does not exist.`,
          409,
        );
      }
      if (!sameExecutionBinding(record.binding, parsedProof.binding)) {
        throw new WorkflowError(
          "WorkWorkspaceLockBindingMismatch",
          `Workspace lock ${parsedProof.lock_id} belongs to attempt ${record.binding.attempt_id}, not ${parsedProof.binding.attempt_id}.`,
          409,
        );
      }
      if (record.state === "released") {
        return record;
      }
      const now = Math.max(this.now(), parsedProof.settled_at);
      this.db
        .prepare(
          `UPDATE workspace_locks
           SET state = 'released',
               updated_at = ?,
               released_at = ?,
               settlement_state = ?
           WHERE lock_id = ?`,
        )
        .run(now, now, parsedProof.physical_settlement, parsedProof.lock_id);
      return this.inspect(parsedProof.lock_id)!;
    });
  }

  close(): void {
    if (this.db?.isOpen) {
      this.db.close();
    }
  }
}
