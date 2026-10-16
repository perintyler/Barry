/** Sessions execution of an activated common-Work assignment. The envelope is
 * retained evidence, never an offline launch capability or a reconstructed user. */
import Database from "better-sqlite3";
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import {
  createModels,
  installedModels,
  VendorModelsSchema,
} from "@barry-rocks/sdk/adapters/models";
import type { InstalledAdapter } from "@barry-rocks/sdk/adapters/harnesses";
import {
  approvedBoundsSchema,
  boundFingerprint,
  type ApprovedBounds,
} from "@barry-rocks/sdk/bounds";
import {
  identityEnvironment,
  requiredCredentials,
  assertSessionCredentials,
} from "@barry-rocks/sdk/internal/env";
import { installationRegistry } from "@barry-rocks/sdk/internal/nodes";
import {
  workflowSessionId,
  type WorkflowSessionJournalStore,
  type WorkflowSessionTurns,
} from "@barry-rocks/sdk/internal/sessions";
import { withStoreContext } from "@barry-rocks/sdk/internal/stores";
import { encodeEffectJson } from "@barry-rocks/sdk/internal/tools";
import {
  assertScopeWithinCeiling,
  executionBindingSchema,
  logicalStageEffectKey,
  workAgentProfileSchema,
  workExecutionDelegationSchema,
  type WorkAgentProfile,
  type WorkArtifactStore,
  type WorkExecutionDelegation,
  type WorkOwnerConnection,
} from "@barry-rocks/sdk/internal/workflows";
import { type SessionConfig } from "@barry-rocks/sdk/sessions";
import { identityRecords } from "@barry-rocks/identities-bag";
import { getSessionsSqlite } from "@barry-rocks/sessions-bag/store/sessions-db";
import { workflowTurnsStore } from "@barry-rocks/sessions-bag/store/workflow-turns";
import type { WorkflowDestinationBinding } from "@barry-rocks/sessions-bag/store/workflow-destinations";
import {
  assertWorkflowProviderCurrent,
  freezeWorkflowProvider,
  resolveWorkflowSessionBounds,
  type FrozenWorkflowProvider,
} from "./workflow-installed-bounds.js";
import { workflowRuntimeArtifacts } from "./workflow-runtime-closure.js";
import type { InstalledWorkflowRuntimeInstallation } from "./workflow-runtime-installation.js";
import {
  workflowSessionExecution,
  type SessionsWorkflowBackend,
} from "./workflow-session-backend.js";
import { fenceWorkflowWorkInput } from "./workflow-work-input-fence.js";

type Binding = z.infer<typeof executionBindingSchema>;
const bindingOf = (start: Binding): Binding =>
  executionBindingSchema.parse(
    Object.fromEntries(
      Object.keys(executionBindingSchema.shape).map((key) => [key, start[key as keyof Binding]]),
    ),
  );
const keyOf = (binding: Binding) =>
  logicalStageEffectKey(binding.owner, binding.workflow_id, binding.activity_id, "execution");
const equal = (left: unknown, right: unknown) => boundFingerprint(left) === boundFingerprint(right);
const ACCEPTED_WORK_VERSION = 1;
interface Authority {
  version: 1;
  delegation: WorkExecutionDelegation;
  profile: WorkAgentProfile;
  declaration: WorkflowDestinationBinding;
}
export interface WorkflowWorkSession {
  key: string;
  declaration: WorkflowDestinationBinding;
  scope: ApprovedBounds;
  backend: SessionsWorkflowBackend;
  turns: WorkflowSessionTurns;
  start(): Promise<unknown>;
  fenceInput(): Promise<{ neverStarted: boolean }>;
  lookup(): ReturnType<WorkflowSessionJournalStore["getTurn"]>;
  interrupt(): Promise<boolean>;
}
function privateDirectory(path: string): string {
  if (!isAbsolute(path)) throw new Error("WorkSessionsDirectoryUnavailable");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.mode & 0o077 ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw new Error("WorkSessionsDirectoryUnavailable");
  return realpathSync(path);
}
function providerOf(profile: WorkAgentProfile): FrozenWorkflowProvider {
  const parsed = z
    .strictObject({
      version: z.literal(1),
      vendor: VendorModelsSchema.element,
      model: z.string(),
      endpoint: z.string(),
      credentialNames: z.array(z.string()),
      fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .parse(profile.provider);
  const rebuilt = freezeWorkflowProvider(parsed.vendor, parsed.model, parsed.endpoint);
  if (
    !equal(parsed, rebuilt) ||
    profile.endpoint !== rebuilt.endpoint ||
    profile.model !== `${rebuilt.vendor.id}/${rebuilt.model}`
  )
    throw new Error("WorkSessionsProviderProfileChanged");
  return rebuilt;
}
function supported(record: InstalledAdapter, scope: ApprovedBounds): void {
  if (
    record.id !== "pi" ||
    record.vendorCode ||
    record.vendor ||
    record.capabilities.endpoint !== "configurable" ||
    record.modes.hosted?.approvalContinuation !== "durable" ||
    record.modes.hosted.guarantees.gating !== "per-call" ||
    record.capabilities.toolDenial !== "native" ||
    Object.keys(record.modes.hosted.native?.uncontrolled ?? {}).length ||
    Object.keys(scope.tools).length ||
    (scope.harness && scope.harness !== "pi") ||
    scope.bound?.files ||
    scope.bound?.bash ||
    scope.bound?.network
  )
    throw new Error("WorkSessionsToolFreeProfileRequired");
  const node = installationRegistry().id;
  if (
    scope.bound?.nodes?.deny?.some((value) => value === node || value === "local") ||
    (scope.bound?.nodes?.allow &&
      !scope.bound.nodes.allow.some((value) => value === node || value === "local"))
  )
    throw new Error("WorkSessionsNodeDenied");
}
function cwdCurrent(profile: WorkAgentProfile): void {
  const info = lstatSync(profile.cwd.path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    realpathSync(profile.cwd.path) !== profile.cwd.path ||
    info.dev !== profile.cwd.device ||
    info.ino !== profile.cwd.inode
  )
    throw new Error("WorkSessionsDirectoryChanged");
}

const ACCEPTED_WORK_COLS = [
  "key:TEXT:0:1",
  "authority_hash:TEXT:1:0",
  "authority_json:TEXT:1:0",
].join(",");
const ACCEPTED_STOPS_COLS = [
  "key:TEXT:0:1",
  "binding_hash:TEXT:1:0",
  "authority_hash:TEXT:1:0",
  "stopped_at:TEXT:1:0",
].join(",");
const EXPECTED_TRIGGERS: Record<string, string> = {
  accepted_work_immutable_update:
    "CREATE TRIGGER accepted_work_immutable_update BEFORE UPDATE ON accepted_work BEGIN SELECT RAISE(ABORT,'accepted work is immutable'); END",
  accepted_work_immutable_delete:
    "CREATE TRIGGER accepted_work_immutable_delete BEFORE DELETE ON accepted_work BEGIN SELECT RAISE(ABORT,'accepted work is immutable'); END",
  accepted_work_stops_immutable_update:
    "CREATE TRIGGER accepted_work_stops_immutable_update BEFORE UPDATE ON accepted_work_stops BEGIN SELECT RAISE(ABORT,'accepted stop is immutable'); END",
  accepted_work_stops_immutable_delete:
    "CREATE TRIGGER accepted_work_stops_immutable_delete BEFORE DELETE ON accepted_work_stops BEGIN SELECT RAISE(ABORT,'accepted stop is immutable'); END",
};
function normalizeSql(sql: string | null | undefined): string {
  return (sql ?? "").replace(/\s+/g, " ").replace(/;\s*$/, "").trim();
}
function authorityTableCols(db: Database.Database, table: string): string {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as {
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }[]
  )
    .map((c) => `${c.name}:${c.type.toUpperCase()}:${c.notnull}:${c.pk}`)
    .join(",");
}
function assertValidAcceptedWorkSchema(db: Database.Database): void {
  const version = Number(db.pragma("user_version", { simple: true }));
  if (!Number.isInteger(version) || version < 0 || version > ACCEPTED_WORK_VERSION) {
    throw new Error("WorkSessionsAuthorityVersionUnsupported");
  }
  const objects = db
    .prepare(
      "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .all() as { type: string; name: string; sql: string | null }[];
  if (objects.length === 0) {
    if (version !== 0) throw new Error("WorkSessionsAuthorityVersionUnsupported");
    return;
  }
  const tables = objects.filter((o) => o.type === "table");
  const triggers = objects.filter((o) => o.type === "trigger");
  if (
    objects.some((o) => o.type !== "table" && o.type !== "trigger") ||
    tables.some((t) => t.name !== "accepted_work" && t.name !== "accepted_work_stops") ||
    !tables.some((t) => t.name === "accepted_work") ||
    authorityTableCols(db, "accepted_work") !== ACCEPTED_WORK_COLS
  ) {
    throw new Error("WorkSessionsAuthorityVersionUnsupported");
  }
  const acceptedWorkSql = normalizeSql(tables.find((t) => t.name === "accepted_work")?.sql);
  if (
    !acceptedWorkSql.includes("CHECK(length(authority_hash)=64)") ||
    !acceptedWorkSql.includes("CHECK(json_valid(authority_json))")
  ) {
    throw new Error("WorkSessionsAuthorityVersionUnsupported");
  }
  if (tables.some((t) => t.name === "accepted_work_stops")) {
    const stopsSql = normalizeSql(tables.find((t) => t.name === "accepted_work_stops")?.sql);
    if (
      authorityTableCols(db, "accepted_work_stops") !== ACCEPTED_STOPS_COLS ||
      !stopsSql.includes("CHECK(length(binding_hash)=64)") ||
      !stopsSql.includes("CHECK(length(authority_hash)=64)")
    ) {
      throw new Error("WorkSessionsAuthorityVersionUnsupported");
    }
  }
  for (const trigger of triggers) {
    const expected = EXPECTED_TRIGGERS[trigger.name];
    if (!expected || normalizeSql(trigger.sql) !== expected) {
      throw new Error("WorkSessionsAuthorityVersionUnsupported");
    }
  }
  if (
    version === ACCEPTED_WORK_VERSION &&
    (!triggers.some((t) => t.name === "accepted_work_immutable_update") ||
      !triggers.some((t) => t.name === "accepted_work_immutable_delete"))
  ) {
    throw new Error("WorkSessionsAuthorityVersionUnsupported");
  }
  const rows = db.prepare("SELECT authority_hash, authority_json FROM accepted_work").all() as {
    authority_hash: unknown;
    authority_json: unknown;
  }[];
  for (const row of rows) {
    if (
      typeof row.authority_hash !== "string" ||
      !/^[a-f0-9]{64}$/.test(row.authority_hash) ||
      typeof row.authority_json !== "string"
    ) {
      throw new Error("WorkSessionsAuthorityVersionUnsupported");
    }
    try {
      JSON.parse(row.authority_json);
    } catch {
      throw new Error("WorkSessionsAuthorityVersionUnsupported");
    }
  }
}

/** Trusted service composition. No route accepts a caller-supplied authority;
 * only the configured authenticated owner connection can confirm an assignment. */
export class WorkflowWorkSessions {
  private readonly directory: string;
  private readonly db: Database.Database;
  private readonly clients: ReadonlyMap<string, WorkOwnerConnection>;
  private readonly assembled = new Map<string, WorkflowWorkSession>();
  private readonly backends = new Set<SessionsWorkflowBackend>();
  private readonly interrupted = new Set<string>();
  private closed = false;
  constructor(
    private readonly options: {
      installation: InstalledWorkflowRuntimeInstallation;
      directory: string;
      clients: ReadonlyMap<string, WorkOwnerConnection>;
      artifacts: WorkArtifactStore;
    },
  ) {
    this.directory = privateDirectory(options.directory);
    this.clients = new Map(options.clients);
    const path = join(this.directory, "accepted-work.sqlite");
    const fd = openSync(
      path,
      constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0o600,
    );
    try {
      const info = fstatSync(fd),
        leaf = lstatSync(path);
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        info.mode & 0o077 ||
        (process.getuid && info.uid !== process.getuid()) ||
        leaf.dev !== info.dev ||
        leaf.ino !== info.ino ||
        realpathSync(path) !== path
      )
        throw new Error("WorkSessionsAuthorityUnavailable");
    } finally {
      closeSync(fd);
    }
    this.db = new Database(path);
    try {
      this.db.pragma("busy_timeout = 5000");
      assertValidAcceptedWorkSchema(this.db);
      // Version 1 is the first stamped schema; validated legacy v0 stores adopt it in place.
      this.db
        .transaction(() => {
          assertValidAcceptedWorkSchema(this.db);
          this.db.exec(`CREATE TABLE IF NOT EXISTS accepted_work (
          key TEXT PRIMARY KEY, authority_hash TEXT NOT NULL CHECK(length(authority_hash)=64),
          authority_json TEXT NOT NULL CHECK(json_valid(authority_json))
        );
        CREATE TRIGGER IF NOT EXISTS accepted_work_immutable_update BEFORE UPDATE ON accepted_work BEGIN SELECT RAISE(ABORT,'accepted work is immutable'); END;
        CREATE TRIGGER IF NOT EXISTS accepted_work_immutable_delete BEFORE DELETE ON accepted_work BEGIN SELECT RAISE(ABORT,'accepted work is immutable'); END;
        CREATE TABLE IF NOT EXISTS accepted_work_stops (
          key TEXT PRIMARY KEY, binding_hash TEXT NOT NULL CHECK(length(binding_hash)=64),
          authority_hash TEXT NOT NULL CHECK(length(authority_hash)=64), stopped_at TEXT NOT NULL
        );
        CREATE TRIGGER IF NOT EXISTS accepted_work_stops_immutable_update BEFORE UPDATE ON accepted_work_stops BEGIN SELECT RAISE(ABORT,'accepted stop is immutable'); END;
        CREATE TRIGGER IF NOT EXISTS accepted_work_stops_immutable_delete BEFORE DELETE ON accepted_work_stops BEGIN SELECT RAISE(ABORT,'accepted stop is immutable'); END;`);
          this.db.pragma(`user_version = ${ACCEPTED_WORK_VERSION}`);
        })
        .immediate();
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = FULL");
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  private partition<T>(identity: string, operation: () => T): T {
    return withStoreContext({ identity }, operation);
  }
  private client(binding: Binding): WorkOwnerConnection {
    const client = this.clients.get(binding.owner);
    if (!client || binding.owner !== installationRegistry().id)
      throw new Error("WorkSessionsOwnerUnavailable");
    return client;
  }
  private read(binding: Binding): Authority | undefined {
    const row = this.db
      .prepare("SELECT authority_hash,authority_json FROM accepted_work WHERE key=?")
      .get(keyOf(binding)) as { authority_hash: string; authority_json: string } | undefined;
    if (!row) return undefined;
    const raw = JSON.parse(row.authority_json) as Authority;
    if (raw.version !== 1 || boundFingerprint(raw) !== row.authority_hash)
      throw new Error("WorkSessionsRetainedAuthorityCorrupt");
    const delegation = workExecutionDelegationSchema.parse(raw.delegation),
      profile = workAgentProfileSchema.parse(raw.profile);
    if (
      !equal(bindingOf(delegation.start), binding) ||
      !equal(raw, { ...raw, delegation, profile })
    )
      throw new Error("WorkSessionsBindingConflict");
    const declaration = raw.declaration;
    if (
      declaration.bindingKey !== `work-session:${keyOf(binding)}` ||
      declaration.identity !== delegation.namespace.identity_id ||
      declaration.sessionId !== workflowSessionId(declaration.bindingKey, declaration.identity) ||
      !equal(declaration.scope, delegation.grant.effective_scope) ||
      !equal(declaration.selection.runtime, profile.runtime) ||
      declaration.selection.harness !== profile.harness ||
      declaration.selection.model !== profile.model ||
      declaration.selection.endpoint !== profile.endpoint ||
      declaration.selection.cwd !== profile.cwd.path ||
      declaration.selection.maxTurns !== 1 ||
      declaration.selection.deadline !==
        Math.min(
          delegation.start.deadline,
          delegation.start.budget_deadline ?? delegation.start.deadline,
        )
    )
      throw new Error("WorkSessionsRetainedAuthorityCorrupt");
    return raw;
  }
  private retained(authority: Authority) {
    const retained = this.options.installation.registry.descriptor(authority.profile.generation);
    if (
      !retained ||
      retained.registration.recordHash !== authority.profile.record_hash ||
      !equal(retained.registration.runtime, authority.profile.runtime)
    )
      throw new Error("WorkSessionsRuntimeUnavailable");
    supported(retained.record, authority.declaration.scope);
    return retained;
  }
  private stopped(authority: Authority): boolean {
    const binding = bindingOf(authority.delegation.start);
    const row = this.db
      .prepare("SELECT binding_hash,authority_hash FROM accepted_work_stops WHERE key=?")
      .get(keyOf(binding)) as { binding_hash: string; authority_hash: string } | undefined;
    if (!row) return false;
    if (
      row.binding_hash !== boundFingerprint(binding) ||
      row.authority_hash !== boundFingerprint(authority)
    )
      throw new Error("WorkSessionsStopBindingConflict");
    return true;
  }
  private stop(authority: Authority): void {
    const binding = bindingOf(authority.delegation.start);
    this.db
      .prepare(
        "INSERT OR IGNORE INTO accepted_work_stops(key,binding_hash,authority_hash,stopped_at) VALUES(?,?,?,?)",
      )
      .run(
        keyOf(binding),
        boundFingerprint(binding),
        boundFingerprint(authority),
        new Date().toISOString(),
      );
    if (!this.stopped(authority)) throw new Error("WorkSessionsStopBindingConflict");
    this.interrupted.add(keyOf(binding));
  }
  private async online(authority: Authority, launch: boolean): Promise<void> {
    if (this.closed && launch) throw new Error("WorkSessionsClosed");
    const binding = bindingOf(authority.delegation.start),
      client = this.client(binding);
    if (launch) {
      if (this.interrupted.has(keyOf(binding)) || this.stopped(authority))
        throw new Error("WorkSessionsInterrupted");
      const fresh = workExecutionDelegationSchema.parse(
        await client.delegation(binding.attempt_id),
      );
      if (!equal(fresh, authority.delegation)) throw new Error("WorkSessionsDelegationChanged");
      if (this.closed || this.interrupted.has(keyOf(binding)) || this.stopped(authority))
        throw new Error("WorkSessionsInterrupted");
    } else {
      const fresh = await client.inspect(binding.attempt_id);
      if (!equal(bindingOf(fresh.observation), binding))
        throw new Error("WorkSessionsBindingConflict");
    }
  }
  private async checkBounds(authority: Authority): Promise<void> {
    await this.online(authority, true);
    const { declaration, profile } = authority;
    if (Date.now() >= declaration.selection.deadline)
      throw new Error("WorkSessionsDeadlineExceeded");
    const registry = installationRegistry();
    if (
      registry.identityId(declaration.identityId) !== declaration.identity ||
      registry.legacyIdentityId(declaration.identity) !== declaration.identityId
    )
      throw new Error("WorkSessionsIdentityChanged");
    const row = await identityRecords.row(declaration.identityId);
    if (!row || row.actor_id !== declaration.actorId)
      throw new Error("WorkSessionsIdentityChanged");
    const retained = this.retained(authority),
      provider = providerOf(profile);
    const selectedBags = declaration.scope.bags ?? [];
    const resolved = await resolveWorkflowSessionBounds(declaration.identityId, {
      bags: selectedBags,
      harness: retained.record.id,
      mode: "hosted",
      defaults: false,
      identityDefaults: false,
    });
    if (resolved.skills.length || resolved.instructions.length || resolved.tools.length)
      throw new Error("WorkSessionsToolFreeProfileRequired");
    const evidence = {
      identity: declaration.identity,
      bags: resolved.bags,
      traits: resolved.bags,
      bound: resolved.bound,
      harness: declaration.scope.harness,
      tools: {},
      contracts: {},
    };
    const current = approvedBoundsSchema.parse(
      JSON.parse(JSON.stringify({ ...evidence, fingerprint: boundFingerprint(evidence) })),
    );
    assertScopeWithinCeiling(current, declaration.scope);
    assertScopeWithinCeiling(authority.delegation.grant.original_caller_ceiling, declaration.scope);
    await this.online(authority, true);
    const final = await identityRecords.row(declaration.identityId);
    if (
      !final ||
      final.actor_id !== declaration.actorId ||
      registry.identityId(final.id) !== declaration.identity ||
      this.closed ||
      this.interrupted.has(keyOf(authority.delegation.start)) ||
      this.stopped(authority) ||
      Date.now() >= declaration.selection.deadline
    )
      throw new Error("WorkSessionsIdentityChanged");
    const vendor = installedModels()
      .vendors()
      .find((value) => value.id === provider.vendor.id);
    if (!vendor || typeof vendor.baseUrl !== "string" || vendor.baseUrl !== provider.endpoint)
      throw new Error("WorkSessionsProviderSelectionChanged");
    assertWorkflowProviderCurrent(provider, vendor);
    cwdCurrent(profile);
  }
  private async credentials(
    authority: Authority,
    record: InstalledAdapter,
  ): Promise<Record<string, string>> {
    const provider = providerOf(authority.profile);
    const required = requiredCredentials({
      harness: { id: record.id, credentials: record.bag?.manifest.credentials },
      routedVendors: [provider.vendor],
    });
    const names = [...new Set(required.map((item) => item.env))];
    if (
      names.some(
        (name) =>
          !/^[A-Z][A-Z0-9_]*$/.test(name) || /^(BARRY_|PI_|NODE_|HOME$|PATH$|TMPDIR$)/.test(name),
      )
    )
      throw new Error("WorkSessionsCredentialProfileUnsupported");
    try {
      const row = await identityRecords.row(authority.declaration.identityId);
      if (!row || row.actor_id !== authority.declaration.actorId)
        throw new Error("IdentityUnavailable");
      const env = await identityEnvironment(identityRecords.config(row), { names, cacheTtlMs: 0 });
      assertSessionCredentials({ required, env, ambientEnv: {}, credentialEnvs: new Set(names) });
      if (names.some((name) => !env.vars[name])) throw new Error("CredentialUnavailable");
      return Object.fromEntries(names.map((name) => [name, env.vars[name]!]));
    } catch {
      throw new Error("WorkSessionsDeclaredCredentialsUnavailable");
    }
  }
  async open(supplied: WorkExecutionDelegation): Promise<WorkflowWorkSession> {
    if (this.closed) throw new Error("WorkSessionsClosed");
    const delegation = workExecutionDelegationSchema.parse(structuredClone(supplied)),
      binding = bindingOf(delegation.start);
    const fresh = workExecutionDelegationSchema.parse(
      await this.client(binding).delegation(binding.attempt_id),
    );
    if (!equal(fresh, delegation)) throw new Error("WorkSessionsDelegationChanged");
    const existing = this.read(binding);
    if (existing) {
      if (!equal(existing.delegation, delegation)) throw new Error("WorkSessionsBindingConflict");
      return this.assemble(existing);
    }
    const program = delegation.start.agent_program;
    if (
      !program ||
      delegation.namespace.identity_id === null ||
      !equal(program.scope, delegation.grant.effective_scope) ||
      delegation.start.effect_policy.class !== "non-repeatable" ||
      delegation.start.resources.executor !== "agent"
    )
      throw new Error("WorkSessionsProfileUnsupported");
    const profile = workAgentProfileSchema.parse(
      JSON.parse(this.options.artifacts.verify(program.profile).toString("utf8")),
    );
    if (
      profile.installation !== binding.owner ||
      delegation.plan.definition.kind !== "action" ||
      delegation.plan.definition.reference !== profile.reference ||
      !equal(profile.validation, delegation.start.validation ?? { mode: "none" }) ||
      program.profile.owner_identity !== null ||
      delegation.plan.selection.resolved_model !== profile.model ||
      delegation.plan.selection.resolved_harness !== profile.harness ||
      delegation.plan.selection.endpoint !== profile.endpoint
    )
      throw new Error("WorkSessionsProfileBindingConflict");
    const endpoint = delegation.start.resources.endpoint;
    if (
      !endpoint ||
      !endpoint.reservation ||
      endpoint.endpoint !== profile.endpoint_resource ||
      endpoint.model !== profile.model ||
      endpoint.max_input_tokens !== profile.max_input_tokens ||
      endpoint.max_output_tokens !== profile.max_output_tokens ||
      endpoint.max_cost !== profile.max_cost ||
      delegation.plan.execution_budget_ms !== profile.execution_budget_ms
    )
      throw new Error("WorkSessionsResourceBindingConflict");
    const closure = workflowRuntimeArtifacts(this.options.artifacts, profile.runtime);
    if (
      closure.length !== profile.sources.length ||
      profile.sources.some((source) => !closure.some((expected) => equal(expected, source))) ||
      [program.profile, ...profile.sources].some(
        (source) => !delegation.plan.source_closure.some((expected) => equal(expected, source)),
      )
    )
      throw new Error("WorkSessionsSourceClosureIncomplete");
    for (const source of [...profile.sources, program.profile])
      this.options.artifacts.retainExecutor(source);
    const scope = approvedBoundsSchema.parse(program.scope),
      identity = delegation.namespace.identity_id;
    if (scope.identity !== identity) throw new Error("WorkSessionsIdentityChanged");
    const identityId = installationRegistry().legacyIdentityId(identity),
      row = await identityRecords.row(identityId);
    if (!row || installationRegistry().identityId(identityId) !== identity)
      throw new Error("WorkSessionsIdentityChanged");
    const bindingKey = `work-session:${keyOf(binding)}`;
    const authority: Authority = {
      version: 1,
      delegation,
      profile,
      declaration: {
        bindingKey,
        sessionId: workflowSessionId(bindingKey, identity),
        identity,
        identityId,
        actorId: row.actor_id,
        scope,
        selection: {
          harness: profile.harness,
          model: profile.model,
          endpoint: profile.endpoint,
          cwd: profile.cwd.path,
          maxTurns: 1,
          deadline: Math.min(
            binding.deadline,
            delegation.start.budget_deadline ?? binding.deadline,
          ),
          runtime: profile.runtime,
        },
      },
    };
    await this.checkBounds(authority);
    this.db
      .prepare(
        "INSERT OR IGNORE INTO accepted_work(key,authority_hash,authority_json) VALUES(?,?,?)",
      )
      .run(keyOf(binding), boundFingerprint(authority), JSON.stringify(authority));
    const winner = this.read(binding);
    if (!winner || !equal(winner, authority)) throw new Error("WorkSessionsBindingConflict");
    return this.assemble(winner);
  }
  /** Authenticated retained recovery does not re-acquire launch authority,
   * resolve credentials, or require the original identity/registry to survive. */
  async recover(supplied: Binding): Promise<WorkflowWorkSession | undefined> {
    const binding = executionBindingSchema.parse(structuredClone(supplied));
    if (this.closed) throw new Error("WorkSessionsClosed");
    const authority = this.read(binding);
    if (!authority) return undefined;
    await this.online(authority, false);
    return this.assemble(authority);
  }
  private assemble(original: Authority): WorkflowWorkSession {
    const authority = structuredClone(original),
      { declaration, profile } = authority,
      key = keyOf(authority.delegation.start);
    const cached = this.assembled.get(key);
    if (cached) return cached;
    const identity = declaration.identity,
      enter = <T>(operation: () => T) => this.partition(identity, operation);
    const home = privateDirectory(join(this.directory, declaration.sessionId));
    const inertEnvironment = {
      HOME: home,
      BARRY_HOME: privateDirectory(join(home, "barry")),
      PI_CODING_AGENT_DIR: privateDirectory(join(home, "pi")),
      TMPDIR: privateDirectory(join(home, "tmp")),
      PATH: process.env.PATH ?? "",
    };
    const journal = new Proxy(workflowTurnsStore, {
      get: (target, property) => {
        const value = Reflect.get(target, property);
        return typeof value === "function"
          ? (...args: unknown[]) => enter(() => Reflect.apply(value, target, args))
          : value;
      },
    });
    const { backend, turns } = workflowSessionExecution(
      {
        db: enter(getSessionsSqlite),
        declaration,
        recovery: { spoolRoot: this.options.installation.executionSpool },
        enforceable: (scope) => equal(scope, declaration.scope),
        authorize: () => enter(() => this.checkBounds(authority)),
        authorizeTool: async () => ({
          allow: false,
          reason: "Work Sessions profile forbids every tool and native effect",
        }),
        prepare: (launch) =>
          this.options.installation.prepare(
            profile.generation,
            {
              inertEnvironment,
              authorize: () => enter(() => this.checkBounds(authority)),
              configure: async () => {
                await enter(() => this.checkBounds(authority));
                const retained = this.retained(authority),
                  env = await enter(() => this.credentials(authority, retained.record));
                await enter(() => this.checkBounds(authority));
                const provider = providerOf(profile),
                  endpoint = createModels([provider.vendor], { env }).endpoint(provider.vendor.id);
                if (!endpoint || endpoint.baseUrl !== profile.endpoint)
                  throw new Error("WorkSessionsProviderSelectionChanged");
                return {
                  sessionId: declaration.sessionId,
                  cwd: profile.cwd.path,
                  model: profile.model as SessionConfig["model"],
                  endpoint,
                  env: { ...inertEnvironment, ...env },
                  mcpServers: {},
                  strictMcpConfig: true,
                  pluginDirs: [],
                  projectRoots: [],
                  extraArgs: [],
                  maxTurns: 1,
                  allowedNativeTools: [],
                  deniedTools: [...(retained.record.tools ?? [])],
                };
              },
            },
            launch,
          ),
      },
      journal,
    );
    this.backends.add(backend);
    const bound = async () => {
      const row = await enter(() => turns.inspect(key));
      if (row) {
        const destination = await enter(() => backend.lookupSession(row.sessionId));
        if (
          row.sessionId !== declaration.sessionId ||
          !destination ||
          destination.identity !== identity ||
          destination.boundFingerprint !== declaration.scope.fingerprint
        )
          throw new Error("WorkSessionsTurnBindingConflict");
      }
      return row;
    };
    const fenceInput = async () => {
      // Commit before the authenticated owner round trip. Even a lost reply or
      // owner outage cannot reopen launch authorization after this process dies.
      this.stop(authority);
      await this.online(authority, false);
      const accepted = z
        .strictObject({ prompt: z.string().min(1).max(262144) })
        .safeParse(authority.delegation.start.inputs);
      const expectedRequestHash = accepted.success
        ? boundFingerprint({
            sessionId: declaration.sessionId,
            input: { text: accepted.data.prompt },
            scope: declaration.scope,
          })
        : boundFingerprint({ nonlaunchableAcceptedInput: authority.delegation.start.inputs });
      return enter(() =>
        fenceWorkflowWorkInput(getSessionsSqlite(), declaration, key, expectedRequestHash),
      );
    };
    const assembled: WorkflowWorkSession = {
      key,
      declaration: structuredClone(declaration),
      scope: structuredClone(declaration.scope),
      backend,
      turns,
      start: async () => {
        await enter(() => this.checkBounds(authority));
        await bound();
        const { prompt: text } = z
          .strictObject({ prompt: z.string().min(1).max(262144) })
          .parse(authority.delegation.start.inputs);
        return enter(async () => {
          const id = await turns.ensure(declaration.bindingKey, declaration.scope);
          // ensure() crosses asynchronous journal operations. A stop committed
          // during them must win before any destination turn admission.
          if (this.closed || this.stopped(authority)) throw new Error("WorkSessionsInterrupted");
          return turns.turn(key, id, { text }, declaration.scope);
        });
      },
      fenceInput,
      lookup: async () => {
        await this.online(authority, false);
        await bound();
        // Physical repair is independent of an outer completed journal entry.
        const observed = await enter(() => backend.lookupTurn(declaration.sessionId, key));
        if (observed?.state === "complete")
          await enter(() =>
            workflowTurnsStore.updateTurn(
              key,
              "complete",
              encodeEffectJson(observed.result ?? null),
            ),
          );
        else if (observed?.state === "interrupted")
          await enter(() => workflowTurnsStore.updateTurn(key, "interrupted"));
        return bound();
      },
      interrupt: async () => {
        await fenceInput();
        const row = await bound();
        return row ? enter(() => turns.interrupt(key)) : true;
      },
    };
    this.assembled.set(key, assembled);
    return assembled;
  }
  async close(): Promise<void> {
    if (!this.db.open) return;
    this.closed = true;
    const backends = [...this.backends];
    const execution = await Promise.allSettled(
      backends.map((backend) => backend.execution.close()),
    );
    const closed = await Promise.allSettled(backends.map((backend) => backend.close()));
    const failures = [...execution, ...closed].filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failures.length)
      throw new AggregateError(
        failures.map((result) => result.reason),
        "WorkSessionsCloseFailed",
      );
    this.backends.clear();
    this.assembled.clear();
    this.db.close();
  }
}
