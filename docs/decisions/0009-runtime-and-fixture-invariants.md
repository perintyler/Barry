# ADR 0009: Runtime and fixture invariants

## Context

Dated source narratives explain failures that established current loading, service-retention and test-fixture contracts. Their complete checkpoint wording is retained below as historical context.

## Decision

Keep the controlling invariant in source and move the supporting narratives here, without changing executable behavior.

## Consequences

Future changes must review the linked failure modes. Historical observations are not current measurements.

## Note 001

Source: [cli/src/commands/bag.ts](../../cli/src/commands/bag.ts)

Print each structured build diagnostic; a count header alone hides the actionable error.

Original rationale:

```text
// esbuild's message begins with a COUNT HEADER ("Build failed with 2
    // errors:") and puts the diagnostics on the lines after it. Printing only
    // line [0] rendered every failure as that header and nothing else — a
    // trailing colon promising detail that never came (vantage-core, which was
    // failing on two unresolved imports nobody could see, 2026-09-17).
```

## Note 002

Source: [cli/src/commands/bag.ts](../../cli/src/commands/bag.ts)

Reject bare repository URLs as MCP endpoints so installation cannot overwrite a valid local registration.

Original rationale:

```text
/**
 * Hosts whose URLs are git repositories, not MCP endpoints.
 *
 * A bare repo URL from one of these is the single most likely thing someone
 * types when they mean "install this bag", and it is the one input this
 * command cannot serve -- see the `install` doc comment for why it does not
 * clone. Registering it as a remote MCP server instead is not a near miss: it
 * OVERWRITES a working local registration with one pointing at an HTML page,
 * dropping the bag's composition and tools, while both `install` and the
 * following `pack` exit 0 and print success.
 *
 * Observed on jalen-brunson, 2026-09-16: `Type: local` with
 * `Composes bags: point-guard, point-guard-macos, point-guard-ios` became
 * `Type: remote` with no composition at all, reported as "registered".
 */
```

## Note 003

Source: [cli/src/commands/bag.ts](../../cli/src/commands/bag.ts)

After a failed install, check whether declared dependencies actually exist before abandoning registration.

Original rationale:

```text
/**
 * Install a bag's npm dependencies, deciding success by MEASURING the result
 * rather than trusting pnpm's exit code.
 *
 * pnpm exits nonzero for conditions that leave a complete, loadable
 * node_modules behind — ERR_PNPM_IGNORED_BUILDS (a dependency ships a build
 * script nobody has approved) being the one that bit us: every dependency
 * resolved and linked, esbuild merely wanted `pnpm approve-builds`, and the
 * installer aborted claiming "the bag would load with missing dependencies"
 * — a state it never checked and which was not true (recommendation-checker,
 * 2026-09-17). Because it exited before registering, the bag was left
 * half-installed and `barry pack` then reported it as missing entirely.
 *
 * `bagNeedsInstall` is the actual measurement: deps declared, node_modules
 * absent. Consult it after a nonzero exit so a warning degrades to a warning
 * and only genuinely missing dependencies stop the install.
 */
```

## Note 004

Source: [cli/src/commands/bag.ts](../../cli/src/commands/bag.ts)

Resolve builtin registration paths relative to their owning directory rather than the caller’s CWD.

Original rationale:

```text
// The DB registry stores builtin paths relative to the builtin directory.
  // Resolved the same way the snapshot writer resolves them; checking the raw
  // value against the CWD instead made `barry pack <any-builtin>` report a bag
  // that plainly exists as missing (found packing point-guard, 2026-09-11).
```

## Note 005

Source: [cli/src/commands/config-export.ts](../../cli/src/commands/config-export.ts)

A missing shipped-bound catalog must fail rather than reclassify every builtin as user-authored.

Original rationale:

```text
/**
 * Export user-defined bounds (not among the bounds Barry ships).
 *
 * The builtin list is the only thing separating "the user wrote this" from
 * "Barry ships this", so an EMPTY list is not a benign default: it
 * reclassifies every builtin as user-defined, writes all seven into the
 * user's config, and a later import upserts them back as if authored there.
 * This used to fall back to `[]` when the file was missing -- and the file's
 * name changed during the Scope -> Bound rename, which is exactly the
 * circumstance that fallback would have swallowed. Fail instead.
 */
```

## Note 006

Source: [cli/src/commands/identity.ts](../../cli/src/commands/identity.ts)

Report manifest-to-service drift explicitly because an unprepared service can otherwise disappear silently.

Original rationale:

```text
/**
 * Declared services that are not prepared or not registered. A bag service
 * dropped from preparation stops existing without an error anywhere, which is
 * how every bag service went down unnoticed on 2026-10-06.
 */
```

## Note 007

Source: [cli/src/commands/vault-backup.ts](../../cli/src/commands/vault-backup.ts)

Show snapshot identity and item counts before restore so operators can compare the backup with the live vault.

Original rationale:

```text
/**
 * What a restore needs to know about a snapshot without opening it.
 *
 * `verify()` already computes `accounts`/`items`; before this they reached
 * only a console line (`db.ts`'s "N items, M accounts" summary) and were then
 * discarded. Persisting them beside the snapshot is what lets a restore say
 * "this is 3 accounts / 412 items from 2026-09-15; your live vault has 3 /
 * 501" — the comparison that stops a bad restore — instead of only "this file
 * parses as SQLite".
 */
```

## Note 008

Source: [cli/src/services/specs.ts](../../cli/src/services/specs.ts)

Retain previously prepared services when their bag manifest is unreadable; drop them only after a successful declaration change or registry removal.

Original rationale:

```text
/**
 * Prepared services a refresh keeps although no manifest declared them this time.
 *
 * A bag whose manifest cannot be read (it fails validation, or its directory is
 * gone) loads as a husk with no services, which looks exactly like a bag that
 * removed them. Treated as removal, a manifest schema change took down every bag
 * service on 2026-10-06: each bag's manifest failed the new schema, the refresh
 * prepared none of their services, and their launchd jobs were removed as
 * undeclared. A service is dropped only when its bag left the registry, or a
 * manifest that did load no longer declares it.
 */
```

## Note 009

Source: [sdk/src/bags/build.ts](../../sdk/src/bags/build.ts)

Use recorded build inputs instead of scanning native build trees on every launch; legacy bundles use the fallback scan.

Original rationale:

```text
/**
 * The files a bundle was built from, recorded beside it by `buildBag`, or null
 * for a bundle built before they were.
 *
 * Checking these instead of walking the bag is most of `barry`'s startup
 * back: a bag's tree can hold a whole native app (SwiftPM's `.build` alone is
 * 16,000+ files), and every launch walked all 119 registered bags — 7s of
 * stats for a bundle built from a few dozen files (2026-10-06).
 */
```

## Note 010

Source: [sdk/src/bags/tool-definitions.ts](../../sdk/src/bags/tool-definitions.ts)

Cache tool metadata by both bundle and contract-derivation stamps; source-only bags still import on each read.

Original rationale:

```text
/**
 * The tools a bag declares — name, namespace, access, contract hash — without
 * running its code when that can be helped.
 *
 * Loading a bag needs only this, and importing each bundle to read it compiled
 * ~100MB of JavaScript (and parsed ~180MB of source maps) on every launch:
 * about 7s of CPU for 72 bags (2026-10-06). So the summary is kept beside the
 * built bundle, stamped with the bundle it was read from: a rebuilt bundle is
 * imported once, an unchanged one never. A bag run from source (no build) is
 * imported every time, as before.
 *
 * The contract hash is here so access checks (`collectToolDefinitions`) need no
 * import either: hashing every bag's tools by importing them cost the same 7s
 * in each service that checks a grant. It is stamped with the code that
 * derives it as well as the bundle, since either changing moves the hash.
 */
```

## Note 011

Source: [bags/sessions/api/src/telemetry.test.ts](../../bags/sessions/api/src/telemetry.test.ts)

A regular-file parent guarantees ENOTDIR for every user, including root.

Original rationale:

```text
/**
 * A database path that cannot be opened by any user, including root.
 *
 * This used to be "/nonexistent-root-dir/nope/usage.db", which relied on the
 * process being unable to create a directory at the filesystem root. That
 * holds for a normal user but not for root, so both failure tests silently
 * passed on a developer's Mac and failed in CI's container, where uid 0 simply
 * created the directory and the write succeeded.
 *
 * Rooting the path under a regular FILE removes the dependency on privilege:
 * the parent is not a directory, so opening it is ENOTDIR for everybody.
 */
```

## Note 012

Source: [bags/sessions/api/src/telemetry.test.ts](../../bags/sessions/api/src/telemetry.test.ts)

Writers and dashboard readers must resolve the same active-generation usage store.

Original rationale:

```text
/**
   * The telemetry bag reads `<generation>/node/telemetry/usage.db` once a home
   * has store generations. Usage written to the pre-generation file instead
   * left every cost panel blind after the 2026-10-01 store migration.
   */
```

## Note 013

Source: [bags/telemetry/src/rules.test.ts](../../bags/telemetry/src/rules.test.ts)

Scale sample staleness to observed cadence so sleeping hosts do not hide sustained unavailability.

Original rationale:

```text
/**
   * The regression. A flat 15-minute bound rejected the real 2026-08-21..23
   * outage: the host was asleep, the collector ticked roughly hourly, and the
   * newest failing sample was 93 minutes old. Three days of total unavailability
   * were dismissed as a stale metric.
   */
```

