# ADR 0022: SDK authentication and logging invariants

Status: accepted

## Context

SDK log formats, request paths, namespace labels and token status must match their consumers. Historical repair narratives explain these contracts but obscure the current controlling invariants.

## Decision

Keep numeric log levels and millisecond timestamps compatible with the shared parser. Capture original request paths before routing and template them to bound field cardinality. Tag vendor tools only on the aggregate endpoint. Bind environment aliases at their declared secret source and require unexpired OAuth tokens. Preserve original rationale below.

## Consequences

The source states its current contract; the complete historical explanations remain available here. This pass changes comments only and makes no new claim about historical production measurements.

## Historical source rationale

### sdk/src/logging/emit-edge.ts

```text
    // Built from the format module, NOT by hand. `level` is the NUMBER
    // parseLine expects and the timestamp key is `time`, in milliseconds —
    // the two things the old hand-built shape got wrong, which is why every
    // line from this emitter was discarded. `name` mirrors what pino writes.
```

### sdk/src/identities/secrets.ts

```text
  // `key` reads a differently named entry, for a value the env file keeps under
  // another name (another consumer reads it there): the rename a bag manifest's
  // `from:` used to do, now made where the source is declared.
```

### sdk/src/bounds/index.ts

```text
/**
 * Barry's own namespaces, as opposed to a vendor's.
 *
 * This no longer decides which namespaces get their own `/mcp/ns/<namespace>`
 * endpoint — every namespace does, which is what gives the agent
 * `mcp__linear__*` and `mcp__git__*` instead of one flat `mcp__barry__*`.
 *
 * Its only remaining job is cosmetic: on the aggregate `/mcp` endpoint, where
 * everything really does share the `mcp__barry__` prefix, vendor tools get a
 * `[Linear] ` tag on their description to show where they came from. Tagging
 * Barry's own tools there would be noise.
 */
```

### sdk/src/bounds/index.ts

```text
  // The shell/host bag `system` was dissolved: its shell tools stamp `bash`,
  // `open` moved into `filesystem`, and `status`/`support` stamp `devops` from
  // the barry-devops bag. `changes` likewise folded into `filesystem`. Both
  // retired names were kept here for a release and are now gone.
```

### sdk/src/vault/oauth.ts

```text
    // `getOAuthAccessToken` applies the expiry check that `hasOAuthTokens` does
    // not: a cached-but-expired token used to read as authorized here, so the
    // CLI stayed silent and the session hit a 401 on first use instead. The
    // live MCP pool has always tracked this as `authExpired`; this is the same
    // verdict, computed from the token file.
```

### sdk/src/services/request-logging.ts

```text
    // Captured ONCE, here. Reading req.path again inside res.on("finish") is the
    // bug this replaces: Express rewrites req.path to be router-relative as the
    // request is routed, so by finish time it describes the sub-router rather
    // than the request. In the live API that logged 34 of 200 requests as "/",
    // making per-route latency impossible to read.
```

### sdk/src/services/request-logging.ts

```text
    // The untemplated path is deliberately NOT logged as its own field. The
    // templated path plus requestId is enough to find a specific call, and
    // one field per distinct URL is what made the old Axiom dataset hit its
    // 257-column ceiling. Axiom is gone, but a per-URL field is still the
    // wrong shape for any sink.
```
