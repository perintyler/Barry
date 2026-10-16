import { withRuntimeVersion } from "../../sessions/runtime-version.js";
import { versionNotice } from "./versions.js";
import type { Platform } from "../../services/platform.js";
import { configureHarnessSession } from "../../sessions/configure.js";
import { inspectHarnessVersion, requireCompatibleVersion } from "./version-guard.js";
/**
 * An adapter: Barry's code for one harness, and Barry's claims about it.
 *
 * Each mode slot holds the declaration AND the code that honours it, in one
 * object, so a mode cannot be claimed without an implementation or implemented
 * without a claim. The claims are what a session records and a sender is told,
 * which is why every one names the check that proved it.
 */
import type { HarnessId, JsonSchema, ModeId, VendorId } from "../../ids.js";
import type { LaunchPlan } from "./launch/index.js";
import type { Session, SessionConfig } from "../../sessions/index.js";
import type { TranscriptSource } from "../../transcripts/index.js";
import type { Vendor } from "../models/vendors/index.js";
import type { VendorFactories } from "../models/vendors/models.js";
import type { StartEngine } from "./engine.js";

export interface Adapter {
  /** Relative directory containing this adapter's ordinary bag manifest. */
  bag?: string;
  id: HarnessId;
  /**
   * Former ids this harness still answers to — what sessions, identities,
   * flags and settings recorded before a rename. Wherever an id is read, an
   * alias resolves to `id`.
   */
  aliases?: readonly HarnessId[];
  label: string;
  /** Present means experimental; the reason names the missing evidence. */
  experimental?: string;
  /**
   * The vendor whose API this harness speaks. A model of another vendor is
   * reachable only through that vendor's imitation of this one. Absent for a
   * harness that connects to vendors itself (opencode), where Barry routes nothing.
   */
  vendor?: VendorId;
  requirements: Requirements;
  capabilities: HarnessCapabilities;
  /** The harness's own tools, as it names them — everything the harness can offer a session. */
  tools: readonly string[];
  defaultMode: ModeId;
  /** `null` is the complete answer "not today"; there is no way to leave a slot unanswered. */
  modes: {
    hosted: SessionMode | null;
    instrumented: LaunchMode | null;
    guest: LaunchMode | null;
  };
  /** JSON Schema for harness-specific settings, which arrive as `SessionConfig.options`. */
  options?: JsonSchema;
  transcript?: TranscriptSource;
  /** The models this account can use, where the harness can say. */
  listModels?(options: { env: Readonly<Record<string, string | undefined>> }): Promise<string[]>;
  /** An executable a caller asks for itself, such as an IDE CLI; not necessarily the session binary. */
  resolveBinary?(): string | Promise<string>;
  /**
   * The models a harness with no vendor offers, named as it names them
   * (`vendor/model`). A harness with a vendor offers that vendor's catalog,
   * and the catalogs of vendors it can be routed to, instead.
   */
  offeredModels?: readonly OfferedModel[];
}

export interface OfferedModel {
  id: string;
  label: string;
}

export interface NativeControlBase {
  /** Groups that can only be turned on whole. */
  inseparable?: readonly (readonly string[])[];
  /** Tools this mode cannot turn off, with the reason. */
  uncontrolled?: Readonly<Record<string, string>>;
  /** How the operator can lift this mode's native gate. */
  operatorOverride?: string;
}

export interface NativeControl extends NativeControlBase {
  /** Tools this mode can turn on while the rest stay off. */
  controllable: readonly string[];
  /** Legacy alias for `controllable` during the Stage 1–7 transition window. */
  grantable?: readonly string[];
}

export type NativeControllable = NativeControl;

export interface LegacyNativeControl extends NativeControlBase {
  /** Tools this mode can turn on while the rest stay off. */
  controllable?: readonly string[];
  /** Legacy alias for `controllable` during the Stage 1–7 transition window. */
  grantable: readonly string[];
}

export interface Mode {
  native?: NativeControl | LegacyNativeControl;
  /** Conversation resume alone never establishes approval continuation. */
  approvalContinuation?: import("../../sessions/continuations.js").ApprovalContinuation;
  guarantees: Guarantees;
  /**
   * Legacy evidence build (also the runtime build for bundled modes).
   * `versions.testedVersions` retains all builds with guarantee evidence.
   */
  verifiedOn: string;
  /** Recommendation, compatibility, and test evidence for the runtime this mode runs. */
  versions?: import("./versions.js").VersionPolicy;
  /** The runnable check that showed them — a claim with no check is not declared. */
  evidence: { check: string; proves: string };
  /** Where they were shown. Other platforms are unverified, not broken. */
  platforms?: Platform[];
  /** Whether Barry's egress proxy holds in this mode. */
  egressSandbox: boolean;
  /**
   * Set on a launch mode whose TUI renders the hosted session rather than
   * running its own: it attaches to the engine Barry already holds, so it may
   * declare guarantees up to the hosted mode's.
   */
  attachesTo?: "hosted";
  /**
   * What this mode runs: the binary `requirements.binary` names (the default),
   * or a build the adapter carries itself, such as an SDK's bundled CLI or a
   * library run in-process. The binary on PATH says nothing about a bundled
   * build, so a launch checks its version only for `binary`.
   */
  build?: "binary" | "bundled";
}

/** Barry drives: every event, delivery, interrupt, and a ruling on each tool call. */
export interface SessionMode extends Mode {
  openContinuation?(config: SessionConfig, startEngine: StartEngine): Promise<import("../../sessions/continuations.js").ContinuationHarness>;
  structuredOutput: "native" | "prompted";
  /**
   * `startEngine` is passed in because a harness that needs a long-running
   * process must not depend on the bag that supervises one.
   */
  start(config: SessionConfig, startEngine: StartEngine): Promise<Session>;
  /** Take over a conversation the harness started without Barry. */
  adopt?(harnessSessionId: string, config: SessionConfig): Promise<Session>;
}

/** A human drives, in the harness's own TUI; Barry plans the launch. */
export interface LaunchMode extends Mode {
  plan(config: SessionConfig): Promise<LaunchPlan>;
}

export type CaptureLevel = "total" | "near-total" | "post-hoc" | "none";

/**
 * Identical to the sessions bag's delivery guarantee on purpose: what an
 * adapter declares is what a live surface registers, and a sender is told one
 * vocabulary either way.
 */
export type DeliveryLevel = "wake" | "wake-peer-framed" | "turn-end" | "tool-call" | "on-resume" | "none";

/**
 * `per-call` means the harness asks and Barry answers; `static` is a denylist
 * fixed at launch; `hooks` is a vendor hook that can veto; `none` means a
 * native call cannot be stopped once started.
 */
export type GatingLevel = "per-call" | "static" | "hooks" | "none";

export type IdentityLevel = "inherent" | "mcp-url" | "hooks" | "none";

export interface Guarantees {
  capture: CaptureLevel;
  delivery: DeliveryLevel;
  /** A message folded into the running turn, not queued behind it. */
  steer: boolean;
  interrupt: boolean;
  gating: GatingLevel;
  /** Whether the human keeps the harness's own TUI. */
  keepsVendorUi: boolean;
  identity: IdentityLevel;
}

export interface HarnessCapabilities {
  mcpTransports: Array<"stdio" | "http" | "sse">;
  /**
   * `none` means `deniedTools` cannot be enforced: Barry denies the harness's
   * own shell so every command runs through its guarded tool, and on a `none`
   * harness that guard does not apply.
   */
  toolDenial: "native" | "none";
  /** `unsupported` means guidance must be prefixed onto the prompt instead. */
  systemPromptFormat: "preset-append" | "raw" | "unsupported";
  skillsMount: "plugin" | "none";
  /**
   * What the harness does with no API key. `subscription-oauth` falls back to
   * the user's own login — which must never be sent to another vendor's
   * endpoint, so routing refuses a keyless endpoint on such a harness.
   */
  withoutKey: "subscription-oauth" | "unauthenticated";
  /**
   * Whether Barry can point the harness at another vendor's endpoint that
   * serves its vendor's API. `fixed` means it reaches only its own, so a model
   * of another vendor is refused before a session starts rather than sent in
   * an API nobody on the other end speaks.
   */
  endpoint: "configurable" | "fixed";
}

export interface Requirements {
  binary: {
    command: string;
    /** Optional explicit executable override, checked before declared paths and PATH. */
    overrideEnv?: string;
    /** Absolute installed paths, tried in order before command on PATH. */
    paths?: string[];
    versionArgs: string[];
    /** A regex whose first capture group is the version, applied to the binary's output. */
    versionPattern: string;
    install: { darwin?: string; linux?: string; fallback?: string };
    /** Install guidance only; never a launch restriction. Modes own compatibility. */
    recommendedVersion?: string;
    /** @deprecated Accepted when reading older adapter registrations. */
    pin?: { version: string; enforcedBy: string };
  };
  platforms?: Platform[];
}

/**
 * What Barry knows about an adapter without loading its code — enough for
 * `barry adapter list`, doctor and the UI, which must work even when the code
 * will not load.
 */
export interface InstalledAdapter {
  packageName: string;
  contractVersion: 1;
  /** Validated bag declarations, readable without loading adapter code. */
  bag?: { path: string; manifest: import("../../bags/types.js").BagManifest };
  id: HarnessId;
  aliases?: HarnessId[];
  label: string;
  experimental?: string;
  vendor?: VendorId;
  offeredModels?: OfferedModel[];
  requirements: Requirements;
  capabilities: HarnessCapabilities;
  tools: string[];
  defaultMode: ModeId;
  modes: Record<ModeId, Mode | null>;
  /**
   * Vendor call code this adapter ships: the DATA half, snapshotted at
   * install — vendor rows a picker or a model registry reads without loading
   * the adapter. The factories are not recorded; they load from the recorded
   * path when the process that hosts models asks for them
   * (`loadVendorCode`).
   */
  vendorCode?: { vendors: Vendor[] };
  path: string;
  version: string;
  installedAt: string;
}

export interface Adapters {
  /** Load, check and record the adapter package at `path`. Nothing is recorded that did not pass. */
  add(path: string, options?: AddOptions): Promise<InstalledAdapter>;
  /** The records alone — no adapter code runs. */
  installed(): InstalledAdapter[];
  /** Remove a selection without deleting its package or registered bag data. */
  remove(id: HarnessId): boolean;
  /** By id or alias. */
  load(id: HarnessId): Promise<Adapter>;
  /**
   * Every vendor row installed adapters declare — read off the records, so a
   * registry, a picker or `createModels` costs no adapter imports. Shipped
   * rows come from registered bags’ vendor declarations and arrive separately.
   */
  vendorRows(): Vendor[];
  /**
   * The installed adapters' vendor call code, loaded: each vendor-carrying
   * adapter is imported and its factories merged in. One that fails to load
   * is reported by name rather than failing the caller — a broken third
   * party must not take down the boot that asked. Rows stay available either
   * way; only the factories are lost, and the refusal says whose.
   */
  loadVendorCode(): Promise<{ factories: VendorFactories; refused: Map<string, string[]> }>;
}

/** The installed record answering to `id`, by its id or one of its aliases. */
export function findInstalled<Record extends { id: HarnessId; aliases?: readonly HarnessId[] }>(
  records: readonly Record[],
  id: HarnessId,
): Record | undefined {
  return records.find((record) => record.id === id) ?? records.find((record) => record.aliases?.includes(id));
}

export interface AddOptions {
  /**
   * Problems running this adapter on this machine — a missing binary, a
   * login. Asked after the adapter's own declarations pass and before
   * anything is recorded.
   */
  vet?: (adapter: Adapter) => Promise<string[]>;
}

// Fields assigned in the body rather than as parameter properties: Node's
// type stripping cannot transform those, and bags load this source unbundled.
export class AdapterNotInstalled extends Error {
  readonly adapterId: HarnessId;
  constructor(adapterId: HarnessId) {
    super(`adapter not installed: ${adapterId} — run \`barry adapter add <path>\``);
    this.name = "AdapterNotInstalled";
    this.adapterId = adapterId;
  }
}

/**
 * A package whose declarations do not hold up. Distinct from
 * `AdapterNotInstalled` because the repair differs: reinstalling a package
 * that is already present changes nothing.
 */
export class AdapterRefused extends Error {
  readonly adapterId: HarnessId;
  readonly problems: string[];
  constructor(adapterId: HarnessId, problems: string[]) {
    super(`adapter ${adapterId} was refused: ${problems.join("; ")}`);
    this.name = "AdapterRefused";
    this.adapterId = adapterId;
    this.problems = problems;
  }
}

export type AdapterInput = Omit<Adapter, "tools"> & {
  tools?: readonly string[];
};

/** Gives an adapter literal its type, so a missing slot or implementation is a compile error. */
export function defineAdapter(input: AdapterInput): Adapter {
  const inventory = input.tools ?? [];
  const adapter: Adapter = {
    ...input,
    tools: inventory,
  };
  const configure = (config: SessionConfig, mode: Mode) => {
    if (adapter.capabilities.toolDenial === "none" && (inventory.length || config.deniedTools?.length)) {
      throw new Error(`${adapter.id} cannot enforce Barry's mandatory tool restrictions`);
    }
    return configureHarnessSession(config, inventory, mode.native);
  };
  // Every launch path applies the same advisory compatibility policy.
  const verified = (mode: Mode, config: SessionConfig) => {
    requireCompatibleVersion(adapter, mode, { env: config.env });
    return config;
  };
  const recordRuntime = async (pending: Promise<Session>, mode: Mode, config: SessionConfig): Promise<Session> => {
    const runtimeVersion = inspectHarnessVersion(adapter, mode, { env: config.env });
    const session = await pending;
    const notice = versionNotice(adapter.id, runtimeVersion);
    return withRuntimeVersion(session, runtimeVersion, notice);
  };
  const recordPlan = async (pending: Promise<LaunchPlan>, mode: Mode, config: SessionConfig): Promise<LaunchPlan> => {
    const assessment = inspectHarnessVersion(adapter, mode, { env: config.env });
    const notice = versionNotice(adapter.id, assessment);
    const plan = await pending;
    return { ...plan, warnings: [...plan.warnings ?? [], ...notice ? [notice] : []] };
  };
  const hosted = adapter.modes.hosted;
  const instrumented = adapter.modes.instrumented;
  const guest = adapter.modes.guest;
  return {
    ...adapter,
    modes: {
      hosted: hosted ? { ...hosted, start: (config, engine) => recordRuntime(hosted.start(verified(hosted, configure(config, hosted)), engine), hosted, config),
        ...(hosted.adopt ? { adopt: (id: string, config: SessionConfig) => recordRuntime(hosted.adopt!(id, verified(hosted, configure(config, hosted))), hosted, config) } : {}),
        ...(hosted.openContinuation ? { openContinuation: (config: SessionConfig, engine: StartEngine) =>
          hosted.openContinuation!(verified(hosted, configure(config, hosted)), engine) } : {}) } : null,
      instrumented: instrumented ? { ...instrumented, plan: (config) => recordPlan(instrumented.plan(verified(instrumented, configure(config, instrumented))), instrumented, config) } : null,
      guest: guest ? { ...guest, plan: (config) => recordPlan(guest.plan(verified(guest, configure(config, guest))), guest, config) } : null,
    },
  };
}

export { checkAdapter, type AdapterCheck } from "./check.js";
export { HarnessVersionMismatch } from "./version-guard.js";
export { testAdapter } from "./testing.js";
export type { EngineHandle, EngineSpec, StartEngine } from "./engine.js";
export * from "./launch/index.js";

export { assessVersion, modeVersions, compareVersions, validVersionPolicy } from "./versions.js";
export type { VersionPolicy, VersionRange, VersionAssessment } from "./versions.js";
export { inspectHarnessVersion, resolveHarnessBinary, resolveHarnessCommand } from "./version-guard.js";
