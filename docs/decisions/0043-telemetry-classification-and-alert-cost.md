# ADR 0043: telemetry classification, alerts and full tick cost

Status: accepted

## Context

Telemetry comments retain incident measurements explaining process-classification order, concurrent notifications, full tick timing and alert thresholds. Those measurements are historical observations, rather than current machine guarantees. The complete source explanations are preserved below.

## Decision

Keep current controlling invariants beside executable code: classify session binaries before argument paths; identify automation browsers without ordinary browser processes; exclude resident daemons from subprocess leaks; dispatch notifications concurrently; measure the entire tick by mode; and distinguish service crashes from scheduled jobs and clean redeploys. Preserve thresholds and all executable behavior.

## Consequences

Operational comments describe the present algorithm without claiming prior host measurements remain representative. These historical explanations remain available for future changes. Compiler-output comparison verifies this move changes no executable behavior.

## Preserved original explanations

### 1. bags/telemetry/src/collect.ts

```text
  // Automation browsers only. Matching /chrome/i would sweep in the user's own
  // Google Chrome — measured at 46 of 50 matches on this machine — and report
  // their everyday browsing as a Barry leak. The leak that actually happened
  // was a headless chrome-devtools-mcp at 4.3GB, and every such binary lives
  // under a driver's cache path or names itself headless.
```

### 2. bags/telemetry/src/collect.ts

```text
  // An npx/uvx-launched MCP SERVER is not a leak candidate: it is a long-lived
  // child of the MCP host and is supposed to outlive any single tool call, so
  // age says nothing about it. `uvx temporal-mcp-server` sat at 103h and fired
  // subprocess-leak every time the host had been up that long — a true reading
  // of the wrong thing. Same for the esbuild --service worker, which is a
  // resident compile daemon by design.
  //
  // What the alert is actually for is a subprocess spawned to do one job that
  // then never exits. Those are still caught: a browser-automation binary is
  // classified above, and anything else npx/uvx launches still lands here.
  // BEFORE any mcp pattern. A session's argv carries
  // `--mcp-config .../barry-mcp-XXXXXX/mcp.json`, which an `-mcp\b` substring
  // rule matched: all 14 live sessions were counted as `mcp-server` and their
  // RSS summed there, reporting 16 servers / 2,521MB against ONE real server at
  // 18MB. Classify by the binary being run, never by a path in its arguments.
  //
  // Matched on the BINARY (argv[0] is `claude`, or a path ending in `/claude`),
  // not on a flag. The previous rule required `claude --dangerously`, so a
  // session started without `--dangerously-skip-permissions` was invisible to
  // every children metric — and the flag is optional, so "no sessions running"
  // and "sessions running without that flag" looked identical. A trailing `\b`
  // rather than end-of-string because the binary is always followed by args.
```

### 3. bags/telemetry/src/sampler.ts

```text
  // Every alert and recovery is dispatched CONCURRENTLY. These were two
  // sequential `for` loops each awaiting one notify, so N alerts cost N full
  // sends end to end and the recovery loop queued behind all of them. At the
  // 53.4s-per-send measured on a thrashing host, a handful of simultaneous
  // alerts ran for minutes inside a job whose own `sampler-expensive` rule
  // trips at 10s — the tick that reports the problem was itself lengthened by
  // the problem.
  //
  // Recoveries go in the same batch rather than after: they are Slack-only and
  // cheap, and making an all-clear wait on an unrelated alert's SMS is how the
  // channel loses track of what is currently true.
```

### 4. bags/telemetry/src/sampler.ts

```text
  // The honest cost of this job, written LAST so it covers everything above:
  // collection, the write, rule evaluation, notification and maintenance.
  //
  // `samplerMs` brackets `sample()` alone and therefore could not see the part
  // that actually got slow. It averaged 2.3s while jobs.db recorded 26.4s for
  // the same job, peaking at 441s against a 60s interval — so launchd started
  // the next tick while this one still ran, and the store accumulated 479
  // duplicate (labels, ts) pairs from concurrent samplers writing the same
  // reading twice.
  //
  // Written on EVERY live tick, including a dry run's absence of alerts, for
  // the same reason the notify metrics are: a series that is empty when things
  // are quiet cannot be told apart from a sampler that stopped running.
  //
  // Labelled by mode like `samplerMs`, because the heavy sweep legitimately
  // takes tens of seconds and sharing one series would either alarm on every
  // sweep or set the ceiling so high a light tick could never trip it.
```

### 5. bags/telemetry/src/rules.ts

```text
    // 3, not 4: three restarts in an hour is already a loop. The limit is
    // compared with >=, unlike the threshold rules, because a restart COUNT is
    // discrete — "more than 3" would quietly mean "at least 4" and disagree
    // with the dashboard, which flags at 3. That mismatch shipped once: the UI
    // showed three services in red while the alerting said nothing was wrong.
```

### 6. bags/telemetry/src/rules.ts

```text
    // Resident services only. A 60s interval job increments the same counter
    // every 60s by design — the sampler alerted on ITSELF minutes after being
    // installed, which is exactly the kind of self-inflicted noise that
    // teaches you to ignore the channel.
```

### 7. bags/telemetry/src/rules.ts

```text
    // A restart count alone cannot tell a crash loop from a redeploy, and this
    // fired for days on mcp.server because rebuilding the bundle and running
    // `barry service restart` is indistinguishable from crashing — by count.
    // By exit code it is not: the mcp redeploys all recorded lastExit 0, while
    // the API crash loop this rule was written for recorded 1. launchd reports
    // the last exit of the PREVIOUS instance, which is exactly the question
    // "did it stop cleanly?".
```

### 8. bags/telemetry/src/rules.ts

```text
    // 20 errors in an hour from ONE service. Barry's steady state is ~200
    // errors a DAY across every service, so this is roughly an order of
    // magnitude above normal for a single one — high enough not to fire on the
    // 409s that are always trickling, low enough to catch a service that has
    // started failing every request.
```
