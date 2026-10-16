# ADR 0047: prepare the requested hosted session eagerly

Status: accepted

## Context

An identity CLI built a guest harness configuration even for hosted launches, and the server deferred the Claude subprocess and its initialize handshake until the first message. A prompt could appear before the session was ready to answer.

## Decision

Prepare the exact session after its traits, provider, model and mode are recorded. `POST /sessions/{sessionId}/prepare` is idempotent; hosted pending creates also schedule preparation so a CLI that exits immediately cannot lose the handoff. `Session.warm()` opens the Claude streaming link through the Agent SDK's `startup()` and resolves after initialization. Concurrent preparation and delivery share the same opening promise. Failure leaves the session available for a cold retry.

Do not keep a per-identity pool of unassigned processes: MCP URLs, permission decisions, working directories and plugins belong to the requested session. Cache identity environments in the API for five minutes and MCP for 90 seconds, with immediate invalidation after mutations in the same process and TTL freshness across processes. Credential bag connections run four at a time and retain input order.

## Consequences

Prepared sessions rest in `waiting`, making them eligible for the resident budget's existing eviction policy. `started_at` records the first turn. Unused sessions expire after 15 minutes without a UI subscriber or renderer; closing the last UI starts the idle clock. Eviction closes the process and deletes a message-less row without a directive. Session lists exclude message-less drafts.

An unused session whose model, provider or working directory changes drops its resident configuration without ending its durable row, then prepares again. Trait changes invalidate and rewarm the harness. Generation checks prevent a stopped preparation from publishing readiness or keeping its assets.

`BARRY_TIMING=1` reports startup work separately from a warm first turn. Message headers and WebSocket timing metadata show `warm=1` without harness creation or readiness stages when preparation finished before admission. `/health` and `/health/live` report the process's boot-time release metadata and sessions schema version for launch-time build checks.

## Streaming process and prompt-cache policy (0049)

Hosted Claude processes now retain a 30-minute idle lease, renewed by subscriber activity. `BARRY_CLAUDE_IDLE_RELEASE_MS` can tune the resource tradeoff. Identity adapter `promptCacheTtl: 5m | 1h` sets `CLAUDE_CODE_PROMPT_CACHE_TTL`; leaving it unset preserves vendor defaults. A one-hour cache can improve repeated-turn cache hits but uses the vendor's longer-retention cache-write pricing. Choose it per identity after checking usage/cache-read measurements. No dynamic system-prompt sections are excluded by default.
