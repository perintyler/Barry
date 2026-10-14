# ADR 0015: verification and socket invariants

Status: accepted

## Context

Hosting configuration belongs to each installation, adapter packaging invokes
external registry operations, and Codex control sockets have a platform path limit.
Source comments carried historical rationale alongside the current requirements.

## Decision

Keep core hosting vendor-neutral with precise, live exceptions. Bound registry
installs and adapter probes with an overridable timeout. Test Codex socket paths
using short, ordinary and long session IDs. Move the original explanations below
and leave concise invariants at the implementation sites.

## Consequences

Checks remain scoped and bounded; provider policy stays outside core. The socket
regression continues to cover varied IDs. This changes comments only; historical
measurements below are preserved evidence, not fresh measurements.

## Historical source rationale

### .github/ci/checks/vendor-neutral.mjs

The full original header is preserved in the review program's historical source archive, kept outside the repository. It names historical installation providers; the current invariant above keeps provider policy outside core.

### .github/ci/checks/adapter-packages.mjs

```text
/**
 * No command may run unbounded: an npm install against a slow registry, or a
 * probe whose adapter waits on something, used to hold the check open with no
 * output until someone killed it. Overridable for a slow network.
 */
```

### adapters/sessions/codex/src/runtime.test.ts

```text
    // The regression this guards: CODEX_HOME used to be built from
    // `~/Library/Application Support/Barry/adapters/codex/sessions/<session id>`,
    // which on a real 21-char nanoid session id produces a control socket path
    // of 135 bytes — codex then fails with "path must be shorter than SUN_LEN"
    // because that exceeds the ~104-byte limit AF_UNIX enforces. A short,
    // long-session-id-input barely mattered: even a 1-character id left the
    // fixed prefix/suffix alone over budget. Covering a short id, a realistic
    // 21-char nanoid, and a pathologically long one proves the fix holds
    // regardless of what the caller passes in, not just for today's id shape.
```
