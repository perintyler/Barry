# ADR 0007: Telemetry schedule cadence

## Context

Manifest comments had drifted between adjacent schedules and described intervals different from their cron expressions. Historical service names and migration counts also obscured the current operating contract.

## Decision

Keep schedule-specific reasons beside the actual cron. Preserve the previous manifest below as historical context; it is not a current configuration example. No cron, timeout, secret or other configuration value changes.

## Consequences

Sample every minute; measure footprint every five minutes; ingest requests every ten minutes, all logs every two minutes, and errors every five minutes offset by one minute; recover transcripts and sweep hourly on separate offsets. Manifest configuration remains authoritative.

## Previous manifest

```text
name: telemetry
# Renamed from `metrics` 2026-09-16. The bag outgrew the name: it holds four
# stores (metrics, logs, errors, requests), a correlation view across them, and
# a registry other bags contribute to.
#
# The directory has since moved into the barry repo (it was ~/repos/bags/metrics).
# The service's name is derived from the bag's, so it became telemetry.web, and
# anything keyed on it has to follow; the names it is published under are the
# installation's hosting policy and did not change with it.
#
# jobs.db rows were migrated with the rename (11,970 across 7 jobs). Leaving
# them would have split every job's history and started the proposed
# `job-overrun` rule with an empty baseline -- a duration history reading "no
# overruns ever" because there is no data.
description: Resource telemetry for Barry itself — samples, stores and alerts on
  the things that have broken this machine

# Every collector shells out to a macOS tool. Declared so `bag doctor` reports a
# missing one instead of the collector silently recording nothing.
#
# Declared as ABSOLUTE paths, matching the BIN map in src/collect.ts — because
# that is what the code actually runs. These were once declared as bare names,
# which made the check answer a question the collectors do not ask: whether the
# tool is on PATH. It is not, for two of them (/usr/sbin is missing from
# launchd's PATH), and pinning absolute paths is exactly how the swap and
# port-ownership collectors were fixed after that silently blanked them. A bare
# declaration reported those two as unreachable while they worked perfectly.
#
# An absolute path is checked directly rather than searched for, so this stays
# honest no matter what PATH the checking process happens to have.
dependencies:
  lsof:
    bin: /usr/sbin/lsof
    reason: identifies which process actually owns a service's port
  ps:
    bin: /bin/ps
    reason: one batched process table per tick, for resource use and subprocess
      attribution
  du:
    bin: /usr/bin/du
    reason: sizes of the instance's data, logs, cache and trash, which grow until
      something prunes them
  sysctl:
    bin: /usr/sbin/sysctl
    reason: host swap and load, the only honest memory signal under pressure
  vm_stat:
    bin: /usr/bin/vm_stat
    reason: page-level memory breakdown behind the swap signal
  top:
    bin: /usr/bin/top
    reason: per-process CPU sampled in one batch per tick
  bash:
    bin: /bin/bash
    reason: runs the notification script (notify.ts)

services:
  # The dashboard.
  web:
    description: Metrics dashboard — service health, resource trends and firing alerts
    entry: src/server.ts
    working-directory: .
    serves: http
    health: /health
    # Read-only handles on the local SQLite stores (see src/usage/stores.ts):
    # the usage panels query Barry's own stores directly. The secret is what
    # a request must carry, as a bearer token or a signed-in browser's cookie.
    secrets: [BARRY_SECRET]

schedules:
  sample:
    cron: "* * * * *"
    timezone: UTC
    traits: [ bash, telemetry ]
    action:
      # Metric provenance labels keep concurrent collectors distinct.
      description: Collect Barry resource metrics and evaluate alert rules
      run:
        command: /usr/bin/env
        args: [ "node", "--import", "tsx", "scripts/sample" ]
        working-directory: .
      secrets:
        # The API requires a bearer token on /api/v1/* — only /health is
        # anonymous. Two things here need it: the record-hook collector scraping
        # /events/hook-counters, and the alert recorder POSTing /events. Without
        # it both fail closed (collectorOk=0, "BARRY_SECRET not set") rather than
        # reporting anything false, which is correct but silent — this is what
        # makes them actually work.
        - BARRY_SECRET
      # Real memory footprint, on its own cadence. One `top` costs ~2.5s: too much
      # for the 60s tick, whose own sampler-expensive rule fires at 10s, and too
      # valuable to defer to the hourly sweep — a virtualization helper process grew
      # from 292MB to 6GB inside a single hour. 2.5s per 300s is a 0.8% duty cycle.
      #
      # This is what `ps` RSS could not see: RSS reported mcp.barry at 44MB against
      # a real 694MB, and a VM host process at 292MB against 4.6-6.1GB.
      timeout: 5m

  footprint:
    # Request logs are not durable: the supervisor rotates a service's log once it
    # passes 10MB and keeps only a few rotations. Ingesting every 10 minutes keeps
    # history that the files themselves will lose.
    cron: "*/5 * * * *"
    timezone: UTC
    traits: [ bash, telemetry ]
    action:
      description: Sample real per-process memory footprint, which RSS understates
      run:
        command: /usr/bin/env
        args: [ "node", "--import", "tsx", "scripts/sample", "--footprint" ]
        working-directory: .
      timeout: 10m

  ingest-requests:
    # Every log line, at every level, not just warn/error.
    #
    # Measured before building: 99.6% of lines are level 30, so this is ~270x the
    # volume ingest-errors handles -- ~186,000 rows/day against the 691/day above
    # level 40. It is affordable only because it reads by byte offset rather than
    # re-reading whole files, and because retention is per level (errors 30 days,
    # warn 14, info 3, debug 1) rather than one horizon for all of them.
    #
    # 120s rather than 300s: at this volume a longer interval means a larger read
    # per pass, not less work overall, and the store is the one you reach for
    # while something is happening.
    cron: "*/10 * * * *"
    timezone: UTC
    traits: [ bash, telemetry ]
    action:
      description: Copy request logs into the local store before they are truncated
      run:
        command: /usr/bin/env
        args: [ "node", "--import", "tsx", "scripts/ingest-requests" ]
        working-directory: .
      timeout: 5m

  ingest-logs:
    # Errors ride the same constraint as requests — the files are truncated at
    # an incident, and a 10-minute-old answer is the wrong one when you are
    # watching whether a fix took. It also publishes barry.errors.count, which
    # the error-spike rule reads, so the interval bounds alert latency too.
    cron: "*/2 * * * *"
    timezone: UTC
    traits: [ bash, telemetry ]
    action:
      description: Copy every service log line, at every level, into the local logs store
      run:
        command: /usr/bin/env
        args: [ "node", "--import", "tsx", "scripts/ingest-logs" ]
        working-directory: .
      timeout: 5m

  ingest-errors:
    # Cost is recovered from the vendor CLI's transcripts rather than intercepted:
    # `barry start` spawns the vendor binary with inherited stdio, so Barry never
    # sees the token counts as they happen. Hourly because the files only grow as
    # sessions run, and 147 of 429 recorded paths are already gone — the vendor
    # prunes them, so waiting longer loses history outright.
    cron: "1-59/5 * * * *"
    timezone: UTC
    traits: [ bash, telemetry ]
    action:
      description: Copy warn/error events into the local store, and publish their counts
      run:
        command: /usr/bin/env
        args: [ "node", "--import", "tsx", "scripts/ingest-errors" ]
        working-directory: .
      timeout: 5m

  ingest-transcripts:
    # The heavy tick: adds directory walks and runs retention. Hourly because `du`
    # over the instance's data walks gigabytes — far more expensive than every
    # other collector combined, and disk moves slowly enough that a
    # minute-resolution answer would be pure waste.
    cron: "17 * * * *"
    timezone: UTC
    traits: [ bash, telemetry ]
    action:
      description: Recover token usage and cost from the vendor CLI transcripts
      run:
        command: /usr/bin/env
        args: [ "node", "--import", "tsx", "scripts/ingest-transcripts" ]
        working-directory: .
      timeout: 30m
    # Still reads the session store through the retired database URL variable and
    # exits early without it — recorded as remaining work in
    # DEFERRED-USAGE-QUERIES.md. No env passthrough until that port lands;
    # handing it the variable would only trade a clean early exit for a
    # connection refusal.

  sweep:
    cron: "37 * * * *"
    timezone: UTC
    traits: [ bash, telemetry ]
    action:
      description: Sample with directory sizes, then roll up and prune old metrics
      run:
        command: /usr/bin/env
        args: [ "node", "--import", "tsx", "scripts/sample", "--heavy", "--maintain" ]
        working-directory: .
      timeout: 30m

stores:
  metrics:
    owned_by: node
    engine: sqlite
    migrations: ./migrations/metrics
  requests:
    owned_by: node
    engine: sqlite
    migrations: ./migrations/requests
  errors:
    owned_by: node
    engine: sqlite
    migrations: ./migrations/errors
  usage:
    owned_by: node
    engine: sqlite
    migrations: ./migrations/usage
```
