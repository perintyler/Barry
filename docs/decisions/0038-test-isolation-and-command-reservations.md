# ADR 0038: Test isolation and command reservations

## Context

Test database overrides alone do not isolate identity directories or registry publication. The scratch guard currently validates lexical temporary-path ancestry, with deliberate limits around symlinks and shared fixtures. Command reservation notes also described historical removals that no longer match the current root registry.

## Decision

State the guard precisely: it accepts memory databases and lexical OS-temporary paths when Vitest is active, without proving canonical containment, emptiness or exclusivity. Apply it only when stores open; require an explicit opt-out for real-store tests. Pin identity directories and registry publication together. Reserve list/delete separately from actual root command registration.

## Consequences

The comments stop overstating the path guard or claiming root service/db commands are absent. Executable behavior is unchanged. Full original explanations remain below, including historical incidents and limits; their old path and command observations are not current verification.

## Preserved comments

### Original comment 1: sdk/src/stores/scratch-guard.ts

```ts
/** Under Vitest, refuse stores outside real scratch paths at the opening boundary. See docs/decisions/0002-test-store-isolation.md */

/**
 * The rule: under VITEST, a store may only be opened from a scratch location.
 *
 * "Scratch" is defined POSITIVELY — the resolved path must be under the OS
 * temp directory — rather than by pattern-matching the path for "test". These
 * are filesystem paths, not database names: a developer whose home is
 * `/Users/testarossa` or who works in `~/repos/latest-barry` would carry
 * "test" in every path they own, including the production stores, and the
 * guard would wave them all through. Substring matching on a path is precisely
 * an unsafe substitute for proving scratch-directory ancestry.
 *
 * `mkdtempSync(join(tmpdir,...))` is already how every correctly-pinned
 * suite in this repo builds its override (see the thirty-odd
 * `BARRY_SESSIONS_DB = join(mkdtempSync(join(tmpdir, "barry-…")), …)` lines
 * in bags/sessions/src/store, and the `BARRY_IDENTITIES_DB` pin in
 * vitest.base.config.ts), so the rule is a statement of the convention that
 * already exists rather than a new burden on suite authors.
 *
 * `:memory:` passes too. It is not a filesystem path at all and cannot be
 * mistaken for a real store — vitest.base.config.ts already pins
 * `BARRY_EVENTS_DB` that way for the events bag.
 *
 * HONEST LIMITS, because a guard whose reach is oversold is worse than none:
 *
 *  - It proves the store is DISPOSABLE, not that it is EMPTY or unshared. Two
 *    suites pointed at the same temp file still stomp each other, and a
 *    developer who copies a production store into `/tmp` and points a suite at
 *    it gets no warning. What it rules out is the specific accident that has
 *    actually happened here: falling back to the real instance's path.
 *  - It is a path-prefix check, not an inode check. It does not follow
 *    symlinks, so a symlink in the temp directory pointing back at the
 *    real sessions.db defeats it. Resolving with `realpathSync`
 *    would close that, but the file frequently does not exist yet at open time
 *    (creating it is the normal case), and a guard that behaves differently on
 *    the first run than the second is its own hazard. Nobody has ever caused
 *    this failure by symlink; they cause it by forgetting an override.
 *  - On macOS `tmpdir` is a per-user path under `/var/folders/...` that is
 *    itself a symlink to `/private/var/folders/...`. Both spellings are
 *    accepted below for that reason; a path written with one spelling and
 *    compared against the other would reject legitimate temp paths.
 *  - It says nothing about NON-test processes. Production is untouched: the
 *    whole function short-circuits when VITEST is unset.
 */
```

### Original comment 2: sdk/src/stores/scratch-guard.ts

```ts
/**
 * Throw unless this store may be opened from the current process.
 *
 * Called from the `get*Sqlite()` functions — where the file is OPENED — and
 * deliberately not from the `*DbPath()` functions. Path resolution happens in
 * places that never open anything (error messages, backup destinations, the
 * `isSharedConfigStore()` predicate), and a guard that fires on a harmless
 * string is a guard people route around. The damage is done by the open, so
 * the open is where the check belongs.
 *
 * `BARRY_ALLOW_NON_TEST_STORE` is the opt-out, named after the earlier
 * `BARRY_ALLOW_NON_TEST_DATABASE` and serving the same purpose: a
 * test that deliberately drives the real store (proving a migration tool, or
 * asserting what the production path resolves to) has a way to say so
 * explicitly, in one place a reviewer can grep for.
 */
```

### Original comment 3: cli/src/command-registry.ts

```ts
/**
 * Old top-level name -> new real path, for the two names Phase 5 keeps
 * permanently RESERVED rather than dropping outright — see reserved-names.ts
 * for why `list` and `delete` specifically, and why blocking beats either
 * silent forwarding or a bare "unknown command". Every other name Phases 3
 * and 4 had aliased (service, db, show, set-model, ...) is now simply gone:
 * `barry <name>` for those reports "unknown command" like any other
 * unregistered name, exactly as if the alias had never existed.
 */
```

### Original comment 4: vitest.base.config.ts

```ts
      // ~/.barry itself, and the machine-wide registry beside it. Pinning each
      // database was not enough: BARRY_HOME decides where identity DIRECTORIES
      // are found (identities/ and identities.yaml), and a fixture named like a
      // real identity ("bux") resolved to the developer's ~/repos/barry-bux —
      // which, once identity writes began routing by directory, meant a suite
      // could rewrite a real identity.yaml. It was caught only because a new
      // guard refused the write. The config store and the registry snapshot
      // are pinned together: publishing refuses a redirected store without a
      // redirected snapshot, and a suite must never publish into the live one.
```

### Original comment 5: vitest.base.config.ts

```ts
      // Action runs and schedule state. Pinned before a suite leaks rather
      // than after: scripts actions and schedules write runs unattended, and a
      // suite that forgot setDb() would put rows into the real run history
      // under ~/.barry/<env>/.
```

