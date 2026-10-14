# ADR 0002: Test store isolation

## Context

Missing test configuration can resolve an instance's real SQLite stores. Opening a store can create or migrate it before any test assertion runs, so naming conventions and test configuration alone cannot protect user data.

## Decision

Under Vitest, enforce scratch locations at the store-opening boundary. Resolve existing ancestors to reject symlinks into persistent storage. Shared test configuration also supplies a disposable instance with unreachable service ports; tests needing live services create their own fixtures.

## Consequences

A misconfigured suite fails before opening persistent stores. This protects new packages and direct store imports even when they omit shared test configuration. Production store paths are unaffected.
