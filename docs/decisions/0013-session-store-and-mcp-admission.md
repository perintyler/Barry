# ADR 0013: session-store boundaries and MCP admission evidence

Status: accepted

## Context

Session and MCP code must distinguish missing evidence from positive failure,
preserve curated authorization grants, and retain independent storage contracts.
Cache freshness depends on both time and policy inputs. Transcript counters need
to expose hollow translations rather than count every write as success. Long
source postmortems obscure these invariants; their historical explanations remain
below, including observations that are not new measurements in this change.

## Decision

Keep concise controlling invariants beside the implementation. Resolve namespace
pruning from the full provider set, report unknown bag health explicitly, and
require a recognized owner answer for edit conflicts. Cache settled and pending
resolutions against their separate deadlines and current trait keys. Parse tool
selection syntax before scoring. Resolve provider ids from provider_sessions and
read active-session fields from their flat contract. Translate transcript entries
with dedupe and channel attribution, and distinguish hollow/duplicate/skipped
outcomes. Annotate asynchronous public store wrappers from their independent
contract rather than deriving the contract from the implementation.

## Consequences

Incomplete evidence cannot silently authorize an edit or masquerade as healthy
state. Slow cache resolution remains single-flight with a bounded pending lifetime.
Transcript ingestion remains diagnosable and repeatable. Store implementation
changes must satisfy the existing public contract. Moving these comments changes
no executable tokens or runtime behavior.

## Historical rationale

### bags/identities/src/config/trait-namespace-reconcile.ts

```typescript
/**
 * Reconcile a trait row's stored namespaces against the value derived from
 * bag manifests.
 *
 * `barry bag sync-traits` used to overwrite `namespaces` outright with the
 * derivation. That is right for the case it was written for — a bag changes
 * shape and the row must follow — but it silently destroyed grants that were
 * curated by hand and had nothing in any manifest to reproduce them. The
 * `sessions` trait granted ["sessions","changes","events","actions"]; one bare
 * sync narrowed it to ["sessions"] and live sessions lost their `actions`
 * tools mid-flight (-32601 Method not found).
 *
 * Merging unconditionally is not the fix: "in the DB, not in the derivation"
 * is also the exact signature of rot. Renames that were never migrated
 * (error→sentry, datadog-official→datadog) left 19 traits granting namespaces
 * no bag provides, and a merge-always sync would have made that drift
 * permanently unprunable.
 *
 * The two cases separate cleanly on one question: does ANY loaded bag still
 * provide the namespace?
 *
 *   provided by some bag → a deliberate cross-bag grant. Keep it.
 *   provided by nobody   → dead reference. Prune it.
 *
 * `provided` is the same set `barry bag doctor` uses to report orphaned trait
 * namespaces (`collectProvidedNamespaces`), so the two agree by construction:
 * anything this function prunes is exactly what doctor would have flagged.
 */
```

### bags/identities/src/identities.ts

```typescript
/**
   * Bag health, as reported by the MCP server.
   *
   * `available: false` is the whole point of the shape. This used to answer an
   * MCP outage with `{ ok: true, needsAuth: [], ... }` — a clean bill of health
   * indistinguishable from a genuinely healthy pool, so the UI's silence proved
   * nothing and a total outage rendered as "everything is authorized". Callers
   * must be able to tell "nothing needs auth" from "we could not find out".
   */
```

### bags/mcp/src/edit-arbiter.ts

```typescript
/**
 * Putting a genuine edit conflict to the user.
 *
 * Coordination stops short of picking a winner when two sessions declare
 * overlapping regions of one file. Both intents are legitimate and the machine
 * has no basis to rank them, so the choice goes to the person who owns the
 * repository.
 *
 * This asks through the **questions bag**, which stores the question and shows
 * it — as a notification, in the Questions app, and on a web page. It used to
 * call `postQuestion`/`pollForAnswer` from the system bag, and that path was
 * write-only in practice: the question became a `messages` row nothing in the
 * product ever read, so every genuine conflict stalled for five minutes and
 * then failed closed with nobody ever asked. The transport existed; the
 * surface did not.
 *
 * Fails CLOSED. A timeout, a transport error, an expired question, or an answer
 * that matches neither option blocks the edit. An unanswered conflict must
 * never licence a write — the cost of being wrong here is silently clobbering
 * work another session said it was doing.
 */
```

### bags/mcp/src/session-resolve-cache.ts

```typescript
/**
 * Freshness rule for the session-resolution cache.
 *
 * Split out from index.ts because that module cannot be imported under vitest —
 * it calls `registerTsSpecifierHook()` at load. Same reason `transport-slots.ts`
 * lives on its own.
 *
 * A session opens one transport per namespace and each would otherwise repeat
 * the full session + traits + barry + credential resolution (including bag
 * connects) within milliseconds. Caching the in-flight promise collapses that
 * burst into one pass, which is worth keeping.
 *
 * But time is not the only thing that invalidates an entry. `barry start`
 * asks for the session's namespaces while building the agent's MCP config,
 * which happens BEFORE it writes the chosen traits to the session row. That
 * call populated the cache from a trait-less session, and the agent's own
 * initialize — arriving well inside the TTL — was handed the same stale answer.
 * The result was a session that printed "Traits: notion" and had no notion
 * tools, with nothing anywhere saying so.
 *
 * So an entry is usable only when it is *both* young enough and was computed
 * from the traits the session currently has.
 */
```

### bags/mcp/src/session-resolve-cache.ts

```typescript
/**
 * How long an UNSETTLED (still in-flight) resolution may stay cached before it
 * is treated as abandoned.
 *
 * Astra review F10: `at` used to double as both "when this entry was created"
 * and the sole clock `isCacheEntryUsable` checked against `SESSION_RESOLVE_TTL_MS`
 * — but `at` is stamped the moment the promise is CREATED (index.ts sets it
 * before the promise resolves), not when it settles. A resolution that takes
 * longer than 10s (DB lookups, credential resolution, bag connects — this
 * cache's own doc says all three can be in the critical path) had its cache
 * entry expire WHILE STILL PENDING. A second transport initializing under the
 * same trait key milliseconds later, at t=10.001s, would see the entry as
 * unusable and kick off a SECOND resolution in parallel with the first —
 * defeating the single-flight collapse this cache exists for, and duplicating
 * the DB/bag work exactly when the system is already slow.
 *
 * 10 minutes is generous headroom over any real resolution (bag connects
 * individually timeout at 45s — see bag-proxy.ts's CONNECT_TIMEOUT_MS — and
 * F11 bounds their fan-out to keep the worst case for many bags well under
 * this), while still being a real ceiling: a resolution that is TRULY stuck
 * (hung network call with no timeout of its own) does not pin this entry
 * forever.
 */
```

### bags/mcp/src/tool-search.ts

```typescript
/**
 * Search deferred tools by query string.
 *
 * Three query forms, all documented on the ToolSearch tool:
 * - `select:a,b` — exact selection by bare or qualified name, bypassing scoring.
 * - `+term` — a required term; tools not matching it are dropped entirely.
 * - bare terms — scored by substring match in namespace (5x), name (3x), and
 *   description (1x), summed across terms.
 *
 * `select:` and `+` used to be matched as literal substrings, so both forms
 * silently returned nothing (no name or description contains "+session"). They
 * are parsed here before scoring.
 */
```

### bags/sessions/api/src/sweep-sessions.ts

```typescript
/**
 * The session list the transcript sweep reads.
 *
 * Extracted from `index.ts` so it can be tested: it lived inline in a module
 * that starts servers on import, which is why the defect below survived.
 *
 * **The provider session id lives in `provider_sessions`, not in metadata.**
 * This mapper used to read `metadata.provider_session_id`, a field nothing has
 * ever written — verified on the live store: 767 sessions carry a
 * `provider_sessions` row and 0 carry the metadata key. The same defect was
 * fixed in `barry session adopt` (handoff #66); this was the second and, per a
 * tree-wide grep, last caller reading it.
 *
 * What it cost is worth stating precisely, because the obvious guess is wrong.
 * A session with no id still resolves a reader — `provider` is `"claude"` and
 * `transcriptReaders()` registers claude — so it was NOT counted `no-reader`.
 * It was counted `considered`, then `locate()` returned null and the loop hit
 * `if (!path) continue`. **It landed in neither `located` nor `no-reader`: a
 * session the sweep looked at, could have read, and silently did not.**
 * Measured directly against the real reader: `locate()` returns null without
 * the id and returns a real `.jsonl` path with it.
 */
```

### bags/sessions/api/src/sweep-sessions.ts

```typescript
/**
 * A session as `getActiveSessions()` returns it — FLAT.
 *
 * `sessionRecordToFlat` lifts the metadata fields it knows to the top level and
 * does not pass `metadata` through at all; the flat `Session` type has no such
 * key. Reading `session.metadata` here therefore always yielded `{}`, which is
 * how `provider` arrived EMPTY and every session was counted `no-reader` —
 * observed in the live log once a minute: `no-reader=10`.
 *
 * `mode` is not on the flat type either. It is null for every active session
 * today, and null reads as "not known to be hosted" — the safe direction, since
 * the dedupe key absorbs a row the engine also stored. If a hosted marker is
 * ever needed here it must be added to the flat mapping first; reaching for
 * `metadata.mode` is what this comment exists to stop.
 */
```

### bags/sessions/api/src/transcript-persist.ts

```typescript
/**
 * Store one entry a transcript reader found.
 *
 * Separate from the sweeper because it is the only part that touches the
 * store, and because it carries the two fields that make a re-read safe and
 * legible:
 *
 *  - **`dedupeKey`** — the reader's own line identity. Without it, a sweep
 *    that runs every minute inserts the whole transcript every minute, and
 *    nothing in the UI shows that as anything but a chattier agent.
 *  - **`channel: "transcript"`** — which of the five routes captured the row.
 *    This is the channel that recorded NOTHING until the sweep had a caller;
 *    stamping it here is what makes `barry start --cursor` show `transcript`
 *    rows, as A2's acceptance requires.
 *
 * It is also where the reader's vocabulary becomes the store's. That
 * translation used to be a spread, which silently wrote every row empty — see
 * `transcript-event.ts`.
 */
```

### bags/sessions/api/src/transcript-persist.ts

```typescript
/**
 * What became of one transcript entry.
 *
 * Four outcomes, not two. `persisted` used to be a bare boolean, which made a
 * row written with an EMPTY payload count as a success — the sweep reported
 * `persisted=3762` while 99.5% of those rows were hollow. A counter that
 * cannot tell those apart cannot detect the failure it exists to detect.
 */
```

### bags/sessions/src/store/sessions-store-api.ts

```typescript
/**
 * The package's public session/message surface, served from SQLite.
 *
 * WHY THIS MODULE EXISTS. `index.ts` used to re-export these names straight
 * from `sessions.ts` and `messages.ts`, whose bodies queried `sessions`,
 * `messages` and `provider_sessions` -- tables migration 041 dropped. Every
 * one of those exports was a function that typechecked, passed the seam
 * guard, and threw `relation "sessions" does not exist` the moment anything
 * called it. The bodies are gone; this is where the same names now come from.
 *
 * TWO DIFFERENCES ARE RECONCILED HERE, AND ONLY TWO.
 *
 * 1. **Async over sync.** The SQLite implementations are synchronous
 *    (better-sqlite3 is a blocking driver); the published contract is
 *    promise-returning, and `session-client` derives every one of its
 *    signatures with `typeof`. Each wrapper below is `async`, so callers
 *    await exactly what they awaited before -- awaiting a non-promise is a
 *    no-op, which is why this is a type change and not a behaviour change.
 *
 * 2. **Naming.** The SQLite functions carry a `Sqlite` suffix because they
 *    once coexisted with legacy namesakes. The public names do not, and
 *    renaming the implementations instead would have churned every one of
 *    their own tests for nothing.
 *
 * TYPED FROM THE CONTRACT, NOT FROM THE IMPLEMENTATION. Every export is
 * annotated with its `sessions-contract.ts` type, so a SQLite function that
 * drifts from the shape callers expect is a compile error HERE rather than a
 * wrong response body at a call site. Typing these from the SQLite side would
 * make the implementation its own contract and turn drift invisible -- the
 * exact failure that once sent `tool_call` to the macOS app instead of
 * `tool_start`, silently, for as long as nobody reloaded a transcript.
 */
```
