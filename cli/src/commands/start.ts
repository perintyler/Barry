import { ensureBarry } from "../lib/barry-init.js";
import { recallSelection, rememberSelection } from "../sessions/session-selections.js";
import { cliBuild, ensureApiCurrent } from "../sessions/api-skew.js";
import { lazy } from "../lib/lazy.js";
import { checkKnownCommand } from "./known-commands.js";
export { checkKnownCommand, setKnownCommands } from "./known-commands.js";
import { queueStaleBagBuild } from "../lib/bag-maintenance.js";
import { prepareSession, supportsCreateBags, type SessionPreparation } from "../sessions/prepare.js";
import { installedHarnesses } from "../lib/harness-flags.js";
import { ensureModelsInstalled, modelVendorsForRouting } from "../lib/models-install.js";
import { mark, span, begin, report } from "../lib/timing.js";
import { spawn } from "child_process";
import { CliError, isCliError } from "../lib/cli-error.js";
const adapterPreflightNotices = lazy(() => import("./doctor.js"), module => module.adapterPreflightNotices);
import { join, basename } from "path";
import { rmSync } from "fs";
const input = lazy(() => import("@inquirer/prompts"), module => module.input);
const confirm = lazy(() => import("@inquirer/prompts"), module => module.confirm);
function isPromptCancellation(error: unknown): boolean { return error instanceof Error && ["ExitPromptError", "CancelPromptError"].includes(error.name); }
import { PATHS, McpConfig } from "../config.js";
const checkSseHealth = lazy(() => import("../mcp-config.js"), module => module.checkSseHealth);
import { baseIdentitySelection, loadBags, loadBagSync, expandCompositionSync, loadBagRegistrySnapshot, mergeBags, loadRegistry, isBuiltinBag } from "@barry-rocks/sdk/internal/bags";
import { ALWAYS_ON_MCP_SERVERS, type Bag } from "@barry-rocks/sdk/bags";
import { guestSessionMcpConfig } from "../lib/session-mcp-config.js";
const sessionPicker = lazy(() => import("../prompts/session-picker.js"), module => module.sessionPicker);
import type { Bound } from "@barry-rocks/sdk/bounds";
import { EMPTY_BOUND_SUMMARY, summarizeBound } from "../lib/bound-summary.js";
const bagAuthCommand = lazy(() => import("./bag.js"), module => module.bagAuthCommand);
import { getCurrentUser } from "../lib/current-user.js";
import type { LaunchPlan, LaunchMode } from "@barry-rocks/sdk/adapters/harnesses";
import { NotSupportedInMode, type SessionConfig } from "@barry-rocks/sdk/sessions";

import { cliName, currentTarget } from "../target.js";
import { resolveLaunchMode, platformWarning, isRefusal, type ModeResolution } from "./launch-mode.js";
import { findInstalled, type InstalledAdapter } from "@barry-rocks/sdk/adapters/harnesses";
import { attachToHostedSession, buildSessionConfig, composeSystemPrompt, detachFromHostedSession, detachWhenGone, discoverConversation, runChildSession, thisCliCommand, type ResumeRequest } from "../sessions/launch.js";
import { resolveSessionNativeTools, buildMcpConfig, preCreateSession as preCreateSessionStep, buildLaunchEnv, launchProvenanceEnv } from "../sessions/launch-context.js";
import { buildMergedSettings } from "../lib/settings.js";
import { Barry, type Instruction, type Skill, type Tool } from "@barry-rocks/sdk";
import { identityRecords, bounds as boundsStore } from "@barry-rocks/identities-bag";
import { readProcessStartTime } from "@barry-rocks/sessions-bag/process-liveness";
import {
  getSession,
  getSessionMessages,
} from "@barry-rocks/sessions-bag/client";

import { getServiceUrl } from "@barry-rocks/sdk/services";
import { identityEnvironment, assertSessionCredentials, requiredCredentials, declaredCredentialEnvs, type Environment, checkBagCredentials } from "@barry-rocks/sdk/internal/env";

import {
  adapterSettings,
  defaultHarness,
  FALLBACK_HARNESS,
  optionalIdentityBags,
  optionalNames,
  requiredIdentityBags,
  requiredNames,
  type IdentityAdapters,
} from "@barry-rocks/sdk/internal/identities";
import type { Vendor, Check } from "@barry-rocks/sdk/adapters/models";
import type { HarnessId, ModeId } from "@barry-rocks/sdk/ids";
import { installedModels, isOfferedModel, routeModel, suggestOfferedModels, type Models, type RoutingHarness } from "@barry-rocks/sdk/adapters/models";

import { getBagsNeedingAuth, filterBagsNeedingAuthForSession } from "@barry-rocks/sdk/internal/vault";

import { resolveSessionNamespaces } from "@barry-rocks/sdk/internal/sessions";
import { resolveSkillDirs, listAllActions, selectSlashCommandActions } from "@barry-rocks/sdk/internal/actions";
import { listAllInstructions, buildInstructionsIndex, buildBagInstructionPointer } from "@barry-rocks/sdk/internal/instructions";

import type { ActionMeta } from "@barry-rocks/sdk/internal/actions";
import type { MergedBagConfig } from "@barry-rocks/sdk/internal/bags";

function apiHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (process.env.BARRY_SECRET) {
    headers["Authorization"] = `Bearer ${process.env.BARRY_SECRET}`;
  }
  return headers;
}

/** Bags selected by --all and --read, including explicit resume selection. */
export async function allSelectableBags(bags: string[]): Promise<string[]> {
  const composed = expandCompositionSync(bags);
  const snapshot = await loadBagRegistrySnapshot();
  const missing = composed.filter((name) => !snapshot.byName.has(name));
  if (missing.length > 0) {
    throw new Error(`Cannot load every packed bag: ${missing.join(", ")}`);
  }
  return composed;
}

/**
 * How a no-extra-bags-selected server list should be described to the user.
 */
export function describeUnselectedServers(config: McpConfig): string {
  const alwaysOn = Object.keys(config.mcpServers).filter((name) =>
    (ALWAYS_ON_MCP_SERVERS as readonly string[]).includes(name),
  );
  const identityPacked = Object.keys(config.mcpServers).length - alwaysOn.length;
  if (identityPacked === 0) return "no bags selected — always-on only";
  return `no extra bags selected — ${alwaysOn.length} always-on + ${identityPacked} from your barry's bags`;
}

export interface OfferedBagInput {
  name: string;
  description?: string | null;
  tools?: string[];
  hint?: string;
  required?: boolean;
  optional?: boolean;
  boundNames?: string[];
  bound?: Bound;
}

/** What the session picker offers once builtin bags are filtered out. */
export interface OfferedCapabilities {
  bags: Array<{ name: string; description: string; hint?: string; boundHint?: string; required?: boolean }>;
  bounds: Array<{ name: string; description: string; hint?: string; required?: boolean }>;
  /** Builtin bags withheld — 0 when `showBuiltin` is set. */
  hiddenBagCount: number;
}

/**
 * Decide what the session picker offers.
 *
 * Split out from `pickCapabilities` so the filtering can be tested without a
 * TTY: the reveal path (`--show-builtin`) is one boolean away from the hide
 * path, and inverting it silently would put builtin bags in front of the user,
 * or — far worse — hide a user's own bags.
 */
export function offeredCapabilities(
  allBags: readonly OfferedBagInput[],
  showBuiltin: boolean,
  isBuiltin: (bag: string) => boolean = isBuiltinBag,
  allBounds: readonly (Bound & { name?: string; description?: string | null; hint?: string; required?: boolean })[] = [],
): OfferedCapabilities {
  const bags = showBuiltin ? [...allBags] : allBags.filter((b) => !isBuiltin(b.name));
  const namedBounds = allBounds.filter(
    (b): b is Bound & { name: string; description?: string | null; hint?: string; required?: boolean } =>
      typeof b.name === "string" && b.name.length > 0,
  );
  return {
    bags: bags.map((b) => {
      const boundHint =
        b.boundNames && b.boundNames.length > 0
          ? b.boundNames.join(", ")
          : b.bound && summarizeBound(b.bound) !== EMPTY_BOUND_SUMMARY
            ? "bounded"
            : undefined;
      return {
        name: b.name,
        description: b.description ?? (b.tools && b.tools.length > 0 ? b.tools.join(", ") : ""),
        ...(b.hint ? { hint: b.hint } : {}),
        ...(boundHint ? { boundHint } : {}),
        ...(b.required ? { required: true } : {}),
      };
    }),
    bounds: namedBounds.map((b) => {
      const summary = summarizeBound(b);
      const hint = b.hint ?? (b.description && summary !== EMPTY_BOUND_SUMMARY ? summary : undefined);
      return {
        name: b.name,
        description: b.description ?? summary,
        ...(hint ? { hint } : {}),
        ...(b.required ? { required: true } : {}),
      };
    }),
    hiddenBagCount: allBags.length - bags.length,
  };
}

export interface SessionPickerCandidatesInput {
  requiredBags: readonly string[];
  optionalBags?: readonly string[];
  installedBags: readonly Bag[];
  requiredBounds?: readonly string[];
  optionalBounds?: readonly string[];
  globalBounds?: readonly Bound[];
  identityBounds?: readonly (Bound & { name?: string; description?: string | null })[];
  identityName?: string;
  showBuiltin?: boolean;
  isBuiltin?: (bag: string) => boolean;
}

export function buildSessionPickerCandidates(input: SessionPickerCandidatesInput) {
  const reqBagSet = new Set(input.requiredBags);
  const optBags = input.optionalBags ?? [];
  const optBagSet = new Set(optBags);
  const installedByName = new Map(input.installedBags.map((bag) => [bag.name, bag]));
  const isBuiltin = input.isBuiltin ?? isBuiltinBag;

  const candidateBagNames = [
    ...new Set([...optBags, ...input.installedBags.map((bag) => bag.name)]),
  ].filter((name) => !reqBagSet.has(name));

  const bagInputs: OfferedBagInput[] = candidateBagNames.map((name) => {
    const bag = installedByName.get(name);
    const optionalHint = optBagSet.has(name)
      ? input.identityName
        ? `optional on ${input.identityName}`
        : "optional"
      : undefined;
    return {
      name,
      description: bag?.manifest?.description ?? bag?.description ?? null,
      tools: bag?.tools?.map((t) => t.toolName) ?? [],
      ...(optionalHint ? { hint: optionalHint } : {}),
    };
  });

  const step1 = offeredCapabilities(bagInputs, Boolean(input.showBuiltin), isBuiltin);
  const reqBoundSet = new Set(input.requiredBounds ?? []);
  const optBoundSet = new Set(input.optionalBounds ?? []);

  const resolveBounds = (pickedBags: readonly string[]) => {
    const activeBags = new Set([...reqBagSet, ...pickedBags]);
    const candidateBounds: Array<Bound & { name: string; description?: string | null; hint?: string }> = [];
    const seen = new Set<string>();

    for (const bound of input.globalBounds ?? []) {
      if (!bound.name || reqBoundSet.has(bound.name) || seen.has(bound.name)) continue;
      seen.add(bound.name);
      candidateBounds.push({ ...bound, name: bound.name });
    }

    for (const bound of input.identityBounds ?? []) {
      if (!bound.name || reqBoundSet.has(bound.name) || seen.has(bound.name)) continue;
      seen.add(bound.name);
      const optionalHint = optBoundSet.has(bound.name)
        ? input.identityName
          ? `optional on ${input.identityName}`
          : "optional"
        : undefined;
      candidateBounds.push({
        ...bound,
        name: bound.name,
        ...(optionalHint ? { hint: optionalHint } : {}),
      });
    }

    for (const bagName of activeBags) {
      const bag = installedByName.get(bagName);
      for (const [boundKey, def] of Object.entries(bag?.manifest?.bounds ?? {})) {
        const qualifiedName = boundKey.includes(":") ? boundKey : `${bagName}:${boundKey}`;
        if (reqBoundSet.has(qualifiedName) || reqBoundSet.has(boundKey) || seen.has(qualifiedName)) {
          continue;
        }
        seen.add(qualifiedName);
        candidateBounds.push({
          ...def.bound,
          name: qualifiedName,
          ...(def.description ? { description: def.description } : {}),
        });
      }
    }

    return offeredCapabilities([], true, isBuiltin, candidateBounds).bounds;
  };

  return {
    bags: step1.bags,
    hiddenBagCount: step1.hiddenBagCount,
    resolveBounds,
  };
}

/**
 * Capabilities offered by the interactive session picker, scoped to the bags
 * and bounds this identity holds.
 */
async function pickCapabilities(
  requiredBags: string[],
  previous?: { bags?: string[]; bounds?: string[] },
  showBuiltin = false,
  header?: SessionHeader,
  identityId?: number | null,
): Promise<{ bags: string[]; bounds?: string[] }> {
  const snapshot = await loadBagRegistrySnapshot().catch(() => ({ bags: [] as Bag[], byName: new Map<string, Bag>() }));
  const identityRecord = identityId ? await identityRecords.row(identityId).catch(() => undefined) : undefined;
  const identityConfig = identityRecord ? identityRecords.config(identityRecord) : undefined;
  const reqIdentityBags = identityConfig
    ? requiredIdentityBags(identityConfig.bags, identityConfig.bag_configs)
    : [];
  const optBags = identityConfig
    ? optionalIdentityBags(identityConfig.bags, identityConfig.bag_configs)
    : [];
  const allRequiredBags = [...new Set([...requiredBags, ...reqIdentityBags])];
  const reqBagSet = new Set(allRequiredBags);
  const reqBounds = identityConfig ? requiredNames(identityConfig.bounds) : [];
  const optBounds = identityConfig ? optionalNames(identityConfig.bounds) : [];
  const reqBoundSet = new Set(reqBounds);
  const identityInlineBounds = (identityConfig?.bounds ?? []).flatMap((entry) =>
    entry.bound ? [{ ...entry.bound, name: entry.name }] : [],
  );

  const candidates = buildSessionPickerCandidates({
    requiredBags: allRequiredBags,
    optionalBags: optBags,
    installedBags: snapshot.bags,
    requiredBounds: reqBounds,
    optionalBounds: optBounds,
    globalBounds: boundsStore.shipped(),
    identityBounds: identityInlineBounds,
    identityName: identityRecord?.name,
    showBuiltin,
    isBuiltin: isBuiltinBag,
  });

  const selectedItems =
    previous?.bags !== undefined
      ? previous.bags.filter((name) => !reqBagSet.has(name))
      : optBags.filter((name) => !reqBagSet.has(name));
  const selectedBounds =
    previous?.bounds !== undefined
      ? previous.bounds.filter((name) => !reqBoundSet.has(name))
      : [];

  const result = await sessionPicker({
    ...(header ? { header } : {}),
    message: candidates.hiddenBagCount > 0
      ? `Select bags (${candidates.hiddenBagCount} builtin hidden — --show-builtin to show)`
      : "Select bags",
    items: candidates.bags,
    resolveBounds: candidates.resolveBounds,
    ...(selectedItems.length > 0 ? { selectedItems } : {}),
    ...(selectedBounds.length > 0 ? { selectedBounds } : {}),
  });

  return { bags: result.items, bounds: result.bounds };
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
  bounds?: string;
  identityBounds?: string;
  sessionId?: string;
}

/**
 * The same banner for the paths that never draw the picker — `--bag`,
 * `--all`, `--prompt`, a non-TTY fallback. Without it those sessions would
 * print no session ID until exit, which is exactly when it is too late to
 * copy one.
 */
export function printSessionHeader(header: SessionHeader): void {
  if (header.identity) console.log(`  Identity: ${header.identity}`);
  if (header.bags) console.log(`  Bags: ${header.bags}`);
  if (header.bounds) console.log(`  Bounds: ${header.bounds}`);
  if (header.identityBounds) console.log(`  Identity bounds: ${header.identityBounds}`);
  if (header.sessionId) console.log(`  Session: ${header.sessionId}`);
  // Decision 28: guards catch ordinary mistakes, not a determined adversary —
  // only a supported sandbox enforces against one. Said plainly here so a guard
  // is never mistaken for sandbox enforcement.
  console.log("  Guards are best-effort against ordinary mistakes; adversarial enforcement needs a supported sandbox.");
}

/**
 * Write the session's bags and bounds before anything asks the server what the
 * session can do.
 */
async function persistSessionSelection(
  sessionId: string,
  selection: { bags: string[]; bounds?: string[] },
): Promise<void> {
  try {
    const resp = await span("session:selection-persisted", () =>
      fetch(`${getServiceUrl("api")}/api/v1/sessions/${sessionId}`, {
        method: "PATCH",
        headers: apiHeaders(),
        body: JSON.stringify({
          bags: selection.bags,
          ...(selection.bounds ? { bounds: selection.bounds } : {}),
        }),
        signal: AbortSignal.timeout(3000),
      }),
    );
    if (!resp.ok) {
      console.warn(`Warning: Could not save session selection — HTTP ${resp.status}`);
    }
  } catch (err) {
    console.warn(`Warning: Could not save session selection — ${err instanceof Error ? err.message : err}`);
  }
}

export interface SessionResolution {
  bound: Bound | null;
  tools: Tool[];
  skills: Skill[];
  instructions: Instruction[];
  namespaces: string[];
}

async function resolveSessionCapabilities(
  identityId: number | null,
  selection: {
    bags: string[];
    bounds: string[];
    harness: string;
    mode: ModeId;
    identityBagNames: string[];
  },
): Promise<SessionResolution> {
  const [bound, tools, skills, instructions] = await Promise.all([
    identityId !== null
      ? Barry.identity(identityId).bound(selection.bounds)
      : Barry.bound(null, selection.bounds),
    identityId !== null
      ? Barry.identity(identityId).tools({
          bags: selection.bags,
          bounds: selection.bounds,
          harness: selection.harness,
          mode: selection.mode,
        })
      : Barry.tools(null, selection.bags, selection.bounds),
    Barry.skills(identityId ?? undefined, selection.bags),
    Barry.instructions(identityId ?? undefined, selection.bags),
  ]);
  const namespaces = new Set<string>([...selection.identityBagNames, ...selection.bags]);
  for (const tool of tools) {
    if (tool.bag !== null && tool.namespace) {
      namespaces.add(tool.namespace);
    }
  }
  return { bound, tools, skills, instructions, namespaces: [...namespaces] };
}

/**
 * Resolve active session bag namespaces for pre-flight auth checks.
 *
 * Compares against the session's active bags and resolved tools rather than
 * currently active MCP server tools alone — an unauthorized bag has no active
 * tools yet, so comparing against active tools alone would drop unauthorized
 * bags that were selected for the session.
 */
export async function resolveSessionBagNamespaces(params: {
  sessionId?: string;
  identityId: number | null;
  sessionBags: string[];
  isAll?: boolean;
  harness?: string;
  bounds?: string[];
  mode?: ModeId;
  resolved?: Pick<SessionResolution, "namespaces">;
}): Promise<string[] | undefined> {
  if (params.isAll) return undefined;

  const namespaces = new Set<string>(params.sessionBags);
  if (params.resolved) {
    for (const ns of params.resolved.namespaces) namespaces.add(ns);
  } else if (params.identityId !== null || params.sessionBags.length > 0) {
    const selection = {
      bags: params.sessionBags,
      ...(params.harness ? { harness: params.harness } : {}),
      ...(params.bounds ? { bounds: params.bounds } : {}),
      ...(params.mode ? { mode: params.mode } : {}),
    };
    const tools =
      params.identityId !== null
        ? await Barry.identity(params.identityId).tools(selection)
        : await Barry.tools(null, params.sessionBags, params.bounds);
    for (const tool of tools) {
      if (tool.bag !== null && tool.namespace) {
        namespaces.add(tool.namespace);
      }
    }
  }
  if (params.sessionId) {
    for (const active of await resolveSessionNamespaces(params.sessionId)) namespaces.add(active);
  }
  return [...namespaces];
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
  bag?: string;
  bags?: string;
  last?: boolean;
  /** Named bound to restrict the session (see `barry bound list`). */
  bound?: string;
  bounds?: string;
  all?: boolean;
  /**
   * Show builtin bags in the overview line and the session picker.
   */
  showBuiltin?: boolean;
  read?: boolean;
  relax?: boolean;
  directive?: string | true;
  none?: boolean;
  ui?: string;
  noUi?: boolean;
  apiRestart?: boolean;
  /** Identity alias for --name; whichever is set wins at identity resolution. */
  barry?: string;
  transport?: "http" | "sse" | "stdio";
  noBranding?: boolean;
  quickStart?: boolean;
  fullBranding?: boolean;
  healthCheck?: boolean;
  rebuildBags?: boolean;
  zai?: boolean;
  ollama?: boolean;
  llamacpp?: boolean;
  modelProvider?: string;
  /**
   * `--mode`. Left as a plain string: validating it against the ADAPTER's
   * declared modes (not against the ModeId union) is what produces a refusal
   * naming what that adapter can actually do.
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
  _resumeBags?: string[];
  _resumeBounds?: string[];
  /**
   * Internal: what resumeCommand asked to resume, harness-agnostic.
   */
  _resume?: ResumeRequest;
}

interface ResolvedIdentity {
  id: number;
  configuration: import("@barry-rocks/sdk/internal/identities").ResolvedIdentityConfig;
  bags: string[];
  adapters: IdentityAdapters;
}

/**
 * Resolve inherited configuration and record use on the leaf identity.
 */
async function resolveIdentity(identityName: string, selected?: Parameters<typeof identityRecords.config>[0]): Promise<ResolvedIdentity> {
  const found = selected ? undefined : await identityRecords.find(identityName).catch(() => undefined);
  const candidate = selected ?? found?.record;
  const identity = candidate && (await identityRecords.row(candidate.id)) ? candidate : undefined;
  if (!identity) {
    throw new Error(`Barry "${identityName}" not found`);
  }

  void identityRecords.touch(identity.id).catch(() => {});

  const meta = identityRecords.config(identity);
  const bags = meta?.bags ?? [];

  return { id: identity.id, configuration: meta, bags, adapters: meta.adapters };
}

/**
 * Suggest pinning an identity to this repo — but only where that is actionable.
 */
async function maybeSuggestLocalIdentity(): Promise<void> {
  if (!process.stdout.isTTY) return;
  try {
    const names = new Set((await identityRecords.list()).map((entry) => entry.record.name));

    if (names.size > 1) {
      console.log("  Tip: pin an identity to this repo with `barry use --local`");
    }
  } catch {
    // Listing identities is not worth failing a session over.
  }
}

/**
 * Everything the harness launchers need after the shared setup completes.
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
  /** Skill directories provided by the session's selected bags. */
  bagSkillDirs: string[];
  /**
   * Instruction index + bag pointers, appended to the system prompt.
   * Empty when this session can reach no on-demand instructions.
   */
  instructionPrompt: string;
  /** Actions from this session's bags that declared `slash_command: true`. */
  slashCommandActions: ActionMeta[];
  claudeArgs: string[];
  directive: string | null;
  /** Resolved model: --model flag > identity adapter model. undefined = harness decides. */
  model?: string;
  modelProvider?: string;
  /** Whether this is an interactive (non --prompt) session. */
  interactive: boolean;
  /** Native inventory withheld by the session's bound or mode. */
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
      await fetch(`${getServiceUrl("api")}/api/v1/sessions/${sessionId}`, {
        method: "PATCH",
        headers: apiHeaders(),
        body: JSON.stringify({ name: trimmed }),
      });
    }
  } catch {
    // Prompt cancelled or DB unavailable — skip silently
  }
}

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
    await fetch(`${getServiceUrl("api")}/api/v1/sessions/${sessionId}`, {
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
    // Never block or fail the session over bookkeeping.
  }
}

/**
 * Wire the shared teardown + signal handling onto a spawned child.
 */
function attachChildLifecycle(
  child: ReturnType<typeof spawn>,
  ctx: LaunchContext,
  onClose?: () => void | Promise<void>,
  identity?: ProcessIdentityReport,
): void {
  queueStaleBagBuild();
  if (child.pid) void reportSessionPid(ctx.sessionId, child.pid, identity);

  child.on("close", async (code) => {
    await onClose?.();
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
 */
async function runHostedLaunch(
  ctx: Pick<LaunchContext, "sessionId" | "model" | "modelProvider" | "tmpDirs">,
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
 * Shared setup for every harness: command-typo detection, identity/bag/bound
 * resolution, MCP config building, temp-dir creation, session pre-creation, and
 * child env population.
 */
async function selectIdentity(options: StartOptions): Promise<ResolvedIdentity & { name: string }> {
  try {
    const target = currentTarget();
    const requested = options.barry ?? options.name;
    if (target.kind === "identity" && target.record && (!requested || requested === target.name)) {
      console.log(`Barry: ${target.name} (identity command)`);
      return { ...await resolveIdentity(target.name, target.record), name: target.name };
    }
    const user = await getCurrentUser();
    const selection = await identityRecords.resolve({
      name: options.barry ?? options.name,
      repoPath: process.cwd(),
    });
    const identityName = selection.barry.name;
    console.log(`Barry: ${identityName} (${identityRecords.describeSource(selection.source)})`);

    if (selection.source !== "repo") {
      await maybeSuggestLocalIdentity();
    }

    const cachedRow = await identityRecords.row(selection.barry.id);
    const drift = cachedRow && cachedRow.name === identityName ? identityRecords.drift(cachedRow, user.id) : [];
    if (drift.length > 0) {
      console.warn(
        `Warning: "${identityName}" has ${drift.length} field${drift.length === 1 ? "" : "s"} ` +
          `where its database row disagrees with barry.yaml (${drift.map((d) => d.field).join(", ")}). ` +
          `This session uses barry.yaml. Run: barry doctor --fix`,
      );
    }

    return { ...await resolveIdentity(identityName, selection.barry), name: identityName };
  } catch (error: unknown) {
    if (isCliError(error)) throw error;
    throw new CliError(`Error loading barry: ${error instanceof Error ? error.message : String(error)}`, 1);
  }
}

async function authorizeSessionBags(prep: SessionPreparation, options: StartOptions, resolveNamespaces: () => Promise<string[] | undefined>): Promise<void> {
  const { identityBagNames, sessionBags, sessionId } = prep;
  if (!options.prompt) {
    try {
      const registry = loadRegistry();
      const barryRegistry: typeof registry = {};
      for (const name of [...new Set([...identityBagNames, ...sessionBags])]) {
        if (registry[name]) barryRegistry[name] = registry[name];
      }

      const configuredAuth = getBagsNeedingAuth(barryRegistry);
      if (!configuredAuth.length) return;

      const activeNamespaces = await resolveNamespaces();
      const needsAuth = filterBagsNeedingAuthForSession(
        configuredAuth,
        activeNamespaces,
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
          if (isPromptCancellation(err)) {
            await abandonLaunch(sessionId);
          }
        }
      }
    } catch {
      // Registry not available — skip OAuth check
    }
  }
}

async function prepareHarnessLaunch(
  prep: SessionPreparation,
  options: StartOptions,
  identity: ResolvedIdentity & { name: string },
  harnessRecord: InstalledAdapter,
  requestedMode: string | undefined,
  mode: ModeId,
  pendingIdentityEnv: Promise<Environment | null>,
  pendingSession: Promise<SessionResolution>,
  resolveNamespaces: () => Promise<string[] | undefined>,
): Promise<LaunchContext> {
  const { sessionId, claudeArgs, directive, sessionBags, identityBagNames, model, modelProvider } = prep;
  const { name: identityName, id: identityId, configuration: identityConfiguration } = identity;
  const preflightLoading = span("launch:preflight", () => adapterPreflightNotices(harnessRecord.aliases?.[0] ?? harnessRecord.id, undefined, mode));
  const transport = options.transport ?? "http";
  let bagConfig: MergedBagConfig | null = null;
  {
    const bags = await span("launch:load-bags", () => loadBags(identityBagNames));
    const skipped = identityBagNames.filter(n => !bags.some(p => p.name === n));
    if (skipped.length > 0) {
      console.log(`Bags skipped (disabled or not found): ${skipped.join(", ")}`);
    }
    if (bags.length > 0) {
      bagConfig = mergeBags(bags);
    }
  }

  const tmpDirs: string[] = [];

  let mcpConfigPath: string;
  let mcpServers: McpConfig["mcpServers"];

  if (transport === "http" || transport === "sse") {
    const activeNamespaces = sessionBags.length ? (await resolveNamespaces()) ?? [] : [];
    const config = await guestSessionMcpConfig(activeNamespaces, sessionId);
    if (sessionBags.length) console.log(`Session bags: ${sessionBags.join(", ")}`);
    console.log(`MCP servers: ${Object.keys(config.mcpServers).join(", ")}${sessionBags.length ? "" : ` (${describeUnselectedServers(config)})`}`);

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
    const { generateMcpConfig } = await import("../mcp-config.js");
    const config = generateMcpConfig("stdio", identityId ?? undefined, harnessRecord.id);
    const artifact = buildMcpConfig(config);
    tmpDirs.push(artifact.tmpDir);
    mcpConfigPath = artifact.mcpConfigPath;
    mcpServers = artifact.mcpServers;
    console.log(`MCP servers: ${Object.keys(config.mcpServers).length} configured`);
  }

  mark("launch:oauth");
  mark("launch:mcp-config");

  const cliBin = join(PATHS.identityDir, "cli", "node_modules", ".bin");
  const credentialEnvs = await sessionCredentialEnvs();
  const childEnv: Record<string, string | undefined> = buildLaunchEnv({
    baseEnv: process.env,
    cliBin,
    sessionId,
    directive,
    identityId,
    stripCredentialNames: [
      ...credentialEnvs,
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

  const sessionHarness = harnessRecord.aliases?.[0] ?? harnessRecord.id;
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
        credentialEnvs,
      });
    } catch (err) {
      if (isCliError(err)) throw err;
      throw new CliError(`Error: ${err instanceof Error ? err.message : String(err)}`, 1);
    }
  }
  mark("launch:credentials");
  if (model) {
    const harnessId: HarnessId = sessionHarness;
    const vendors = installedModels().vendors();
    if (!isOfferedModel(harnessRecord, vendors, model)) {
      let cursorModels: string[] = [];
      if (harnessId === "cursor") {
        const { harnessAdapter } = await import("../adapters/installed.js");
        const cursorAdapter = await harnessAdapter(harnessId);
        cursorModels = await cursorAdapter.listModels?.({ env: childEnv }) ?? [];
      }
      if (!cursorModels.includes(model)) {
        const suggestions = cursorModels.length
          ? cursorModels.filter((m) => m.includes(model) || model.includes(m)).slice(0, 3)
          : suggestOfferedModels(harnessRecord, vendors, model);
        console.warn(
          `Warning: model '${model}' is not in the curated model list${suggestions.length ? ` — did you mean: ${suggestions.join(", ")}?` : ""} (proceeding anyway)`,
        );
      }
    }
    console.log(`Model: ${model}${options.model ? "" : " (barry default)"}`);
  }

  const routedToOllama = modelProvider === "ollama";
  if (routedToOllama) {
    const resolvedModel = model;
    if (resolvedModel) {
      console.log(`Preflight ollama/${resolvedModel}: checking tool calling…`);
      for (const notice of await ollamaPreflightNotices(resolvedModel, {
        ...(childEnv.BARRY_OLLAMA_URL ? { baseUrl: childEnv.BARRY_OLLAMA_URL } : {}),
      })) console.warn(notice);
    }
  }

  const routedToLlama = modelProvider === "llamacpp";
  if (routedToLlama) {
    const resolvedModel = model;
    if (resolvedModel) {
      console.log(`Preflight llamacpp/${resolvedModel}: checking health and tool calling…`);
      for (const notice of await llamacppPreflightNotices(resolvedModel, {
        ...(childEnv.BARRY_LLAMACPP_URL ? { baseUrl: childEnv.BARRY_LLAMACPP_URL } : {}),
      })) console.warn(notice);
    }
  }

  for (const line of await preflightLoading) console.warn(line);

  Object.assign(childEnv, launchProvenanceEnv({
    harness: sessionHarness,
    ...(model ? { model } : {}),
    ...(modelProvider ? { modelProvider } : {}),
    mode: resolveRecordedMode(harnessRecord, requestedMode),
  }));

  let registeredBags: readonly Bag[] = [];
  try {
    registeredBags = (await span("launch:snapshot", () => loadBagRegistrySnapshot())).bags;
  } catch (err) {
    console.warn(`Warning: Could not load bag registry — ${err instanceof Error ? err.message : err}`);
  }

  const resolvedSession = await pendingSession;

  const finishResources = begin("launch:resources");
  const skillsLoading = (async () => {
    let bagSkillDirs: string[] = [];
    try {
      const skillNames = resolvedSession.skills.map((skill) => skill.name);
      if (skillNames.length > 0) {
        bagSkillDirs = await resolveSkillDirs(registeredBags, skillNames);
        if (bagSkillDirs.length > 0) {
          console.log(`Bag skills: ${skillNames.join(", ")}`);
        }
      }
    } catch (err) {
      console.warn(`Warning: Could not resolve bag skills — ${err instanceof Error ? err.message : err}`);
    }

    return bagSkillDirs;
  })();
  const instructionsLoading = (async () => {
    let instructionPrompt = "";
    try {
      const activeBagNames = [...new Set([...identityBagNames, ...sessionBags])];
      const instructions = await listAllInstructions(registeredBags, { bagNames: activeBagNames });
      const bagInstructionNames = resolvedSession.instructions.map((instruction) => instruction.name);

      const sections = [
        buildInstructionsIndex(instructions, { exclude: bagInstructionNames }),
        buildBagInstructionPointer(bagInstructionNames, instructions),
      ].filter((s): s is string => Boolean(s));

      if (sections.length > 0) instructionPrompt = sections.join("\n\n");
    } catch (err) {
      console.warn(`Warning: Could not resolve instructions — ${err instanceof Error ? err.message : err}`);
    }

    return instructionPrompt;
  })();
  const promptsLoading = (async () => {
    try {
      const { collectPromptSections } = await import("@barry-rocks/sdk/internal/instructions");
      const activeBagNames = [...new Set([...identityBagNames, ...sessionBags])];
      const loadedBags = registeredBags.filter((bag) => activeBagNames.includes(bag.name));
      const promptSections = await collectPromptSections(loadedBags, {
        cwd: process.cwd(),
        sessionId,
        provider: sessionHarness,
      });
      const prompt = promptSections.join("\n\n");
      return prompt;
    } catch (err) {
      console.warn(`Warning: Could not resolve bag prompts — ${err instanceof Error ? err.message : err}`);
    }

    return "";
  })();
  const actionsLoading = skillsLoading.then(async (bagSkillDirs) => {
    let slashCommandActions: ActionMeta[] = [];
    try {
      slashCommandActions = selectSlashCommandActions(
        await listAllActions(registeredBags, {
          bagNames: [
            ...new Set([
              ...identityBagNames,
              ...sessionBags,
              ...registeredBags
                .filter((bag) =>
                  [...bag.skillsDirs, ...bag.actionsDirs].some((dir) =>
                    bagSkillDirs.some((skill) => skill === dir || skill.startsWith(`${dir}/`)),
                  ),
                )
                .map((bag) => bag.name),
            ]),
          ],
        }),
        identityBagNames,
        bagSkillDirs,
      );
    } catch (err) {
      console.warn(`Warning: Could not resolve action slash commands — ${err instanceof Error ? err.message : err}`);
    }

    return slashCommandActions;
  });
  const [bagSkillDirs, instructionIndex, bagPrompt, slashCommandActions] = await Promise.all([
    skillsLoading, instructionsLoading, promptsLoading, actionsLoading,
  ]);
  const instructionPrompt = [instructionIndex, bagPrompt].filter(Boolean).join("\n\n");
  finishResources();
  const { native, deniedTools, allowedNativeTools } = resolveSessionNativeTools(resolvedSession, harnessRecord, mode);
  if (Object.keys(native.conflicts).length) {
    throw new CliError(`Session bounds cannot take back ${Object.keys(native.conflicts).join(", ")} on ${harnessRecord.id} (${mode}): ${[...new Set(Object.values(native.conflicts))].join("; ")}. Start in another mode or on another harness, or drop the bound.`, 1);
  }
  console.log(`Native tools: ${native.allowed.join(", ") || "none"}`);
  for (const [tool, reason] of Object.entries(native.refused)) console.warn(`${tool} refused on ${harnessRecord.id} (${mode}): ${reason}`);
  if (Object.keys(native.uncontrolled).length) console.warn(`${harnessRecord.id} (${mode}) cannot turn off ${Object.keys(native.uncontrolled).join(", ")}: ${[...new Set(Object.values(native.uncontrolled))].join("; ")}`);
  if (native.operatorOverride) console.warn(native.operatorOverride);
  const finishSettings = begin("launch:settings");
  const settingsPath = buildMergedSettings({ deniedTools, bagHooks: bagConfig?.hooks ?? [] });
  finishSettings();
  tmpDirs.push(join(settingsPath, ".."));
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
    bagSkillDirs,
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
 * Leave a launch cancelled before anything ran — a picker or prompt the user
 * pressed Ctrl+C at.
 */
async function abandonLaunch(sessionId: string): Promise<never> {
  await endSession(sessionId);
  throw new CliError("", 0);
}

async function endSession(sessionId: string): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${getServiceUrl("api")}/api/v1/sessions/end`, {
        method: "POST",
        headers: apiHeaders(),
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
 */
async function recordLaunch(sessionId: string, harness: string, mode: ModeId, plan: LaunchPlan): Promise<void> {
  try {
    await fetch(`${getServiceUrl("api")}/api/v1/sessions/start`, {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify({
        sessionId,
        provider: harness,
        mode,
        guarantees: plan.guarantees,
        ...(plan.harnessSessionId ? { harnessSessionId: plan.harnessSessionId } : {}),
      }),
      signal: AbortSignal.timeout(3000),
    });
  } catch { /* bookkeeping must never block the session */ }
}

/**
 * An identity's name, given its name or its store folder id.
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
  if (options.rebuildBags) process.env.BARRY_BAGS_REBUILD = "1";
  const identityReference = options.name ?? options.barry;
  if (identityReference) options.name = await localIdentityName(identityReference);

  const apiGuard = ensureApiCurrent(cliBuild(), { base: getServiceUrl("api"), headers: apiHeaders(), noRestart: options.apiRestart === false });
  const selectedIdentity = await span("start:identity-selected", () => selectIdentity(options));
  const records = await span("start:adapters", () => installedHarnesses());
  const record = selectHarness(options, selectedIdentity.adapters, records);
  const harness = record.aliases?.[0] ?? record.id;
  const requestedMode = options.mode ?? adapterSettings(selectedIdentity.adapters, record)?.mode;
  const launched = resolveModeOrExit(options, selectedIdentity, record);
  mark("start:mode");
  if (launched.mode !== "hosted") await span("start:ensure-full", () => ensureBarry());
  const uiLoading = import("../ui/dispatch.js");
  uiLoading.catch(() => {});
  if (launched.mode !== "hosted") void import("@barry-rocks/sessions-bag/client/terminal-relay").catch(() => {});
  const pendingIdentityEnv = launched.mode === "hosted" ? Promise.resolve(null) : span("launch:identity-env", () => identityEnvironment(selectedIdentity.configuration));
  pendingIdentityEnv.catch(() => {});
  const prep = await prepareSession(args, options, selectedIdentity, record, launched.mode, {
    supportsBags: supportsCreateBags(),
    persistSelection: persistSessionSelection,
    recallSelection: () => recallSelection({ identityId: selectedIdentity.id, harness: record.id }),
    rememberSelection: selection => rememberSelection({ identityId: selectedIdentity.id, harness: record.id, bags: selection.bags, bounds: selection.bounds }),
    checkKnownCommand,
    expandComposition: async names => expandCompositionSync(names),
    baseBags: () => baseIdentitySelection().bags,
    isBuiltinBag: name => loadRegistry()[name]?.type === "local" ? (loadBagSync(name)?.builtin ?? false) : false,
    allBags: allSelectableBags,
    pick: pickCapabilities,
    printHeader: printSessionHeader,
    warn: console.warn,
    cancelled: error => isPromptCancellation(error),
    abandon: async () => { throw new CliError("", 0); },
    directive: async () => {
      try { return (await (await import("@inquirer/prompts")).input({ message: "Directive (press Enter to skip):" })).trim() || null; }
      catch (error) {
        if (isPromptCancellation(error)) throw new CliError("", 0);
        return null;
      }
    },
    model: async () => {
      const identityModel = adapterSettings(selectedIdentity.adapters, record)?.model;
      if (launched.mode === "hosted" && !options.model && !options.modelProvider && !options.zai && !options.ollama && !options.llamacpp && !identityModel) return {};
      if (launched.mode === "hosted") {
        const vendors = await span("preaction:model-declarations", () => modelVendorsForRouting());
        return resolveModelSelection(options, record, identityModel, vendors);
      }
      await span("preaction:models", () => ensureModelsInstalled());
      return resolveModelSelection(options, record, identityModel);
    },
    create: async input => {
      const current = await apiGuard.beforeCreate(launched.mode === "hosted" || input.selectedBounds.length > 0);
      if (!current.ok) return { ok: false, body: {}, warning: current.warning };
      const deps = { fetch, endpoint: `${getServiceUrl("api")}/api/v1/sessions/start`, headers: apiHeaders() };
      const result = await preCreateSessionStep(input, deps);
      if (!result.ok && await apiGuard.retryCreate(result.warning ?? "")) return preCreateSessionStep(input, deps);
      return result;
    },
  });
  const pendingSession =
    launched.mode === "hosted"
      ? undefined
      : span("launch:session", () =>
          resolveSessionCapabilities(prep.identityId, {
            bags: prep.sessionBags,
            bounds: prep.selectedBounds,
            harness: record.id,
            mode: launched.mode,
            identityBagNames: prep.identityBagNames,
          }),
        );
  pendingSession?.catch(() => {});
  let namespaces: Promise<string[] | undefined> | undefined;
  const resolveNamespaces = () =>
    (namespaces ??= (async () =>
      resolveSessionBagNamespaces({
        sessionId: prep.sessionId,
        identityId: prep.identityId,
        sessionBags: prep.sessionBags,
        isAll: options.all,
        harness: record.id,
        bounds: prep.selectedBounds,
        mode: launched.mode,
        ...(pendingSession ? { resolved: await pendingSession } : {}),
      }))());
  if (options.transport !== "stdio") await span("launch:oauth", () => authorizeSessionBags(prep, options, resolveNamespaces));
  if (launched.mode === "hosted") {
    void fetch(`${getServiceUrl("api")}/api/v1/sessions/${prep.sessionId}/prepare`, { method: "POST", headers: apiHeaders(), signal: AbortSignal.timeout(5000) }).catch(() => {});
    await uiLoading;
    return runHostedLaunch(prep, harness, options.prompt, Boolean(options.prompt), options, selectedIdentity);
  }
  const ctx = await prepareHarnessLaunch(prep, options, selectedIdentity, record, requestedMode, launched.mode, pendingIdentityEnv, pendingSession!, resolveNamespaces);
  const { harnessAdapter } = await import("../adapters/installed.js");
  const adapter = await span("launch:adapter-load", () => harnessAdapter(harness));
  const launchMode = launched.mode === "instrumented" ? adapter.modes.instrumented : adapter.modes.guest;
  if (!launchMode) {
    throw new CliError(`${harness} has no ${launched.mode} mode, so \`barry start\` cannot launch it.`, 1);
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
    bagSkillDirs: ctx.bagSkillDirs,
    slashCommandActions: ctx.slashCommandActions,
    ...(options._resume ? { resume: options._resume } : {}),
    tmpDirs: ctx.tmpDirs,
    ...(launched.mode === "instrumented" || launched.mode === "guest" ? { relayCommand: thisCliCommand("hook", harness) } : {}),
    ...(launched.mode === "instrumented" ? { telemetry: telemetryReceiver() } : {}),
  });

  if (launchMode.attachesTo === "hosted") {
    if (options.prompt) return runHostedLaunch(ctx, harness, options.prompt, true, options, selectedIdentity);
    return runAttachedLaunch(ctx, harness, launched.mode, launchMode, config);
  }

  let plan: LaunchPlan;
  try {
    plan = await span("launch:plan", () => launchMode.plan(config));
  } catch (err) {
    if (options.prompt && err instanceof NotSupportedInMode && err.operation === "prompt") {
      return runHostedLaunch(ctx, harness, options.prompt, true, options, selectedIdentity);
    }
    throw err;
  }
  ctx.tmpDirs.push(...plan.tmpDirs);

  const launchRecorded = span("launch:record", () => recordLaunch(ctx.sessionId, harness, launched.mode, plan));
  launchRecorded.catch(() => {});
  const discovery = !plan.harnessSessionId && plan.discoverHarnessSessionId
    ? discoverConversation(
        () => plan.discoverHarnessSessionId!(),
        (harnessSessionId) => recordLaunch(ctx.sessionId, harness, launched.mode, { ...plan, harnessSessionId }),
      )
    : null;

  const relay = plan.inbox ? await startTerminalRelay(ctx.sessionId, plan.inbox) : null;

  const identity: ProcessIdentityReport = {
    command: [plan.command, ...plan.args].join(" "),
    processName: basename(plan.command),
    appName: harness,
    parentPid: process.pid,
  };

  report("launch:plan");
  runChildSession(plan, {
    attach: (child, onClose) => attachChildLifecycle(child, ctx, onClose, identity),
    onClose: async () => {
      void relay?.stop();
      await discovery?.stop();
      await launchRecorded;
    },
  });
}

async function runAttachedLaunch(ctx: LaunchContext, harness: string, mode: ModeId, launchMode: LaunchMode, config: SessionConfig): Promise<void> {
  const api = { base: `${getServiceUrl("api")}/api/v1`, headers: apiHeaders() };
  const fail = (what: string, err: unknown): never => {
    console.error(`${what}: ${err instanceof Error ? err.message : String(err)}`);
    cleanupTmpDirs(ctx.tmpDirs);
    throw new CliError("", 1);
  };

  const attachment = await attachToHostedSession(ctx.sessionId, {
    harness,
    ...(ctx.model ? { model: ctx.model } : {}),
    ...(ctx.modelProvider ? { modelProvider: ctx.modelProvider } : {}),
  }, api).catch((err: unknown) => fail(`Could not open the session to ${harness}'s TUI`, err));
  const detach = () => detachFromHostedSession(ctx.sessionId, attachment.attachmentId, api);

  let plan: LaunchPlan;
  try {
    const options = typeof config.options === "object" && config.options !== null ? config.options : {};
    plan = await launchMode.plan({ ...config, options: { ...options, attachment: { address: attachment.address, harnessSessionId: attachment.harnessSessionId } } });
  } catch (err) {
    await detach();
    return fail(`Could not launch ${harness}'s TUI`, err);
  }
  ctx.tmpDirs.push(...plan.tmpDirs);
  await recordLaunch(ctx.sessionId, harness, mode, plan);

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
