# ADR 0020: session route and cache invariants

Status: accepted

## Context

Action discovery, detached-run settlement, lightweight session reads and live
bound invalidation serve different callers. Historical implementation stories
can obscure current behavior, especially when action metadata evolves.

## Decision

Expand composed identity bags in the action list and report resolution scope.
Persist settled output even when a detached run outlasts the caller's wait.
Bypass enrichment for ID-only liveness reads, coalesce concurrent picker rebuilds,
and let the owning session API re-evaluate live sessions with an actual result count.
Keep concise invariants in source and preserve the original explanations below.

## Consequences

Action resolution errors remain distinguishable from empty configurations.
Detached completion is recorded independently of caller lifetime. Liveness probes
avoid unnecessary enrichment, and live capability changes have a countable result.
This changes comments only. Historical references and metadata descriptions below
are archived context, not the current public protocol or new measurements.

## Historical source rationale

### bags/sessions/api/src/routes/actions.ts

```text
/**
 * GET /actions/catalog — what can be run, for a trigger UI.
 *
 * Scoped to the ACTIVE IDENTITY's bags, because triggering an action whose bag
 * the identity has not packed fails in the worst available way: the session
 * starts, the agent reads a prompt telling it to call tools it was never
 * granted, and the run LOOKS like it succeeded while doing nothing. Listing
 * only what can actually run is what makes the trigger UI honest.
 *
 * This is narrower than it was. The endpoint used to list every installed
 * action on the reasoning that "a GUI has no session, so the MCP layer is the
 * real enforcement". MCP is still the real enforcement — which is why this
 * filter is an honesty measure and not a security boundary — but a catalog
 * that offers what it cannot run pushes the failure to the one place it is
 * invisible.
 *
 * Composition is expanded rather than read from the stored list, mirroring
 * session-runtime: a bag's manifest `bags:` children reach the session even when
 * only the parent is packed, so an action from a sub-bag IS runnable and must
 * be listed. Reading `metadata.bags` raw would hide those.
 *
 * `scope` reports which of the two happened, and exists because the empty case
 * is otherwise unreadable: an identity with nothing packed and a catalog that
 * failed to resolve one both return zero actions. A client that cannot tell
 * those apart renders a broken install as an empty one.
 *
 * `executable` marks the actions the generated instruction runs detached with
 * `run_action` (`context: none` + an output schema). The rest run inline in a
 * session, which is why the trigger seeds a session rather than calling the
 * executor.
 */
```

### bags/sessions/api/src/routes/actions.ts

```text
      /**
       * Record a settled run's output and verdict on its row, and answer what
       * the caller is told. Shared by the blocking path and the `wait_s`
       * continuation: a run that outlasted its caller's wait settles with
       * nobody awaiting it, and used to leave its row `started` until the
       * sweep closed it as abandoned, output and all lost.
       */
```

### bags/sessions/api/src/routes/sessions.ts

```text
  // A caller that only wants "which session ids are currently active" — the
  // locks liveness probe is the motivating case, hitting this route on every
  // edit-lock acquisition — used to pay for the full enrichment (message
  // activity, latest progress event, camelCase serialization for every field)
  // just to read `.id` off each row. `fields=id` skips straight to that.
```

### bags/sessions/api/src/routes/sessions.ts

```text
// Single-flight: concurrent misses during a cold window used to each run the
// full session fan-out and git resolution; now they share one rebuild.
```

### bags/sessions/api/src/routes/sessions.ts

```text
/**
 * POST /sessions/invalidate-tools — re-scope live sessions on an identity.
 *
 * When an identity's grants change, sessions already running on it must pick up
 * the new toolset without a reconnect. The identity routes used to do this by
 * dynamically importing session-runtime and walking the active sessions
 * themselves; that only works while both halves share a process, and this API is
 * being split. The loop lives here, with the runtime that owns it, and the
 * caller reaches it the same way it already reaches the engine's /refresh-tools.
 *
 * Returns the count it actually invalidated. A caller that gets 200 and zero is
 * looking at a real answer — "no live session on that identity" — rather than a
 * silent no-op, which is how the two bugs guarded below both presented.
 */
```
