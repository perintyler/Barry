import { validVersionPolicy } from "./versions.js";
/**
 * What any adapter must satisfy to be installed.
 *
 * It names no adapter, so a third party can run it against one Barry has never
 * heard of; `barry adapter add` runs it before recording anything, and loading
 * runs it again. Every check is about the DECLARATION — complete, coherent,
 * evidenced. Whether a guarantee is true is shown only by running the check a
 * mode names in `evidence`.
 *
 * Reads the adapter defensively: a third-party module can be any shape at all,
 * and a guard that throws on a half-built adapter reports "does not load"
 * instead of the list of what is missing.
 */
import { isAbsolute } from "node:path";
import { isHarnessId, MODE_IDS, type ModeId } from "../../ids.js";
import type { Adapter, Mode } from "./index.js";

export interface AdapterCheck {
  problems: string[];
  /** How many checks ran. Zero is a broken checker, not a clean adapter. */
  checked: number;
}

export function checkAdapter(
  adapter: Adapter,
  /** The parsed bag manifest, when the adapter declares one — the credentials rule reads it. */
  options: { bagManifest?: { credentials?: Record<string, { source: "vault"; item: string; field: string }> } } = {},
): AdapterCheck {
  const problems: string[] = [];
  let checked = 0;
  const expect = (ok: boolean, problem: string): void => {
    checked += 1;
    if (!ok) problems.push(problem);
  };

  expect(typeof adapter.id === "string" && isHarnessId(adapter.id), `adapter id "${String(adapter.id)}" is not lowercase letters, digits and dashes`);
  const aliases: unknown[] = Array.isArray(adapter.aliases) ? adapter.aliases : [];
  expect(adapter.aliases === undefined || Array.isArray(adapter.aliases), "aliases must be a list of former ids");
  expect(
    aliases.every((alias) => typeof alias === "string" && isHarnessId(alias) && alias !== adapter.id),
    "each alias must be a harness id other than the adapter's own",
  );
  expect(typeof adapter.label === "string" && adapter.label.length > 0, "adapter has no label");

  expect(adapter.experimental === undefined || typeof adapter.experimental === "string" && adapter.experimental.trim().length > 0, "experimental must name missing evidence in a non-empty string");
  expect(adapter.resolveBinary === undefined || typeof adapter.resolveBinary === "function", "resolveBinary must be a function when provided");
  expect(adapter.listModels === undefined || typeof adapter.listModels === "function", "listModels must be a function when provided");

  const modes: Partial<Record<string, unknown>> =
    adapter.modes && typeof adapter.modes === "object" ? adapter.modes : {};
  // A key present but undefined — easy to produce through a spread — would
  // otherwise read as "not supported" when nobody said so.
  expect(
    MODE_IDS.every((slot) => modes[slot] !== undefined),
    `modes must answer every slot with a mode or null (${MODE_IDS.join(", ")})`,
  );
  expect(
    Boolean(adapter.defaultMode && modes[adapter.defaultMode]),
    `default mode "${String(adapter.defaultMode)}" is not declared`,
  );

  for (const slot of MODE_IDS) {
    const mode = modes[slot];
    if (mode === null || mode === undefined) continue;
    const hosted = modes.hosted as Partial<Mode> | null | undefined;
    checkMode(slot, mode as Partial<Mode> & Record<string, unknown>, expect, hosted ?? null);
    const native = (mode as Partial<Mode>).native;
    if (native) {
      const rawInventory = adapter.tools;
      const inventory = Array.isArray(rawInventory) ? rawInventory : [];
      const rawControllable = native.controllable ?? native.grantable;
      const controllable = Array.isArray(rawControllable) ? rawControllable : [];
      expect(Array.isArray(rawControllable) && rawControllable.every(tool => inventory.includes(tool)), `mode "${slot}" names grantable tools outside its inventory`);
      expect(Object.keys(native.uncontrolled ?? {}).every(tool => inventory.includes(tool)), `mode "${slot}" names uncontrolled tools outside its inventory`);
      expect(Object.keys(native.uncontrolled ?? {}).every(tool => !controllable.includes(tool)), `mode "${slot}" makes a tool both grantable and uncontrolled`);
      expect(native.inseparable === undefined || Array.isArray(native.inseparable) && native.inseparable.every(group => Array.isArray(group) && group.every(tool => controllable.includes(tool))), `mode "${slot}" has an inseparable set outside grantable`);
    }
  }

  checkRequirements(adapter, expect, options);
  return { problems, checked };
}

function checkMode(
  slot: ModeId,
  mode: Partial<Mode> & Record<string, unknown>,
  expect: (ok: boolean, problem: string) => void,
  hosted: Partial<Mode> | null,
): void {
  // Declaration and implementation travel together, so each half's absence
  // is its own problem: a claim nothing honours, or code nobody vouched for.
  const implementation = slot === "hosted" ? "start" : "plan";
  expect(typeof mode[implementation] === "function", `mode "${slot}" is declared but has no ${implementation}()`);
  if (slot === "hosted") {
    expect(
      mode.structuredOutput === "native" || mode.structuredOutput === "prompted",
      `mode "hosted" does not say how it produces structured output`,
    );
  }

  expect(
    typeof mode.verifiedOn === "string" && /\d/.test(mode.verifiedOn),
    `mode "${slot}" records no harness build in verifiedOn`,
  );
  expect(
    Boolean(mode.evidence?.check) && Boolean(mode.evidence?.proves),
    `mode "${slot}" must name the check that proved it and what that check proves`,
  );
  expect(typeof mode.egressSandbox === "boolean", `mode "${slot}" does not say whether the egress sandbox holds`);

  expect(!mode.versions || validVersionPolicy(mode.versions), `mode "${slot}" has an invalid version policy`);
  const guarantees = mode.guarantees;
  if (!guarantees) {
    expect(false, `mode "${slot}" declares no guarantees`);
    return;
  }
  // The one relationship no type can state: total capture, interrupt and
  // per-call gating all need Barry to hold the session. A TUI mode claiming
  // any of them would have a session report guarantees it cannot deliver,
  // unless it renders the hosted session itself, and then only as far as
  // hosted goes.
  if (slot === "hosted") return;
  if (mode.attachesTo === "hosted") {
    checkAttached(slot, guarantees, hosted, expect);
    return;
  }
  expect(guarantees.capture !== "total", `mode "${slot}" claims total capture, which only hosted can give`);
  expect(guarantees.interrupt === false, `mode "${slot}" claims interrupt, which only hosted can give`);
  expect(guarantees.gating !== "per-call", `mode "${slot}" claims per-call gating, which only hosted can give`);
}

const CAPTURE_RANK = ["none", "post-hoc", "near-total", "total"];
const DELIVERY_RANK = ["none", "on-resume", "tool-call", "turn-end", "wake-peer-framed", "wake"];
const GATING_RANK = ["none", "static", "hooks", "per-call"];

/** A TUI attached to the hosted session can claim what hosted gives, and no more. */
function checkAttached(
  slot: ModeId,
  guarantees: Mode["guarantees"],
  hosted: Partial<Mode> | null,
  expect: (ok: boolean, problem: string) => void,
): void {
  const base = hosted?.guarantees;
  expect(Boolean(base), `mode "${slot}" attaches to hosted, but the adapter declares no hosted mode`);
  if (!base) return;
  const within = (rank: string[], claimed: string, held: string) => rank.indexOf(claimed) <= rank.indexOf(held);
  expect(within(CAPTURE_RANK, guarantees.capture, base.capture), `mode "${slot}" claims more capture than its hosted mode gives`);
  expect(within(DELIVERY_RANK, guarantees.delivery, base.delivery), `mode "${slot}" claims more delivery than its hosted mode gives`);
  expect(within(GATING_RANK, guarantees.gating, base.gating), `mode "${slot}" claims more gating than its hosted mode gives`);
  expect(!guarantees.steer || base.steer, `mode "${slot}" claims steer, which its hosted mode does not give`);
  expect(!guarantees.interrupt || base.interrupt, `mode "${slot}" claims interrupt, which its hosted mode does not give`);
}

function checkRequirements(
  adapter: Adapter,
  expect: (ok: boolean, problem: string) => void,
  options: { bagManifest?: { credentials?: Record<string, { source: "vault"; item: string; field: string }> } } = {},
): void {
  // A harness that can host a session must say what it authenticates with.
  // The bag manifest's `credentials:` is that declaration (vault defaults the
  // identity may override); without it a hosted session would run on whatever
  // the harness finds lying around, which is exactly what the gate exists to
  // refuse. Read off the adapter's own bag declaration so no table in sdk/
  // names a harness.
  const hosted = adapter.modes?.hosted;
  const credentials = options.bagManifest?.credentials as Record<string, unknown> | undefined;
  if (hosted) {
    expect(
      credentials !== undefined && Object.keys(credentials).length > 0,
      "hosted adapter declares no credentials — add a credentials: block to its bag.yaml naming the env vars it authenticates with, as vault items",
    );
  }
  const requirements = adapter.requirements;
  if (!requirements?.binary) {
    expect(false, "adapter declares no binary requirement");
    return;
  }
  const { binary } = requirements;
  expect(binary.paths === undefined || Array.isArray(binary.paths) && binary.paths.every(path => typeof path === "string" && isAbsolute(path)), "requirements binary paths must be absolute paths");
  expect(Boolean(binary.command), "requirements name no binary command");
  expect((binary.versionArgs?.length ?? 0) > 0, "requirements give no way to ask the binary its version");
  expect(
    Boolean(binary.install?.darwin ?? binary.install?.linux ?? binary.install?.fallback),
    "requirements carry no install hint for any platform",
  );
  const recommendation = binary.recommendedVersion ?? binary.pin?.version;
  expect(Boolean(recommendation), "requirements state no recommended build");
  // The vendor-login requirement is gone with the vendor-login modes: a
  // session authenticates with declared credentials or not at all, so there
  // is no login to check or instruct about. A package still declaring one is
  // describing a Barry that no longer exists.
  expect(
    (requirements as { login?: unknown }).login === undefined,
    "adapter declares a login requirement — vendor-login modes are refused; declare credentials in the bag manifest instead",
  );

  // The pattern is the part of a requirement that can be wrong in a way doctor
  // reports as "not installed". Fed a realistic line, it must find the pin.
  let found: string;
  try {
    found = new RegExp(binary.versionPattern).exec(`${binary.command} ${recommendation}`)?.[1] ?? "nothing";
  } catch (err) {
    found = `an error (${err instanceof Error ? err.message : String(err)})`;
  }
  expect(
    found === recommendation,
    `versionPattern applied to "${binary.command} ${recommendation}" found ${found}, not the recommendation`,
  );
}
