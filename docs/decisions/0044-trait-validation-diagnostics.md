# ADR 0044: trait validation diagnostics and mounted server labels

Status: accepted

## Context

The trait validator comments combine current declaration rules with incident narratives and legacy terminology. The always-on server label comment also suggests a grant guarantee that the mounted-entry display does not establish. Complete original comments are preserved below.

## Decision

Describe the existing validators in terms of final declarations, catalog availability and legacy spelling support. Preserve their reporting and refusal behavior. Describe the legacy server list as a display classification, while tool access continues to resolve through grants.

## Consequences

Comments no longer use past incidents as present guarantees or equate a mounted entry with a granted tool. No executable behavior changes; strict stored-bound and inheritance validation belongs to Step 17.

## Preserved original comments

### 1. bags/identities/src/config/trait-bound-validation.ts

```text
/**
 * A trait as declared in YAML, narrowed to the fields validation reads.
 *
 * BOTH key spellings are declared and both are read. These files live on the
 * user's disk, outside this repo and outside the database, so migration 028 cannot
 * convert them and no moment exists at which every copy is known to be
 * converted. Reading only `bounds:` would make a legacy `scopes:` trait look
 * like it declares nothing — and this validator would then skip it in silence,
 * turning a fail-closed guard into a no-op.
 */
```

### 2. bags/identities/src/config/trait-bound-validation.ts

```text
/**
 * Traits naming a bound that does not exist.
 *
 * `knownScopes` empty means the scopes table did not load, NOT that every name
 * is bad — reporting all of them would turn one upstream failure into dozens
 * of bogus errors and bury the real cause. `barry bag doctor` skips its
 * orphaned-namespace check on an empty provider set for the same reason.
 * Returning nothing here is safe: the caller has a broken bound table, which
 * is its own louder problem.
 */
```

### 3. bags/identities/src/config/trait-bound-validation.ts

```text
/**
 * Overrides that silently strip a bound from the definition they shadow.
 *
 * The three trait YAML sources are concatenated and upserted in order, so the
 * last definition of a name wins. That upsert replaces `metadata` wholesale,
 * and `boundNames` lives inside `metadata` — so an override written without
 * `scopes:` does not merely decline to add one, it DELETES the bound the
 * shadowed definition carried.
 *
 * This is not hypothetical. A local `read` override silently stripped
 * `scopes: [readonly]` from the builtin, leaving `barry start -r` holding the
 * provider's native Bash/Write/Edit: with `boundNames` empty,
 * the effective native policy loses its inherited restrictions. The
 * row read `{"boundNames": []}` and nothing anywhere said so.
 *
 * Overriding a trait is legitimate and common, so this reports rather than
 * refuses — the hazard is dropping a restriction by omission, not overriding.
 */
```

### 4. bags/identities/src/config/trait-bound-validation.ts

```text
/**
 * Names in `DEFAULT_TRAITS` that nothing in the merged declaration list defines.
 *
 * A default trait with no row grants NOTHING, to every session, silently. The
 * runtime cannot report this usefully: `resolveSessionBound` errors only when
 * EVERY default is missing (`bound.default_traits_missing`), so four-of-six
 * resolving looks exactly like six-of-six — the broken state is indistinguishable
 * from the healthy one.
 *
 * This is not hypothetical. `docs-media` and `keychain` were listed as defaults
 * while being defined only in a personal config repo, so on any other checkout
 * every session asked for them and got nothing, with nothing anywhere saying so.
 *
 * Deliberately takes the declaration list rather than querying the table: the
 * caller validates precisely what it is about to upsert, with no timing window
 * between the check and the write. Call it AFTER bag auto-traits have joined the
 * list — a default may legitimately be provided by a bag manifest rather than by
 * YAML, and checking earlier would fail those machines wrongly.
 */
```

### 5. bags/identities/src/config/traits.ts

```text
/** MCP servers that are always enabled regardless of trait selection */
```
