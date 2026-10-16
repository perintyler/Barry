import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, statSync, statfsSync, existsSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { z } from "zod";
import { SqliteDatabase } from "../stores/sqlite-connection.js";
import {
  approvedBoundsSchema,
  boundFingerprint,
  type ApprovedBounds,
} from "../bounds/workflow-bounds.js";
import {
  workNamespaceSchema,
  workOriginSchema,
  workDefinitionSchema,
  workSubmissionSchema,
  workIntentHash,
  type WorkSubmission,
} from "./work-contracts.js";
import type { WorkAuthority } from "./work-authority.js";
import { encodeEnvelope } from "./types.js";
import { WorkflowError } from "./errors.js";

const ref = z.string().min(1).max(200);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const instant = z.number().int().nonnegative();
const DOMAIN = "barry.work-admission.v2\0";
const AUDIENCE = "workflows.runtime:actions";
const MAX_LIFETIME = 60000;
const authoritySchema = z.strictObject({
  namespace: workNamespaceSchema,
  caller_ceiling: approvedBoundsSchema,
  origin: workOriginSchema,
  run_identity: ref.nullable(),
});
export const workDelegationRecordSchema = z.strictObject({
  version: z.literal(2),
  issuer: ref,
  grant_ref: ref,
  request_hash: hash,
  authority: authoritySchema,
  definition: workDefinitionSchema,
  requested_overrides: workSubmissionSchema.shape.overrides.nullable(),
  source_kind: z.enum(["operator", "session", "schedule", "event", "internal"]),
  definition_owner_session: ref.nullable(),
  background_parent: z.literal(false),
  created_at: instant,
});
export type WorkDelegationRecord = z.infer<typeof workDelegationRecordSchema>;
const claimsSchema = z.strictObject({
  version: z.literal(2),
  audience: z.literal(AUDIENCE),
  issuer: ref,
  key_id: ref,
  installation: ref,
  grant_ref: ref,
  record_digest: hash,
  request_hash: hash,
  request_id: z.uuid(),
  nonce: z.uuid(),
  issued_at: instant,
  expires_at: instant,
});
export interface DelegationKey {
  id: string;
  secret: string;
  not_before: number;
  not_after: number;
}
export interface WorkDelegationCredentials {
  assertion: string;
  record: WorkDelegationRecord;
}
function denied(message = "Invalid work delegation."): never {
  throw new WorkflowError("InvalidDelegation", message, 403);
}
function validScope(scope: ApprovedBounds): void {
  const { fingerprint, ...body } = approvedBoundsSchema.parse(scope);
  if (boundFingerprint(body) !== fingerprint) denied("Caller ceiling evidence is invalid.");
}
function recordRules(record: WorkDelegationRecord): void {
  const { authority, source_kind: kind } = record;
  validScope(authority.caller_ceiling);
  if (
    authority.namespace.principal_kind !== "operator" &&
    authority.namespace.principal_id === "local-operator"
  )
    denied("Reserved operator identity cannot be delegated as a session or producer.");
  if ((authority.origin.caller_session_id ?? null) !== authority.namespace.caller_session_id)
    denied("Caller session provenance differs from its namespace.");
  if (
    kind === "session" &&
    (!authority.namespace.caller_session_id || authority.namespace.principal_kind !== "identity")
  )
    denied("Session origin requires an authenticated identity and session.");
  if (kind === "operator" && authority.namespace.principal_kind !== "operator")
    denied("An originating session cannot become an operator.");
  if (
    ["schedule", "event", "internal"].includes(kind) &&
    (authority.namespace.principal_kind !== "service" ||
      authority.origin.trigger !== kind ||
      !authority.origin.producer_ref ||
      !authority.origin.occurrence_id)
  )
    denied("Producer origin requires an authenticated occurrence.");
  if (
    ["session", "operator"].includes(kind) &&
    !["invocation", "manual"].includes(authority.origin.trigger)
  )
    denied("Interactive origin cannot claim a protected producer lane.");
  if (
    record.definition_owner_session !== null &&
    record.definition_owner_session !== authority.namespace.caller_session_id
  )
    denied("Ad-hoc definition belongs to another session.");
  if ((authority.namespace.identity_id === null) !== (authority.run_identity === null))
    denied("Run identity must have a stable namespace reference.");
}
function selectKey(keys: DelegationKey[], id: string, now: number): DelegationKey {
  if (keys.length > 4 || new Set(keys.map((key) => key.id)).size !== keys.length)
    denied("Delegation key ring is ambiguous or exceeds its bound.");
  const key = keys.find((key) => key.id === id);
  if (
    !key ||
    key.secret.length < 32 ||
    !Number.isSafeInteger(key.not_before) ||
    !Number.isSafeInteger(key.not_after) ||
    key.not_before > now ||
    key.not_after <= now
  )
    denied("Delegation key is unavailable or retired.");
  return key;
}
function signature(key: DelegationKey, payload: string): Buffer {
  return createHmac("sha256", key.secret).update(DOMAIN).update(payload).digest();
}

/** Issuer-side immutable evidence. Register only after the normal API/CLI/MCP/producer boundary authenticates and authorizes. */
export class WorkDelegationIssuer {
  private db: SqliteDatabase;
  private uncertain = false;
  constructor(
    private readonly options: {
      path: string;
      issuer: string;
      signingKey: () => DelegationKey;
      now?: () => number;
    },
  ) {
    if (!isAbsolute(options.path)) throw new Error("issuer evidence path must be absolute");
    mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
    this.db = new SqliteDatabase(options.path);
    try {
      const version = Number(this.db.prepare("PRAGMA user_version").get()?.user_version);
      if (version > 2) throw new Error("unsupported work delegation store version");
      this.db.exec(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=50; BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS delegation_records(grant_ref TEXT PRIMARY KEY,request_hash TEXT NOT NULL,record_digest TEXT NOT NULL,record TEXT NOT NULL); CREATE TABLE IF NOT EXISTS delegation_meta(issuer TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS delegation_preparations(namespace_hash TEXT NOT NULL,idempotency_key TEXT NOT NULL,grant_ref TEXT NOT NULL,PRIMARY KEY(namespace_hash,idempotency_key)); CREATE TRIGGER IF NOT EXISTS delegation_records_immutable BEFORE UPDATE ON delegation_records BEGIN SELECT RAISE(ABORT,'delegation evidence is immutable'); END; CREATE TRIGGER IF NOT EXISTS delegation_preparations_immutable BEFORE UPDATE ON delegation_preparations BEGIN SELECT RAISE(ABORT,'prepared authority binding is immutable'); END; PRAGMA user_version=2;",
      );
      const previous = this.db.prepare("SELECT issuer FROM delegation_meta").get();
      if (previous && previous.issuer !== options.issuer)
        throw new Error("delegation store belongs to another issuer");
      this.db.prepare("INSERT OR IGNORE INTO delegation_meta VALUES(?)").run(options.issuer);
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* Original startup fault. */
      }
      this.db.close();
      throw error;
    }
  }
  private ensureConnection(): void {
    if (!this.uncertain) return;
    try {
      if (this.db.isOpen) this.db.close();
      const replacement = new SqliteDatabase(this.options.path);
      try {
        if (
          Number(replacement.prepare("PRAGMA user_version").get()?.user_version) !== 2 ||
          replacement.prepare("SELECT issuer FROM delegation_meta").get()?.issuer !==
            this.options.issuer
        )
          throw new Error("issuer store identity/schema differs");
        replacement.exec(
          "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=50",
        );
      } catch (error) {
        replacement.close();
        throw error;
      }
      this.db = replacement;
      this.uncertain = false;
    } catch {
      throw new WorkflowError(
        "AuthorityStoreUnavailable",
        "Issuer evidence storage is unavailable; preserve the authority reference.",
        503,
        true,
      );
    }
  }
  register(
    request: WorkSubmission,
    authority: WorkAuthority,
    source: {
      kind: WorkDelegationRecord["source_kind"];
      definition_owner_session: string | null;
      background_parent: boolean;
    },
  ): WorkDelegationRecord {
    this.ensureConnection();
    request = workSubmissionSchema.parse(request);
    if (source.background_parent) denied("Nested detached delegation is not permitted.");
    const record = workDelegationRecordSchema.parse({
      version: 2,
      issuer: this.options.issuer,
      grant_ref: request.authority_ref,
      request_hash: workIntentHash(request, authority.namespace),
      authority: authoritySchema.parse(authority),
      definition: request.definition,
      requested_overrides: request.overrides ?? null,
      source_kind: source.kind,
      definition_owner_session: source.definition_owner_session,
      background_parent: false,
      created_at: (this.options.now ?? Date.now)(),
    });
    recordRules(record);
    if (boundFingerprint(request.origin) !== boundFingerprint(record.authority.origin))
      denied("Requested origin is not authenticated.");
    this.db.exec("BEGIN IMMEDIATE");
    let committing = false;
    try {
      const previous = this.db
        .prepare(
          "SELECT request_hash,record_digest,record FROM delegation_records WHERE grant_ref=?",
        )
        .get(record.grant_ref);
      if (previous) {
        const stored = workDelegationRecordSchema.parse(JSON.parse(String(previous.record)));
        if (
          previous.request_hash !== record.request_hash ||
          boundFingerprint({ ...stored, created_at: 0 }) !==
            boundFingerprint({ ...record, created_at: 0 })
        )
          denied("Authority reference already identifies different intent or caller evidence.");
        committing = true;
        this.db.exec("COMMIT");
        return stored;
      }
      const encoded = encodeEnvelope(record);
      if (Number(this.db.prepare("SELECT count(*) n FROM delegation_records").get()?.n) >= 1000000)
        throw new WorkflowError(
          "AuthorityRetentionQuota",
          "Issuer evidence retention quota is exhausted.",
          429,
        );
      const disk = statfsSync(dirname(this.options.path)),
        size =
          statSync(this.options.path).size +
          (existsSync(`${this.options.path}-wal`) ? statSync(`${this.options.path}-wal`).size : 0);
      if (size > 858993459 || disk.bavail * disk.bsize < 268435456 + Buffer.byteLength(encoded))
        throw new WorkflowError(
          "AuthorityStoragePressure",
          "Issuer storage is under pressure; existing evidence remains readable.",
          503,
          true,
        );
      this.db
        .prepare("INSERT INTO delegation_records VALUES(?,?,?,?)")
        .run(record.grant_ref, record.request_hash, boundFingerprint(record), encoded);
      committing = true;
      this.db.exec("COMMIT");
      return record;
    } catch (error) {
      let rolledBack = false;
      try {
        this.db.exec("ROLLBACK");
        rolledBack = true;
      } catch {
        /* Preserve original fault. */
      }
      this.uncertain = committing || (!rolledBack && this.db.isTransaction);
      throw error;
    }
  }
  prepare(
    input: Omit<WorkSubmission, "authority_ref">,
    authority: WorkAuthority,
    source: {
      kind: WorkDelegationRecord["source_kind"];
      definition_owner_session: string | null;
      background_parent: boolean;
    },
  ): { request: WorkSubmission; record: WorkDelegationRecord } {
    this.ensureConnection();
    if (source.background_parent) denied("Nested detached delegation is not permitted.");
    const namespace = boundFingerprint(workNamespaceSchema.parse(authority.namespace));
    const lookup = (): { request: WorkSubmission; record: WorkDelegationRecord } | null => {
      const row = this.db
        .prepare(
          "SELECT r.record,r.record_digest,r.grant_ref FROM delegation_preparations p JOIN delegation_records r ON r.grant_ref=p.grant_ref WHERE p.namespace_hash=? AND p.idempotency_key=?",
        )
        .get(namespace, input.idempotency_key);
      if (!row) return null;
      const record = workDelegationRecordSchema.parse(JSON.parse(String(row.record)));
      const request = workSubmissionSchema.parse({
        ...input,
        authority_ref: String(row.grant_ref),
      });
      if (
        boundFingerprint(record) !== row.record_digest ||
        workIntentHash(request, authority.namespace) !== record.request_hash ||
        boundFingerprint(authority.origin) !== boundFingerprint(record.authority.origin) ||
        authority.run_identity !== record.authority.run_identity ||
        source.kind !== record.source_kind
      )
        denied("Prepared key identifies different intent or authenticated provenance.");
      return { request, record };
    };
    const previous = lookup();
    if (previous) return previous;
    const request = workSubmissionSchema.parse({
      ...input,
      authority_ref: `agr_${randomBytes(32).toString("hex")}`,
    });
    const record = this.register(request, authority, source);
    // A record may survive a crash before this binding commits. It cannot have
    // been forwarded through prepare's return; retry safely binds another staged
    // record. Once the binding commits, all gateway redeliveries reuse its ref.
    this.db.exec("BEGIN IMMEDIATE");
    let committing = false;
    try {
      this.db
        .prepare("INSERT OR IGNORE INTO delegation_preparations VALUES(?,?,?)")
        .run(namespace, request.idempotency_key, record.grant_ref);
      const accepted = lookup();
      if (!accepted) throw new Error("prepared authority binding is missing");
      committing = true;
      this.db.exec("COMMIT");
      return accepted;
    } catch (error) {
      let rolledBack = false;
      try {
        this.db.exec("ROLLBACK");
        rolledBack = true;
      } catch {
        /* Original commit fault. */
      }
      this.uncertain = committing || (!rolledBack && this.db.isTransaction);
      throw error;
    }
  }
  issue(request: WorkSubmission, authenticated: WorkAuthority): WorkDelegationCredentials {
    this.ensureConnection();
    request = workSubmissionSchema.parse(request);
    const row = this.db
      .prepare("SELECT record_digest,record FROM delegation_records WHERE grant_ref=?")
      .get(request.authority_ref);
    if (!row) denied("Delegation reference is not registered.");
    const record = workDelegationRecordSchema.parse(JSON.parse(String(row.record)));
    if (
      !authenticated ||
      boundFingerprint(authenticated.namespace) !== boundFingerprint(record.authority.namespace) ||
      authenticated.run_identity !== record.authority.run_identity ||
      boundFingerprint(authenticated.origin) !== boundFingerprint(record.authority.origin)
    )
      denied("Delegation renewal belongs to another authenticated subject.");
    if (
      boundFingerprint(record) !== row.record_digest ||
      workIntentHash(request, record.authority.namespace) !== record.request_hash
    )
      denied("Delegation record or request binding differs.");
    const now = (this.options.now ?? Date.now)(),
      candidate = this.options.signingKey(),
      key = selectKey([candidate], candidate.id, now);
    const claims = claimsSchema.parse({
      version: 2,
      audience: AUDIENCE,
      issuer: this.options.issuer,
      key_id: key.id,
      installation: record.authority.namespace.installation,
      grant_ref: record.grant_ref,
      record_digest: row.record_digest,
      request_hash: record.request_hash,
      request_id: request.request_id,
      nonce: randomUUID(),
      issued_at: now,
      expires_at: Math.min(now + MAX_LIFETIME, key.not_after),
    });
    if (claims.expires_at <= now) denied();
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url"),
      assertion = `bwa2.${payload}.${signature(key, payload).toString("base64url")}`;
    if (assertion.length > 8192) denied("Delegation assertion exceeds its header budget.");
    return { assertion, record };
  }
  close(): void {
    this.db.close();
  }
}

/** Dedicated keys prove issuer/service identity; current policy independently proves the originating caller's rights. */
export class WorkDelegationVerifier {
  constructor(
    private readonly options: {
      installation: string;
      keys: (issuer: string) => DelegationKey[];
      /** Trusted installation policy; key possession alone grants no principal role. */
      authorizeIssuer: (record: Readonly<WorkDelegationRecord>) => boolean;
      now?: () => number;
      currentPolicy: (
        record: WorkDelegationRecord,
        operation: "lookup" | "admit",
        request: WorkSubmission,
      ) => Promise<ApprovedBounds>;
    },
  ) {}
  private checkIssuer(record: WorkDelegationRecord): void {
    let allowed = false;
    try {
      // The policy may inspect or mutate its private copy, never authenticated
      // evidence. Missing policies and non-boolean approvals fail closed.
      allowed = this.options.authorizeIssuer(structuredClone(record)) === true;
    } catch {
      // Do not expose policy internals or key configuration in a refusal.
    }
    if (!allowed) denied("Delegation issuer is not authorized for this principal or source.");
  }
  async authenticate(
    request: WorkSubmission,
    credentials: WorkDelegationCredentials,
    operation: "lookup" | "admit",
  ): Promise<WorkAuthority> {
    const now = (this.options.now ?? Date.now)();
    if (
      !credentials ||
      typeof credentials.assertion !== "string" ||
      credentials.assertion.length > 8192
    )
      denied();
    const [prefix, payload, supplied, extra] = credentials.assertion.split(".");
    if (
      prefix !== "bwa2" ||
      !payload ||
      !supplied ||
      extra ||
      !/^[A-Za-z0-9_-]+$/.test(payload) ||
      !/^[A-Za-z0-9_-]+$/.test(supplied)
    )
      denied();
    let claims: z.infer<typeof claimsSchema>;
    try {
      claims = claimsSchema.parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
    } catch {
      denied();
    }
    const key = selectKey(this.options.keys(claims.issuer), claims.key_id, now),
      expected = signature(key, payload),
      actual = Buffer.from(supplied, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) denied();
    if (
      claims.installation !== this.options.installation ||
      claims.issued_at > now ||
      claims.expires_at <= now ||
      claims.expires_at - claims.issued_at > MAX_LIFETIME ||
      claims.issued_at < key.not_before ||
      claims.request_id !== request.request_id
    )
      denied("Delegation audience, lifetime or transport binding differs.");
    let record: WorkDelegationRecord;
    try {
      record = workDelegationRecordSchema.parse(credentials.record);
    } catch {
      denied();
    }
    recordRules(record);
    if (
      record.issuer !== claims.issuer ||
      record.grant_ref !== request.authority_ref ||
      record.grant_ref !== claims.grant_ref ||
      boundFingerprint(record) !== claims.record_digest ||
      record.request_hash !== claims.request_hash ||
      workIntentHash(request, record.authority.namespace) !== claims.request_hash
    )
      denied("Delegation evidence or intent binding differs.");
    this.checkIssuer(record);
    let current: ApprovedBounds;
    try {
      current = approvedBoundsSchema.parse(
        await this.options.currentPolicy(structuredClone(record), operation, structuredClone(request)),
      );
    } catch (error) {
      if (error instanceof WorkflowError) throw error;
      throw new WorkflowError(
        "AuthorityUnavailable",
        "Current caller policy could not be verified.",
        503,
        true,
      );
    }
    validScope(current);
    if (current.identity !== record.authority.caller_ceiling.identity)
      denied("Current policy changed the originating caller identity.");
    const checkedAt = (this.options.now ?? Date.now)();
    selectKey(this.options.keys(claims.issuer), claims.key_id, checkedAt);
    if (claims.expires_at <= checkedAt) denied("Delegation expired during policy evaluation.");
    this.checkIssuer(record);
    return {
      ...record.authority,
      current_caller_ceiling: current,
      delegation: {
        issuer: claims.issuer,
        key_id: claims.key_id,
        nonce: claims.nonce,
        request_hash: claims.request_hash,
        assertion_hash: createHash("sha256").update(credentials.assertion).digest("hex"),
        record_digest: claims.record_digest,
        expires_at: claims.expires_at,
        evidence: record,
      },
    };
  }
}

/** Rotation affects new signatures immediately; verifier overlap is explicit and bounded. */
export function rotateDelegationKeys(
  previous: DelegationKey,
  next: DelegationKey,
  now: number,
  overlapMs = 300000,
): DelegationKey[] {
  if (
    !Number.isInteger(overlapMs) ||
    overlapMs < 0 ||
    overlapMs > 300000 ||
    previous.id === next.id
  )
    throw new Error("invalid delegation rotation overlap");
  selectKey([next], next.id, now);
  return [{ ...previous, not_after: Math.min(previous.not_after, now + overlapMs) }, next];
}
