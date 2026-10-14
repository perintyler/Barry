import generatedMigrations from "./generated/registry-migrations.js";
import { migrateStore } from "../stores/migrate.js";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { SqliteDatabase as DatabaseSync } from "../stores/sqlite-connection.js";
import { z } from "zod";
import { activeStoreRoot } from "../stores/migration.js";
import { barryStoresDir } from "../services/home.mjs";
import { ownerUrl, WORKER_CREDENTIAL_PREFIX } from "./join-token.js";
export { WORKER_CREDENTIAL_PREFIX } from "./join-token.js";

/** A machine this installation invited to run its workflow activities. */
export interface Worker {
  id: string;
  name: string;
  createdAt: string;
  jobs: string[] | null;
  inviteExpiresAt: number | null;
  joinedAt: number | null;
}
/** A workflows owner this installation joined as a worker. */
export interface Owner {
  id: string;
  name: string;
  url: string;
  workerId: string;
  joinedAt: string;
  jobs: string[] | null;
}
const WorkerSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  jobs: z
    .string()
    .nullable()
    .transform((value) => (value === null ? null : (JSON.parse(value) as string[]))),
  inviteExpiresAt: z.number().nullable(),
  joinedAt: z.number().nullable(),
});
const OwnerSchema = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string(),
  workerId: z.string(),
  joinedAt: z.string(),
  jobs: z
    .string()
    .nullable()
    .transform((value) => (value === null ? null : (JSON.parse(value) as string[]))),
});
const safe = (value: string) => {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(value) || value.includes(".."))
    throw new Error("invalid node identifier");
  return value;
};
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/**
 * This installation's id, its identity folder names, and its worker links.
 *
 * Linking is one-way. An owner invites a worker (`inviteWorker`), which
 * stores only a hashed credential; the worker joins (`join`), which stores the
 * owner's address and the credential to call it with. Neither side holds
 * anything about the other's sessions or identities.
 */
export class NodeRegistry {
  readonly db: DatabaseSync;
  readonly id: string;
  readonly directory: string;
  private readonly credentialsDirectory: string;
  constructor(
    configuredRoot?: string,
    private readonly now: () => number = Date.now,
  ) {
    const root = configuredRoot ?? join(activeStoreRoot(), "node", "nodes");
    this.credentialsDirectory = configuredRoot
      ? join(root, "credentials")
      : join(barryStoresDir(), "credentials", "nodes");
    mkdirSync(this.credentialsDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.directory = root;
    this.db = new DatabaseSync(join(root, "peers.db"));
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    migrateStore(this.db, NODE_MIGRATIONS, "NODE_MIGRATIONS");
    this.db.prepare("INSERT OR IGNORE INTO settings VALUES ('nodeId', ?)").run(randomUUID());
    this.id = (
      this.db.prepare("SELECT value FROM settings WHERE key='nodeId'").get() as {
        value: string;
      }
    ).value;
  }
  identityId(legacyId: number): string {
    this.db
      .prepare("INSERT OR IGNORE INTO local_identities VALUES(?,?)")
      .run(legacyId, randomUUID());
    return String(
      this.db.prepare("SELECT uuid FROM local_identities WHERE legacyId=?").get(legacyId)!.uuid,
    );
  }
  legacyIdentityId(uuid: string): number {
    const row = this.db.prepare("SELECT legacyId FROM local_identities WHERE uuid=?").get(uuid);
    if (!row) throw new Error("unknown local identity");
    return Number(row.legacyId);
  }

  // ---- owner side: the workers this installation invited ----

  /** Invite a worker: a fresh worker id and its first credential, shown once. */
  inviteWorker(
    name: string,
    jobs: string[] | null = null,
    caller = "local-operator",
    expiryMs: number | null = 86_400_000,
  ): { worker: Worker; credential: string } {
    safe(name);
    const now = this.now();
    const inviteExpiresAt = expiryMs === null ? null : now + expiryMs;
    if (
      expiryMs !== null &&
      (!Number.isSafeInteger(expiryMs) ||
        expiryMs <= 0 ||
        !Number.isSafeInteger(inviteExpiresAt) ||
        !Number.isFinite(new Date(now + expiryMs).getTime()))
    )
      throw new Error(
        "invite expiry must be a positive safe number of milliseconds within the supported date range or null",
      );
    return this.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM workers WHERE name=?").get(name))
        throw new Error(
          `a worker named ${name} already exists; revoke it first or pick another name`,
        );
      if (
        jobs !== null &&
        (!jobs.length ||
          jobs.length > 100 ||
          jobs.some((job) => !/^[a-z0-9._-]+:[a-z0-9._-]+@[1-9][0-9]*$/i.test(job)))
      )
        throw new Error("job scopes must contain versioned bag:name@version references");
      const worker: Worker = {
        id: randomUUID(),
        name,
        createdAt: new Date(now).toISOString(),
        jobs,
        inviteExpiresAt,
        joinedAt: null,
      };
      this.db
        .prepare("INSERT INTO workers(id,name,createdAt,jobs,inviteExpiresAt) VALUES(?,?,?,?,?)")
        .run(
          worker.id,
          worker.name,
          worker.createdAt,
          jobs === null ? null : JSON.stringify(jobs),
          worker.inviteExpiresAt,
        );
      this.audit(worker.id, "invite", caller);
      return { worker, credential: this.issueCredential(worker.id).secret };
    });
  }
  workers(): Worker[] {
    return this.db
      .prepare("SELECT id,name,createdAt,jobs,inviteExpiresAt,joinedAt FROM workers ORDER BY name")
      .all()
      .map((row) => WorkerSchema.parse(row));
  }
  worker(idOrName: string): Worker {
    const row = this.db
      .prepare(
        "SELECT id,name,createdAt,jobs,inviteExpiresAt,joinedAt FROM workers WHERE id=? OR name=?",
      )
      .get(idOrName, idOrName);
    if (!row)
      throw new Error(`no worker ${idOrName}; \`barry workers list\` shows the invited ones`);
    return WorkerSchema.parse(row);
  }
  /** Remove a worker and kill every credential it holds; its next call is refused. */
  revokeWorker(idOrName: string): Worker {
    return this.transaction(() => {
      const worker = this.worker(idOrName);
      this.db
        .prepare(
          "UPDATE credentials SET revokedAt=? WHERE peerId=? AND (revokedAt IS NULL OR revokedAt > ?)",
        )
        .run(this.now(), worker.id, this.now());
      this.db.prepare("DELETE FROM workers WHERE id=?").run(worker.id);
      this.audit(worker.id, "revoke", "local-operator");
      return worker;
    });
  }
  issueCredential(workerId: string): {
    id: string;
    secret: string;
  } {
    safe(workerId);
    const id = randomUUID();
    const secret = `${WORKER_CREDENTIAL_PREFIX}${randomBytes(32).toString("base64url")}`;
    this.db
      .prepare(
        "INSERT INTO credentials (id, peerId, hash, expiresAt, revokedAt) VALUES(?,?,?,NULL,NULL)",
      )
      .run(id, workerId, digest(secret));
    return { id, secret };
  }
  /** A new credential; the old ones keep working for the grace period so the worker can switch. */
  rotateCredential(
    workerId: string,
    gracePeriodMs: number = 300_000,
  ): {
    id: string;
    secret: string;
    previousCredentials: string[];
  } {
    safe(workerId);
    return this.transaction(() => {
      const previous = (
        this.db
          .prepare(
            "SELECT id FROM credentials WHERE peerId=? AND (revokedAt IS NULL OR revokedAt > ?)",
          )
          .all(workerId, this.now()) as { id: string }[]
      ).map((r) => r.id);
      const expiresAt = this.now() + gracePeriodMs;
      this.db
        .prepare("UPDATE credentials SET expiresAt = ? WHERE peerId = ? AND expiresAt IS NULL")
        .run(expiresAt, workerId);
      const issued = this.issueCredential(workerId);
      this.audit(workerId, "rotate", "local-operator");
      return { ...issued, previousCredentials: previous };
    });
  }
  revokeCredential(id: string): void {
    this.db.prepare("UPDATE credentials SET revokedAt = ? WHERE id = ?").run(this.now(), id);
  }
  /** The worker id a credential belongs to, or null when it is unknown, expired, revoked or its worker is gone. */
  authenticate(secret: string): string | null {
    if (!secret.startsWith(WORKER_CREDENTIAL_PREFIX)) return null;
    const hash = digest(secret);
    const now = this.now();
    const row = this.db
      .prepare("SELECT peerId, hash, expiresAt, revokedAt FROM credentials WHERE hash=?")
      .get(hash) as
      | {
          peerId: string;
          hash: string;
          expiresAt: number | null;
          revokedAt: number | null;
        }
      | undefined;
    if (!row || !timingSafeEqual(Buffer.from(hash), Buffer.from(row.hash))) return null;
    if (row.revokedAt !== null && row.revokedAt <= now) return null;
    if (row.expiresAt !== null && row.expiresAt <= now) return null;
    const worker = this.db
      .prepare("SELECT inviteExpiresAt,joinedAt FROM workers WHERE id=?")
      .get(row.peerId);
    if (
      !worker ||
      (worker.joinedAt === null &&
        worker.inviteExpiresAt !== null &&
        Number(worker.inviteExpiresAt) <= now)
    )
      return null;
    return row.peerId;
  }

  audit(workerId: string, event: string, caller: string): void {
    this.db
      .prepare("INSERT INTO worker_audit(workerId,time,caller,event) VALUES(?,?,?,?)")
      .run(workerId, this.now(), caller, event);
  }
  audits(): { workerId: string; time: number; caller: string; event: string }[] {
    return this.db
      .prepare("SELECT workerId,time,caller,event FROM worker_audit ORDER BY id")
      .all()
      .map((row) =>
        z
          .object({ workerId: z.string(), time: z.number(), caller: z.string(), event: z.string() })
          .parse(row),
      );
  }
  /** Called after an authenticated hello successfully opens a workflow session. */
  recordHello(workerId: string, takeover: boolean): void {
    this.transaction(() => {
      const worker = this.worker(workerId);
      if (worker.joinedAt === null) {
        this.db.prepare("UPDATE workers SET joinedAt=? WHERE id=?").run(this.now(), workerId);
        this.audit(workerId, "join", workerId);
      } else if (takeover) this.audit(workerId, "session-takeover", workerId);
    });
  }
  /** Enrollment changes and their audit row commit together in peers.db. */
  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  permitsJob(workerId: string, type: string): boolean {
    const worker = this.workers().find((entry) => entry.id === workerId);
    return !!worker && (worker.jobs === null || worker.jobs.includes(type));
  }

  // ---- worker side: the owners this installation joined ----

  /** Record an owner this installation now works for, with the credential to call it. */
  join(
    owner: { id: string; name: string; url: string; workerId: string; jobs?: string[] | null },
    credential: string,
  ): Owner {
    safe(owner.id);
    safe(owner.workerId);
    if (owner.id === this.id)
      throw new Error(
        "this join token was issued by this installation; run `barry workers join` on the machine that should do the work",
      );
    if (!credential.startsWith(WORKER_CREDENTIAL_PREFIX))
      throw new Error("invalid worker credential");
    const record: Owner = {
      id: owner.id,
      name: owner.name,
      url: ownerUrl(owner.url),
      workerId: owner.workerId,
      joinedAt: new Date(this.now()).toISOString(),
      jobs: owner.jobs ?? null,
    };
    this.db
      .prepare(
        "INSERT INTO owners(id,name,url,workerId,joinedAt,jobs) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,url=excluded.url,workerId=excluded.workerId,joinedAt=excluded.joinedAt,jobs=excluded.jobs",
      )
      .run(
        record.id,
        record.name,
        record.url,
        record.workerId,
        record.joinedAt,
        record.jobs === null ? null : JSON.stringify(record.jobs),
      );
    const credentials = this.readCredentials();
    credentials[record.id] = credential;
    this.writeCredentials(credentials);
    return record;
  }
  owners(): Owner[] {
    return this.db
      .prepare("SELECT id,name,url,workerId,joinedAt,jobs FROM owners ORDER BY name")
      .all()
      .map((row) => OwnerSchema.parse(row));
  }
  owner(idOrName: string): Owner {
    const row = this.db
      .prepare("SELECT id,name,url,workerId,joinedAt,jobs FROM owners WHERE id=? OR name=?")
      .get(idOrName, idOrName);
    if (!row)
      throw new Error(
        `not a worker of ${idOrName}; \`barry workers list\` shows the joined owners`,
      );
    return OwnerSchema.parse(row);
  }
  /** The credential this installation presents to an owner it joined. */
  ownerCredential(ownerId: string): string {
    const value = this.readCredentials()[ownerId];
    if (!value) throw new Error(`no credential for owner ${ownerId}; join it again`);
    return value;
  }
  /** Stop working for an owner. The owner still lists the worker until it revokes it. */
  leave(idOrName: string): Owner {
    const owner = this.owner(idOrName);
    this.db.prepare("DELETE FROM owners WHERE id=?").run(owner.id);
    const credentials = this.readCredentials();
    delete credentials[owner.id];
    this.writeCredentials(credentials);
    return owner;
  }
  private readCredentials(): Record<string, string> {
    try {
      return JSON.parse(
        readFileSync(join(this.credentialsDirectory, "outgoing-secrets.json"), "utf8"),
      ) as Record<string, string>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }
  private writeCredentials(value: Record<string, string>): void {
    const path = join(this.credentialsDirectory, "outgoing-secrets.json");
    const temporaryPath = `${path}.${randomUUID()}`;
    writeFileSync(temporaryPath, JSON.stringify(value), { mode: 0o600 });
    renameSync(temporaryPath, path);
  }
  close(): void {
    this.db.close();
  }
}
const INSTALLATION_REGISTRY = Symbol.for("barry.node-registry");
type RegistryHolder = { [INSTALLATION_REGISTRY]?: Map<string, NodeRegistry> };
/**
 * This process's shared registry for the active store root: the installation
 * id and the identity folder mapping every store lookup needs. Opened on
 * first use per store root (a test that moves BARRY_HOME gets that home's).
 */
export function installationRegistry(): NodeRegistry {
  const holder = globalThis as RegistryHolder;
  const registries = (holder[INSTALLATION_REGISTRY] ??= new Map());
  const directory = join(activeStoreRoot(), "node", "nodes");
  let registry = registries.get(directory);
  if (!registry) {
    registry = new NodeRegistry();
    registries.set(directory, registry);
  }
  return registry;
}
/** Close every registry `installationRegistry()` opened; the next call reopens. */
export function closeInstallationRegistry(): void {
  const holder = globalThis as RegistryHolder;
  for (const registry of holder[INSTALLATION_REGISTRY]?.values() ?? []) registry.close();
  holder[INSTALLATION_REGISTRY]?.clear();
}
/**
 * The installation's peers.db, opened read-only, or undefined when it does
 * not exist. `new NodeRegistry()` creates the database and inserts a fresh
 * installation id, which a backup, a listing or a restore must never do.
 */
function readPeers<T>(root: string, read: (db: DatabaseSync) => T): T | undefined {
  const path = join(root, "node", "nodes", "peers.db");
  if (!existsSync(path)) return undefined;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout=5000");
    return read(db);
  } finally {
    db.close();
  }
}
/** This installation's id, read without creating peers.db; undefined before first use. */
export function readInstallationId(root = activeStoreRoot()): string | undefined {
  return readPeers(root, (db) => {
    const row = db.prepare("SELECT value FROM settings WHERE key='nodeId'").get() as
      { value: string } | undefined;
    return row?.value;
  });
}
/** Identity partition UUIDs mapped to their legacy numeric ids, read-only. */
export function readLocalIdentities(root = activeStoreRoot()): Map<string, number> {
  return (
    readPeers(
      root,
      (db) =>
        new Map(
          (
            db.prepare("SELECT uuid, legacyId FROM local_identities").all() as {
              uuid: string;
              legacyId: number;
            }[]
          ).map((row) => [String(row.uuid), Number(row.legacyId)]),
        ),
    ) ?? new Map()
  );
}
export const NODE_MIGRATIONS = generatedMigrations;
