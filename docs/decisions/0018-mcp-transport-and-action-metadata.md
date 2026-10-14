# ADR 0018: MCP transport and action metadata invariants

Status: accepted

## Context

MCP initialization owns admission reservations, transport slots and pooled bag
connections. Anonymous requests still require scope filtering. Action metadata
and CSV worker reuse have separate compatibility contracts. Historical rationale
is preserved rather than repeated beside each implementation.

## Decision

Replace superseded transport slots and transfer live connection ownership to pool
leases. Release initialization reservations on success and on failure. Apply the
anonymous default-trait grant at aggregate and namespace endpoints. Serve no tools
on resolution failure, with bounded retries. Keep action detachment a call mode
rather than deriving capability from context/output fields. Share typed CSV parsing
with worker callers. Leave these invariants in source and preserve full rationale below.

## Consequences

Reconnects release prior resources, and failures retain scope restrictions.
Action metadata describes the action independently of caller execution choices.
Typed shared parsing avoids duplicate worker logic. This change moves comments
only; historical counts and review labels below are archived observations.

## Historical source rationale

### bags/mcp/src/application.ts

```text
    /**
     * Register a newly initialized transport, closing whichever transport already
     * held this (session, namespace) slot.
     *
     * This is the leak fix: a re-initializing client used to abandon its previous
     * transport forever (onclose needs a DELETE it never sends; the dead-owner
     * sweep can't fire because the owner is alive; the 8h idle TTL is far slower
     * than the observed ~15min reconnect). Reclaiming here matches the leak rate
     * exactly, so live transports plateau instead of climbing into the cap.
     *
     * `admissionId` is the reservation `admitTransport` returned for this same
     * initialize — released here because the real `transports`/`transportOwner`
     * writes below now make it redundant. The caller must also
     * release it on any path that does NOT reach here (a failed initialize,
     * a request that errors first) — see the two `/mcp` handlers.
     *
     * `activePoolKeys` are the bag connection-pool keys this transport
     * references, committed here into `connectionLeases` so releaseTransport
     * can free them the instant this transport closes — the pool itself
     * separately protects a key against the prune sweep for
     * CONNECTION_SETTLE_GRACE_MS from the moment it connects, regardless of
     * whether any transport has committed ownership yet (bag-proxy.ts;
     * astra review F9-F11 — the two mechanisms are complementary, not
     * redundant: the pool covers "just connected, not yet claimed", this
     * covers "claimed, now released promptly on a clean close").
     */
```

### bags/mcp/src/application.ts

```text
            // Anonymous initializes resolve too — under the designated anonymous
            // scope, which has no session row and lands on the default-trait
            // grant. This was the last unscoped surface: omitting `?sessionId=`
            // used to yield every loaded tool with nothing but BARRY_SECRET.
```

### bags/mcp/src/application.ts

```text
                // Fail CLOSED. This used to fall through with the whole unscoped
                // toolset, so a store/DB blip at initialize handed a session ~360
                // tools with none of its deny rules — a restricted session lost
                // its guardrails exactly when infrastructure hiccuped, and looked
                // healthy doing it. Serve nothing instead; scheduleResolveRetry
                // re-resolves on a backoff and pushes the recovered toolset.
```

### bags/mcp/src/application.ts

```text
            // Anonymous clients resolve under the designated anonymous scope and
            // get the default-trait grant, filtered to this namespace — the same
            // rule the aggregate endpoint applies. (They used to get the full
            // unscoped view here.)
```

### bags/actions/src/tools.ts

```text
    // No `executable` flag. It used to mean "context: none + a declared output",
    // the pair that made an action eligible for do_action — but detachment is a
    // property of how a caller wants to run something this time, never of the
    // action, and deriving a capability from two manifest fields barred 57 of 60
    // actions from a calling convention for reasons unrelated to what they do.
    // `context: none` is now documentation (this action needs nothing from the
    // calling conversation) and `hasOutputSchema` stands on its own.
```

### bags/artifacts/src/rendering/artifact-format.js

```text
 * The worker imports this too (it used to keep a hand-copied duplicate), so the
 * types are declared: without them its callers infer `any` and lose checking.
```
