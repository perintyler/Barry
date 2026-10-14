# ADR 0042: Vault key custody and action records

## Context

The vault documentation referenced a removed future plan and retired schema files. Action-run comments described an implementation phase instead of current storage invariants.

## Decision

Keep the documented daemon-UID boundary and its client-key limitation explicit, without implying a removed plan implements stronger custody. Describe the current inline vault schema and checkable action-run records. Preserve full original passages below.

## Consequences

No security boundary, schema or action behavior changes. The hypothetical custody change remains a design direction, not completed work or an added review-program commitment.

## Preserved passages

### Original passage 1: bags/vault/README.md

```text
Closing that gap — moving key custody into the daemon's UID — is the local-broker
design in the multi-vault plan, since removed from this tree (Phase 6).
```

### Original passage 2: bags/vault/README.md

```text
The old app's SQL files
were not used by this inline vault implementation.
```

### Original passage 3: bags/actions/src/action-runs.ts

```text
/**
 * Action runs — one row per `begin_action` call.
 *
 * Phase 1 records that an action started and, when the agent calls
 * `complete_action`, that it finished. The row exists now so completion is a
 * checkable contract (a bogus run id errors instead of silently succeeding) and
 * so the validation runtime has a place to hang its verdict.
 *
 * Three things this store has to do by hand: serialise JSON columns
 * (better-sqlite3 refuses to bind an object), stamp timestamps as ISO text
 * (there is no SQLite `NOW()` equivalent that matches the column format), and
 * parse the JSON back on read.
 */

```

