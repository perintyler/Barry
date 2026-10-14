import { spawn } from "child_process";
import { CliError, isCliError } from "../lib/cli-error.js";
import { adapterPreflightNotices } from "./doctor.js";
import { join, basename } from "path";
import { rmSync } from "fs";
import { input, confirm } from "@inquirer/prompts";
import { ExitPromptError, CancelPromptError } from "@inquirer/core";
import { PATHS, McpConfig } from "../config.js";
import { generateMcpConfig, checkSseHealth } from "../mcp-config.js";
import { baseIdentitySelection, loadBags, expandCompositionFromSnapshot, loadBagRegistrySnapshot, mergeBags, loadRegistry, isBuiltinBag } from "@barry-rocks/sdk/internal/bags";
import { sessionMcpConfig } from "../lib/session-mcp-config.js";
import { traitPicker, type TraitPickerResult } from "../prompts/trait-picker.js";
import type { Bound } from "@barry-rocks/sdk/bounds";
import { bagAuthCommand } from "./bag.js";
import { getCurrentUser } from "../lib/current-user.js";
import type { LaunchPlan, LaunchMode } from "@barry-rocks/sdk/adapters/harnesses";
import { NotSupportedInMode, type SessionConfig } from "@barry-rocks/sdk/sessions";

import { isIdentityCommand, cliName } from "../scope.js";
import { resolveLaunchMode, platformWarning, isRefusal, type ModeResolution } from "./launch-mode.js";
import { findInstalled, type InstalledAdapter } from "@barry-rocks/sdk/adapters/harnesses";
import { attachToHostedSession, buildSessionConfig, composeSystemPrompt, detachFromHostedSession, detachWhenGone, discoverConversation, runChildSession, thisCliCommand, type ResumeRequest } from "../sessions/launch.js";
import { resolveGrants, buildMcpConfig, preCreateSession as preCreateSessionStep, buildLaunchEnv, launchProvenanceEnv } from "../sessions/launch-context.js";
import { buildMergedSettings } from "../lib/settings.js";
import { Barry, type GrantSelection, type Grants } from "@barry-rocks/sdk";
import { identityRecords, traits } from "@barry-rocks/identities-bag";
import { generateId } from "@barry-rocks/sdk/ids";
import { readProcessStartTime } from "@barry-rocks/sessions-bag/process-liveness";
import {
  getSession,
  getSessionMessages,
} from "@barry-rocks/sessions-bag/client";

import { getServicePort, getServiceUrl } from "@barry-rocks/sdk/services";
import { identityEnvironment, assertSessionCredentials, requiredCredentials, declaredCredentialEnvs, type Environment, checkBagCredentials } from "@barry-rocks/sdk/internal/env";


// This file is imported eagerly at the top of
// cli/src/index.ts, so any import here that loads an agent SDK runs on EVERY
// CLI invocation, including --version/--help. None of the specifiers below
// do: `sdk-adapters-agents` has no vendor SDK at all, and the two adapter
// subpaths are SDK-free MODULES inside packages that do depend on one — the
// subpath is what makes the difference.
import { adapterSettings, defaultHarness, FALLBACK_HARNESS, type IdentityAdapters } from "@barry-rocks/sdk/internal/identities";
import type { Vendor, Check } from "@barry-rocks/sdk/adapters/models";
import type { HarnessId as CatalogProvider, ModeId } from "@barry-rocks/sdk/ids";
import { installedModels, isOfferedModel, routeModel, suggestOfferedModels, type Models, type RoutingHarness } from "@barry-rocks/sdk/adapters/models";




import { getBagsNeedingAuth, filterBagsNeedingAuthForSession } from "@barry-rocks/sdk/internal/vault";

import { resolveSessionNamespaces } from "@barry-rocks/sdk/internal/sessions";
import { resolveSkillDirs, listAllActions, selectSlashCommandActions } from "@barry-rocks/sdk/internal/actions";
import { listAllInstructions, buildInstructionsIndex, buildTraitInstructionPointer } from "@barry-rocks/sdk/internal/instructions";

import type { ActionMeta } from "@barry-rocks/sdk/internal/actions";
import type { MergedBagConfig } from "@barry-rocks/sdk/internal/bags";
import type { Bag } from "@barry-rocks/sdk/bags";

function apiHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (process.env.BARRY_SECRET) {
    headers["Authorization"] = `Bearer ${process.env.BARRY_SECRET}`;
  }
  return headers;
}



let knownCommands: string[] = [];
export function setKnownCommands(commands: string[]): void {
  knownCommands = commands;
}

/** Traits granted by --all and --read, including explicit resume selection. */
export async function allPackedTraits(bags: string[]): Promise<string[]> {
  const synced = await traits.syncBags(bags, { strict: true });
  const unavailable = synced.warnings.filter(warning => warning.kind === "bag-load-failed" || warning.kind === "unregistered-subbag");
  if (synced.timedOut || unavailable.length > 0) {
    throw new Error(`Cannot grant every packed bag: ${unavailable.map(warning => warning.message).join("; ") || "bag loading timed out"}`);
  }
  const available = new Set((await traits.installed(synced.composedBags)).map(trait => trait.name));
  return (await import("@barry-rocks/sdk/internal/traits")).bagTraits(bags).filter(name => available.has(name));
}

/**
 * How a no-traits-selected server list should be described to the user.
 *
 * The banner used to hardcode "(always-on only)" on every empty-selection
 * branch. That was true before the namespace split: the config really was just
 * `ALWAYS_ON_SERVERS`. It is not true now. `generateMcpConfig("http")` writes a
 * single server (`barry`), so the always-on seed contributes ONE key, and every
 * other entry is a namespace granted by the identity's own bags — which the
 * capability picker does not control. Telling someone who selected nothing that
 * they have "always-on only" asserts a security property the code does not
 * deliver: unchecking every trait, and `--none`, do not shrink this list.
 *
 * Under `bag_grant: session` (the default) that security property IS now
 * delivered for TOOLS: the server is still mounted, but its tools are filtered
 * out because no trait grants them. The label therefore has to separate the two
 * axes it used to conflate. Saying "from your barry's bags" alone would now
 * overclaim in the opposite direction — implying a grant that was withheld —
 * which is the same defect with the sign flipped.
 *
 * Derived from the config rather than hardcoded, so it cannot drift from the
 * list it labels the way the fixed string did.
 */
export function describeUnselectedServers(
  config: McpConfig,
  bagGrant: "session" | "identity" = "session",
): string {
  const alwaysOn = Object.keys(config.mcpServers).filter((name) => traits.alwaysOn.includes(name));
  const identityGranted = Object.keys(config.mcpServers).length - alwaysOn.length;
  if (identityGranted === 0) return "no traits selected — always-on only";
  return bagGrant === "identity"
    ? `no traits selected — ${alwaysOn.length} always-on + ${identityGranted} from your barry's bags`
    : `no traits selected — ${alwaysOn.length} always-on + ${identityGranted} mounted but ungranted (bag_grant: session)`;
}

/** What the capability picker offers, once builtins are filtered out. */
export interface OfferedCapabilities {
  traits: Array<{ name: string; description: string; boundHint?: string }>;
  /** Builtin traits withheld — 0 when `showBuiltin` is set. */
  hiddenTraitCount: number;
}

/**
 * Short marker naming a trait's restrictions for the picker.
 *
 * Deliberately just the bound names (plus a generic word for inline rules):
 * the picker is a one-line-per-trait list, and the full denial summary belongs
 * in `barry trait list`. The point here is only that a restricted trait must
 * not look identical to an unrestricted one.
 */
function boundHint(trait: { boundNames?: string[]; bound?: Bound }): string | undefined {
  const names = [...(trait.boundNames ?? [])];
  if (trait.bound && Object.keys(trait.bound).length > 0) names.push("bounded");
  return names.length > 0 ? names.join(", ") : undefined;
}

/**
 * Decide what the picker offers.
 *
 * Split out from `pickCapabilities` so the filtering can be tested without a
 * TTY: the reveal path (`--show-builtin`) is one boolean away from the hide
 * path, and inverting it silently would put ~10 builtin traits back in front
 * of the user, or — far worse — hide a user's own bags.
 *
 * Traits only: the picker no longer offers individual tools or bare namespaces
 * (see the note on `TraitPickerResult`). Per-tool selection lives in
 * BarrySessions, which reaches it through the session contract rather than
 * through this prompt.
 *
 * `isBuiltin` is injected rather than imported so tests can describe a bag set
 * without touching the real registry.
 */
export function offeredCapabilities(
  allTraits: Array<{
    name: string;
    bag: string | null;
    description: string | null;
    tools: string[];
    namespaces: string[];
    // Optional so existing callers and fixtures stay valid: these are carried
    // through for display only, and a caller that has no bound data should not
    // be forced to invent it.
    boundNames?: string[];
    bound?: Bound;
  }>,
  showBuiltin: boolean,
  isBuiltin: (bag: string) => boolean = isBuiltinBag,
): OfferedCapabilities {
  // Builtin bags are Barry's own plumbing, and the ones a session needs are
  // already reachable without being picked: their namespaces arrive through
  // DEFAULT_TRAITS (`sessions` absorbs actions/changes/events, `coding` covers
  // system/filesystem/git, and instructions is granted
  // directly). Offering them again as choices made the picker mostly noise —
  // ~25 bags deep before the first bag the user actually installed.
  // `--show-builtin` brings them back.
  //
  // Hiding a builtin whose namespace NO default trait covers would strand it:
  // filterTools fails closed, so it would be unreachable with nothing in the
  // UI saying so. session-bound.test.ts guards that for the always-on set.
  //
  // A trait with no `bag` is user-authored or a cross-bag composite (`all`,
  // `read`, `coding`); those are never builtin and always offered.
  const traits = showBuiltin ? allTraits : allTraits.filter((t) => !t.bag || !isBuiltin(t.bag));

  return {
    traits: traits.map((t) => ({
      name: t.name,
      description: t.description ?? t.tools.join(", "),
      // A separate field, never folded into `description`: the picker filters
      // on name and description, so concatenating would quietly change what
      // typing matches. Names only, not the resolved denials — the picker
      // renders one line per trait with no width budget.
      ...(boundHint(t) ? { boundHint: boundHint(t) } : {}),
    })),
    hiddenTraitCount: allTraits.length - traits.length,
  };
}

/**
 * Capabilities offered by the interactive picker, scoped to the bags this
 * barry actually holds.
 *
 * `Traits.list()` is a bare `SELECT *` on an append-only table (`ensureTraits`
 * never deletes), so it accumulates a row for every bag ever synced on this
 * machine — including bags renamed by the pack->bag migration, uninstalled
 * since, or belonging to a different barry. Offering those meant picking a
 * trait that resolves to zero tools at runtime, with nothing in the UI saying
 * so. `Traits.listInstalled` keeps rows whose `bag` is null (user-authored and
 * cross-bag composites like `all`/`read`/`coding`, which have no single owner)
 * and drops the rest.
 *
 * The API's `GET /traits` has filtered this way for a while; this brings the
 * CLI in line with it. It scopes tighter than the API does — to this barry's
 * own bags rather than every registered one — because the picker's whole job
 * is to offer what *this* session can actually use.
 */
async function pickCapabilities(
  installedBags: string[],
  selectedTraits?: string[],
  showAll = false,
  header?: SessionHeader,
  identityId?: number | null,
): Promise<TraitPickerResult> {
  const allTraits = await traits.installed(installedBags);
  if (identityId) for (const trait of await Barry.identity(identityId).traits()) {
    if (!trait.optional || allTraits.some(existing => existing.name === trait.name)) continue;
    allTraits.push({ ...trait, description: trait.description ?? null, namespaces: trait.namespaces ?? [], tools: trait.tools ?? [], skills: trait.skills ?? [], instructions: trait.instructions ?? [], bound: trait.bound ?? {}, boundNames: trait.boundNames ?? [], access: trait.access ?? "read", bag: trait.bag ?? null });
  }

  const offered = offeredCapabilities(allTraits, showAll);
  const { hiddenTraitCount } = offered;

  const result = await traitPicker({
    ...(header ? { header } : {}),
    // Name the real flag: `--all` is a different thing (it skips the picker
    // outright), so pointing at it here sent users somewhere they did not mean
    // to go.
    message: hiddenTraitCount > 0
      ? `Select capabilities (${hiddenTraitCount} builtin hidden — --show-builtin to show)`
      : "Select capabilities",
    traits: offered.traits,
    ...(selectedTraits && selectedTraits.length > 0 ? { selectedTraits } : {}),
  });

  return result;
}

/**
 * The last thing a session prints. A bare ID made the user assemble the
 * command themselves; this is the whole line, ready to paste back.
 */
function printResumeHint(sessionId: string): void {
  console.log(`\nSession: ${sessionId}`);
  console.log(`  ${cliName()} session resume ${sessionId}`);
}

/**
 * The banner the README's quick start shows: who this barry is, what it is
 * carrying, and the ID needed to resume it.
 */
interface SessionHeader {
  identity?: string;
  bags?: string;
  sessionId?: string;
}

/**
 * The same banner for the paths that never draw the picker — `--traits`,
 * `--all`, `--prompt`, a non-TTY fallback. Without it those sessions would
 * print no session ID until exit, which is exactly when it is too late to
 * copy one.
 */
function printSessionHeader(header: SessionHeader): void {
  if (header.identity) console.log(`  Identity: ${header.identity}`);
  if (header.bags) console.log(`  Bags: ${header.bags}`);
  if (header.sessionId) console.log(`  Session: ${header.sessionId}`);
  // Decision 28: guards catch ordinary mistakes, not a determined adversary —
  // only a supported sandbox enforces against one. Said plainly here so a guard
  // is never mistaken for sandbox enforcement.
  console.log("  Guards are best-effort against ordinary mistakes; adversarial enforcement needs a supported sandbox.");
}

/**
 * Write the session's traits before anything asks the server what the session
 * can do.
 *
 * Order matters and is the whole point. Building the MCP config queries
 * `/session-namespaces`, and the MCP server caches that resolution per session.
 * Writing the traits afterwards meant the first query resolved a trait-less
 * session and the agent inherited the stale answer — `--traits notion` produced
 * a session with no notion tools. The server now re-resolves when a session's
 * traits change, so this is no longer a correctness bug, but resolving twice
 * per start is pure waste: the first pass is always discarded.
 *
 * Best-effort by design. A session that cannot record its traits should still
 * start — the agent just gets the default grant — so this warns and returns
 * rather than throwing.
 */
async function persistSessionTraits(sessionId: string, traits: string[]): Promise<void> {
  try {
    const resp = await fetch(`http://localhost:${getServicePort("api")}/api/v1/sessions/${sessionId}`, {
      method: "PATCH",
      headers: apiHeaders(),
      body: JSON.stringify({ traits }),
    });
    if (!resp.ok) {
      console.warn(`Warning: Could not save traits — HTTP ${resp.status}`);
    }
  } catch (err) {
    console.warn(`Warning: Could not save traits — ${err instanceof Error ? err.message : err}`);
  }
}

/** What a session of this identity (none: a session with no identity) is granted, given what it selects. */
function grantsOf(identityId: number | null, selection: GrantSelection): Promise<Grants> {
  return identityId ? Barry.identity(identityId).grants(selection) : Barry.grants(selection);
}

/**
 * Resolve granted namespaces for pre-flight auth checks.
 *
 * Compares against the session's granted namespaces (traits, identity-level
 * grants, and active tools) rather than currently active tools alone —
 * an unauthorized bag has no active tools yet, so comparing against active
 * tools alone would drop unauthorized bags that were legitimately granted.
 */
export async function resolveGrantedNamespacesForSession(params: {
  sessionId?: string;
  identityId: number | null;
  sessionTraits: string[];
  isAll?: boolean;
  harness?: string;
}): Promise<string[] | undefined> {
  if (params.isAll) return undefined;

  const granted = await grantsOf(params.identityId, {
    traits: params.sessionTraits,
    ...(params.harness ? { harness: params.harness } : {}),
  });
  const namespaces = new Set<string>(granted.namespaces);
  if (params.sessionId) {
    for (const active of await resolveSessionNamespaces(params.sessionId)) namespaces.add(active);
  }
  return [...namespaces];
}

/**
 * The MCP config a session starts with, from what its identity and the traits
 * it selected grant: the barry aggregate plus one endpoint per granted
 * namespace, so a tool keeps its namespace's prefix instead of collapsing onto
 * mcp__barry__*. Records the selected traits on the session first: every
 * branch that picks traits builds a config from them at once, and the two must
 * not be separated (see `persistSessionTraits`).
 */
async function grantedMcpConfig(
  identityId: number | null,
  traitNames: string[],
  sessionId?: string,
  harness?: string,
): Promise<McpConfig> {
  if (sessionId) await persistSessionTraits(sessionId, traitNames);
  const { namespaces } = await grantsOf(identityId, { traits: traitNames, ...(harness ? { harness } : {}) });
  return await sessionMcpConfig(namespaces, sessionId, namespaces);
}

/**
 * The installed record a launch runs on: a harness flag (or a resumed
 * session's recorded harness), then a vendor flag on the fallback harness,
 * then the identity's default, then the fallback. Picked once, before the mode
 * or any session state: an identity's harness that was applied later reached
 * the context but not the launch, so a codex identity ran Claude.
 */
export function selectHarness(options: StartOptions, adapters: IdentityAdapters, records: readonly InstalledAdapter[]): InstalledAdapter {
  const id = options.harness ?? (options.zai || options.ollama || options.llamacpp || options.modelProvider ? FALLBACK_HARNESS : defaultHarness(adapters) ?? FALLBACK_HARNESS);
  const record = findInstalled(records, id);
  if (!record) throw new Error(`${id} is not an installed adapter. Install its session adapter package, then run barry adapter add <package-directory>. See barry adapter list.`);
  return record;
}

/**
 * `--mode`, then the identity's entry for this harness, then the adapter's own
 * default. An undeclared mode refuses rather than downgrades, and says when the
 * identity named it, since no flag on the command line explains the refusal.
 */
export function selectMode(options: StartOptions, identity: { name: string; adapters: IdentityAdapters }, record: InstalledAdapter): ModeResolution {
  const settings = adapterSettings(identity.adapters, record);
  const requested = options.mode ?? settings?.mode;
  const resolved = resolveLaunchMode(record, requested);
  if (isRefusal(resolved)) {
    const origin = options.mode === undefined && settings?.mode ? `identity ${identity.name} sets adapters.${record.id}.mode: ${settings.mode}: ` : "";
    throw new Error(origin + resolved.message);
  }
  return resolved;
}

/**
 * `selectMode`, or refuse and exit. An unverified platform WARNS and proceeds
 * (`platforms` means "verified here", not "broken elsewhere"), while an
 * undeclared mode REFUSES. The difference is whether Barry knows the mode
 * cannot work or merely has not measured it.
 */
function resolveModeOrExit(options: StartOptions, identity: { name: string; adapters: IdentityAdapters }, record: InstalledAdapter): ModeResolution {
  let resolved: ModeResolution;
  try { resolved = selectMode(options, identity, record); }
  catch (error) { throw new CliError(error instanceof Error ? error.message : String(error), 1); }
  const warning = platformWarning(record, resolved.mode, resolved.declared, process.platform);
  if (warning) console.error(warning);
  return resolved;
}

/**
 * Every credential env var declared anywhere on this host: across installed
 * adapters' harness manifests and every vendor row. The ambient-strip
 * denylist.
 */
async function sessionCredentialEnvs(): Promise<Set<string>> {
  const { adapterStore } = await import("../adapters/installed.js");
  const { adapters } = await adapterStore();
  return declaredCredentialEnvs({
    vendors: installedModels().vendors(),
    harnessManifests: adapters
      .installed()
      .map((record) => record.bag?.manifest.credentials as Record<string, unknown> | undefined),
  });
}

/**
 * The mode to write onto the session, resolved from the same record and
 * request as the launch. It never exits: `startCommand` has already refused
 * anything invalid, and a launch that dies while writing its provenance is
 * worse than one that records the requested mode, else the adapter's default.
 */
export function resolveRecordedMode(record: InstalledAdapter, requested: string | undefined): string {
  const resolved = resolveLaunchMode(record, requested);
  return isRefusal(resolved) ? requested ?? record.defaultMode : resolved.mode;
}

export interface ModelSelection {
  model: string | undefined;
  /** The model provider requests go to; `undefined` means the agent's own endpoint. */
  modelProvider: string | undefined;
}

/**
 * Which model, served by which model provider, a CLI session runs on: `-m`,
 * then the identity's entry for this harness, then the provider's default.
 *
 * The provider is chosen EXPLICITLY when anything names one (a flag, or the
 * vendor of the identity's `vendor/model` ref) and only inferred from the
 * curated catalog otherwise. Inference alone is what let `--ollama -m
 * my-custom:7b` lose its route: the custom id is in no catalog, so it went to
 * Anthropic. The provider's default model is the LAST fallback; placing it
 * earlier silently replaced an identity's chosen Ollama model.
 *
 * Throws on conflicting provider flags or a harness/provider pair the harness
 * cannot speak, before any session exists.
 */
export function resolveModelSelection(
  options: StartOptions,
  harness: RoutingHarness,
  identityModel?: string,
  vendors: readonly Vendor[] = installedModels().vendors(),
): ModelSelection {
  const flagged = [
    options.modelProvider,
    options.zai ? "zai" : undefined,
    options.ollama ? "ollama" : undefined,
    options.llamacpp ? "llamacpp" : undefined,
  ].filter((value): value is string => !!value);
  if (new Set(flagged).size > 1) {
    throw new Error(`Conflicting model providers: ${[...new Set(flagged)].join(", ")}`);
  }
  const route = routeModel(
    harness,
    {
      ...(options.model ? { model: options.model } : {}),
      ...(flagged[0] ? { vendor: flagged[0] } : {}),
      identity: { model: identityModel },
    },
    vendors,
  );
  return { model: route.model, modelProvider: route.vendor };
}

/**
 * The preflight lines for an Ollama-routed session, one per outcome.
 *
 * Never throws and never blocks: a failed check is reported, and the session
 * launches anyway. Always returns the tool-call line — success included — so a
 * skipped check is distinguishable from a passed one. The size warning is
 * independent of the probe, because tool-call failure in small models is
 * intermittent and a pass does not predict the next turn.
 */
export async function ollamaPreflightNotices(
  model: string,
  options: { baseUrl?: string } = {},
  models: Models = installedModels(),
): Promise<string[]> {
  const checks = await models
    .check(`ollama/${model}`, options.baseUrl ? { baseUrl: options.baseUrl } : undefined)
    .catch((err): Check[] => [
      { name: "tool call", status: "failed", observed: `probe error: ${err instanceof Error ? err.message : String(err)}` },
    ]);
  const notices: string[] = [];
  for (const check of checks) {
    // The size warning is a sentence of its own, printed as written.
    if (check.name === "size") {
      if (check.status !== "ok") notices.push(check.observed);
    } else if (check.name === "tool call" || check.status === "failed") {
      notices.push(`Preflight ollama/${model}: ${check.observed}${check.fix ? ` — run ${check.fix}` : ""}`);
    }
  }
  return notices;
}

export async function llamacppPreflightNotices(
  model: string,
  options: { baseUrl?: string } = {},
  models: Models = installedModels(),
): Promise<string[]> {
  const checks = await models
    .check(`llamacpp/${model}`, options.baseUrl ? { baseUrl: options.baseUrl } : undefined)
    .catch((err): Check[] => [
      { name: "tool call", status: "failed", observed: `probe error: ${err instanceof Error ? err.message : String(err)}` },
    ]);
  const notices: string[] = [];
  for (const check of checks) {
    if (check.name === "tool call" || check.status === "failed") {
      notices.push(`Preflight llamacpp/${model}: ${check.observed}${check.fix ? ` — ${check.fix}` : ""}`);
    }
  }
  return notices;
}

export interface StartOptions {
  harness?: string;
  traits?: string;
  /** Named bound to restrict the session (see `barry bound list`). */
  bound?: string;
  all?: boolean;
  /**
   * Show builtin bags in the overview line and the capability picker.
   *
   * Distinct from `--all`, which skips the picker altogether: this one changes
   * what the picker OFFERS. Builtins are hidden by default because every one of
   * them is already granted via DEFAULT_TRAITS, so picking them is a no-op.
   */
  showBuiltin?: boolean;
  read?: boolean;
  relax?: boolean;
  directive?: string | true;
  none?: boolean;
  ui?: string;
  noUi?: boolean;
  /** Identity alias for --name; whichever is set wins at identity resolution. */
  barry?: string;
  transport?: "http" | "sse" | "stdio";
  noBranding?: boolean;
  quickStart?: boolean;
  fullBranding?: boolean;
  healthCheck?: boolean;
  zai?: boolean;
  ollama?: boolean;
  llamacpp?: boolean;
  modelProvider?: string;
  /**
   * `--mode`. Left as a plain string: validating it against the ADAPTER's
   * declared modes (not against the ModeId union) is what produces a refusal
   * naming what that adapter can actually do. A typed field here would reject
   * "hosted" for an adapter that does not support it with a generic parse
   * error instead.
   */
  mode?: string;
  prompt?: string;
  model?: string;
  /** Identity whose API keys/bags to use (--name, or its --barry alias). */
  name?: string;
  /** Session display name (-N/--session-name). Suppresses the end-of-session prompt. */
  sessionName?: string;
  // Internal: set by resumeCommand to reuse an existing session
  _resumeSessionId?: string;
  _resumeTraits?: string[];
  _resumeBounds?: string[];
  /**
   * Internal: what resumeCommand asked to resume, provider-agnostic.
   *
   * Was three codex-shaped booleans (`_codexResume`, `_codexResumeLast`,
   * `_codexResumeSessionId`) that every other provider had to work around by
   * passing raw flags through argv instead. The adapters translate this into
   * each vendor's own spelling.
   */
  _resume?: ResumeRequest;
}

interface ResolvedIdentity {
  id: number;
  configuration: import("@barry-rocks/sdk/internal/identities").ResolvedIdentityConfig;
  bags: string[];
  adapters: IdentityAdapters;
  /**
   * Named bound the identity applies when the session does not name one with
   * `--bound`. This is how an identity stays bounded by default; without it the
   * restriction would depend on remembering a flag every time.
   */
  /**
   * Whether this identity's packed bags grant their tools to every session.
   * Non-optional so a caller cannot forget it and silently get the wording for
   * the wrong mode; the loader always resolves it.
   */
  bagGrant: "session" | "identity";
}

/**
 * Resolve inherited configuration and record use on the leaf identity.
 */
async function resolveIdentity(identityName: string): Promise<ResolvedIdentity> {
  // Directory first, as resolution found it. A session records its identity's
  // row, so an identity with none (its record then carries a hash of its name)
  // is as absent here as it always was.
  const found = await identityRecords.find(identityName).catch(() => undefined);
  const identity = found && (await identityRecords.row(found.record.id)) ? found.record : undefined;
  if (!identity) {
    throw new Error(`Barry "${identityName}" not found`);
  }

  await identityRecords.touch(identity.id);

  const meta = identityRecords.config(identity);
  const bags = meta?.bags ?? [];
  // Mirrors resolveIdentityConfig: anything but the explicit opt-in reads as
  // "session", so a typo fails toward NOT granting.
  const bagGrant: "session" | "identity" = meta?.bag_grant === "identity" ? "identity" : "session";

  // The name is already printed at resolution time, together with *why* this
  // identity was chosen — repeating it bare here said less, twice.
  return { id: identity.id, configuration: meta, bags, adapters: meta.adapters, bagGrant };
}

/**
 * Suggest pinning an identity to this repo — but only where that is actionable.
 *
 * Silent with a single identity (nothing to choose between) and silent when the
 * repo is already pinned. Best-effort: a tip must never be why a session fails
 * to start.
 */
async function maybeSuggestLocalIdentity(): Promise<void> {
  try {
    const names = new Set((await identityRecords.list()).map((entry) => entry.record.name));

    if (names.size > 1) {
      console.log("  Tip: pin an identity to this repo with `barry use --local`");
    }
  } catch {
    // Listing identities is not worth failing a session over.
  }
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/**
 * Everything the provider launchers need after the shared setup completes.
 * Populated by resolveLaunchContext, consumed by the launch* functions.
 */
interface LaunchContext {
  sessionId: string;
  childEnv: Record<string, string | undefined>;
  tmpDirs: string[];
  settingsPath: string;
  mcpConfigPath: string;
  /** What `mcpConfigPath` holds, for a harness that takes the servers directly. */
  mcpServers: McpConfig["mcpServers"];
  bagConfig: MergedBagConfig | null;
  /** Skill directories granted by the session's + barry's traits (trait.skills → bag registry) */
  traitSkillDirs: string[];
  /**
   * Instruction index + trait pointers, appended to the system prompt.
   * Empty when this session can reach no on-demand instructions.
   */
  instructionPrompt: string;
  /** Actions from this session's bags that declared `slash_command: true`. */
  slashCommandActions: ActionMeta[];
  claudeArgs: string[];
  directive: string | null;
  /** Effective model: --model flag > identity adapter model. undefined = provider decides. */
  model?: string;
  modelProvider?: string;
  /** Whether this is an interactive (non --prompt) session. */
  interactive: boolean;
  /** Native inventory less allowed trait grants, plus explicit denials. */
  deniedTools: string[];
  allowedNativeTools: string[];

  /** Session name from --name flag (skips end-of-session name prompt). */
  sessionName?: string;
}

/** Remove temp dirs created during setup (best-effort). Shared by close + signal + SDK cleanup. */
function cleanupTmpDirs(tmpDirs: string[]): void {
  for (const dir of tmpDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
}

/**
 * Prompt the user to name the session after it closes.
 * Only runs for interactive sessions that had at least one exchange.
 */
async function promptSessionName(sessionId: string): Promise<void> {
  try {
    // Check if the session had at least 1 user message and 1 assistant message.
    //
    // Through the seam. This was a raw `db.selectFrom("messages")` GROUP BY
    // against the old server database, and migration 041 dropped that table —
    // so the whole
    // function has been throwing since, swallowed by the `try` below, and the
    // name prompt silently stopped appearing.
    //
    // A page rather than a GROUP BY: the seam has no aggregate surface, and
    // the question is only "did both roles speak at least once", which the
    // first handful of messages answers.
    const page = await getSessionMessages(sessionId, { limit: 50 });
    const roles = new Set(
      page.messages
        .map((m) => m.role)
        .filter((r): r is string => typeof r === "string"),
    );

    const hasUser = roles.has("user");
    const hasAssistant = roles.has("assistant");
    if (!hasUser || !hasAssistant) return;

    const name = await input({ message: "Session name (enter to skip):" });
    const trimmed = name.trim();
    if (trimmed) {
      // Through the API, not the DB: the CLI's one write path (Stage 2 of the
      // session-storage extraction — control-plane writes converge on HTTP).
      await fetch(`http://localhost:${getServicePort("api")}/api/v1/sessions/${sessionId}`, {
        method: "PATCH",
        headers: apiHeaders(),
        body: JSON.stringify({ name: trimmed }),
      });
    }
  } catch {
    // Prompt cancelled or DB unavailable — skip silently
  }
}

/**
 * Tell the API which OS process is running this session, so liveness can be a
 * fact rather than an inference.
 *
 * The session row is created before the child is spawned, so this is a second
 * write and cannot ride on `/sessions/start`. Sent through the API rather than
 * the DB, matching promptSessionName above — the CLI's one write path.
 *
 * pid and start time travel together: on their own a pid is not evidence,
 * because the OS reuses pids and a recycled one would make a dead session look
 * alive.
 */
interface ProcessIdentityReport {
  command?: string;
  processName?: string;
  appName?: string;
  parentPid?: number;
}

async function reportSessionPid(
  sessionId: string,
  pid: number,
  identity?: ProcessIdentityReport,
): Promise<void> {
  try {
    await fetch(`http://localhost:${getServicePort("api")}/api/v1/sessions/${sessionId}`, {
      method: "PATCH",
      headers: apiHeaders(),
      body: JSON.stringify({
        pid,
        pidStartedAt: readProcessStartTime(pid),
        command: identity?.command,
        processName: identity?.processName,
        appName: identity?.appName,
        parentPid: identity?.parentPid,
      }),
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    // Never block or fail the session over bookkeeping. A missed write leaves
    // the session with no pid, which the reaper reads as "unknown" and leaves
    // to the existing idle sweep — the pre-existing behaviour, not a new risk.
  }
}

/**
 * Wire the shared teardown + signal handling onto a spawned child.
 * On close: run the optional onClose hook, await endSession, clean up temp dirs, then exit with the child's code.
 * On SIGINT/SIGTERM: clean up temp dirs, kill the child, and exit — so Ctrl+C no longer leaks temp dirs.
 */
function attachChildLifecycle(
  child: ReturnType<typeof spawn>,
  ctx: LaunchContext,
  onClose?: () => void | Promise<void>,
  identity?: ProcessIdentityReport,
): void {
  // Every provider launcher funnels through here, so recording the pid once
  // covers claude, codex, cursor and opencode.
  if (child.pid) void reportSessionPid(ctx.sessionId, child.pid, identity);

  child.on("close", async (code) => {
    await onClose?.();
    // Do NOT clear pid! Stale PID is safe under pid-reuse guard, and keeps the
    // evidence that lets the reaper prove death within 5 minutes.
    // Instead, await endSession close-write with a 2s timeout (and retry once)
    // before process.exit.
    await endSession(ctx.sessionId);
    if (ctx.interactive && !ctx.sessionName) {
      const session = await getSession(ctx.sessionId);
      if (!session?.metadata?.name) {
        await promptSessionName(ctx.sessionId);
      }
    }
    printResumeHint(ctx.sessionId);
    cleanupTmpDirs(ctx.tmpDirs);
    process.exit(code ?? 0);
  });

  const onSignal = () => {
    cleanupTmpDirs(ctx.tmpDirs);
    try { child.kill(); } catch { /* child may already be gone */ }
    process.exit(130);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}





/**
 * A hosted launch: the session runs in Barry's API, and this terminal renders
 * it — lines typed become turns, Ctrl-C ends the running turn, leaving ends
 * only the terminal. `once` is the one-shot (`-p`): one turn, then exit.
 *
 * Also where a harness whose own one-shot is not a TUI launch runs its `-p`.
 */
async function runHostedLaunch(
  ctx: LaunchContext,
  harness: string,
  prompt: string | undefined,
  once: boolean,
  options?: StartOptions,
  identity?: ResolvedIdentity,
): Promise<void> {
  const { launchSessionUi } = await import("../ui/dispatch.js");
  await launchSessionUi(
    {
      sessionId: ctx.sessionId,
      tmpDirs: ctx.tmpDirs,
      harness,
      model: ctx.model,
      modelProvider: ctx.modelProvider,
      prompt,
      once,
      repoPath: process.cwd(),
    },
    {
      ui: options?.ui,
      noUi: options?.noUi,
      selectedIdentity: identity,
      cleanupTmpDirs: (dirs) => cleanupTmpDirs(dirs ?? []),
      printResumeHint,
    },
  );
}

/**
 * Exits with "Unknown command" if `first` looks like a command name Commander
 * was never told about — i.e. it reached the default `session start` action
 * only because nothing else claimed it, not because the user meant to start a
 * session named that. A no-op for flags and anything already registered.
 *
 * Exported so `index.ts` can run this ahead of `program.parse()`. It has to
 * live outside the start action: Commander resolves `--help`/`-h` at the
 * ROOT, before any action (including start's) ever runs, so a guard placed
 * only inside `resolveLaunchContext` never sees `barry <typo> --help` — that
 * invocation fell through to root help with exit 0 instead of reporting the
 * unknown command.
 */
export function checkKnownCommand(first: string): void {
  if (!first || first.startsWith("-") || !/^[a-z][\w-]*$/i.test(first)) return;
  if (knownCommands.includes(first)) return;

  if (isIdentityCommand(first)) {
    console.error(`Error: "${first}" is an identity command, not a system command.\n`);
    console.error(`Barry operates through identity personas. Run the command under an identity:`);
    console.error(`  <identity> ${process.argv.slice(2).join(" ")}`);
    console.error(`\nOr specify an identity explicitly:`);
    console.error(`  barry --identity <identity> ${process.argv.slice(2).join(" ")}`);
    console.error(`\nRun "barry identity list" to see your installed identities.`);
    process.exit(1);
  }

  const close = knownCommands.filter((cmd) => levenshtein(first, cmd) <= 2 && first !== cmd);
  if (close.length > 0) {
    console.error(`Unknown command: ${first}`);
    console.error(`Did you mean: ${close.join(", ")}?`);
    process.exit(1);
  }
  console.error(`Unknown command: ${first}`);
  console.error(`Run "barry --help" for available commands.`);
  process.exit(1);
}

/**
 * Shared setup for every provider: command-typo detection, barry/bag/trait
 * resolution, MCP config building, temp-dir creation, session pre-creation, and
 * child env population (including barry env resolution + vault resolver).
 * Returns everything the launchers need.
 */
async function selectIdentity(options: StartOptions): Promise<ResolvedIdentity & { name: string }> {
  try {
    const user = await getCurrentUser();
    // An explicit name, then BARRY_IDENTITY (a per-identity command), then
    // the repository's .barry, then the owner's active default: the operation
    // reads the last three itself.
    const selection = await identityRecords.resolve({
      // --name is the identity flag here, matching every other barry command;
      // --barry is its alias. (--session-name names the session.)
      name: options.barry ?? options.name,
      repoPath: process.cwd(),
    });
    const identityName = selection.barry.name;
    // Name first: the source alone ("file") is the same string for a repo
    // binding and the global default, so it never answered "who am I running
    // as?" — the question this line exists for.
    console.log(`Barry: ${identityName} (${identityRecords.describeSource(selection.source)})`);

    // Only worth suggesting when it can be acted on: nothing pinned here, and
    // more than one identity to choose between. A tip that fires when there is
    // no choice to make just teaches the user to ignore tips.
    if (selection.source !== "repo") {
      await maybeSuggestLocalIdentity();
    }

    // Drift is silent by construction: the directory wins on read, so a stale
    // row only shows up as a session behaving unlike its barry.yaml. Say so
    // here, where it is about to affect this session.
    // Compare the ROW with the file. selection.barry is loaded from the
    // directory for a file-backed identity, so passing it compared the file
    // with itself and this warning could never fire.
    const cachedRow = await identityRecords.row(selection.barry.id);
    const drift = cachedRow && cachedRow.name === identityName ? identityRecords.drift(cachedRow, user.id) : [];
    if (drift.length > 0) {
      console.warn(
        `Warning: "${identityName}" has ${drift.length} field${drift.length === 1 ? "" : "s"} ` +
          `where its database row disagrees with barry.yaml (${drift.map((d) => d.field).join(", ")}). ` +
          `This session uses barry.yaml. Run: barry doctor --fix`,
      );
    }

    return { ...await resolveIdentity(identityName), name: identityName };
  } catch (error: unknown) {
    if (isCliError(error)) throw error;
    throw new CliError(`Error loading barry: ${error instanceof Error ? error.message : String(error)}`, 1);
  }

}

async function resolveLaunchContext(args: string[], options: StartOptions, identity: ResolvedIdentity & { name: string }, harnessRecord: InstalledAdapter, requestedMode: string | undefined, mode: ModeId): Promise<LaunchContext> {
  // Check if first arg looks like a mistyped command (since start is the default command).
  // Also caught pre-parse in index.ts (see checkKnownCommand's doc comment) — kept
  // here too as defense in depth for any path that reaches this action directly.
  if (args.length > 0) checkKnownCommand(args[0]);

  // `--read` is `--all` under the `readonly` bound. It used to select a shipped
  // composite trait, `read`, whose bag list went stale whenever a bag was
  // added; now it is whatever `--all` grants, restricted.
  if (options.read) {
    options.bound = [...new Set([...(options.bound?.split(",").map(name => name.trim()).filter(Boolean) ?? []), "readonly"])].join(",");
    options.all = true;
  }

  const claudeArgs = args;

  // Determine transport mode (default: http for instant startup)
  const transport = options.transport ?? "http";

  let identityBagNames = identity.bags;
  const { name: identityName, id: identityId, configuration: identityConfiguration, bagGrant: identityBagGrant } = identity;

  // Pre-warm / kick off identity secret resolution in the background while
  // bag composition, prompts, and the interactive trait picker are displayed.
  const pendingIdentityEnv: Promise<Environment | null> = identityConfiguration
    ? identityEnvironment(identityConfiguration)
    : Promise.resolve(null);
  // A failure is reported where this is awaited. Until then it is marked
  // handled, so one that lands while the picker is up is not an unhandled
  // rejection.
  pendingIdentityEnv.catch(() => {});

  // Every session loads the base identity's bags, whatever identity it runs
  // as. Loading is not granting: these contribute hooks, skills, actions and
  // instructions, while tools are gated by the base identity's traits, and
  // `filterTools` fails closed.
  for (const name of baseIdentitySelection().bags) {
    if (!identityBagNames.includes(name)) {
      identityBagNames.unshift(name);
    }
  }

  // Composition is resolved at load time, not read from the stored list: a
  // parent's manifest `bags:` children must reach the session even when only
  // the parent is packed. Everything downstream — instructions, actions,
  // slash commands — keys off this expanded set.
  identityBagNames = await expandCompositionFromSnapshot(identityBagNames);

  let bagConfig: MergedBagConfig | null = null;
  // Held for the picker's header rather than printed here: the banner is drawn
  // once, next to the session ID, where it survives the list repainting.
  let bagSummary: string | null = null;
  {
    const bags = await loadBags(identityBagNames);
    const skipped = identityBagNames.filter(n => !bags.some(p => p.name === n));
    if (skipped.length > 0) {
      console.log(`Bags skipped (disabled or not found): ${skipped.join(", ")}`);
    }
    if (bags.length > 0) {
      bagConfig = mergeBags(bags);
      // Builtins ship with Barry and are always loaded, so naming them here is
      // noise that buries the bags this barry actually chose. `loadBags`
      // already stamped `builtin`, so no second registry lookup is needed.
      // They are still LOADED — this hides them from the line, nothing else.
      const shown = options.showBuiltin ? bags : bags.filter((p) => !p.builtin);
      const hiddenCount = bags.length - shown.length;
      if (shown.length > 0 || hiddenCount === 0) {
        const suffix = hiddenCount > 0 ? ` (+${hiddenCount} builtin)` : "";
        bagSummary = `${shown.map(p => p.name).join(", ")}${suffix}`;
      } else {
        bagSummary = `${hiddenCount} builtin`;
      }
    }
  }

  // Directive: only if -d/--directive is used
  // -d "text" → use that text; -d (no value) → interactive prompt
  let directive: string | null = null;
  if (typeof options.directive === "string") {
    directive = options.directive;
  } else if (options.directive === true) {
    try {
      const answer = await input({
        message: "Directive (press Enter to skip):",
      });
      directive = answer.trim() || null;
    } catch (err) {
      if (err instanceof ExitPromptError || err instanceof CancelPromptError) {
        throw new CliError("", 0);
      }
    }
  }

  // Pre-create (or reuse) Barry session before spawning agent
  const source = ["cursor", "codex", "opencode"].includes(harnessRecord.id) ? harnessRecord.id : "cli";

  const selectedBounds = [...new Set([...(options._resumeBounds ?? []), ...(options.bound?.split(",").map(name => name.trim()).filter(Boolean) ?? [])])];
  if (selectedBounds.length) console.log(`Bounds: ${selectedBounds.join(", ")}`);
  const identityBounds = identityConfiguration?.bounds.filter(entry => !entry.optional).map(entry => entry.name) ?? [];
  if (identityBounds.length) console.log(`Identity bounds: ${identityBounds.join(", ")}`);

  async function preCreateSession(id: string, opts?: { directive?: string | null; name?: string }) {
    // Delegates to the extracted, in-process-testable step; the console warning
    // and the fatal-bound decision stay here, where the launch's I/O lives.
    const result = await preCreateSessionStep(
      {
        sessionId: id,
        cwd: process.cwd(),
        source,
        ...(opts?.directive !== undefined ? { directive: opts.directive } : {}),
        ...(opts?.name !== undefined ? { name: opts.name } : {}),
        identityId,
        selectedBounds,
        provider: harnessRecord.id,
      },
      {
        fetch,
        endpoint: `http://localhost:${getServicePort("api")}/api/v1/sessions/start`,
        headers: apiHeaders(),
      },
    );
    // A rejected body used to be swallowed here, so a session could start
    // silently unbounded after `--bound` appeared to succeed. Surface it, and
    // refuse to continue unbounded when a bound was explicitly requested.
    if (!result.ok) {
      if (result.warning) console.warn(`Warning: ${result.warning}`);
      if (selectedBounds.length) {
        throw new CliError("Refusing to continue: --bound was requested but the session could not be scoped.", 1);
      }
    }
  }

  let sessionId: string;

  if (options._resumeSessionId) {
    sessionId = options._resumeSessionId;
    console.log(`Resuming session: ${sessionId.slice(0, 8)}`);
    // Forward the name here too: renaming on resume is the natural moment to
    // label a session you started unnamed.
    await preCreateSession(sessionId, { name: options.sessionName });
  } else {
    sessionId = generateId();
    await preCreateSession(sessionId, { directive, name: options.sessionName });
  }

  // Temp dirs created below; tracked directly (not derived from file parents) so
  // cleanup removes exactly what we made.
  const tmpDirs: string[] = [];

  // Build merged settings (includes sandbox config from external files).
  // Native tools start off; traits grant them and bounds take them back.
  // MCP calls continue through Barry’s guarded tools.
  const settingsPath = buildMergedSettings({ deniedTools: [], bagHooks: bagConfig?.hooks ?? [] });
  tmpDirs.push(join(settingsPath, ".."));

  let mcpConfigPath: string;
  let mcpServers: McpConfig["mcpServers"];
  // Traits attached to this session (picker / --traits / resume) — drives
  // trait-granted skill mounting below in addition to MCP tool filtering.
  let sessionTraits: string[] = [];

  if (transport === "http" || transport === "sse") {
    let config: McpConfig;
    // Collect selected trait names so we can store them on the session.
    //
    // The session contract still carries `selectedNamespaces`/`selectedTools`
    // for ad-hoc grants — BarrySessions writes them, and the MCP server turns
    // them into the `__direct_*` synthetic traits. The CLI picker just does not
    // produce them any more, so it sends neither key rather than an empty one.
    let selectedTraits: string[] = [];

    // Built after the session exists, so the ID in it is always the real one.
    const sessionHeader: SessionHeader = {
      ...(identityName ? { identity: identityName } : {}),
      ...(bagSummary ? { bags: bagSummary } : {}),
      sessionId,
    };
    // Every branch below either hands this to the picker or prints it; a
    // session must never start without showing the ID that resumes it.
    const picksInteractively =
      !options.all && !options.none && !options.traits && !options.prompt;
    if (!picksInteractively) printSessionHeader(sessionHeader);

    if (options._resumeTraits && (options.none || options.all || options.traits)) {
      // Resuming with an explicit capability flag — the flag wins, no picker.
      selectedTraits = options.traits
        ? options.traits.split(",").map((t) => t.trim()).filter(Boolean)
        : options.all
          ? await allPackedTraits(identityBagNames)
          : options.none
            ? []
            : options._resumeTraits;
      if (selectedTraits.length > 0) {
        config = await grantedMcpConfig(identityId, selectedTraits, sessionId, harnessRecord.id);
        console.log(`Traits: ${selectedTraits.join(", ")}`);
        console.log(`MCP servers: ${Object.keys(config.mcpServers).join(", ")}`);
      } else {
        config = await sessionMcpConfig([], sessionId);
        console.log(`MCP servers: ${Object.keys(config.mcpServers).join(", ")} (${describeUnselectedServers(config, identityBagGrant)})`);
      }
    } else if (options._resumeTraits) {
      // Resuming — show the picker with the previous session's traits already
      // checked, so they can be accepted with Enter or adjusted. Resume used to
      // skip the picker entirely, which left no way to change capabilities
      // without starting a fresh session.
      try {
        const pick = await pickCapabilities(identityBagNames, options._resumeTraits, options.showBuiltin, sessionHeader, identityId);
        selectedTraits = pick.traits;
        if (pick.traits.length > 0) {
          config = await grantedMcpConfig(identityId, pick.traits, sessionId, harnessRecord.id);
          console.log(`\nTraits: ${pick.traits.join(", ")}`);
          console.log(`MCP servers: ${Object.keys(config.mcpServers).join(", ")}`);
        } else {
          config = await sessionMcpConfig([], sessionId);
          console.log(`MCP servers: ${Object.keys(config.mcpServers).join(", ")} (${describeUnselectedServers(config, identityBagGrant)})`);
        }
      } catch (err) {
        if (err instanceof ExitPromptError || err instanceof CancelPromptError) {
          await abandonLaunch(sessionId);
        }
        // Picker unavailable (e.g. non-TTY) — fall back to the recorded traits
        // rather than dropping the session's capabilities on the floor.
        console.warn(`Warning: capability picker failed — ${err instanceof Error ? err.message : err}`);
        // The banner rode along with the picker frame, which never drew.
        printSessionHeader(sessionHeader);
        selectedTraits = options._resumeTraits;
        if (selectedTraits.length > 0) {
          config = await grantedMcpConfig(identityId, selectedTraits, sessionId, harnessRecord.id);
          console.log(`Traits (resumed): ${selectedTraits.join(", ")}`);
          console.log(`MCP servers: ${Object.keys(config.mcpServers).join(", ")}`);
        } else {
          config = await sessionMcpConfig([], sessionId);
          console.log(`MCP servers: ${Object.keys(config.mcpServers).join(", ")} (${describeUnselectedServers(config, identityBagGrant)})`);
        }
      }
    } else if (options.none) {
      // --none: skip trait selection. NOT the same as "no servers" — identity
      // bags still grant their namespaces, so this list is usually not empty.
      config = await sessionMcpConfig([], sessionId);
      console.log(`MCP servers: ${Object.keys(config.mcpServers).join(", ")} (${describeUnselectedServers(config, identityBagGrant)})`);
    } else if (options.all) {
      // Every packed bag's own trait: what the identity packs, all of it. It
      // used to start every MCP server and select no trait, so the session's
      // grant was only the defaults.
      selectedTraits = await allPackedTraits(identityBagNames);
      config = await grantedMcpConfig(identityId, selectedTraits, sessionId, harnessRecord.id);
      console.log(`Traits: every packed bag${options.bound ? ` (bound: ${options.bound})` : ""}`);
      console.log(`MCP servers: ${Object.keys(config.mcpServers).join(", ")}`);
    } else if (options.traits) {
      selectedTraits = options.traits.split(",").map((t) => t.trim()).filter(Boolean);
      config = await grantedMcpConfig(identityId, selectedTraits, sessionId, harnessRecord.id);
      console.log(`Traits: ${selectedTraits.join(", ")}`);
      console.log(`MCP servers: ${Object.keys(config.mcpServers).join(", ")}`);
    } else if (options.prompt) {
      // --prompt is the non-interactive entrypoint (scripts, cron, `barry -p`),
      // so it must never block on the TTY picker. No capability flag was given,
      // so fall back to always-on servers — same result the picker's non-TTY
      // path already produced, minus the hang.
      config = await sessionMcpConfig([], sessionId);
      console.log(`MCP servers: ${Object.keys(config.mcpServers).join(", ")} (${describeUnselectedServers(config, identityBagGrant)}; pass --traits/--all for more)`);
    } else {
      try {
        const pick = await pickCapabilities(identityBagNames, undefined, options.showBuiltin, sessionHeader, identityId);
        if (pick.traits.length > 0) {
          selectedTraits = pick.traits;
          config = await grantedMcpConfig(identityId, pick.traits, sessionId, harnessRecord.id);
          console.log(`\nTraits: ${pick.traits.join(", ")}`);
          console.log(`MCP servers: ${Object.keys(config.mcpServers).join(", ")}`);
        } else {
          // No selection — only always-on servers
          config = await sessionMcpConfig([], sessionId);
          console.log(`MCP servers: ${Object.keys(config.mcpServers).join(", ")} (${describeUnselectedServers(config, identityBagGrant)})`);
        }
      } catch (err) {
        if (err instanceof ExitPromptError || err instanceof CancelPromptError) {
          await abandonLaunch(sessionId);
        }
        console.warn(`Warning: capability picker failed — ${err instanceof Error ? err.message : err}`);
        // The banner rode along with the picker frame, which never drew.
        printSessionHeader(sessionHeader);
        config = await sessionMcpConfig([], sessionId);
        console.log(`MCP servers: ${Object.keys(config.mcpServers).join(", ")} (${describeUnselectedServers(config, identityBagGrant)})`);
      }
    }

    sessionTraits = selectedTraits;

    // Traits were already written by `grantedMcpConfig`, which has to do
    // it before it asks the server for the session's namespaces. What is left is
    // the case that path never reaches: an EMPTY selection.
    //
    // Clearing matters on resume. The picker runs there now, so unchecking every
    // trait is a deliberate act and must overwrite the session's previous traits
    // rather than silently leaving them in place. `--none` and `--all` land here
    // too; both skip trait resolution entirely.
    //
    // Through the API rather than the DB: PATCH also invalidates the active SDK
    // session's tool connections on trait changes, which the old direct writes
    // never did.
    if (selectedTraits.length === 0 && options._resumeTraits) {
      await persistSessionTraits(sessionId, []);
    }

    // Pre-flight OAuth check: prompt only for bags this session can actually
    // reach that need browser-based authorization. Still before the agent
    // spawns, so the user can auth interactively.
    //
    // Deliberately placed here, after traits are resolved and persisted, not
    // with the other bag setup further up. It needs the session's resolved
    // GRANT, and `resolveSessionNamespaces` reads that back from the MCP
    // server — which can only answer once the traits are recorded. Moving this
    // earlier reintroduces the bug it fixes: prompting to authorize every OAuth
    // bag installed on the identity, including ones no trait grants.
    if (!options.prompt) {
      try {
        const registry = loadRegistry();
        const barryRegistry: typeof registry = {};
        for (const name of identityBagNames) {
          if (registry[name]) barryRegistry[name] = registry[name];
        }

        // Scoped by the session's GRANTED namespaces, not only currently active tools:
        // an unauthorized bag has no active tools yet, so comparing only against
        // `resolveSessionNamespaces` dropped unauthorized bags from the check.
        const granted = await resolveGrantedNamespacesForSession({
          sessionId,
          identityId,
          sessionTraits,
          isAll: options.all,
          harness: harnessRecord.id,
        });
        const needsAuth = filterBagsNeedingAuthForSession(
          getBagsNeedingAuth(barryRegistry),
          granted,
        );

        if (needsAuth.length > 0) {
          console.log("");
          for (const entry of needsAuth) {
            console.log(`OAuth required: ${entry.name} (${entry.url})`);
          }
          try {
            const shouldAuth = await confirm({
              message: `Authorize ${needsAuth.length === 1 ? needsAuth[0].name : `${needsAuth.length} bags`} now?`,
              default: false,
            });
            if (shouldAuth) {
              for (const entry of needsAuth) {
                await bagAuthCommand(entry.name);
              }
            }
          } catch (err) {
            if (err instanceof ExitPromptError || err instanceof CancelPromptError) {
              await abandonLaunch(sessionId);
            }
          }
        }
      } catch {
        // Registry not available — skip OAuth check
      }
    }

    if (options.healthCheck) {
      const { unhealthy } = await checkSseHealth();
      if (unhealthy.length > 0) {
        console.log(`Warning: ${unhealthy.length} MCP servers not responding`);
        console.log(`  Start the instance with: barry up`);
      }
    }

    const artifact = buildMcpConfig(config);
    tmpDirs.push(artifact.tmpDir);
    mcpConfigPath = artifact.mcpConfigPath;
    mcpServers = artifact.mcpServers;
  } else {
    console.log("Transport: stdio (spawning MCP servers as subprocesses)");
    const config = generateMcpConfig("stdio", identityId ?? undefined, harnessRecord.id);
    const artifact = buildMcpConfig(config);
    tmpDirs.push(artifact.tmpDir);
    mcpConfigPath = artifact.mcpConfigPath;
    mcpServers = artifact.mcpServers;
    console.log(`MCP servers: ${Object.keys(config.mcpServers).length} configured`);
  }

  // The agent's environment: your shell's, plus what its identity exposes and
  // the session's own Barry credential (added below). No instance secrets are
  // loaded into this process, so there is nothing to strip back out.
  //
  // Ensure hook binaries are on PATH, carry the session id/directive/identity,
  // and strip every declared credential name so no ambient provider key reaches
  // the harness — the denylist is computed from declarations (every credential
  // env var any installed adapter or vendor row names, plus the identity's own
  // secret keys), not a hardcoded list, so a new harness is covered without
  // touching this file. Claude Code falls back to subscription (OAuth) auth
  // when its key is genuinely absent, so an exhausted key here must fail the
  // session, not defer to the logged-in account.
  const cliBin = join(PATHS.identityDir, "cli", "node_modules", ".bin");
  const childEnv: Record<string, string | undefined> = buildLaunchEnv({
    baseEnv: process.env,
    cliBin,
    sessionId,
    directive,
    identityId,
    stripCredentialNames: [
      ...await sessionCredentialEnvs(),
      ...Object.keys(identityConfiguration?.secrets ?? {}),
    ],
  });

  let identityResolvedEnv: Record<string, string> = {};
  let identityBuiltEnv: Environment | null = null;
  if (identityConfiguration) {
    try {
      identityBuiltEnv = await pendingIdentityEnv;
      identityResolvedEnv = identityBuiltEnv?.vars ?? {};
    } catch (error: unknown) {
      if (isCliError(error)) throw error;
      throw new CliError(`Error: this identity's secrets could not be read — refusing to start.\n${error instanceof Error ? error.message : String(error)}`, 1);
    }
  }

  // Check for missing bag credentials after env resolution
  if (bagConfig && Object.keys(bagConfig.mcpServers).length > 0) {
    const deferredConfigs: Record<string, { name: string; env?: string[] }> = {};
    for (const [name, server] of Object.entries(bagConfig.mcpServers)) {
      if (server.env?.length) {
        deferredConfigs[name] = { name, env: server.env };
      }
    }
    if (Object.keys(deferredConfigs).length > 0) {
      const resolvedLookup: Record<string, string> = { ...identityResolvedEnv };
      for (const [k, v] of Object.entries(childEnv)) if (v != null) resolvedLookup[k] ??= v;

      const missing = checkBagCredentials(deferredConfigs, resolvedLookup);
      if (missing.length > 0) {
        console.log("");
        for (const m of missing) {
          console.warn(`⚠ Bag "${m.bag}" is missing credentials: ${m.missingVars.join(", ")}`);
          for (const v of m.missingVars) {
            console.warn(`  Add to barry: barry vault set-env ${v} <value> --source vault --name ${identityName ?? "<barry>"}`);
          }
        }
        console.log("");
      }
    }
  }

  const sessionProvider = harnessRecord.aliases?.[0] ?? harnessRecord.id;
  let model: string | undefined;
  let modelProvider: string | undefined;
  try {
    ({ model, modelProvider } = resolveModelSelection(options, harnessRecord, adapterSettings(identity.adapters, harnessRecord)?.model));
  } catch (err) {
    if (isCliError(err)) throw err;
    throw new CliError(`Error: ${err instanceof Error ? err.message : String(err)}`, 1);
  }
  // The gate. Against the env the identity built, not the process env: an
  // endpoint key that arrived from nowhere declared is the leak this exists
  // to close. A refusal names the missing credential and both fix paths.
  {
    const routedVendors =
      modelProvider && modelProvider !== harnessRecord.vendor
        ? installedModels().vendors().filter((v) => v.id === modelProvider)
        : [];
    const required = requiredCredentials({
      harness: {
        id: harnessRecord.id,
        credentials: harnessRecord.bag?.manifest.credentials,
      },
      routedVendors,
    });
    for (const { env: name } of required) {
      const secret = identityResolvedEnv[name];
      if (secret !== undefined) childEnv[name] = secret;
    }
    try {
      assertSessionCredentials({
        required,
        env: identityBuiltEnv ?? { vars: {}, sources: {} },
        ambientEnv: childEnv,
        credentialEnvs: await sessionCredentialEnvs(),
      });
    } catch (err) {
      if (isCliError(err)) throw err;
      throw new CliError(`Error: ${err instanceof Error ? err.message : String(err)}`, 1);
    }
  }
  if (model) {
    const provider: CatalogProvider = sessionProvider;
    const vendors = installedModels().vendors();
    if (!isOfferedModel(harnessRecord, vendors, model)) {
      // Cursor can be asked what it actually offers, and it ships ids faster
      // than the curated catalog tracks them, so a catalog miss alone is not
      // evidence of a bad model. An unreadable list (empty) falls back to the
      // catalog's answer rather than silently blessing anything.
      let cursorModels: string[] = [];
      if (provider === "cursor") {
        const { harnessAdapter } = await import("../adapters/installed.js");
        const cursorAdapter = await harnessAdapter(provider);
        cursorModels = await cursorAdapter.listModels?.({ env: childEnv }) ?? [];
      }
      if (!cursorModels.includes(model)) {
        const suggestions = cursorModels.length
          ? cursorModels.filter((m) => m.includes(model) || model.includes(m)).slice(0, 3)
          : suggestOfferedModels(harnessRecord, vendors, model);
        console.warn(
          `Warning: model '${model}' is not in the curated catalog${suggestions.length ? ` — did you mean: ${suggestions.join(", ")}?` : ""} (proceeding anyway)`,
        );
      }
    }
    console.log(`Model: ${model}${options.model ? "" : " (barry default)"}`);
  }

  // Say the unflattering thing before the session starts, not after the user
  // finds out. A small local model often answers in prose instead of calling
  // tools — it reports edits and commands it never ran — and that reads as the
  // agent working until someone checks the disk. Unconditional disclosure
  // rather than a probe: the behavior is intermittent, so a green probe would
  // not mean the next turn behaves.
  // Was `sessionProvider === "ollama"`: ollama is a model provider now, not an
  // agent id, so the check is on the resolved MODEL's routing instead. Any
  // qwen/llama id claude routes to Ollama gets the same disclosure a
  // dedicated ollama agent used to give unconditionally.
  const routedToOllama = modelProvider === "ollama";
  if (routedToOllama) {
    // Routing gave a model routed to a vendor with none named that vendor's default.
    const effectiveModel = model;
    if (effectiveModel) {
      // Print before waiting: the probe can take tens of seconds on a cold
      // model, and a silent pause reads as a hang.
      console.log(`Preflight ollama/${effectiveModel}: checking tool calling…`);
      for (const notice of await ollamaPreflightNotices(effectiveModel, {
        ...(childEnv.BARRY_OLLAMA_URL ? { baseUrl: childEnv.BARRY_OLLAMA_URL } : {}),
      })) console.warn(notice);
    }
  }

  const routedToLlama = modelProvider === "llamacpp";
  if (routedToLlama) {
    const effectiveModel = model;
    if (effectiveModel) {
      console.log(`Preflight llamacpp/${effectiveModel}: checking health and tool calling…`);
      for (const notice of await llamacppPreflightNotices(effectiveModel, {
        ...(childEnv.BARRY_LLAMACPP_URL ? { baseUrl: childEnv.BARRY_LLAMACPP_URL } : {}),
      })) console.warn(notice);
    }
  }

  // The adapter's own requirements, checked by the SAME function `barry adapter
  // doctor` runs — two implementations of "is codex installed" is how a launch
  // succeeds against a requirement doctor calls broken.
  //
  // One line, success included, following the ollama probe's precedent: a
  // silent preflight cannot be told from one that was skipped. Only a MISSING
  // BINARY blocks; an unpinned or logged-out vendor is reported and the session
  // starts, because a warning the user can act on beats a refusal they cannot.
  for (const line of await adapterPreflightNotices(sessionProvider)) console.warn(line);

  // Hand the resolved provider/model to the session-tracker hook, which runs in
  // the child and posts /sessions/start. It has no other way to learn them —
  // the hook payload carries no model field — and without them a CLI session
  // (the great majority) records no provenance for any of its messages.
  // Set even when `model` is undefined: the provider still pins the row.
  Object.assign(childEnv, launchProvenanceEnv({
    provider: sessionProvider,
    ...(model ? { model } : {}),
    ...(modelProvider ? { modelProvider } : {}),
    // `BARRY_MODE` is assigned at this same point; the mode travels the same
    // road as the provider, for the same reason (see the note below).
    mode: resolveRecordedMode(harnessRecord, requestedMode),
  }));

  // The mode travels the same road as the provider, for the same reason: the
  // session record is the only place a reader can later learn what guarantees
  // this session actually had. A session whose mode is unrecorded is one whose
  // capture and gating nobody can reconstruct — and D5's matrix is built from
  // exactly this field.
  //
  // Recorded even when it came from the adapter's DEFAULT rather than an
  // explicit `--mode`, which is the great majority of sessions. Writing only
  // the explicit case would leave most rows blank and make the field useless
  // for the one question it exists to answer; worse, a later reader would have
  // to re-derive the default from whatever the adapter declares TODAY, which
  // is not necessarily what it declared when the session ran.
  // (Assigned together with the provider/model keys just above via
  // `launchProvenanceEnv`, so the whole provenance block is written at once.)

  // Every registered bag, loaded ONCE for the three catalog calls below
  // (skills, instructions, slash commands). The catalogs used to fetch this
  // themselves and leant on the loader's process-wide memoization to avoid
  // three loads; holding it here makes the single load explicit instead.
  // Best-effort: a registry that will not load must not block a launch — the
  // three blocks below each degrade on their own.
  let registeredBags: readonly Bag[] = [];
  try {
    registeredBags = (await loadBagRegistrySnapshot()).bags;
  } catch (err) {
    console.warn(`Warning: Could not load bag registry — ${err instanceof Error ? err.message : err}`);
  }

  // What the session is granted, from its identity and the traits it selected:
  // its skills, instructions and the bound native tools are denied by.
  const granted = await grantsOf(identityId, { traits: sessionTraits, bounds: selectedBounds, harness: harnessRecord.id, mode });

  // Trait-granted skills → bag registry skill dirs. Best-effort: skill mounting
  // must never block launch.
  let traitSkillDirs: string[] = [];
  try {
    const skillNames = granted.skills.map((skill) => skill.name);
    if (skillNames.length > 0) {
      traitSkillDirs = await resolveSkillDirs(registeredBags, skillNames);
      if (traitSkillDirs.length > 0) {
        console.log(`Trait skills: ${skillNames.join(", ")}`);
      }
    }
  } catch (err) {
    console.warn(`Warning: Could not resolve trait skills — ${err instanceof Error ? err.message : err}`);
  }

  // Instructions this session can reach. Two parts, both cheap:
  //
  //   index   — one line per on-demand instruction, so the agent knows what
  //             guidance exists and can fetch it when relevant.
  //   pointer — for instructions a TRAIT names, one line saying when it
  //             applies, derived from the instruction's own description.
  //
  // Deliberately NOT joinAlwaysInstructions: always-on bodies are a standing
  // tax on every turn of every session, and the whole point of the index is
  // that the body arrives only when it is wanted. The server path
  // (session-runtime) makes the other choice; that is its call, not this one's.
  //
  // Best-effort, like the skills block above: prose must never block a launch.
  let instructionPrompt = "";
  try {
    const instructions = await listAllInstructions(registeredBags, { bagNames: identityBagNames });
    const traitInstructionNames = granted.instructions.map((instruction) => instruction.name);

    // The pointer covers trait-named instructions with more context than the
    // index would, so they are excluded there rather than listed twice.
    const sections = [
      buildInstructionsIndex(instructions, { exclude: traitInstructionNames }),
      buildTraitInstructionPointer(traitInstructionNames, instructions),
    ].filter((s): s is string => Boolean(s));

    if (sections.length > 0) instructionPrompt = sections.join("\n\n");
  } catch (err) {
    console.warn(`Warning: Could not resolve instructions — ${err instanceof Error ? err.message : err}`);
  }

  // Loaded bags may contribute computed prompt sections. Contributor failures
  // are isolated by the host and never block session startup.
  try {
    const { collectPromptSections } = await import("@barry-rocks/sdk/internal/instructions");
    const loadedBags = registeredBags.filter((bag) => identityBagNames.includes(bag.name));
    const promptSections = await collectPromptSections(loadedBags, {
      cwd: process.cwd(),
      sessionId,
      provider: sessionProvider,
    });
    const prompt = promptSections.join("\n\n");
    if (prompt) {
      instructionPrompt = instructionPrompt
        ? `${instructionPrompt}\n\n${prompt}`
        : prompt;
    }
  } catch (err) {
    console.warn(`Warning: Could not resolve bag prompts — ${err instanceof Error ? err.message : err}`);
  }

  // Scoped to what this session can actually reach — enabled bags UNION
  // trait-granted action dirs. See selectSlashCommandActions for why both.
  let slashCommandActions: ActionMeta[] = [];
  try {
    slashCommandActions = selectSlashCommandActions(
      await listAllActions(registeredBags),
      identityBagNames,
      traitSkillDirs,
    );
  } catch (err) {
    console.warn(`Warning: Could not resolve action slash commands — ${err instanceof Error ? err.message : err}`);
  }

  const { native, deniedTools, allowedNativeTools } = resolveGrants(granted, harnessRecord, mode);
  if (Object.keys(native.conflicts).length) {
    throw new CliError(`Session bounds cannot take back ${Object.keys(native.conflicts).join(", ")} on ${harnessRecord.id} (${mode}): ${[...new Set(Object.values(native.conflicts))].join("; ")}. Start in another mode or on another harness, or drop the bound.`, 1);
  }
  const nativeHarnesses = (await (await import("../adapters/installed.js")).adapterStore()).adapters.installed();
  for (const name of sessionTraits) {
    if (!granted.traits.includes(name) && !granted.traits.includes(`${harnessRecord.bag?.manifest.name}:${name}`) && nativeHarnesses.some(record => record.bag?.manifest.traits[`${record.bag.manifest.name}:${name}`])) console.warn(`${harnessRecord.id} has no ${name} trait`);
  }
  console.log(`Native tools: ${native.allowed.join(", ") || "none"}`);
  for (const [tool, reason] of Object.entries(native.refused)) console.warn(`${tool} refused on ${harnessRecord.id} (${mode}): ${reason}`);
  if (Object.keys(native.uncontrolled).length) console.warn(`${harnessRecord.id} (${mode}) cannot turn off ${Object.keys(native.uncontrolled).join(", ")}: ${[...new Set(Object.values(native.uncontrolled))].join("; ")}`);
  if (native.operatorOverride) console.warn(native.operatorOverride);
  buildMergedSettings({ deniedTools, bagHooks: bagConfig?.hooks ?? [], path: settingsPath });
  if (deniedTools.length && harnessRecord.capabilities.toolDenial === "none") {
    console.warn(`Native denials cannot be enforced in this launch mode: ${deniedTools.join(", ")}`);
  }
  return {
    sessionId,
    childEnv,
    tmpDirs,
    settingsPath,
    mcpConfigPath,
    mcpServers,
    bagConfig,
    traitSkillDirs,
    instructionPrompt,
    slashCommandActions,
    claudeArgs,
    directive,
    model,
    modelProvider,
    interactive: !options.prompt,
    deniedTools,
    allowedNativeTools,
    sessionName: options.sessionName,
  };
}


/**
 * Tell the API a session's process has exited.
 *
 * Awaited with a 2-second timeout and retried once before process.exit.
 * The reaper is the backstop when this close-write is lost.
 */
/**
 * Leave a launch cancelled before anything ran — a picker or prompt the user
 * pressed Ctrl+C at. The session row already exists, and with no process for
 * the reaper to find dead, it stayed "running" forever; ending it removes it,
 * as ending any session with no messages does.
 */
async function abandonLaunch(sessionId: string): Promise<never> {
  await endSession(sessionId);
  throw new CliError("", 0);
}

async function endSession(sessionId: string): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`http://localhost:${getServicePort("api")}/api/v1/sessions/end`, {
        method: "POST",
        headers: apiHeaders(),
        // camelCase only: the API refuses a snake_case key outright (400), so
        // the `session_id` this also sent made every end here fail, silently —
        // sessions ended only when the reaper found their process dead, and a
        // launch cancelled before it had one stayed "running" for good.
        body: JSON.stringify({ sessionId, reason: "process_exit" }),
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) return;
    } catch {
      // Best-effort cleanup on shutdown
    }
  }
}

/**
 * Record what this launch runs as: its mode, the guarantees the plan actually
 * arranged, and the vendor conversation id `barry resume` looks up.
 *
 * Awaited, unlike the other bookkeeping writes here: the child is spawned
 * right after and `attachChildLifecycle` exits on its close, so an un-awaited
 * write can be lost and leave `barry resume` with nothing to find. Errors are
 * still swallowed, because failing to record must not stop the session.
 */
async function recordLaunch(sessionId: string, provider: string, mode: ModeId, plan: LaunchPlan): Promise<void> {
  try {
    await fetch(`http://localhost:${getServicePort("api")}/api/v1/sessions/start`, {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify({
        sessionId,
        provider,
        mode,
        guarantees: plan.guarantees,
        ...(plan.harnessSessionId ? { providerSessionId: plan.harnessSessionId } : {}),
      }),
      signal: AbortSignal.timeout(3000),
    });
  } catch { /* bookkeeping must never block the session */ }
}

/**
 * An identity's name, given its name or its store folder id. A
 * node-qualified reference (`laptop/coder`) named an identity on another
 * machine; sessions now always run where they are started.
 */
async function localIdentityName(reference: string): Promise<string> {
  if (reference.includes("/")) throw new Error(`"${reference}" names an identity on another machine; start the session on that machine instead`);
  const { installationRegistry } = await import("@barry-rocks/sdk/internal/nodes");
  let legacyId: number;
  try { legacyId = installationRegistry().legacyIdentityId(reference); }
  catch { return reference; }
  return (await identityRecords.row(legacyId))?.name ?? reference;
}

export async function startCommand(args: string[], options: StartOptions): Promise<void> {
  const identityReference = options.name ?? options.barry;
  if (identityReference) options.name = await localIdentityName(identityReference);

  const selectedIdentity = await selectIdentity(options);
  const { adapterStore } = await import("../adapters/installed.js");
  const { adapters } = await adapterStore();
  const record = selectHarness(options, selectedIdentity.adapters, adapters.installed());
  const provider = record.aliases?.[0] ?? record.id;
  const requestedMode = options.mode ?? adapterSettings(selectedIdentity.adapters, record)?.mode;
  // Settled BEFORE resolveLaunchContext, which creates the session row and
  // writes MCP config: a mode this adapter cannot run is ordinary user error,
  // and it should cost nothing and strand nothing.
  const launched = resolveModeOrExit(options, selectedIdentity, record);
  const ctx = await resolveLaunchContext(args, options, selectedIdentity, record, requestedMode, launched.mode);
  // Hosted runs in Barry's runtime; this terminal is one of its renderers.
  if (launched.mode === "hosted") return runHostedLaunch(ctx, provider, options.prompt, Boolean(options.prompt), options, selectedIdentity);
  const { harnessAdapter } = await import("../adapters/installed.js");
  const adapter = await harnessAdapter(provider);
  // The launch runs the code of the mode it records, never another's.
  const launchMode = launched.mode === "instrumented" ? adapter.modes.instrumented : adapter.modes.guest;
  if (!launchMode) {
    throw new CliError(`${provider} has no ${launched.mode} mode, so \`barry start\` cannot launch it.`, 1);
  }

  const config = buildSessionConfig({
    harness: adapter,
    vendors: installedModels().vendors(),
    mcpServers: ctx.mcpServers,
    sessionId: ctx.sessionId,
    repoDir: process.cwd(),
    childEnv: ctx.childEnv,
    mcpConfigPath: ctx.mcpConfigPath,
    settingsPath: ctx.settingsPath,
    systemPrompt: composeSystemPrompt(process.cwd(), ctx.instructionPrompt, ctx.directive),
    ...(ctx.model ? { model: ctx.model } : {}),
    ...(ctx.modelProvider ? { modelProvider: ctx.modelProvider } : {}),
    ...(ctx.modelProvider === "ollama" && ctx.childEnv.BARRY_OLLAMA_URL ? { baseURL: ctx.childEnv.BARRY_OLLAMA_URL } : {}),
    ...(ctx.modelProvider === "llamacpp" && ctx.childEnv.BARRY_LLAMACPP_URL ? { baseURL: ctx.childEnv.BARRY_LLAMACPP_URL } : {}),
    ...(options.prompt ? { prompt: options.prompt } : {}),
    extraArgs: ctx.claudeArgs,
    ...(options.relax ? { relax: true } : {}),
    deniedTools: ctx.deniedTools,
    allowedNativeTools: ctx.allowedNativeTools,
    skillsDirs: ctx.bagConfig?.skillsDirs ?? [],
    traitSkillDirs: ctx.traitSkillDirs,
    slashCommandActions: ctx.slashCommandActions,
    ...(options._resume ? { resume: options._resume } : {}),
    tmpDirs: ctx.tmpDirs,
    ...(launched.mode === "instrumented" || launched.mode === "guest" ? { relayCommand: thisCliCommand("hook", provider) } : {}),
    ...(launched.mode === "instrumented" ? { telemetry: telemetryReceiver() } : {}),
  });

  // A mode that attaches shows the hosted session, so a one-shot is simply a
  // hosted one.
  if (launchMode.attachesTo === "hosted") {
    if (options.prompt) return runHostedLaunch(ctx, provider, options.prompt, true, options, selectedIdentity);
    return runAttachedLaunch(ctx, provider, launched.mode, launchMode, config);
  }

  // A harness whose own one-shot is not a TUI launch refuses the prompt in
  // guest mode; that turn runs hosted, on the server, instead. Decided by the
  // adapter rather than by name here, so there is no second routing rule to
  // drift from the first.
  let plan: LaunchPlan;
  try {
    plan = await launchMode.plan(config);
  } catch (err) {
    if (options.prompt && err instanceof NotSupportedInMode && err.operation === "prompt") {
      return runHostedLaunch(ctx, provider, options.prompt, true, options, selectedIdentity);
    }
    throw err;
  }
  // The plan's directories are the launcher's to remove, spawned or not
  // (LaunchPlan.tmpDirs), and the launch's own are removed on every exit.
  // Nothing added these, so each opencode guest launch left its runtime dir.
  ctx.tmpDirs.push(...plan.tmpDirs);

  // Before the spawn, so a session that dies early can still be resumed.
  await recordLaunch(ctx.sessionId, provider, launched.mode, plan);
  const discovery = !plan.harnessSessionId && plan.discoverHarnessSessionId
    ? discoverConversation(
        () => plan.discoverHarnessSessionId!(),
        (harnessSessionId) => recordLaunch(ctx.sessionId, provider, launched.mode, { ...plan, harnessSessionId }),
      )
    : null;

  // A launch that opened a way into the TUI is kept fed while the TUI runs.
  const relay = plan.inbox ? await startTerminalRelay(ctx.sessionId, plan.inbox) : null;

  const identity: ProcessIdentityReport = {
    command: [plan.command, ...plan.args].join(" "),
    processName: basename(plan.command),
    appName: provider,
    parentPid: process.pid,
  };

  runChildSession(plan, {
    attach: (child, onClose) => attachChildLifecycle(child, ctx, onClose, identity),
    onClose: async () => {
      // Its claim on the session is withdrawn now; a claim left behind would
      // lapse on its own within a minute.
      void relay?.stop();
      await discovery?.stop();
    },
  });
}

/**
 * A launch that attaches to the hosted session: the session runs in Barry's
 * runtime, and the vendor TUI is one more place it shows. Leaving ends this
 * attachment, not the session, so its pid is not the session's and closing
 * does not end it.
 */
async function runAttachedLaunch(ctx: LaunchContext, provider: string, mode: ModeId, launchMode: LaunchMode, config: SessionConfig): Promise<void> {
  const api = { base: `http://localhost:${getServicePort("api")}/api/v1`, headers: apiHeaders() };
  const fail = (what: string, err: unknown): never => {
    console.error(`${what}: ${err instanceof Error ? err.message : String(err)}`);
    cleanupTmpDirs(ctx.tmpDirs);
    throw new CliError("", 1);
  };

  const attachment = await attachToHostedSession(ctx.sessionId, {
    harness: provider,
    ...(ctx.model ? { model: ctx.model } : {}),
    ...(ctx.modelProvider ? { modelProvider: ctx.modelProvider } : {}),
  }, api).catch((err: unknown) => fail(`Could not open the session to ${provider}'s TUI`, err));
  const detach = () => detachFromHostedSession(ctx.sessionId, attachment.attachmentId, api);

  let plan: LaunchPlan;
  try {
    const options = typeof config.options === "object" && config.options !== null ? config.options : {};
    plan = await launchMode.plan({ ...config, options: { ...options, attachment: { address: attachment.address, harnessSessionId: attachment.harnessSessionId } } });
  } catch (err) {
    await detach();
    return fail(`Could not launch ${provider}'s TUI`, err);
  }
  ctx.tmpDirs.push(...plan.tmpDirs);
  await recordLaunch(ctx.sessionId, provider, mode, plan);

  runChildSession(plan, {
    attach: (child) => {
      child.on("error", (err) => console.error(`Could not run ${plan.command}: ${err.message}`));
      detachWhenGone(child, detach, (code) => {
        cleanupTmpDirs(ctx.tmpDirs);
        printResumeHint(ctx.sessionId);
        process.exit(code);
      });
    },
  });
}

/**
 * Where an instrumented TUI reports: the sessions API's OTLP receiver, with
 * the bearer token the API requires of every request.
 */
function telemetryReceiver(): { endpoint: string; headers: Record<string, string> } {
  return {
    endpoint: getServiceUrl("api"),
    headers: process.env.BARRY_SECRET ? { Authorization: `Bearer ${process.env.BARRY_SECRET}` } : {},
  };
}

async function startTerminalRelay(sessionId: string, inbox: NonNullable<LaunchPlan["inbox"]>) {
  const { TerminalRelay } = await import("@barry-rocks/sessions-bag/client/terminal-relay");
  const relay = new TerminalRelay(sessionId, inbox);
  relay.start();
  return relay;
}
