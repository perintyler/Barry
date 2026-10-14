# ADR 0045: auto-trait eligibility and packed bag names

Status: accepted

## Context

The original review names auto-trait comments for the source audit. The actual CLI acceptance fixture also demonstrated that a packed service-only bag can have no generated trait. The existing header incorrectly says every bag receives two traits, and the root-name helper cannot establish that a trait exists. Full original comments are preserved below.

## Decision

Describe the generation predicate beside the implementation: namespaces or skills produce the main trait and readonly twin; service-only and action-only bags can omit auto-traits. The root-name helper supplies eligible names, which consumers must check against the actual trait catalog. Keep readonly's session-wide restriction and transitive composition explicit.

## Consequences

This comment-only correction changes no executable behavior or exports. Step 04 owns the CLI all/read selection follow-up and its actual registry/store regressions. Stored identity-grant validation remains Step 17's responsibility; these comments are not evidence of that behavior already being fixed.

## Preserved original comments

### 1. sdk/src/traits/auto-traits.ts

```text
/**
 * Auto-generate traits for bags.
 *
 * Every bag gets two auto-traits:
 * - {bag-name}: all bags and namespaces, readwrite
 * - {bag-name}:read: includes {bag-name} and carries the `readonly` bound
 *
 * The read twin restricts by bound, not by `access`: the grant is the main
 * trait's, and the bound denies writes. Bounds merge across a session, so
 * selecting `{bag-name}:read` makes the whole session read-only — the same
 * restriction as `barry start --read`, scoped to one bag's tools. It lives in
 * the bag's own policy namespace (`{bag-name}:`), so no two bags can collide
 * on it, and a manifest trait named `read` overrides it.
 *
 * Composition: a bag that lists children in its manifest `bags:` gets "all
 * the stuff" — when a registry map is supplied, the parent's auto-trait
 * absorbs every sub-bag's namespaces and skills, transitively, so a session
 * granted the parent trait sees the children's tools without the children
 * re-declaring anything.
 */
```

### 2. sdk/src/traits/index.ts

```text
/** Packed bags that carry their own trait. */
```
