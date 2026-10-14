/** Validate grant and bound configuration at authoring time so unknown restrictions cannot become unrestricted grants. */

/**
 * Both current bounds and legacy scopes spellings remain readable in user-authored trait declarations.
 * See docs/decisions/0044-trait-validation-diagnostics.md.
 */
export interface BoundedTraitDeclaration {
  name: string;
  bounds?: string[];
  /** Legacy spelling, read permanently — see above. */
  scopes?: string[];
}

/** The bound names a trait declares, under either spelling. */
function declaredBoundNames(trait: BoundedTraitDeclaration): string[] {
  return trait.bounds ?? trait.scopes ?? [];
}

export interface UnknownBoundReference {
  trait: string;
  unknown: string[];
}

/**
 * List unknown trait-bound references after the bound catalog loads; an empty catalog has its own upstream diagnostic.
 * See docs/decisions/0044-trait-validation-diagnostics.md.
 */
export function findUnknownBoundNames(
  traits: ReadonlyArray<BoundedTraitDeclaration>,
  knownBounds: ReadonlySet<string>,
): UnknownBoundReference[] {
  if (knownBounds.size === 0) return [];

  const offenders: UnknownBoundReference[] = [];
  for (const trait of traits) {
    const unknown = declaredBoundNames(trait).filter((bound) => !knownBounds.has(bound));
    if (unknown.length > 0) offenders.push({ trait: trait.name, unknown });
  }
  return offenders;
}

export interface DroppedBoundOverride {
  trait: string;
  /** Bound names the shadowed definition carried and the winner does not. */
  dropped: string[];
}

/**
 * Report bounds omitted by the last same-name trait declaration after comparing every shadowed declaration; overriding remains permitted.
 * See docs/decisions/0044-trait-validation-diagnostics.md.
 */
export function findDroppedBoundOverrides(
  traits: ReadonlyArray<BoundedTraitDeclaration>,
): DroppedBoundOverride[] {
  const lastByName = new Map<string, BoundedTraitDeclaration>();
  for (const trait of traits) lastByName.set(trait.name, trait);

  const dropped: DroppedBoundOverride[] = [];
  for (const [name, winner] of lastByName) {
    const winnerBounds = new Set(declaredBoundNames(winner));
    // Union what every shadowed definition carried: with three sources a
    // bound can be declared in the builtin, kept by the middle override and
    // dropped by the last, and reading only the first would miss it.
    const shadowedBounds = new Set<string>();
    for (const trait of traits) {
      if (trait.name !== name || trait === winner) continue;
      for (const bound of declaredBoundNames(trait)) shadowedBounds.add(bound);
    }

    const lost = [...shadowedBounds].filter((bound) => !winnerBounds.has(bound));
    if (lost.length > 0) dropped.push({ trait: name, dropped: lost });
  }
  return dropped;
}

/**
 * Validate every default trait against the final declaration list, including bag auto-traits, before publishing it.
 * See docs/decisions/0044-trait-validation-diagnostics.md.
 */
export function findMissingDefaultTraits(
  defaults: readonly string[],
  declared: ReadonlyArray<{ name: string }>,
): string[] {
  const names = new Set(declared.map((t) => t.name));
  return defaults.filter((name) => !names.has(name));
}

/** An identity's default bound, narrowed to the field this check reads. */
export interface DefaultBoundedIdentity {
  name: string;
  /** The bound the identity pins as its default, or null when it pins none. */
  bound: { name: string; deniedTools?: string[] } | null;
}

export interface ShellessIdentity {
  identity: string;
  bound: string;
}

/**
 * Identities whose default bound leaves every one of their sessions with NO
 * shell at all.
 *
 * Native Bash is off unless a trait grants it, and a Bash-denying bound
 * takes it back even when granted. The MCP copy is removed by `filterTools`
 * when a bound names `Bash` in `deniedTools`.
 *
 * Each denial is correct alone. Together they are absolute: an identity that
 * pins a Bash-denying bound as its DEFAULT has no shell in any session it
 * starts, and the two halves live in different packages, so nothing was
 * positioned to notice the combination.
 *
 * This is not hypothetical. The `bux` identity carried `bound_id` pointing at
 * the builtin `no-bash` bound, and 66 consecutive sessions started with no
 * Bash. The symptom was near-undiagnosable from inside: `filterTools` removes
 * `Bash` by name while leaving its companions `BashOutput` and `KillShell` in
 * place, so the toolset looked deliberate rather than broken, and no log line
 * anywhere said "this session cannot run commands".
 *
 * Deliberately NOT an error, and deliberately only about DEFAULT scopes. A
 * shell-less session is a legitimate thing to ask for — `barry start --bound
 * no-bash` is the supported way to get one. Pinning it to an identity is what
 * makes it permanent and invisible, so that is what this reports.
 *
 */
export function findShellessIdentities(
  identities: ReadonlyArray<DefaultBoundedIdentity>,
): ShellessIdentity[] {
  const shelless: ShellessIdentity[] = [];
  for (const identity of identities) {
    if (!identity.bound) continue;
    // Bounds are hand-authored YAML and hand-edited JSON, so casing cannot be
    // relied on; native-tool category restrictions are also case insensitive.
    const deniesBash = (identity.bound.deniedTools ?? []).some(
      (tool) => tool.toLowerCase() === "bash",
    );
    if (deniesBash) shelless.push({ identity: identity.name, bound: identity.bound.name });
  }
  return shelless;
}
