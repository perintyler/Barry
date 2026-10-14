# ADR 0021: telemetry polling and adapter regressions

Status: accepted

## Context

Telemetry staleness and dashboard polling constrain different resources. An alert
must be evaluated, and adapter configuration regressions must exercise the actual
tracker and MCP shapes. Historical explanations are retained with their decisions.

## Decision

Bound inferred staleness while retaining the fifteen-minute minimum. Pause polling
for hidden tabs and back off failures without shortening the base interval. Test
alert evaluation rather than declaration alone. Keep Cursor tracker hooks present
when a directory is absent and require equivalent OpenCode MCP configuration for
command strings and arrays. Preserve full historical rationale below.

## Consequences

Sampling cadence and tab visibility remain explicit. Regression tests continue to
cover real evaluator/configuration outputs. This changes comments only and retains
JSDoc parameter and return types; historical monitor and review references below
are context, not newly measured deployment behavior.

## Historical source rationale

### bags/telemetry/src/rules.ts

```text
/**
 * Floor and ceiling on how stale a point may be before a rule ignores it.
 *
 * The floor is the 15 minutes every guard used to hardcode, so a fast-sampling
 * series is judged exactly as strictly as before.
 */
```

### bags/telemetry/web/spark.js

```text
/**
 * Run `refresh` immediately, then on an interval, paused while the tab is not
 * visible. Replaces the `refresh(); setInterval(refresh, N);` every page here
 * used to write for itself.
 *
 * Every page here polls its own API route on a fixed interval regardless of
 * whether anyone is looking — a backgrounded tab kept firing the same
 * queries as a foregrounded one, for a user who is not going to see the
 * result until they come back anyway. `document.visibilityState`
 * is the standard signal for "is this tab actually on screen"; pausing on it
 * is the same "why poll a tab nobody's looking at" logic F13 landed for
 * services polling in the main barry repo.
 *
 * Also backs off on repeated failures — `refresh` throwing (a network error,
 * the dashboard's own server being down) no longer retries at the same 15-60s
 * cadence indefinitely; the interval doubles up to `maxIntervalMs` and resets
 * to `intervalMs` on the next success. This is deliberately NOT retried faster
 * than the base interval — this is a dashboard, not a queue consumer, and a
 * hammering retry loop against a server that is already struggling is the
 * wrong failure mode.
 *
```

### bags/telemetry/src/rules.test.ts

```text
    // End-to-end against the shape Axiom's error-spike monitor used to catch.
    // Written because the rule did NOT fire the first time it was exercised —
    // a rule that is merely declared is not a rule that works.
```

### adapters/sessions/cursor/src/workspace.test.ts

```text
      // hooks.json is written unconditionally: it used to be gated on a
      // hooks/ directory existing, which meant deleting that directory
      // silently took the bag-declared trackers with it.
```

### adapters/sessions/opencode/src/mcp-config.test.ts

```text
  // The CLI reads this config from JSON on disk, where `command` may already be
  // an array; the runtime provider passes a typed string. Both spellings must
  // land on the same OpenCode config, since that divergence is precisely what
  // having two copies of this translation used to hide.
```
