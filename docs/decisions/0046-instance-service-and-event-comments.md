# ADR 0046: instance, service and event comment audit

Status: accepted

## Context

The original named-file audit still found historical prose in instance command paths, service aliases, startup validation and the events README. The test-config example named an obsolete relative path. The events comparison also incorrectly equated a retained session id in another database with ON DELETE SET NULL. Complete originals are preserved below.

## Decision

State current ownership and data semantics: redirected instances own their command directories; MCP uses its registry key; startup rules are a subset of environment configuration; packages extend the tracked test defaults; and independent event records retain their original attribution after a session disappears. Keep current implementation unchanged.

## Consequences

These comments no longer claim a dated compatibility window, a complete environment inventory or a nonexistent cross-database constraint effect. This is a source-comment and historical-prose correction, not a lifecycle or schema behavior change. CLI and event consumers retain their existing interfaces.

## Preserved original comments and prose

### 1. sdk/src/services/config.ts

```text
/**
 * The MCP server's service key: the `mcp` bag's `server` service. It was
 * `barry.mcp`, a spec hard-coded outside every bag; `barry service` still
 * accepts that name for one release.
 */
```

### 2. sdk/src/services/validate.ts

```text
/**
 * All known Barry environment variables and whether they're required.
 *
 * "always"   — the service refuses to start without it
 * "optional" — nice to have, never blocks startup
 */
```

### 3. cli/src/lib/identity-shims.ts

```text
/**
 * The commands directory of an instance under `BARRY_HOME`, or null for the
 * machine's own instance.
 *
 * `BARRY_HOME` moves every directory an instance owns under one root, and its
 * commands belong there too: a dev instance's setup used to write `barry` and
 * every identity shim into the PATH directory the installed instance uses,
 * repointing the real `barry` at a worktree.
 */
```

### 4. vitest.base.config.ts

```text
/**
 * Shared vitest defaults. Packages extend this via `mergeConfig` in their own
 * vitest.config.ts so the include glob and common settings live in one place:
 *
 *   import { mergeConfig } from "vitest/config";
 *   import base from "../../vitest.base.config.ts";
 *   export default mergeConfig(base, { test: { ... overrides ... } });
 */
```

### 5. bags/events/README.md

```text
Events are the **single source of truth for progress**. They replaced an
overwrite-based pattern that wrote status into `sessions.metadata`; nothing is
mirrored there anymore. An append-only log keeps the history that overwriting
destroyed.
```

### 6. bags/events/README.md

```text
instance has its own, so a contributor instance does not write the feed the
installed instance's menu bar is showing. It lived in a shared database until 2026-09;
`src/db.ts` holds the migrations and a one-time import script moved the old
rows.
```

### 7. bags/events/README.md

```text
`session_id` is a plain nullable column with **no foreign key** — the sessions
live in a different database now, so there is nothing for SQLite to reference.
The effect the old `ON DELETE SET NULL` had is therefore the default: deleting a
session **orphans but preserves** its events, and nothing cascades.
```
