# ADR 0032: SDK contract regression history

Status: accepted

## Context

SDK regression tests preserve registry authority, service/schedule separation,
path and domain bounds, explicit secret bindings, wire-format compatibility,
remote manifests and omission-safe session patches. Historical comments explain
why those assertions exist but must not describe obsolete code as current.

## Decision

Keep each current invariant next to its assertion or implementation, and preserve
the complete original comment below. Do not change executable behavior, emitted
code, tool inventories, manifest defaults or bounds verdicts in this comment pass.

## Consequences

The same assertions continue guarding the contracts. Historical package names
and failure descriptions remain available without becoming current dependencies.
These preserved explanations are historical evidence, not fresh reproductions.

## Original rationale: sdk/src/bags/__tests__/build.test.ts

```text
    // `barry install` runs this sweep over EVERY registered bag, so an
    // unparseable manifest belonging to some unrelated bag used to throw and
    // make the install look like it had failed — after registration had
    // already landed. One bad bag must not hide the good ones.
```

## Original rationale: sdk/src/bags/__tests__/launch-vocabulary.test.ts

```text
  // The whole design, exercised as one manifest: a supervisor its own tools
  // bootstrap, and the one-shot that used to masquerade as a service.
```

## Original rationale: sdk/src/bags/__tests__/registry.test.ts

```text
    // The YAML file used to stand in for the snapshot; it is a copy for people now.
```

## Original rationale: sdk/src/bags/manifest.ts

```text
  // Who decides when this starts. `login` (the default) means the machine
  // brings it up; `manual` means something else does, and Barry only installs
  // it ready to be started.
  //
  // This replaces `run-at-load` + `keep-alive`, which conflated two unrelated
  // questions — "what kind of thing is this" and "who starts it" — into two
  // booleans whose four corners a reader had to decode. `coffee.daemon`'s
  // `run-at-load: false, keep-alive: true` reads as a contradiction until you
  // find that the bag's own tools.ts bootstraps it.
  //
  // A service is by definition a thing that RUNS CONTINUOUSLY, so
  // restart-on-exit stops being a per-service choice: a service that exits has
  // failed. The one-shot `keep-alive: false` used to express belongs in
  // `schedules:` with `at: login` — see schedule-manifest.ts.
```

## Original rationale: sdk/src/bounds/bound-guards.test.ts

```text
  // A bound written as `~/.ssh/**` used to match nothing: candidates are
  // normalized to absolute paths before matching, so a literal `~` never
  // appears in one. The pattern is what gets expanded.
```

## Original rationale: sdk/src/bounds/bound-guards.test.ts

```text
  // "**/.ssh/**" means ".ssh at any depth". The directory branch used to strip
  // only the trailing "/**" and then match the rest literally, so the leading
  // "**/" never matched anything — the pattern silently denied nothing.
```

## Original rationale: sdk/src/bounds/tool-guards.ts

```text
        // Tools that take a URL parameter (WebFetch): apply domain rules per call.
        // Domain denial used to cover Bash only, so a denied host was still
        // reachable through the structured fetch tools.
```

## Original rationale: sdk/src/env/secret-bindings.test.ts

```text
  // The rename a bag manifest's `from:` used to do, now made where the source
  // is declared: the env file keeps the value under another consumer's name.
```

## Original rationale: sdk/src/logging/format.test.ts

```text
    // The whole bug in one assertion: the Workers emitter used to return null
    // here, for every line it ever wrote.
```

## Original rationale: sdk/src/mcp/__tests__/remote.test.ts

```text
    // {name, description, tools} used to fail validation for want of a
    // manifestVersion, and fell back to a degraded shape. With only one
    // manifest format there is no version to require, so it now parses — these
    // bags gain instructions support instead of losing it.
```

## Original rationale: sdk/src/sessions/types.test.ts

```text
    // A third-party adapter: well-formed, not shipped, no longer rejected
    // here. This is the line that used to expect `false`.
```

## Original rationale: sdk/src/sessions/types.test.ts

```text
  // A partial update must distinguish "leave traits alone" from "clear traits".
  //
  // `traits` carries a `.default([])` on the create schema, and `.partial()`
  // does not strip defaults — so this schema used to fabricate `traits: []` for
  // any PATCH that never mentioned traits. The handler treats a defined value
  // as intent and cleared the column, which wiped a session's grant on the
  // unrelated pid/name PATCHes that `barry start` sends right after recording
  // it. The session then had a browser MCP namespace serving zero tools.
```

## Original rationale: sdk/src/tools/__tests__/define-tool.test.ts

```text
    // Regression guard. The key used to be "@barry-rocks/tools/mcp-result",
    // which made renaming the package a SILENT wire break: an old bundled bag
    // mints an unrecognized key, isMcpResult returns false, and register.ts
    // re-serializes the result as plain text -- turning `isError: true` into a
    // success with nothing thrown. Renaming the package must not move the key.
```
