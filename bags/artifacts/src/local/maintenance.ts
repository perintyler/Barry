import Database from "better-sqlite3";
import { lstatSync } from "node:fs";
import { resolve } from "node:path";
import { ArtifactContentSchema, ArtifactError, ArtifactIdSchema, TimestampSchema } from "../types.js";
import type { ArtifactBlob } from "../blobs.js";
import { createSqliteArtifactRepository } from "./catalog.js";
import type { LocalArtifactBlobs } from "./blobs.js";

const hashSchema = ArtifactContentSchema.unwrap().shape.sha256;
interface MaintenanceOptions {
  database: Database.Database; identityId: string; blobs: LocalArtifactBlobs;
  now: () => string; newId: () => string; graceMs?: number; budgetMs?: number;
}
export interface ArtifactMaintenanceReport {
  examined: number; cleanedIntents: number; collectedBlobs: number; protectedBlobs: number; verifiedBlobs: number; unavailableBlobs: number;
  budgetExhausted: boolean; failures: readonly { subject: string; message: string }[];
}
export function createLocalArtifactMaintenance({ database, identityId, blobs, now, newId, graceMs = 600_000, budgetMs = 200 }: MaintenanceOptions) {
  if (!Number.isSafeInteger(budgetMs) || budgetMs < 1 || budgetMs > 1000) throw new ArtifactError("unavailable");
  if (!Number.isSafeInteger(graceMs) || graceMs < 120_000) throw new ArtifactError("unavailable");
  if (database.name === ":memory:" || blobs.directory !== `${resolve(database.name)}.blobs`) throw new ArtifactError("forbidden");
  createSqliteArtifactRepository(database, identityId);
  const filepath = resolve(database.name), originalFile = lstatSync(filepath);
  const generation = (database.prepare("SELECT token FROM artifact_storage_generation WHERE singleton = 1").get() as { token: string }).token;
  const requireGeneration = () => {
    blobs.assertCurrent();
    const before = lstatSync(filepath);
    if (!before.isFile() || before.isSymbolicLink() || before.ino !== originalFile.ino || before.dev !== originalFile.dev) throw new ArtifactError("unavailable");
    const current = new Database(filepath, { readonly: true, fileMustExist: true, timeout: 100 });
    try {
      current.pragma("query_only = ON");
      const actual = current.prepare("SELECT token FROM artifact_storage_generation WHERE singleton = 1").get() as { token: string } | undefined;
      if (actual?.token !== generation) throw new ArtifactError("unavailable");
    } finally { current.close(); }
    const after = lstatSync(filepath);
    if (after.ino !== before.ino || after.dev !== before.dev) throw new ArtifactError("unavailable");
  };
  requireGeneration();
  const transaction = <T>(operation: () => T): T => {
    if (database.inTransaction) throw new ArtifactError("unavailable");
    requireGeneration();
    return database.transaction(() => { requireGeneration(); return operation(); }).immediate();
  };
  const clock = () => TimestampSchema.parse(now());
  const protectedBlob = (sha256: string, timestamp: string) => Boolean(
    database.prepare("SELECT 1 FROM artifacts WHERE sha256 = ? LIMIT 1").get(sha256)
    || database.prepare("SELECT 1 FROM blob_intents WHERE sha256 = ? AND expires_at > ? LIMIT 1").get(sha256, timestamp)
    || database.prepare("SELECT 1 FROM artifact_blob_pins WHERE sha256 = ? LIMIT 1").get(sha256),
  );
  const cursor = (key: string) => (database.prepare("SELECT value FROM artifact_maintenance_progress WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? "";
  const advance = (key: string, value: string) => transaction(() => database.prepare("INSERT INTO artifact_maintenance_progress VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value));
  const cutoff = (timestamp: string) => new Date(Date.parse(timestamp) - graceMs).toISOString();
  const markDeletion = (blob: ArtifactBlob) => transaction(() => {
    hashSchema.parse(blob.sha256);
    if (protectedBlob(blob.sha256, clock())) return undefined;
    const previous = database.prepare("SELECT token FROM blob_deletions WHERE sha256 = ?").get(blob.sha256) as { token: string } | undefined;
    if (previous) return previous.token;
    const token = ArtifactIdSchema.parse(newId());
    database.prepare("INSERT INTO blob_deletions VALUES (?, ?, ?, ?)").run(blob.sha256, blob.size, token, clock());
    return token;
  });
  const collect = (blob: ArtifactBlob, token: string) => transaction(() => {
    const ticket = database.prepare("SELECT 1 FROM blob_deletions WHERE sha256 = ? AND token = ? AND size = ?").get(blob.sha256, token, blob.size);
    if (!ticket || protectedBlob(blob.sha256, clock())) return false;
    // Keep the writer lock through deletion/ack so a stale worker cannot unlink republished bytes.
    blobs.removeSync(blob);
    database.prepare("INSERT INTO blob_gc_completed VALUES (?, ?) ON CONFLICT(sha256) DO UPDATE SET deleted_at = excluded.deleted_at").run(blob.sha256, clock());
    database.prepare("DELETE FROM blob_deletions WHERE sha256 = ? AND token = ?").run(blob.sha256, token);
    return true;
  });
  return {
    pin(pinId: string, hashes: readonly string[]) {
      ArtifactIdSchema.parse(pinId);
      if (hashes.length > 1000) throw new ArtifactError("too_large");
      transaction(() => {
        for (const hash of hashes) {
          hashSchema.parse(hash);
          if (database.prepare("SELECT 1 FROM blob_deletions WHERE sha256 = ?").get(hash)) throw new ArtifactError("unavailable");
          database.prepare("INSERT OR IGNORE INTO artifact_blob_pins VALUES (?, ?)").run(pinId, hash);
        }
      });
    },
    releasePin(pinId: string) {
      ArtifactIdSchema.parse(pinId);
      transaction(() => database.prepare("DELETE FROM artifact_blob_pins WHERE pin_id = ?").run(pinId));
    },
    run(limit = 64): ArtifactMaintenanceReport {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ArtifactError("unavailable");
      if (database.inTransaction) throw new ArtifactError("unavailable");
      requireGeneration();
      const deadline = performance.now() + budgetMs;
      const timestamp = clock(), age = cutoff(timestamp), failures: { subject: string; message: string }[] = [];
      let examined = 0, cleanedIntents = 0, collectedBlobs = 0, protectedBlobs = 0, verifiedBlobs = 0, unavailableBlobs = 0;
      const selectIntents = (after: string) => database.prepare(`SELECT i.id FROM blob_intents i WHERE i.id > ? AND i.expires_at <= ? AND i.created_at <= ?
        AND NOT EXISTS (SELECT 1 FROM intent_cleanup c WHERE c.intent_id = i.id) ORDER BY i.id LIMIT ?`)
        .all(after, timestamp, age, limit) as { id: string }[];
      let intents = selectIntents(cursor("intents"));
      if (!intents.length) { advance("intents", ""); intents = selectIntents(""); }
      for (const intent of intents) {
        if (performance.now() >= deadline) break;
        examined++;
        try {
          const cleaned = transaction(() => {
            if (!database.prepare("SELECT 1 FROM blob_intents WHERE id = ? AND expires_at <= ? AND created_at <= ?").get(intent.id, clock(), cutoff(clock()))) return false;
            if (database.prepare("SELECT 1 FROM intent_cleanup WHERE intent_id = ?").get(intent.id)) return false;
            blobs.discardSync(intent.id);
            database.prepare("UPDATE blob_intents SET status = 'failed' WHERE id = ? AND status IN ('uploading','staged','published')").run(intent.id);
            database.prepare("INSERT INTO intent_cleanup VALUES (?, ?)").run(intent.id, clock());
            return true;
          });
          if (cleaned) cleanedIntents++;
        } catch (error) { failures.push({ subject: intent.id, message: error instanceof Error ? error.message : "Intent cleanup failed" }); }
        advance("intents", intent.id);
      }
      const selectCandidates = (after: string) => database.prepare(`SELECT sha256, max(size) AS size FROM blob_intents
        WHERE sha256 IS NOT NULL AND sha256 > ? AND NOT EXISTS (SELECT 1 FROM blob_gc_completed g WHERE g.sha256 = blob_intents.sha256)
        GROUP BY sha256 HAVING min(created_at) <= ? ORDER BY sha256 LIMIT ?`)
        .all(after, age, limit) as ArtifactBlob[];
      let candidates = performance.now() < deadline ? selectCandidates(cursor("blobs")) : undefined;
      if (candidates && !candidates.length) { advance("blobs", ""); candidates = selectCandidates(""); }
      for (const blob of candidates ?? []) {
        if (performance.now() >= deadline) break;
        examined++;
        try {
          const token = markDeletion(blob);
          if (!token) protectedBlobs++;
          else if (collect(blob, token)) collectedBlobs++;
        } catch (error) { failures.push({ subject: blob.sha256, message: error instanceof Error ? error.message : "Blob collection failed" }); }
        advance("blobs", blob.sha256);
      }
      const selectReferences = (after: string) => database.prepare("SELECT sha256, max(size) AS size FROM artifacts WHERE sha256 > ? GROUP BY sha256 ORDER BY sha256 LIMIT ?").all(after, limit) as ArtifactBlob[];
      let references = performance.now() < deadline ? selectReferences(cursor("references")) : undefined;
      if (references && !references.length) { advance("references", ""); references = selectReferences(""); }
      for (const blob of references ?? []) {
        if (performance.now() >= deadline) break;
        examined++;
        try { requireGeneration(); blobs.verifySync(blob); verifiedBlobs++; }
        catch (error) { unavailableBlobs++; failures.push({ subject: blob.sha256, message: error instanceof Error ? error.message : "Referenced content unavailable" }); }
        advance("references", blob.sha256);
      }
      return Object.freeze({ examined, cleanedIntents, collectedBlobs, protectedBlobs, verifiedBlobs, unavailableBlobs, budgetExhausted: performance.now() >= deadline, failures: Object.freeze(failures.map(failure => Object.freeze(failure))) });
    },
  };
}
