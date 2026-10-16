# ADR 0041: Command classification and completion

## Context

Historical restructuring notes obscured root registration authority, namespace classification, reserved-name refusal and completion traversal. Config exports also cited an unfinished historical phase instead of the current exclusion rule.

## Decision

Describe actual root registration and compare classifications against Commander in the existing root-surface tests. Keep hidden generic-name blockers, replacement guidance and help interception rules. Traverse the live tree for completion, using bag metadata only for lazy groups. Preserve all original rationale below.

## Consequences

Only comments change. Original phase descriptions remain historical evidence, not assertions about current registrations or future migrations.

## Preserved comments

### Original comment 1: cli/src/reserved-names.ts

```ts
/**
 * Reserved top-level names — old command spellings that are permanently
 * blocked from being claimed by anything else, even though they no longer
 * work as commands themselves.
 *
 * History: Phases 3 and 4 of the command-surface restructure (removing 14
 * hand-duplicated devops registrations, then grouping 21 flat identity verbs
 * under `barry identity`) moved 32 top-level commands to new homes and kept
 * every old spelling working as a hidden, forwarding, deprecation-noticed
 * alias for a release cycle — that mechanism (`registerDeprecatedAlias` /
 * `registerDeprecatedAliasesUnder`) lived in this file. Phase 5 removed the
 * deprecation window: those 32 spellings are gone now, `barry <old-name>`
 * reports "unknown command" like any other unregistered name.
 *
 * `registerReservedName` below is what's left, kept for exactly 2 of the 32:
 * `list` and `delete`, the highest-risk generic names a bag could otherwise
 * silently acquire (see the restructure plan's "Generic names become
 * bag-claimable" risk note — a bag named `list` claiming the root `list`
 * slot would make `barry list` mean something entirely unrelated, with no
 * error and no warning). These two stay permanently reserved.
 */

```

### Original comment 2: cli/src/reserved-names.ts

```ts
/**
 * Register a PERMANENT hidden blocker for `oldName` — it occupies the name
 * (so a bag can never claim it, via registerBagGroups' `knownNames` check,
 * which includes hidden commands) but does not forward: there is no "moved
 * to X, will be removed in a future release", because this IS after that
 * release — the move already happened and is not coming back.
 *
 * Deliberately errors rather than silently forwarding forever: a command
 * that works but never appears in `--help` and is never mentioned in any
 * documentation is not a feature, it is a trap for whoever finds it by
 * typing muscle memory. Telling the user where the command actually lives
 * is more honest than either forwarding invisibly forever or a bare
 * "unknown command".
 *
 * `helpOption(false)` is required, not optional: without it, Commander
 * intercepts `--help` and renders help for this (content-free) blocker
 * command itself, before the action below ever runs — the exact bug already
 * fixed once in index.ts's pre-parse unknown-command guard (see
 * checkKnownCommand's doc comment). `allowUnknownOption` +
 * `allowExcessArguments` are what let an arbitrary tail of flags and
 * positionals reach the action rather than Commander trying (and failing)
 * to validate them against this command's own empty option/argument list.
 */
```

### Original comment 3: cli/src/command-registry.ts

```ts
/**
 * "namespace" is for `devops` itself: it is the container the 14 devops
 * commands live under, not a leaf command that ships in either package.
 * `findBoundaryViolations` (devops.ts) already special-cases the string
 * "devops" as "the namespace, not a command in either set" — this Ship value
 * keeps that same fact expressed here, so PUBLISHABLE_NAMES/DEVOPS_NAMES
 * still exclude it while the grouped-help formatter can still find it (it
 * would otherwise be indistinguishable from a bag group discovered at
 * runtime, which is exactly the bug this caused before the Ship value
 * existed — `devops` rendered under "From your bags").
 */
```

### Original comment 4: cli/src/command-registry.ts

```ts
/**
 * Every top-level command this CLI statically registers, classified.
 *
 * This is NOT what drives registration in index.ts — the `.command(...)`
 * calls there are still the source of truth for what actually runs. This is
 * the classification of that same set, checked against reality by
 * `root-surface.test.ts` rather than assumed to match it.
 */
```

### Original comment 5: cli/src/command-registry.ts

```ts
  // "identity" holds every identity-configuration verb now (create, list,
  // show, test, check, delete, traits, bound, adapters, notifier, github) as
  // real subcommands. None of those 20 old flat spellings are registered at
  // the top level any more — Phase 5 dropped the
  // deprecation aliases Phases 3-4 introduced for them, so they are
  // correctly absent from this file: there is nothing left to classify them
  // as, since they never appear in `registeredNames` again.
```

### Original comment 6: cli/src/command-registry.ts

```ts
  // "health" was deleted outright in Phase 3, never moved: see git history
  // on this comment block for the locked decision's reasoning (a shorthand
  // for `service status` that would nest awkwardly under devops, and it
  // appeared nowhere in the usage evidence that grounded this restructure).

```

### Original comment 7: cli/src/commands/completion.ts

```ts
/**
 * Walk `program`'s own command tree to the position `args` describes,
 * returning what could complete the NEXT word.
 *
 * Replaces two independent failure modes in the previous implementation:
 *   - a hardcoded top-level array that had already drifted (listed `coffee`,
 *     removed as a static command; listed `barry`, never a real command;
 *     omitted ~30 real commands including every identity verb) — see
 *     command-registry.ts's own doc comment for the full account
 *   - a depth limit of 2: `tryBagGroupCompletions` was the only source of
 *     subcommand completions, and it only ever consulted the BAG REGISTRY,
 *     never Commander's own static command tree. `barry db status --help`
 *     completing further, or `barry devops service restart` completing AT
 *     ALL, was structurally impossible before this.
 *
 * Bag groups remain a special case: they register a single lazy action
 * handler with no real Commander subcommands (`registerBagGroups` sets
 * `helpOption(false)` and defers loading the bag's tools until first
 * invocation — see bag-cli.ts), so `cmd.commands` is always empty for them.
 * `tryBagGroupCompletions` is kept exactly for that case.
 *
 * Through Phases 3-4 of the command-surface restructure, this also had to
 * redirect through hidden DEPRECATION aliases (e.g. `db`, forwarding to
 * `devops db`) into their real target's subtree — a deprecation alias was
 * its own, separate, empty Command object, so matching it directly would
 * dead-end completion at a leaf with no subcommands. Phase 5 removed those
 * aliases entirely, so that redirect is gone too: `list` and `delete`
 * (command-registry.ts's RESERVED_NAMES) are hidden, empty leaves with
 * nothing to redirect TO any more — they error rather than forward — so
 * completing past either falls through to the ordinary "no real subcommand
 * here" case below, same as any other leaf command.
 */
```

### Original comment 8: cli/src/commands/config-export.ts

```ts
  // Barry ships no traits, only bounds, so every trait is a bag's or the
  // user's. Until phase C deletes their rows, the composites Barry used to
  // ship still sit in the table; they are not the user's to export.
```

