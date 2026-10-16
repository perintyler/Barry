/** Standalone diagnostics on a sealed SQLite copy, independent of workflow services. */
import Database from "better-sqlite3";
import { copyFileSync, lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashOpsFile } from "./work-ops.js";

const queries = {
  executor: {
    installation: "SELECT installation FROM executor_meta",
    custody:
      "SELECT owner, json_extract(observation,'$.physical_state') state, count(*) count FROM executions GROUP BY owner,state",
    undelivered:
      "SELECT r.owner,count(*) count FROM execution_receipts r LEFT JOIN execution_deliveries d USING(receipt_ref) WHERE d.acknowledged IS NULL GROUP BY r.owner",
    lateEvidence: "SELECT owner,count(*) count FROM execution_late_evidence GROUP BY owner",
    claims: "SELECT owner,count(*) count FROM execution_claim_inbox GROUP BY owner",
  },
  broker: {
    identity: "SELECT broker FROM resource_meta",
    reservations:
      "SELECT owner,resource,pool,state,count(*) count,sum(input_tokens) input_tokens,sum(output_tokens) output_tokens,sum(cost_micros) cost_micros FROM resource_reservations GROUP BY owner,resource,pool,state",
  },
  sessions: {
    unsettled:
      "SELECT owner,phase,count(*) count FROM session_workflow_settlements WHERE ceased_at IS NULL GROUP BY owner,phase",
  },
  runtime: {
    generations: "SELECT state,count(*) count FROM workflow_runtime_generations GROUP BY state",
  },
} as const;
export type WorkOpsDiagnosticRole = keyof typeof queries;

function assertNoSidecars(path: string): void {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    try {
      lstatSync(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    throw new Error("SealedCopyRequired");
  }
}

/** Caller supplies an independently trusted hash, not a live database path. */
export function diagnoseWorkOps(path: string, sha256: string, role: WorkOpsDiagnosticRole) {
  if (!/^[a-f0-9]{64}$/.test(sha256) || !Object.hasOwn(queries, role))
    throw new Error("InvalidDiagnosticInput");
  assertNoSidecars(path);
  if (hashOpsFile(path).sha256 !== sha256) throw new Error("SealedCopyHashMismatch");
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "barry-work-ops-")));
  try {
    const scratch = join(directory, "inspection.db");
    copyFileSync(path, scratch);
    if (hashOpsFile(scratch).sha256 !== sha256 || hashOpsFile(path).sha256 !== sha256)
      throw new Error("SealedCopyChanged");
    assertNoSidecars(path);
    const db = new Database(scratch, { readonly: true, fileMustExist: true });
    try {
      db.pragma("query_only=ON");
      db.pragma("trusted_schema=OFF");
      db.pragma("busy_timeout=0");
      const integrity = db.pragma("quick_check", { simple: true });
      if (integrity !== "ok") throw new Error("SQLiteIntegrityFailed");
      const observations: Record<string, unknown> = {},
        issues: string[] = [];
      const schemaVersion = Number(db.pragma("user_version", { simple: true }));
      const supportedVersions: Record<WorkOpsDiagnosticRole, readonly number[]> = {
        executor: [5],
        broker: [1],
        sessions: [26],
        runtime: [0, 1],
      };
      const versionSupported = supportedVersions[role].includes(schemaVersion);
      if (!versionSupported) issues.push("UnsupportedSchemaVersion");
      for (const [name, sql] of versionSupported ? Object.entries(queries[role]) : []) {
        try {
          observations[name] = db.prepare(sql).all();
        } catch {
          issues.push(`UnsupportedSchema:${name}`);
        }
      }
      return {
        scope: "sealed-copy-diagnostics",
        role,
        sha256,
        schemaVersion,
        observations,
        issues,
        complete: false,
        restoreReady: false,
        liveHealth: "unknown",
        warning: "Counts describe supplied bytes only; custody and reservations remain retained.",
      };
    } finally {
      db.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
