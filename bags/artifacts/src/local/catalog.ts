import { migrateStore } from "@barry-rocks/sdk/stores";
import { createHash } from "node:crypto";
import migrations from "../generated/artifacts-migrations.js";
import type Database from "better-sqlite3";
import {
  ArtifactError, ArtifactListSchema, ArtifactMetadataSchema, ArtifactRecordSchema, IdentityIdSchema,
  ShareGrantRecordSchema, TimestampSchema,
  type ArtifactRecord, type ShareGrantRecord,
} from "../types.js";
import type { ArtifactTransaction } from "../core.js";

import { ArtifactUploadIntentSchema, type ArtifactCreationRepository } from "../create.js";
import { MAX_ARTIFACT_BYTES, type ArtifactBlob } from "../blobs.js";
import { requireArtifactActivationComplete } from "./activation-journal.js";

const selection = `SELECT a.*, m.title, m.tags, m.revision, m.updated_at
  FROM artifacts a JOIN artifact_metadata m ON m.artifact_id = a.id`;
interface ArtifactRow {
  id: string; identity_id: string; filename: string; mime_type: string; size: number;
  sha256: string; kind: string; created_at: string; creator_actor_id: number;
  creator_identity_id: string; session_id: string | null; derived_from: string | null;
  title: string | null; tags: string; revision: number; updated_at: string;
}
function parseArtifact(row: ArtifactRow): ArtifactRecord {
  return ArtifactRecordSchema.parse({
    id: row.id, identityId: row.identity_id,
    content: { filename: row.filename, mimeType: row.mime_type, size: row.size, sha256: row.sha256,
      kind: row.kind, createdAt: row.created_at,
      creator: { actorId: row.creator_actor_id, identityId: row.creator_identity_id },
      sessionId: row.session_id, derivedFrom: row.derived_from },
    metadata: { title: row.title, tags: JSON.parse(row.tags), revision: row.revision, updatedAt: row.updated_at },
  });
}
export function sealArtifactGeneration(database: Database.Database, identityId: string, generation: string, sealedAt: string): void {
  IdentityIdSchema.parse(identityId);
  TimestampSchema.parse(sealedAt);
  if (!/^[a-f0-9]{32}$/.test(generation) || database.inTransaction) throw new ArtifactError("unavailable");
  database.pragma("synchronous = FULL");
  database.transaction(() => {
    const owner = database.prepare("SELECT identity_id FROM artifact_catalog WHERE singleton=1").get() as { identity_id: string } | undefined;
    if (owner?.identity_id !== identityId) throw new ArtifactError("forbidden");
    const current = database.prepare("SELECT token FROM artifact_storage_generation WHERE singleton=1").get() as { token: string } | undefined;
    if (current?.token !== generation) throw new ArtifactError("unavailable");
    const status = database.prepare("SELECT state FROM artifact_generation_status WHERE singleton=1").get() as { state: string } | undefined;
    if (status?.state === "sealed") return;
    const changed = database.prepare("UPDATE artifact_generation_status SET state='sealed',sealed_at=? WHERE singleton=1 AND state='active'").run(sealedAt).changes;
    if (changed !== 1) throw new ArtifactError("unavailable");
  }).immediate();
}
export function createSqliteArtifactRepository(database: Database.Database, identityId: string, options: { readonly?: boolean } = {}): ArtifactCreationRepository {
  IdentityIdSchema.parse(identityId);
  // A caller-owned transaction could acknowledge a write before it becomes durable.
  if (database.inTransaction) throw new ArtifactError("unavailable");
  requireArtifactActivationComplete(database.name);
  if (options.readonly && (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='artifact_catalog'").get()
    || !database.prepare("SELECT 1 FROM artifact_catalog WHERE singleton=1").get())) throw new ArtifactError("not_found");
  if (database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'artifact_catalog'").get()) {
    const owner = database.prepare("SELECT identity_id, schema_version FROM artifact_catalog WHERE singleton = 1").get() as { identity_id: string; schema_version: number } | undefined;
    if (owner && owner.identity_id !== identityId) throw new ArtifactError("forbidden");
    if (owner && owner.schema_version !== 1) throw new ArtifactError("unavailable");
  }
  if (database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'artifact_schema_migrations'").get()
    && database.prepare("SELECT 1 FROM artifact_schema_migrations WHERE version > 3").get()) throw new ArtifactError("unavailable");
  const sealed = Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='artifact_generation_status'").get()
    && (database.prepare("SELECT state FROM artifact_generation_status WHERE singleton=1").get() as { state: string } | undefined)?.state === "sealed");
  database.pragma("foreign_keys = ON");
  if (sealed || options.readonly) {
    if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get()) throw new ArtifactError("unavailable");
    const history = database.prepare("SELECT version,name,checksum FROM schema_migrations ORDER BY version").all() as { version: number; name: string; checksum: string }[];
    if (database.pragma("user_version", { simple: true }) !== migrations.length || history.length !== migrations.length
      || history.some((entry, index) => entry.version !== index + 1 || entry.name !== migrations[index].name
        || entry.checksum !== createHash("sha256").update(migrations[index].sql).digest("hex"))) throw new ArtifactError("unavailable");
  }
  if (!sealed && !options.readonly) {
    database.pragma("journal_mode = WAL");
    database.pragma("synchronous = FULL");
    migrateStore(database, migrations, database.name);
    database.transaction(() => {
      if (!database.prepare("SELECT 1 FROM artifact_catalog WHERE singleton = 1").get()) database.prepare("INSERT INTO artifact_catalog VALUES (1, ?, 1)").run(identityId);
      const catalog = database.prepare("SELECT identity_id,schema_version FROM artifact_catalog WHERE singleton=1").get() as { identity_id: string; schema_version: number };
      if (catalog.identity_id !== identityId) throw new ArtifactError("forbidden");
      if (catalog.schema_version !== 1) throw new ArtifactError("unavailable");
    }).immediate();
  }
  const requireWritable = () => {
    if (options.readonly) throw new ArtifactError("unavailable");
    requireArtifactActivationComplete(database.name);
    const status = database.prepare("SELECT state FROM artifact_generation_status WHERE singleton=1").get() as { state: string } | undefined;
    if (status?.state !== "active") throw new ArtifactError("unavailable");
  };
  const lookup = database.prepare(`${selection} WHERE a.id = ?`);
  const get = (id: string) => {
    const row = lookup.get(id) as ArtifactRow | undefined;
    return row ? parseArtifact(row) : undefined;
  };
interface ShareRow {
  id: string; artifact_id: string; identity_id: string; token_hash: string;
  expires_at: string; revoked: number; password_salt: string | null;
  password_hash: string | null; revision: number; created_at: string; updated_at: string;
}
function parseShareGrant(row: ShareRow): ShareGrantRecord {
  return ShareGrantRecordSchema.parse({
    id: row.id, artifactId: row.artifact_id, identityId: row.identity_id,
    tokenHash: row.token_hash, expiresAt: row.expires_at, revoked: Boolean(row.revoked),
    passwordSalt: row.password_salt, passwordHash: row.password_hash,
    revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at,
  });
}
  const lookupShare = database.prepare("SELECT * FROM share_grants WHERE id = ?");
  const lookupShareByHash = database.prepare("SELECT * FROM share_grants WHERE token_hash = ?");
  const listSharesForArtifact = database.prepare("SELECT * FROM share_grants WHERE artifact_id = ? ORDER BY created_at DESC");
  const insertShare = database.prepare("INSERT INTO share_grants VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const revokeShareStmt = database.prepare("UPDATE share_grants SET revoked = 1, revision = revision + 1, updated_at = ? WHERE id = ?");
  const replace = database.prepare(`UPDATE artifact_metadata SET title = ?, tags = ?, revision = ?, updated_at = ?
    WHERE artifact_id = ? AND revision = ?`);
  const committed = <T>(operation: () => T): T => {
    if (database.inTransaction) throw new ArtifactError("unavailable");
    return database.transaction(() => { requireWritable(); const result = operation(); requireWritable(); return result; }).immediate();
  };
  const validateBlob = (blob: ArtifactBlob) => {
    ArtifactRecordSchema.unwrap().shape.content.unwrap().shape.sha256.parse(blob.sha256);
    if (!Number.isSafeInteger(blob.size) || blob.size < 0 || blob.size > MAX_ARTIFACT_BYTES) throw new ArtifactError("too_large");
  };
  return {
    identityId,
    beginIntent(input) {
      const intent = ArtifactUploadIntentSchema.parse(input);
      if (intent.expiresAt <= intent.createdAt) throw new ArtifactError("unavailable");
      committed(() => database.prepare("INSERT INTO blob_intents VALUES (?, ?, ?, 'uploading', NULL, NULL)").run(intent.id, intent.createdAt, intent.expiresAt));
    },
    stageIntent(id, blob, now) {
      TimestampSchema.parse(now); validateBlob(blob);
      committed(() => {
        if (database.prepare("SELECT 1 FROM blob_deletions WHERE sha256 = ?").get(blob.sha256)) throw new ArtifactError("unavailable");
        const changed = database.prepare("UPDATE blob_intents SET status = 'staged', sha256 = ?, size = ? WHERE id = ? AND status = 'uploading' AND expires_at > ?").run(blob.sha256, blob.size, id, now).changes;
        if (changed !== 1) throw new ArtifactError("unavailable");
        database.prepare("DELETE FROM blob_gc_completed WHERE sha256 = ?").run(blob.sha256);
      });
    },
    publishIntent(id, now) {
      TimestampSchema.parse(now);
      committed(() => {
        const changed = database.prepare("UPDATE blob_intents SET status = 'published' WHERE id = ? AND status = 'staged' AND expires_at > ?").run(id, now).changes;
        if (changed !== 1) throw new ArtifactError("unavailable");
      });
    },
    failIntent(id) {
      committed(() => database.prepare("UPDATE blob_intents SET status = 'failed' WHERE id = ? AND status != 'complete'").run(id));
    },
    commitArtifact(input) {
      const artifact = ArtifactRecordSchema.parse(input.record); validateBlob(artifact.content);
      TimestampSchema.parse(input.now);
      ArtifactRecordSchema.unwrap().shape.content.unwrap().shape.sha256.parse(input.fingerprint);
      if (artifact.identityId !== identityId) throw new ArtifactError("forbidden");
      if (artifact.metadata.revision !== 1) throw new ArtifactError("conflict");
      return committed(() => {
        input.checkActive();
        if (database.prepare("SELECT 1 FROM blob_deletions WHERE sha256 = ?").get(artifact.content.sha256)) throw new ArtifactError("unavailable");
        const intent = database.prepare("SELECT 1 FROM blob_intents WHERE id = ? AND status = 'published' AND expires_at > ? AND sha256 = ? AND size = ?")
          .get(input.intentId, input.now, artifact.content.sha256, artifact.content.size);
        if (!intent) throw new ArtifactError("unavailable");
        const previous = database.prepare("SELECT fingerprint, artifact_id FROM creation_requests WHERE idempotency_key = ?")
          .get(input.idempotencyKey) as { fingerprint: string; artifact_id: string } | undefined;
        let saved: ArtifactRecord;
        if (previous) {
          if (previous.fingerprint !== input.fingerprint) throw new ArtifactError("conflict");
          const existing = get(previous.artifact_id);
          if (!existing) throw new ArtifactError("unavailable");
          saved = existing;
        } else {
          const content = artifact.content, metadata = artifact.metadata;
          database.prepare("INSERT INTO artifacts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
            .run(artifact.id, identityId, content.filename, content.mimeType, content.size, content.sha256, content.kind, content.createdAt, content.creator.actorId, content.creator.identityId, content.sessionId, content.derivedFrom);
          database.prepare("INSERT INTO artifact_metadata VALUES (?, ?, ?, ?, ?)").run(artifact.id, metadata.title, JSON.stringify(metadata.tags), metadata.revision, metadata.updatedAt);
          database.prepare("INSERT INTO creation_requests VALUES (?, ?, ?)").run(input.idempotencyKey, input.fingerprint, artifact.id);
          saved = artifact;
        }
        database.prepare("UPDATE blob_intents SET status = 'complete' WHERE id = ?").run(input.intentId);
        input.checkActive();
        return saved;
      });
    },
    async get(id) {
      if (database.inTransaction) throw new ArtifactError("unavailable");
      return get(id);
    },
    transaction<T>(operation: (transaction: ArtifactTransaction) => T): T {
      if (database.inTransaction) throw new ArtifactError("unavailable");
      return database.transaction(() => {
        requireWritable();
        let active = true;
        const requireActive = () => { if (!active) throw new ArtifactError("unavailable"); };
        try {
          const outcome = operation({
            get(id) { requireActive(); return get(id); },
            replaceMetadata(id, expectedRevision, metadata) {
              requireActive();
              const validated = ArtifactMetadataSchema.parse(metadata);
              return replace.run(validated.title, JSON.stringify(validated.tags), validated.revision, validated.updatedAt, id, expectedRevision).changes === 1;
            },
            getShare(shareId) {
              requireActive();
              const row = lookupShare.get(shareId) as ShareRow | undefined;
              return row ? parseShareGrant(row) : undefined;
            },
            createShare(share) {
              requireActive();
              const validated = ShareGrantRecordSchema.parse(share);
              insertShare.run(
                validated.id, validated.artifactId, validated.identityId, validated.tokenHash,
                validated.expiresAt, validated.revoked ? 1 : 0, validated.passwordSalt, validated.passwordHash,
                validated.revision, validated.createdAt, validated.updatedAt
              );
            },
            updateShare(shareId, expectedRevision, update) {
              requireActive();
              const existing = lookupShare.get(shareId) as ShareRow | undefined;
              if (!existing || existing.revision !== expectedRevision) return false;
              const revoked = update.revoked !== undefined ? (update.revoked ? 1 : 0) : existing.revoked;
              const expiresAt = update.expiresAt ?? existing.expires_at;
              const passwordSalt = update.passwordSalt !== undefined ? update.passwordSalt : existing.password_salt;
              const passwordHash = update.passwordHash !== undefined ? update.passwordHash : existing.password_hash;
              const nextRev = update.revision;
              const updatedAt = update.updatedAt;
              return database.prepare("UPDATE share_grants SET revoked = ?, expires_at = ?, password_salt = ?, password_hash = ?, revision = ?, updated_at = ? WHERE id = ? AND revision = ?")
                .run(revoked, expiresAt, passwordSalt, passwordHash, nextRev, updatedAt, shareId, expectedRevision).changes === 1;
            },
            revokeShare(shareId) {
              requireActive();
              const existing = lookupShare.get(shareId) as ShareRow | undefined;
              if (!existing) return false;
              if (existing.revoked === 1) return true;
              return revokeShareStmt.run(new Date().toISOString(), shareId).changes === 1;
            },
          });
          if (outcome && typeof (outcome as { then?: unknown }).then === "function") {
            // The rejected callback can finish later; its late failure must not crash the service.
            void Promise.resolve(outcome).catch(() => undefined);
            throw new ArtifactError("unavailable");
          }
          return outcome;
        } finally { active = false; }
      }).immediate();
    },
    async getShare(shareId) {
      if (database.inTransaction) throw new ArtifactError("unavailable");
      const row = lookupShare.get(shareId) as ShareRow | undefined;
      return row ? parseShareGrant(row) : undefined;
    },
    async getShareByTokenHash(tokenHash) {
      if (database.inTransaction) throw new ArtifactError("unavailable");
      const row = lookupShareByHash.get(tokenHash) as ShareRow | undefined;
      return row ? parseShareGrant(row) : undefined;
    },
    async listShares(artifactId) {
      if (database.inTransaction) throw new ArtifactError("unavailable");
      const rows = listSharesForArtifact.all(artifactId) as ShareRow[];
      return Object.freeze(rows.map(parseShareGrant));
    },
    async list(input) {
      if (database.inTransaction) throw new ArtifactError("unavailable");
      const filters = ArtifactListSchema.parse(input), conditions: string[] = [], parameters: (string | number)[] = [];
      if (filters.cursor) {
        conditions.push("(a.created_at < ? OR (a.created_at = ? AND a.id < ?))");
        parameters.push(filters.cursor.createdAt, filters.cursor.createdAt, filters.cursor.id);
      }
      if (filters.kind) { conditions.push("a.kind = ?"); parameters.push(filters.kind); }
      if (filters.sessionId) { conditions.push("a.session_id = ?"); parameters.push(filters.sessionId); }
      if (filters.query) {
        const pattern = `%${filters.query.replace(/[\\%_]/g, character => `\\${character}`)}%`;
        conditions.push(`(a.filename LIKE ? ESCAPE '\\' OR m.title LIKE ? ESCAPE '\\' OR a.kind LIKE ? ESCAPE '\\'
          OR EXISTS (SELECT 1 FROM json_each(m.tags) WHERE value LIKE ? ESCAPE '\\'))`);
        parameters.push(pattern, pattern, pattern, pattern);
      }
      parameters.push(filters.limit);
      const sql = `${selection}${conditions.length ? ` WHERE ${conditions.join(" AND ")}` : ""}
        ORDER BY a.created_at DESC, a.id DESC LIMIT ?`;
      return Object.freeze((database.prepare(sql).all(...parameters) as ArtifactRow[]).map(parseArtifact));
    },
  };
}
