/**
 * The commands an identity answers to, and the reconcile that puts them on PATH.
 *
 * `barry heir` installed the one shim for the identity it was birthing, and
 * `barry alias` installed one per extra name. Nothing else ever did — so an
 * identity born before that feature, or created through the API by the
 * Identities window, or given an alias by editing `identity.yaml` by hand, had
 * no command at all, and `bux list` was simply "command not found". Nothing
 * reported it, because nothing ever compared the two sides.
 *
 * This module is the comparison: `expectedCommands` says what SHOULD be on
 * PATH, `findMissingCommands` is the read-only check, `reconcileCommands` is
 * the write. `barry use` and `barry doctor` both read from here, so the check
 * and the fix cannot disagree about what correct means.
 */

import {
  describeConflict,
  ensureShims,
  findInstalledBarry,
  getShimDir,
  isCurrentShim,
  type EnsureResult,
  type ShimSpec,
} from "./identity-shims.js";

/**
 * The shape both identity sources fit: a name, and metadata that may hold
 * aliases. Deliberately narrower than `IdentityRecord` so a directory-backed
 * identity and a database row are interchangeable here, and so this module
 * needs no store import to typecheck.
 */
export interface CommandBearingIdentity {
  id?: number;
  name: string;
  metadata?: { aliases?: unknown } | null;
}

/** The CLI's own command, which no identity's command may take. */
const CLI_COMMAND = "barry";

/** Commands reserved by the CLI or base identity that do not receive identity shims. */
const RESERVED_SHIM_COMMANDS = new Set([CLI_COMMAND, "base"]);

/** Aliases recorded on an identity, in yaml order. */
function aliasesOf(metadata: { aliases?: unknown } | null | undefined): string[] {
  const raw = metadata?.aliases;
  return Array.isArray(raw) ? raw.filter((a): a is string => typeof a === "string") : [];
}

/**
 * Every command these identities should answer to. An alias points at the
 * identity's real name rather than itself, so `BARRY_IDENTITY` resolves an
 * identity and not a second alias for it to chase.
 */
export function expectedCommands(identities: readonly CommandBearingIdentity[]): ShimSpec[] {
  const specs: ShimSpec[] = [];
  const seen = new Set<string>();

  for (const identity of identities) {
    for (const command of [identity.name, ...aliasesOf(identity.metadata)]) {
      // `barry` is the CLI itself, and `base` is the base parent template:
      // neither receives an identity command shim.
      if (RESERVED_SHIM_COMMANDS.has(command)) continue;
      // Two identities claiming one name is a conflict worth reporting
      // somewhere, but not by writing the same file twice in one pass.
      if (seen.has(command)) continue;
      seen.add(command);
      specs.push({ command, identity: identity.name, ...(identity.id ? { binding: { id: identity.id, home: process.env.BARRY_HOME ?? null } } : {}) });
    }
  }

  return specs;
}

/** Where a shim goes and what it execs. Injectable so tests never touch PATH. */
export interface ShimIo {
  binDir: string;
  barryPath: string;
}

/** The real PATH directory and installed barry, or null when there is none. */
function installedIo(): ShimIo | null {
  const binDir = getShimDir();
  const barryPath = findInstalledBarry();
  return binDir && barryPath ? { binDir, barryPath } : null;
}

/**
 * Which expected commands are absent, or present but pointing at the wrong
 * identity. Read-only — this is the question `barry doctor` asks.
 *
 * Null when barry is not installed on PATH: there is no directory to inspect,
 * and "you have no identity commands" would be a misleading answer for someone
 * running out of a checkout.
 */
export function findMissingCommands(
  identities: readonly CommandBearingIdentity[],
  io: ShimIo | null = installedIo(),
): ShimSpec[] | null {
  if (!io) return null;

  return expectedCommands(identities).filter(
    (spec) => !isCurrentShim(spec.command, spec.identity, io.binDir, spec.binding),
  );
}

/**
 * Install whatever is missing, leave everything already correct alone.
 *
 * Null for the same reason as `findMissingCommands` — no installed `barry`
 * means nowhere to put a shim.
 */
export function reconcileCommands(
  identities: readonly CommandBearingIdentity[],
  io: ShimIo | null = installedIo(),
): EnsureResult | null {
  if (!io) return null;

  return ensureShims(expectedCommands(identities), io);
}

/**
 * What a reconcile did, in lines worth printing — empty when there is nothing
 * to say. Everything already correct is the usual case, and announcing it on
 * every `barry use` would train people to ignore the lines that matter.
 *
 * Refusals always print: a name recorded in `identity.yaml` that never reached
 * PATH is a promise the CLI cannot keep, and silently is exactly how this
 * feature stayed broken for two identities.
 */
export function describeReconcile(result: EnsureResult | null): string[] {
  if (!result) return [];
  if (result.installed.length === 0 && result.refused.length === 0) return [];

  const lines: string[] = [];
  if (result.installed.length > 0) {
    const plural = result.installed.length === 1 ? "" : "s";
    lines.push(`Installed identity command${plural}: ${result.installed.join(", ")}`);
  }
  for (const { command, conflict } of result.refused) {
    lines.push(`  refused: ${describeConflict(command, conflict)}`);
  }
  return lines;
}

/**
 * Every identity the owner has, from both sources, directory winning.
 *
 * The same merge the listings do: a Barry can exist as a directory AND as a
 * cache row, and reading aliases from the stale copy would install from one
 * source and then report the other as wrong.
 *
 * Lazy because the store is: this module is imported by `barry doctor`'s file,
 * which is imported by the CLI entry point, and a top-level store import would
 * put the database on the load path of `--version`.
 */
export async function collectIdentities(): Promise<CommandBearingIdentity[]> {
  const { identityRecords } = await import("@barry-rocks/identities-bag");
  return (await identityRecords.list()).map((entry) => entry.record);
}

/** Reconcile every identity the owner has. See `reconcileCommands` for null. */
export async function reconcileAllIdentities(): Promise<EnsureResult | null> {
  return reconcileCommands(await collectIdentities());
}
