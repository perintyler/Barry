/** Trusted Sessions composition. Common Work admission/receipts are a separate gate. */
import { mkdirSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { parseModelRef } from "@barry-rocks/sdk/ids";
import { createModels, installedModels, type Vendor } from "@barry-rocks/sdk/adapters/models";
import type { InstalledAdapter } from "@barry-rocks/sdk/adapters/harnesses";
import { approvedBoundsSchema, boundFingerprint, mergeBounds, type ApprovedBounds } from "@barry-rocks/sdk/bounds";
import { AuthPrincipalSchema, type AuthPrincipal } from "@barry-rocks/sdk/internal/auth";
import { identityEnvironment, requiredCredentials, assertSessionCredentials } from "@barry-rocks/sdk/internal/env";
import { installationRegistry } from "@barry-rocks/sdk/internal/nodes";
import { workflowSessionId, type WorkflowSessionJournalStore } from "@barry-rocks/sdk/internal/sessions";
import { encodeEffectJson } from "@barry-rocks/sdk/internal/tools";
import { withStoreContext } from "@barry-rocks/sdk/internal/stores";
import type { SessionConfig } from "@barry-rocks/sdk/sessions";
import { identityRecords } from "@barry-rocks/identities-bag";
import { selectionOf } from "@barry-rocks/sessions-bag";
import { authorizeSessionExecution } from "@barry-rocks/sessions-bag/execution-authorization";
import { getSessionsSqlite } from "@barry-rocks/sessions-bag/store/sessions-db";
import { workflowTurnsStore } from "@barry-rocks/sessions-bag/store/workflow-turns";
import type { WorkflowDestinationBinding } from "@barry-rocks/sessions-bag/store/workflow-destinations";
import { sessionWorkflowScope } from "./session-workflow-control.js";
import { workflowSessionExecution, type SessionsWorkflowBackend } from "./workflow-session-backend.js";
import type { InstalledWorkflowRuntimeInstallation } from "./workflow-runtime-installation.js";
import { workflowRuntimeReferenceSchema } from "./workflow-runtime-closure.js";
import { assertWorkflowProviderCurrent, freezeWorkflowProvider, immutableWorkflowOrigin, resolveWorkflowSessionBounds, workflowNativeCeiling, type FrozenWorkflowProvider } from "./workflow-installed-bounds.js";

const intentSchema = z.strictObject({
  key: z.string().min(1).max(500), callerSessionId: z.string().min(1).max(500), identity: z.string().min(1).max(200),
  harness: z.string().min(1).max(200), model: z.string().min(1).max(500), bags: z.array(z.string().min(1)).max(1000),
  cwd: z.string().min(1).max(4000).refine(isAbsolute), maxTurns: z.number().int().positive().max(10000), deadline: z.number().finite().positive(),
});
export type InstalledWorkflowRequest = z.infer<typeof intentSchema> & { principal: AuthPrincipal };
interface Authority {
  version: 1; installation: string; requestHash: string; intent: z.infer<typeof intentSchema>;
  originHash: string; callerScope: ApprovedBounds; generation: string; recordHash: string;
  provider: FrozenWorkflowProvider; native: { allowed: string[]; denied: string[] };
  selectedBoundHash: string; declaration: WorkflowDestinationBinding;
}
export interface InstalledWorkflowSession {
  declaration: WorkflowDestinationBinding;
  start(key: string, input: unknown): Promise<unknown>;
  lookup(key: string): ReturnType<WorkflowSessionJournalStore["getTurn"]>;
  interrupt(key: string): Promise<boolean>;
}
function privateDirectory(path: string): string {
  if (!isAbsolute(path)) throw new Error("WorkflowAuthorityDirectoryUnavailable");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o077) !== 0 || process.getuid && info.uid !== process.getuid()) throw new Error("WorkflowAuthorityDirectoryUnavailable");
  return realpathSync(path);
}
function supported(record: InstalledAdapter, scope: ApprovedBounds): void {
  // This first executable profile has no Barry MCP credential issuer, dynamic
  // vendors/plugins or containment. Refuse requests needing those mechanisms.
  const bound = scope.bound;
  if (record.id !== "pi" || record.vendorCode || record.vendor || record.capabilities.endpoint !== "configurable"
    || record.modes.hosted?.approvalContinuation !== "durable" || record.modes.hosted.guarantees.gating !== "per-call"
    || record.capabilities.toolDenial !== "native" || Object.keys(record.modes.hosted.native?.uncontrolled ?? {}).length || Object.keys(scope.tools).length
    || bound?.files || bound?.bash || bound?.network) throw new Error("WorkflowInstalledProfileUnsupported");
  const node = installationRegistry().id;
  if (bound?.nodes?.deny?.some(id => id === "local" || id === node)
    || bound?.nodes?.allow && !bound.nodes.allow.some(id => id === "local" || id === node)) throw new Error("WorkflowInstalledNodeDenied");
}
const requiredFor = (record: InstalledAdapter, provider: Vendor) => requiredCredentials({ harness: { id: record.id, credentials: record.bag?.manifest.credentials }, routedVendors: [provider] });
function staticEndpoint(provider: Vendor): string {
  if (typeof provider.baseUrl !== "string") throw new Error("WorkflowProviderEndpointProfileUnsupported");
  return provider.baseUrl;
}

/** Only an already authenticated in-process caller may supply a principal.
 * No public route, Work capability advertisement or arbitrary host callback is installed. */
export class InstalledWorkflowSessions {
  private readonly directory: string;
  private closed = false;
  private readonly backends = new Set<SessionsWorkflowBackend>();
  constructor(private readonly options: { installation: InstalledWorkflowRuntimeInstallation; directory: string }) {
    this.directory = privateDirectory(options.directory);
  }
  private partition<T>(identity: string, operation: () => T): T { return withStoreContext({ identity }, operation); }
  private store(identity: string) {
    return this.partition(identity, getSessionsSqlite);
  }
  private read(identity: string, key: string): Authority | undefined {
    const row = this.store(identity).prepare("SELECT authority_hash,authority_json FROM session_workflow_execution_authorities WHERE binding_key=?").get(key) as { authority_hash: string; authority_json: string } | undefined;
    if (!row) return undefined;
    const authority = JSON.parse(row.authority_json) as Authority;
    if (authority.version !== 1 || boundFingerprint(authority) !== row.authority_hash || authority.declaration.identity !== identity
      || authority.intent.key !== key || authority.intent.identity !== identity
      || authority.installation !== installationRegistry().id) throw new Error("WorkflowAuthorityRecordUnavailable");
    return authority;
  }
  private async owner(principal: AuthPrincipal, identity: string, identityId?: number): Promise<number> {
    if (this.closed || principal.kind !== "installation") throw new Error("WorkflowAuthorityUnavailable");
    const id = identityId ?? installationRegistry().legacyIdentityId(identity);
    if (installationRegistry().identityId(id) !== identity) throw new Error("WorkflowAuthorityIdentityUnavailable");
    await this.partition(identity, () => authorizeSessionExecution(principal, { identityId: id }));
    return id;
  }
  private retained(authority: Authority) {
    const retained = this.options.installation.registry.descriptor(authority.generation);
    if (!retained || retained.registration.recordHash !== authority.recordHash
      || boundFingerprint(retained.registration.runtime) !== boundFingerprint(workflowRuntimeReferenceSchema.parse(authority.declaration.selection.runtime))) throw new Error("WorkflowAuthorityRuntimeUnavailable");
    supported(retained.record, authority.declaration.scope);
    if (authority.native.allowed.length || authority.declaration.selection.maxTurns !== 1) throw new Error("WorkflowInstalledToolFreeProfileRequired");
    return retained;
  }
  private async credentials(authority: Authority, record: InstalledAdapter): Promise<Record<string, string>> {
    const required = requiredFor(record, authority.provider.vendor), names = [...new Set(required.map(item => item.env))];
    // Credentials cannot override process roots, executable lookup or service-hop authority.
    if (names.some(name => !/^[A-Z][A-Z0-9_]*$/.test(name) || /^(BARRY_|PI_|NODE_|HOME$|PATH$|TMPDIR$)/.test(name))) throw new Error("WorkflowCredentialProfileUnsupported");
    try {
      const row = await identityRecords.row(authority.declaration.identityId);
      if (!row || row.actor_id !== authority.declaration.actorId) throw new Error("IdentityUnavailable");
      const env = await identityEnvironment(identityRecords.config(row), { names, cacheTtlMs: 0 });
      assertSessionCredentials({ required, env, ambientEnv: {}, credentialEnvs: new Set(names) });
      if (names.some(name => !env.vars[name])) throw new Error("CredentialUnavailable");
      return Object.fromEntries(names.map(name => [name, env.vars[name]!]));
    } catch { throw new Error("WorkflowDeclaredCredentialsUnavailable"); }
  }
  private async checkBounds(authority: Authority, principal: AuthPrincipal): Promise<void> {
    await this.owner(principal, authority.declaration.identity, authority.declaration.identityId);
    if (principal.actorId !== authority.declaration.actorId || Date.now() >= authority.declaration.selection.deadline) throw new Error("WorkflowAuthorityUnavailable");
    const retained = this.retained(authority), current = installedModels().vendors().find(vendor => vendor.id === authority.provider.vendor.id);
    if (!current || staticEndpoint(current) !== authority.provider.endpoint) throw new Error("WorkflowProviderSelectionChanged");
    assertWorkflowProviderCurrent(authority.provider, current);
    const resolved = await this.partition(authority.declaration.identity, () => sessionWorkflowScope(authority.intent.callerSessionId, principal, authority.declaration.identity, undefined, true));
    if (immutableWorkflowOrigin(resolved.row) !== authority.originHash || boundFingerprint(resolved.scope) !== boundFingerprint(authority.callerScope)) throw new Error("WorkflowCallerPolicyChanged");
    const parent = await resolveWorkflowSessionBounds(authority.declaration.identityId, selectionOf(resolved.row));
    const selected = await resolveWorkflowSessionBounds(authority.declaration.identityId, { ...selectionOf(resolved.row), bags: authority.intent.bags,
      harness: retained.record.id, mode: "hosted", defaults: false, identityDefaults: false });
    const callerBags = resolved.scope.bags ?? [];
    if (selected.bags.some(bag => !callerBags.includes(bag)) || boundFingerprint(selected.bound) !== authority.selectedBoundHash) throw new Error("WorkflowCallerPolicyChanged");
    const native = workflowNativeCeiling(parent, selected, retained.record);
    if (authority.native.allowed.some(name => !native.allowed.includes(name))) throw new Error("WorkflowNativePolicyChanged");
    // Bound resolution can perform asynchronous file/tool work. A row rebind
    // or identity deletion must not become valid because an earlier read passed.
    const final = await this.partition(authority.declaration.identity, () => sessionWorkflowScope(authority.intent.callerSessionId, principal, authority.declaration.identity, undefined, true));
    if (immutableWorkflowOrigin(final.row) !== authority.originHash || boundFingerprint(final.scope) !== boundFingerprint(authority.callerScope)) throw new Error("WorkflowCallerPolicyChanged");
    await this.owner(principal, authority.declaration.identity, authority.declaration.identityId);
    if (this.closed || Date.now() >= authority.declaration.selection.deadline) throw new Error("WorkflowAuthorityUnavailable");
    const finalProvider = installedModels().vendors().find(vendor => vendor.id === authority.provider.vendor.id);
    if (!finalProvider || staticEndpoint(finalProvider) !== authority.provider.endpoint) throw new Error("WorkflowProviderSelectionChanged");
    assertWorkflowProviderCurrent(authority.provider, finalProvider);
  }
  async prepare(request: InstalledWorkflowRequest): Promise<InstalledWorkflowSession> {
    const { principal: suppliedPrincipal, ...untrusted } = request, principal = AuthPrincipalSchema.parse(structuredClone(suppliedPrincipal)), intent = intentSchema.parse(structuredClone(untrusted));
    intent.bags = [...new Set(intent.bags)].sort();
    const requestHash = boundFingerprint(intent);
    const identityId = await this.owner(principal, intent.identity);
    const existing = this.read(intent.identity, intent.key);
    if (existing) {
      if (existing.requestHash !== requestHash || existing.declaration.actorId !== principal.actorId) throw new Error("WorkflowAuthorityRequestConflict");
      return this.assemble(existing, principal);
    }
    const origin = await this.partition(intent.identity, () => sessionWorkflowScope(intent.callerSessionId, principal, intent.identity));
    if (origin.row.metadata.workflow_bound !== undefined || origin.row.metadata.execution_context !== undefined
      || ["action-executor", "workflow-destination"].includes(String(origin.row.metadata.source))) throw new Error("WorkflowNestedAdmissionUnsupported");
    const originBags = origin.scope.bags ?? [];
    if (intent.bags.some(bag => !originBags.includes(bag)) || Date.now() >= intent.deadline
      || realpathSync(intent.cwd) !== intent.cwd || !lstatSync(intent.cwd).isDirectory()) throw new Error("WorkflowAuthoritySelectionUnavailable");
    const registration = this.options.installation.registry.current(intent.harness);
    const retained = registration && this.options.installation.registry.descriptor(registration.generation);
    const ref = parseModelRef(intent.model), vendor = ref && installedModels().vendors().find(item => item.id === ref.vendor);
    if (!registration || !retained || !ref || !vendor) throw new Error("WorkflowAuthoritySelectionUnavailable");
    const provider = freezeWorkflowProvider(vendor, ref.model, staticEndpoint(vendor));
    const parent = await resolveWorkflowSessionBounds(identityId, selectionOf(origin.row));
    const selected = await resolveWorkflowSessionBounds(identityId, { ...selectionOf(origin.row), bags: intent.bags,
      harness: retained.record.id, mode: "hosted", defaults: false, identityDefaults: false });
    if (selected.bags.some(bag => !originBags.includes(bag)) || selected.skills.length || selected.instructions.length || selected.tools.some(tool => tool.bag !== null)) throw new Error("WorkflowInstalledProfileUnsupported");
    const native = workflowNativeCeiling(parent, selected, retained.record);
    if (native.allowed.length || intent.maxTurns !== 1) throw new Error("WorkflowInstalledToolFreeProfileRequired");
    const evidence = { identity: intent.identity, bags: selected.bags, traits: selected.bags, bound: mergeBounds(origin.scope.bound, selected.bound), harness: retained.record.id, tools: {}, contracts: {} };
    const scope = approvedBoundsSchema.parse(JSON.parse(JSON.stringify({ ...evidence, fingerprint: boundFingerprint(evidence) })));
    supported(retained.record, scope);
    const authority: Authority = { version: 1, installation: installationRegistry().id, requestHash, intent,
      originHash: immutableWorkflowOrigin(origin.row), callerScope: origin.scope, generation: registration.generation,
      recordHash: registration.recordHash, provider, native, selectedBoundHash: boundFingerprint(selected.bound), declaration: {
        bindingKey: intent.key, sessionId: workflowSessionId(intent.key, intent.identity), identity: intent.identity, identityId,
        actorId: principal.actorId, scope, selection: { harness: retained.record.id, model: intent.model, endpoint: provider.endpoint,
          cwd: intent.cwd, maxTurns: intent.maxTurns, deadline: intent.deadline, runtime: registration.runtime },
      } };
    await this.checkBounds(authority, principal);
    await this.credentials(authority, retained.record);
    await this.checkBounds(authority, principal);
    if (this.options.installation.registry.current(intent.harness)?.generation !== registration.generation) throw new Error("WorkflowRuntimeSelectionChanged");
    const json = JSON.stringify(authority);
    this.store(intent.identity).prepare("INSERT OR IGNORE INTO session_workflow_execution_authorities(binding_key,authority_hash,authority_json) VALUES(?,?,?)").run(intent.key, boundFingerprint(authority), json);
    const winner = this.read(intent.identity, intent.key)!;
    if (boundFingerprint(winner) !== boundFingerprint(authority)) throw new Error("WorkflowAuthorityRequestConflict");
    return this.assemble(winner, principal);
  }
  async open(request: { key: string; identity: string; principal: AuthPrincipal }): Promise<InstalledWorkflowSession> {
    request = { ...request, principal: AuthPrincipalSchema.parse(structuredClone(request.principal)) };
    await this.owner(request.principal, request.identity);
    const authority = this.read(request.identity, request.key);
    if (!authority || authority.declaration.actorId !== request.principal.actorId) throw new Error("WorkflowAuthorityUnavailable");
    return this.assemble(authority, request.principal);
  }
  private assemble(original: Authority, originalPrincipal: AuthPrincipal): InstalledWorkflowSession {
    const authority = structuredClone(original), principal = structuredClone(originalPrincipal), retained = this.retained(authority);
    const identity = authority.declaration.identity, enter = <T>(operation: () => T) => this.partition(identity, operation);
    const home = privateDirectory(join(this.directory, authority.declaration.sessionId));
    const inertEnvironment = { HOME: home, BARRY_HOME: privateDirectory(join(home, "barry")), PI_CODING_AGENT_DIR: privateDirectory(join(home, "pi")),
      TMPDIR: privateDirectory(join(home, "tmp")), PATH: process.env.PATH ?? "" };
    const journal = new Proxy(workflowTurnsStore, { get: (target, property) => {
      const value = Reflect.get(target, property);
      return typeof value === "function" ? (...args: unknown[]) => enter(() => Reflect.apply(value, target, args)) : value;
    } });
    const { backend, turns } = workflowSessionExecution({ db: this.store(identity), declaration: authority.declaration,
      recovery: { spoolRoot: this.options.installation.executionSpool },
      enforceable: scope => boundFingerprint(scope) === boundFingerprint(authority.declaration.scope),
      authorize: () => enter(() => this.checkBounds(authority, principal)),
      authorizeTool: async (_scope, call) => {
        await enter(() => this.checkBounds(authority, principal));
        return { allow: false, reason: `Tool outside retained tool-free authority: ${call.tool}` };
      },
      prepare: launch => this.options.installation.prepare(authority.generation, { inertEnvironment,
        authorize: () => enter(() => this.checkBounds(authority, principal)), configure: async () => {
          await enter(() => this.checkBounds(authority, principal));
          const env = await enter(() => this.credentials(authority, retained.record));
          await enter(() => this.checkBounds(authority, principal));
          const endpoint = createModels([authority.provider.vendor], { env }).endpoint(authority.provider.vendor.id);
          if (!endpoint || endpoint.baseUrl !== authority.provider.endpoint) throw new Error("WorkflowProviderSelectionChanged");
          return { sessionId: authority.declaration.sessionId, cwd: authority.declaration.selection.cwd,
            model: authority.declaration.selection.model as SessionConfig["model"], endpoint, env: { ...inertEnvironment, ...env },
            mcpServers: {}, strictMcpConfig: true, pluginDirs: [], projectRoots: [], extraArgs: [],
            maxTurns: authority.declaration.selection.maxTurns, allowedNativeTools: authority.native.allowed, deniedTools: authority.native.denied };
        } }, launch),
    }, journal);
    this.backends.add(backend);
    const owned = async () => { await this.owner(principal, identity, authority.declaration.identityId);if (principal.actorId !== authority.declaration.actorId) throw new Error("WorkflowAuthorityUnavailable"); };
    const boundTurn = async (key: string) => {
      const row = await enter(() => turns.inspect(key));
      if (row) {
        if (row.sessionId !== authority.declaration.sessionId) throw new Error("WorkflowTurnBindingConflict");
        const destination = await enter(() => backend.lookupSession(row.sessionId));
        if (!destination || destination.identity !== identity || destination.boundFingerprint !== authority.declaration.scope.fingerprint) throw new Error("WorkflowTurnBindingConflict");
      }
      return row;
    };
    return { declaration: structuredClone(authority.declaration),
      start: async (key, input) => { await owned();await boundTurn(key);return enter(async () => { const id = await turns.ensure(authority.intent.key, authority.declaration.scope);return turns.turn(key, id, input, authority.declaration.scope); }); },
      lookup: async key => {
        await owned();
        const row = await boundTurn(key);
        if (!row || row.state === "complete" || row.state === "interrupted") return row;
        // Reconcile retained physical/result evidence without reading credentials
        // or submitting input again. Unknown evidence remains unknown.
        const observed = await enter(() => backend.lookupTurn(row.sessionId, key));
        if (observed?.state === "complete") await enter(() => workflowTurnsStore.updateTurn(key, "complete", encodeEffectJson(observed.result ?? null)));
        else if (observed?.state === "interrupted") await enter(() => workflowTurnsStore.updateTurn(key, "interrupted"));
        return boundTurn(key);
      },
      interrupt: async key => { await owned();await boundTurn(key);return enter(() => turns.interrupt(key)); },
    };
  }
  async close(): Promise<void> {
    this.closed = true;
    const backends = [...this.backends];
    // A replay/open may hold a standby backend for the same destination. Drain
    // every execution owner before any standby evaluates the shared physical
    // fences; each backend still performs its own strict cessation checks.
    const executions = await Promise.allSettled(backends.map(backend => backend.execution.close()));
    const results = await Promise.allSettled(backends.map(backend => backend.close()));
    const failures = [...executions, ...results].filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), "WorkflowInstalledSessionsCloseFailed");
    this.backends.clear();
  }
}

let installed: InstalledWorkflowSessions | undefined;
/** Service composition only; neither request configuration nor a binding key authenticates a caller. */
export function installWorkflowSessions(service: InstalledWorkflowSessions): void {
  if (installed) throw new Error("WorkflowSessionsAlreadyInstalled");
  installed = service;
}
export function installedWorkflowSessions(): InstalledWorkflowSessions {
  if (!installed) throw new Error("WorkflowSessionsNotInstalled");
  return installed;
}
