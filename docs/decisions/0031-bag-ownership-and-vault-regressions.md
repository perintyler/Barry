# ADR 0031: bag ownership and vault failure distinctions

Status: accepted

## Context

Apps own their client builds; bags own storage and tool contracts. Cross-store
sweeps cannot infer termination from a missing session. Vault fixtures must
represent the daemon's unauthenticated salt route and preserve distinct failures.

## Decision

State current ownership and failure invariants beside the code. Preserve the
complete historical explanations below. Keep executable regression assertions,
SQL, retry limits, generated manifests and permission behavior unchanged.

## Consequences

Comment moves preserve historical reasons without treating old measurements or
package names as current interfaces. Vault rate limiting stops login before
salt-dependent decryption, and permission failures stay distinct from reachability.

## Original rationale: bags/actions/src/action-runs.test.ts

```text
/**
 * The two halves the abandoned-run sweep is built from.
 *
 * The sweep itself does not live here. It used to be one statement joining
 * `action_runs` to `sessions`, and that stopped being possible when sessions
 * moved to SQLite -- and is doubly so now that action runs are in a THIRD
 * file. The decision lives in `@barry-rocks/sessions`, which depends on both
 * stores; its suite pins the liveness logic.
 *
 * What remains here is SQL, so it is still tested against a real database: a
 * TypeScript-only test would pass with either query written backwards.
 */
```

## Original rationale: sdk/src/vault/client.test.ts

```text
    // The real salt route is unauthenticated and never 401s; only the login
    // does. (This fake used to 401 everything, which getSalt now rightly
    // refuses to paper over — so the fake answers the salt like the daemon.)
```

## Original rationale: sdk/src/vault/client.test.ts

```text
  // A 429 used to surface as a missing credential. The client now waits and
  // retries, so a burst of secret reads survives the daemon's limiter.
```

## Original rationale: sdk/src/vault/client.test.ts

```text
    // The salt lookup gets 1 try + 2 retries, then the login STOPS. It used to
    // carry on to /api/auth/api-key with a guessed (email-only) salt, turning
    // the rate limit into a decryption failure three requests later.
```

## Original rationale: sdk/src/vault/client.test.ts

```text
    // What a caller outside the _barryvault group sees. It used to read exactly
    // like a daemon that is not running.
```

## Original rationale: bags/events/bag.yaml

```text
# No `bags:` or `apps:` entry for events-macos. The windowed app used to be
# declared here, on the reasoning that a sub-bag's app belongs to the bag that
# owns the surface. It is its own repo now — events-macos, under the events-ui
# umbrella — and declares its own build and URL scheme there. This bag owns
# the event store, `record_event`, and the feed's contract.
```

## Original rationale: bags/identities/bag.yaml

```text
# No `apps:` block. BarryIdentities is its own repo now — identities-macos,
# under the identities-ui umbrella — and declares its own build there. This bag
# owns the identity store, its traits and its tools; the app is a client.
#
# The description above changed with it: it used to describe the WINDOW ("a
# windowed app for creating and configuring identities"), which stopped being
# true of this bag the moment the window left.
```

## Original rationale: bags/events/README.md

```text
This bag holds `record_event` and its tools. The store itself is
`src/store.ts` (it used to live in the old shared db package, which is
dissolved), schema and migrations are in `src/db.ts`, and the contract schema —
the closed enum described above — is in `sdk/src/events/index.ts`.
```
