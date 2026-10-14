import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";
import { invalidateAuthorizationChanges } from "./authorization-changes.js";
import { DeviceScopesSchema, IdentityGrantsSchema, DevicePrincipalSchema, type DevicePrincipal, type DeviceScope } from "@barry-rocks/sdk/internal/auth";

const PAIRING_TTL_MS = 300_000;
const UNUSED_TOKEN_TTL_MS = 600_000;
const CLAIM_INTERVAL_MS = 1_500;
const USAGE_INTERVAL_MS = 60_000;

export class DevicePairingError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryAfter?: number;
  constructor(code: string, status: number, retryAfter?: number) {
    super(code);
    this.name = "DevicePairingError";
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

interface PairingRow {
  id: string; code: string; client_name: string; requested_scopes: string; requested_identity_ids: string;
  approved_scopes: string | null; approved_identity_ids: string | null; actor_id: number | null;
  status: "pending" | "authorized" | "rejected" | "expired" | "consumed";
  created_at: number; expires_at: number; credential_expires_at: number | null; last_claim_at: number | null;
}
interface DeviceRow {
  id: string; name: string; token_hash: string; token_prefix: string; actor_id: number; scopes: string; identity_ids: string;
  created_at: number; unused_expires_at: number; expires_at: number | null;
  first_used_at: number | null; last_used_at: number | null; revoked_at: number | null;
}
import type { PairingInput, PairingGrant, PairingRequest, PairingClaim, DeviceRecord } from "@barry-rocks/sdk/internal/auth";
export type { PairingInput, PairingGrant, PairingRequest, PairingClaim, DeviceRecord } from "@barry-rocks/sdk/internal/auth";

function hash(secret: string): string { return createHash("sha256").update(secret).digest("hex"); }
function pairingCode(code: string): string {
  if (!/^\d{6}$|^\d{3}-\d{3}$/.test(code)) throw new DevicePairingError("invalid_pairing_code", 400);
  return code.replace("-", "");
}
function parseJson(text: string): unknown { try { return JSON.parse(text); } catch { return undefined; } }
function validTimestamp(value: unknown): boolean { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function grant(scopes: unknown, identityIds: unknown): { scopes: DeviceScope[]; identityIds: number[] } {
  const parsedScopes = DeviceScopesSchema.safeParse(scopes);
  const parsedIds = IdentityGrantsSchema.safeParse(identityIds);
  if (!parsedScopes.success || !parsedIds.success) throw new DevicePairingError("invalid_device_grant", 400);
  return { scopes: [...parsedScopes.data].sort(), identityIds: [...parsedIds.data].sort((a, b) => a - b) };
}

/** Synchronous transactions keep approval and token issuance atomic across processes. */
export class DeviceStore {
  private readonly db: Database.Database;
  private readonly now: () => number;
  constructor(db: Database.Database, now: () => number = Date.now) { this.db = db; this.now = now; }

  private expire(now: number): void {
    this.db.prepare("UPDATE pairing_requests SET status = 'expired' WHERE status IN ('pending', 'authorized') AND expires_at <= ?").run(now);
  }
  private ownsIdentities(actorId: number, ids: readonly number[]): boolean {
    if (!Number.isSafeInteger(actorId) || actorId <= 0 || !ids.length || ids.length > 64) return false;
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM identities i JOIN actors a ON a.id=i.actor_id
      WHERE a.id=? AND a.type='user' AND i.id IN (${ids.map(() => "?").join(",")})`).get(actorId, ...ids) as { count: number };
    return row.count === ids.length;
  }

  private principal(row: DeviceRow | undefined, now: number): DevicePrincipal | null {
    if (!row || !validTimestamp(now) || !validTimestamp(row.created_at) || !validTimestamp(row.unused_expires_at)
      || [row.expires_at, row.first_used_at, row.last_used_at].some(value => value !== null && !validTimestamp(value))
      || row.revoked_at !== null || (row.expires_at !== null && row.expires_at <= now)
      || (row.first_used_at === null && row.unused_expires_at <= now) || !/^[a-f0-9]{64}$/.test(row.token_hash)) return null;
    const parsed = DevicePrincipalSchema.safeParse({ kind: "device", credentialId: row.id, actorId: row.actor_id, scopes: parseJson(row.scopes), identityIds: parseJson(row.identity_ids) });
    return parsed.success && this.ownsIdentities(row.actor_id, parsed.data.identityIds) ? parsed.data : null;
  }

  /** Revalidation requires a previously authenticated principal; an ID alone is not a credential. */
  revalidate(input: DevicePrincipal): DevicePrincipal | null {
    const previous = DevicePrincipalSchema.safeParse(input);
    if (!previous.success) return null;
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT * FROM device_credentials WHERE id = ?").get(previous.data.credentialId) as DeviceRow | undefined;
      if (!row || row.first_used_at === null) return null;
      const current = this.principal(row, this.now());
      if (!current || current.actorId !== previous.data.actorId
        || current.scopes.length !== previous.data.scopes.length || !current.scopes.every(scope => previous.data.scopes.includes(scope))
        || current.identityIds.length !== previous.data.identityIds.length || !current.identityIds.every(id => previous.data.identityIds.includes(id))) return null;
      return current;
    }).deferred();
  }

  request(input: PairingInput, source: string): PairingRequest {
    const requested = grant(input.requestedScopes, input.requestedIdentityIds);
    // eslint-disable-next-line no-control-regex -- a device's name is shown to people; control characters are refused
    if (typeof input.clientName !== "string" || !input.clientName.trim() || input.clientName.length > 100 || /[\x00-\x1f\x7f]/.test(input.clientName)
      || typeof source !== "string" || !source || source.length > 256) throw new DevicePairingError("invalid_pairing_request", 400);
    return this.db.transaction(() => {
      const now = this.now();
      this.expire(now);
      this.db.prepare("DELETE FROM pairing_requests WHERE status = 'expired' AND actor_id IS NULL AND created_at < ?").run(now - 86_400_000);
      const sourceHash = hash(source);
      const recent = this.db.prepare("SELECT COUNT(*) AS count FROM pairing_requests WHERE source_hash = ? AND created_at > ?").get(sourceHash, now - 60_000) as { count: number };
      const active = this.db.prepare("SELECT COUNT(*) AS count FROM pairing_requests WHERE status IN ('pending', 'authorized')").get() as { count: number };
      const sourceActive = this.db.prepare("SELECT COUNT(*) AS count FROM pairing_requests WHERE source_hash = ? AND status IN ('pending', 'authorized')").get(sourceHash) as { count: number };
      if (recent.count >= 5 || sourceActive.count >= 5 || active.count >= 100) throw new DevicePairingError("pairing_rate_limited", 429, 60);
      for (let attempt = 0; attempt < 20; attempt++) {
        const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
        if (this.db.prepare("SELECT 1 FROM pairing_requests WHERE code = ? AND status IN ('pending', 'authorized')").get(code)) continue;
        const pollToken = `barry_pr_${randomBytes(24).toString("base64url")}`;
        const id = `pair_${randomUUID()}`;
        this.db.prepare(`INSERT INTO pairing_requests
          (id, code, poll_token_hash, source_hash, client_name, requested_scopes, requested_identity_ids, status, created_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`).run(id, code, hash(pollToken), sourceHash, input.clientName.trim(), JSON.stringify(requested.scopes), JSON.stringify(requested.identityIds), now, now + PAIRING_TTL_MS);
        return { requestId: id, pairingCode: `${code.slice(0, 3)}-${code.slice(3)}`, pollToken, expiresAt: now + PAIRING_TTL_MS, expiresIn: 300 };
      }
      throw new DevicePairingError("pairing_capacity_unavailable", 503);
    }).immediate();
  }

  authorize(code: string, actorId: number, approved: PairingGrant | null): { status: "authorized" | "rejected"; clientName: string } {
    const normalized = pairingCode(code);
    const approvedGrant = approved ? grant(approved.scopes, approved.identityIds) : null;
    return this.db.transaction(() => {
      const now = this.now();
      if (!Number.isSafeInteger(actorId) || actorId <= 0 || !this.db.prepare("SELECT 1 FROM actors WHERE id = ? AND type = 'user'").get(actorId)) throw new DevicePairingError("operator_denied", 403);
      this.expire(now);
      const row = this.db.prepare("SELECT * FROM pairing_requests WHERE code = ? AND status IN ('pending', 'authorized')").get(normalized) as PairingRow | undefined;
      if (!row) throw new DevicePairingError("pairing_unavailable", 410);
      if (row.status !== "pending") throw new DevicePairingError("pairing_already_decided", 409);
      if (!approved || !approvedGrant) {
        this.db.prepare("UPDATE pairing_requests SET status = 'rejected', actor_id = ?, approved_at = ? WHERE id = ? AND status = 'pending'").run(actorId, now, row.id);
        return { status: "rejected" as const, clientName: row.client_name };
      }
      const requested = grant(parseJson(row.requested_scopes), parseJson(row.requested_identity_ids));
      if (approvedGrant.scopes.some(scope => !requested.scopes.includes(scope)) || approvedGrant.identityIds.some(id => !requested.identityIds.includes(id))) throw new DevicePairingError("grant_would_expand_request", 403);
      if (!this.ownsIdentities(actorId, approvedGrant.identityIds)) throw new DevicePairingError("identity_grant_denied", 403);
      if (approved.expiresAt !== undefined && (!Number.isSafeInteger(approved.expiresAt) || approved.expiresAt <= now)) throw new DevicePairingError("invalid_credential_expiry", 400);
      this.db.prepare(`UPDATE pairing_requests SET status = 'authorized', approved_scopes = ?, approved_identity_ids = ?, actor_id = ?, approved_at = ?, credential_expires_at = ? WHERE id = ? AND status = 'pending'`)
        .run(JSON.stringify(approvedGrant.scopes), JSON.stringify(approvedGrant.identityIds), actorId, now, approved.expiresAt ?? null, row.id);
      return { status: "authorized" as const, clientName: row.client_name };
    }).immediate();
  }

  claim(pollToken: string): PairingClaim {
    if (typeof pollToken !== "string" || !/^barry_pr_[A-Za-z0-9_-]{32}$/.test(pollToken)) throw new DevicePairingError("invalid_poll_token", 401);
    return this.db.transaction(() => {
      const now = this.now();
      const row = this.db.prepare("SELECT * FROM pairing_requests WHERE poll_token_hash = ?").get(hash(pollToken)) as PairingRow | undefined;
      if (!row) throw new DevicePairingError("invalid_poll_token", 401);
      if (row.status === "consumed" || row.status === "rejected" || row.status === "expired") return { status: row.status };
      if (row.expires_at <= now) {
        this.db.prepare("UPDATE pairing_requests SET status = 'expired' WHERE id = ?").run(row.id);
        return { status: "expired" as const };
      }
      if (row.last_claim_at !== null && now - row.last_claim_at < CLAIM_INTERVAL_MS) throw new DevicePairingError("claim_rate_limited", 429, Math.ceil((CLAIM_INTERVAL_MS - (now - row.last_claim_at)) / 1000));
      this.db.prepare("UPDATE pairing_requests SET last_claim_at = ? WHERE id = ?").run(now, row.id);
      if (row.status === "pending") return { status: "pending" as const };
      const approved = grant(parseJson(row.approved_scopes ?? ""), parseJson(row.approved_identity_ids ?? ""));
      if (row.actor_id === null || !this.ownsIdentities(row.actor_id, approved.identityIds)) throw new DevicePairingError("identity_grant_denied", 403);
      if (row.credential_expires_at !== null && row.credential_expires_at <= now) {
        this.db.prepare("UPDATE pairing_requests SET status = 'expired' WHERE id = ?").run(row.id);
        return { status: "expired" as const };
      }
      const token = `barry_dt_${randomBytes(24).toString("base64url")}`;
      const deviceId = `device_${randomUUID()}`;
      this.db.prepare(`INSERT INTO device_credentials
        (id, name, token_hash, token_prefix, actor_id, scopes, identity_ids, created_at, unused_expires_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(deviceId, row.client_name, hash(token), token.slice(0, 17), row.actor_id, JSON.stringify(approved.scopes), JSON.stringify(approved.identityIds), now, now + UNUSED_TOKEN_TTL_MS, row.credential_expires_at);
      this.db.prepare("UPDATE pairing_requests SET status = 'consumed', issued_device_id = ? WHERE id = ? AND status = 'authorized'").run(deviceId, row.id);
      return { status: "authorized" as const, deviceId, deviceToken: token, ...approved };
    }).immediate();
  }

  verify(token: string): DevicePrincipal | null {
    if (typeof token !== "string" || !/^barry_dt_[A-Za-z0-9_-]{32}$/.test(token)) return null;
    return this.db.transaction(() => {
      const now = this.now();
      const digest = hash(token);
      const row = this.db.prepare("SELECT * FROM device_credentials WHERE token_hash = ?").get(digest) as DeviceRow | undefined;
      if (!row || !/^[a-f0-9]{64}$/.test(row.token_hash) || !timingSafeEqual(Buffer.from(digest, "hex"), Buffer.from(row.token_hash, "hex"))) return null;
      const principal = this.principal(row, now);
      if (!principal) return null;
      if (row.first_used_at === null || row.last_used_at === null || now - row.last_used_at >= USAGE_INTERVAL_MS) {
        this.db.prepare("UPDATE device_credentials SET first_used_at = COALESCE(first_used_at, ?), last_used_at = ? WHERE id = ? AND revoked_at IS NULL").run(now, now, row.id);
      }
      return principal;
    }).immediate();
  }

  list(actorId: number): DeviceRecord[] {
    const rows = this.db.prepare(`SELECT * FROM device_credentials WHERE actor_id = ? ORDER BY created_at, id`).all(actorId) as DeviceRow[];
    return rows.map(row => ({ id: row.id, name: row.name, tokenPrefix: row.token_prefix, actorId: row.actor_id,
      ...grant(parseJson(row.scopes), parseJson(row.identity_ids)), createdAt: row.created_at, unusedExpiresAt: row.unused_expires_at, expiresAt: row.expires_at,
      firstUsedAt: row.first_used_at, lastUsedAt: row.last_used_at, revokedAt: row.revoked_at }));
  }

  revoke(actorId: number, deviceId: string): boolean {
    const now = this.now();
    const result = this.db.prepare("UPDATE device_credentials SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ? AND actor_id = ?").run(now, deviceId, actorId);
    if (result.changes === 1) invalidateAuthorizationChanges(this.db.name);
    return result.changes === 1;
  }

  pending(): { requestId: string; pairingCode: string; clientName: string; requestedScopes: readonly DeviceScope[]; requestedIdentityIds: readonly number[]; expiresAt: number }[] {
    return this.db.transaction(() => {
      this.expire(this.now());
      const rows = this.db.prepare("SELECT * FROM pairing_requests WHERE status = 'pending' ORDER BY created_at, id").all() as PairingRow[];
      return rows.map(row => ({ requestId: row.id, pairingCode: `${row.code.slice(0, 3)}-${row.code.slice(3)}`, clientName: row.client_name,
        requestedScopes: grant(parseJson(row.requested_scopes), parseJson(row.requested_identity_ids)).scopes,
        requestedIdentityIds: grant(parseJson(row.requested_scopes), parseJson(row.requested_identity_ids)).identityIds, expiresAt: row.expires_at }));
    }).immediate();
  }
}
