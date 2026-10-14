# ADR 0004: Telemetry extension and alert invariants

## Context

Dashboard extensions and alert evaluation had long source narratives describing both their contracts and past failures. The retained notes below describe the comment-pass checkpoint and preserve its observations.

## Decision

Keep concise invariants in source and retain the complete supporting notes here. This move changes no executable tokens.

## Consequences

Extension and alert changes must preserve unavailable-state distinctions, series identity and failure isolation. Incident dates below are historical evidence, not current measurements.

## Note 039

Source: [bags/telemetry/src/framework/contributed-panels.test.ts](../../bags/telemetry/src/framework/contributed-panels.test.ts)

Validate disk-supplied panel descriptors at runtime; TypeScript cannot check JSON contributions.

Original rationale:

```text
/**
   * A contribution is JSON from another bag's file on disk. TypeScript enforces
   * the shape where a descriptor is built in code; nothing enforces it here.
   *
   * Both of these are real declarations that failed during the first end-to-end
   * proof. The old code read `c.columns.length` on undefined and threw
   * "Cannot read properties of undefined (reading 'length')" — naming neither
   * the panel, the bag, nor the field. The loader caught it, logged it, and
   * moved on, so the panel just never appeared.
   */
```

## Note 040

Source: [bags/telemetry/src/framework/contributed-panels.ts](../../bags/telemetry/src/framework/contributed-panels.ts)

Contributions extend the host dashboard through descriptors, without importing another bag’s implementation.

Original rationale:

```text
/**
 * How another bag puts a panel on this dashboard.
 *
 * `registry.ts` made metrics, rules and collectors contributable; `pages.ts`
 * made the page list a declaration rather than nine hand-edited files. Neither
 * gets a second bag's data onto the screen. This does.
 *
 * ## The mechanism: a descriptor plus a JSON endpoint, never contributed HTML
 *
 * A contributor declares a title and a data path. The host resolves the bag's
 * base URL through the resource registry, fetches `<base><dataPath>`, expects a
 * `Panel<Row[]>` back, and renders it into the host's own shell with the host's
 * own markup. The contributor supplies data and a title. It never supplies
 * markup, a stylesheet, a script, or a URL the host pastes into the page.
 *
 * The alternative — a contributed *page*, where the host proxies or links to
 * HTML the contributor serves — was rejected on three counts, in order of how
 * much they cost:
 *
 *   1. **Injection.** Proxying a contributor's HTML into the host document
 *      means arbitrary script running on the host's origin, with the host's
 *      cookies, reading every other panel on the page and calling every `/api/`
 *      route as the reader. There is no escaping story for "a whole document",
 *      only sandboxing, and a sandboxed iframe is no longer the host's shell.
 *      Serving it from the host's path space also reintroduces exactly the
 *      traversal `server.ts` refuses: a contributor-supplied `file` resolved
 *      against `web/` is the `join(HERE, "..", "web", url.pathname)` that the
 *      STATIC_ASSETS allowlist exists to prevent.
 *   2. **Layout.** A contributed document owns its own `<head>`. One unclosed
 *      tag, one `position: fixed`, one `* { }` rule and the host's nav is gone.
 *      With a descriptor the contributor cannot emit a single element.
 *   3. **Failure isolation.** A proxied page that hangs is a page that never
 *      renders. A descriptor's fetch has a deadline and a typed failure, and
 *      the worst case is one panel reading `unavailable` beside eight healthy
 *      ones. Linking out instead of proxying avoids the injection but gives up
 *      the whole point: the reader wanted the number on the dashboard, and a
 *      link to a service that is down is a 404 in a new tab rather than a
 *      stated reason on the page they were already looking at.
 *
 * What the descriptor costs, honestly: a contributor cannot ship a bespoke
 * visualisation. It gets a titled table of rows. That is the trade — the host
 * keeps control of every pixel, and in exchange a contributor cannot express
 * a chart shape the host does not already have. If that becomes the binding
 * constraint, the answer is more host-side renderers named by the descriptor
 * (`render: "table" | "stat" | "series"`), not contributed markup.
 *
 * ## Unreachable must not look like empty
 *
 * The rule the rest of this bag is built around applies with more force here,
 * because a contributor is a separate process that can be stopped without
 * anything in this repo noticing. Every failure path below — unregistered bag,
 * connection refused, timeout, non-200, unparseable body, a body that is not a
 * Panel — resolves to `{ state: "unavailable", reason }` naming the bag and the
 * cause. None of them resolve to `empty`, and none of them throw: `fetchPanel`
 * has no rejection path, so a contributor cannot take down the route that
 * renders it.
 */
```

## Note 041

Source: [bags/telemetry/src/framework/contributed-panels.ts](../../bags/telemetry/src/framework/contributed-panels.ts)

A contributed panel declares its data contract and location without owning the host page.

Original rationale:

```text
/**
 * One panel a bag contributes.
 *
 * `dataPath` is a path, not a URL, and it is the contributor's only say in
 * where the host connects. The origin comes from the resource registry, so a
 * contributor cannot point the host's fetch at an arbitrary host — that would
 * be a server-side request forgery with the host's network position, handed
 * over by a config file.
 */
```

## Note 042

Source: [bags/telemetry/src/framework/contributed-panels.ts](../../bags/telemetry/src/framework/contributed-panels.ts)

Panel keys include their owner; reject collisions rather than silently replacing a contribution.

Original rationale:

```text
/**
 * The contributed panels, keyed so two bags cannot claim one slot.
 *
 * Same rule as `TelemetryRegistry`: collisions throw at registration, naming
 * both claimants, rather than surfacing as one panel mysteriously winning at
 * 3am. Kept as its own class for the same reason — a module-global that
 * accumulates across a test run passes for reasons nobody can reproduce.
 */
```

## Note 043

Source: [bags/telemetry/src/framework/contributed-panels.ts](../../bags/telemetry/src/framework/contributed-panels.ts)

Validate panel response shape before rendering untrusted data.

Original rationale:

```text
/**
 * Is this body actually a `Panel<PanelRow[]>`?
 *
 * A contributor that returns 200 with the wrong shape is a contributor that is
 * broken, and rendering its garbage as data is the same lie as rendering an
 * outage as an empty table. Validated here so the caller narrows a real union.
 */
```

## Note 044

Source: [bags/telemetry/src/framework/contributed-panels.ts](../../bags/telemetry/src/framework/contributed-panels.ts)

A contributed fetch returns a typed unavailable result instead of rejecting the host page.

Original rationale:

```text
/**
 * Fetch one contributed panel. Never rejects.
 *
 * Every way this can go wrong — the bag is not in the resource registry, the
 * service is not listening, it is listening but hung, it answers 500, it
 * answers HTML, it answers a JSON object that is not a Panel — comes back as
 * `unavailable` with a reason naming the bag. That is the entire contract, and
 * it is why `server.ts` can render a contributed panel without a try/catch
 * around it: there is no throw to catch.
 *
 * The reason strings say what is wrong AND where to look, because "fetch
 * failed" on a dashboard is indistinguishable from the dashboard being broken.
 */
```

## Note 045

Source: [bags/telemetry/src/framework/contributed-panels.ts](../../bags/telemetry/src/framework/contributed-panels.ts)

Escape every contributed title and cell because both are untrusted input.

Original rationale:

```text
/**
 * Escape contributed text. A title is untrusted input; so is every cell.
 *
 * Duplicated from `pages.ts` rather than imported to keep this module free of
 * a dependency on the page list — the escape is four characters and a shared
 * one-liner is not worth coupling the two.
 */
```

## Note 046

Source: [bags/telemetry/src/framework/contributed-panels.ts](../../bags/telemetry/src/framework/contributed-panels.ts)

Render an empty panel shell before fetching so a missing contributor cannot block the page.

Original rationale:

```text
/**
 * The server-rendered shell for one contributed panel, before its data arrives.
 *
 * The shell is the host's markup end to end: the contributor supplies a title
 * and column headers as TEXT, which are escaped into it. There is no path by
 * which a contributor emits an element, an attribute or a script — the whole
 * reason the descriptor was chosen over a contributed page.
 *
 * It renders with a "loading" state rather than empty, and the client replaces
 * it from `/api/panels/<key>`. A shell that never gets replaced therefore reads
 * as "still loading" and then as unavailable when the fetch fails — never as
 * an empty table, which would be the exact lie this bag exists to prevent.
 */
```

## Note 047

Source: [bags/telemetry/src/framework/contributions.ts](../../bags/telemetry/src/framework/contributions.ts)

Build contributions once at boot from the installed registry, isolating malformed entries.

Original rationale:

```text
/**
 * The live set of contributed panels, assembled at boot.
 *
 * Kept separate from `contributed-panels.ts` (the mechanism) and from
 * `registry.ts` (metrics, rules, collectors) so the three compose rather than
 * collide. `registry.ts` is gaining a consumer in parallel; this module is the
 * panel half of the same story and deliberately does not import it — a bag
 * contributing only a panel should not have to construct a `Contribution`, and
 * a bag contributing only a collector should not have to think about pages.
 *
 * ## Where contributions come from
 *
 * A file of declarations, not a code import. The host must not `import()` a
 * contributor's module: that would run a second bag's code inside this process,
 * where a throw at module scope takes down the dashboard and a dependency of
 * theirs becomes a dependency of ours. A JSON declaration cannot execute.
 *
 * The file lives beside the resource registry, written by whatever enables the
 * bag. A missing or malformed file means "nothing contributed", never a crash —
 * same rule `readBagResourceRegistry` follows, and for the same reason: the
 * dashboard has to come up when other things are broken.
 */
```

## Note 048

Source: [bags/telemetry/src/framework/contributions.ts](../../bags/telemetry/src/framework/contributions.ts)

Read declarations from installed bag manifests, without discovering arbitrary directories.

Original rationale:

```text
/**
 * Where declarations are read from.
 *
 * Application Support rather than Caches, matching the resource registry: a
 * dashboard that loses a bag's panels because a cache was evicted would look
 * exactly like the bag having been removed.
 */
```

## Note 049

Source: [bags/telemetry/src/framework/contributions.ts](../../bags/telemetry/src/framework/contributions.ts)

Validate and register every contribution; one bad bag must not suppress the others.

Original rationale:

```text
/**
 * Load and register every declared panel.
 *
 * A malformed individual panel is skipped with its reason on stderr rather than
 * aborting the load: one bag's bad declaration must not cost every other bag
 * its panels. That is `registry.ts`'s "a contributor that fails costs only
 * itself", applied at registration time instead of at collect time.
 */
```

## Note 050

Source: [bags/telemetry/src/framework/correlate.ts](../../bags/telemetry/src/framework/correlate.ts)

Correlate a session across owning stores without making the dashboard a second source of truth.

Original rationale:

```text
/**
 * One session, across every store.
 *
 * The four stores each answer a different question well and none of them
 * answers "what happened in this session". A cost spike in `usage.db`, the
 * errors that session logged in `errors.db`, and the HTTP traffic around it in
 * `requests.db` are three separate investigations today, stitched together by
 * hand and by eye.
 *
 * The join key already exists and nothing walks it: `errors.ctx` carries
 * `sessionId` on 4,213 of 4,280 rows, and `usage.db` keys both of its tables on
 * `session_id`. This is the read model that walks it.
 *
 * ## Why requests join on TIME and not on id
 *
 * `requests.db` has no session column — its rows are
 * `{id, service, method, path, status, duration_ms, ts}`. There is no id to
 * join on, and inventing one by parsing paths would be a guess presented as a
 * fact.
 *
 * So requests are returned as "what the HTTP surface was doing while this
 * session ran", bounded by the session's own window, and the return type says
 * so: `requestsInWindow`, not `requests`. A reader who thinks they are looking
 * at this session's requests would draw conclusions the data cannot support —
 * the same class of error as an empty panel reading as healthy.
 *
 * ## Absence is reported, not implied
 *
 * Every section returns a `Panel`, so "this session logged no errors" and "the
 * errors store is unreadable" cannot render the same way. That distinction is
 * the one this bag gets wrong most often.
 */
```

## Note 051

Source: [bags/telemetry/src/framework/correlate.ts](../../bags/telemetry/src/framework/correlate.ts)

Missing stores produce explicit gaps rather than fabricating an empty session history.

Original rationale:

```text
/**
 * Assemble one session's story.
 *
 * Each store is optional and independently fallible: a missing `usage.db` must
 * still let the errors show, because during an incident the store that is down
 * is often the one you are investigating.
 */
```

## Note 052

Source: [bags/telemetry/src/framework/endpoints.ts](../../bags/telemetry/src/framework/endpoints.ts)

Resolve service addresses from the instance registry so collectors follow configured ports.

Original rationale:

```text
/**
 * Where Barry's own services answer, for the collectors that scrape them.
 *
 * Looked up in the instance registry on every call. This used to be a table of
 * port numbers, and a table is right in one instance and silently blind in
 * another: `collect-hooks.ts` once shipped with the dev API's port while the
 * table said prod's, and reported a working collector as broken for sixty
 * ticks. The registry is what the supervisor actually assigned.
 *
 * Lives in `framework/` because both `collect.ts` and the individual collectors
 * need it, and `collect.ts` imports the collectors — putting it there instead
 * would be an import cycle.
 */
```

## Note 053

Source: [bags/telemetry/src/framework/endpoints.ts](../../bags/telemetry/src/framework/endpoints.ts)

Authenticated API scrapes require the instance secret; an absent secret is a configuration failure.

Original rationale:

```text
/**
 * The shared secret the API requires on `/api/v1/*`.
 *
 * `/health` sits before `applyAuth`, which is why a health probe can be
 * anonymous and a counter scrape cannot. An empty string is unset rather than
 * a secret — `??` would accept it and then 403, which reads as an auth bug
 * instead of a missing config.
 *
 * BARRY_SECRET only. There was a fallback to the API's own bearer-token
 * variable here, and it could never fire: both callers run inside the `sample` job,
 * whose manifest declares `BARRY_SECRET` alone, and launchd passes only what
 * the manifest names — verified against the generated plists, where that
 * variable appears in none of them. So it read as a supported
 * configuration while being unreachable, which is worse than not offering it.
 *
 * It is also what `check:monorepo` flags: a bag may not read a secret from
 * process.env that its manifest does not declare. Adding the variable to
 * `bag.yaml` would have satisfied the check by making the dead path live,
 * which is the wrong direction — the API's own token is not this bag's to read.
 */
```

## Note 054

Source: [bags/telemetry/src/framework/log-sources.ts](../../bags/telemetry/src/framework/log-sources.ts)

Discover supervised output logs by service identity so renamed services remain visible.

Original rationale:

```text
/**
 * Every supervised service's output log, named by the service it belongs to.
 *
 * The supervisor writes each service's stdout to `<logs>/<bag>/<service>.out.log`
 * (and stderr beside it), so the registry name `<bag>.<service>` is the
 * directory plus the file. Discovered rather than listed: a hardcoded list
 * once kept naming a log that had stopped existing, and ingested nothing for
 * weeks while reporting success. A new service appears here the first time it
 * writes a line.
 *
 * Shared by the error, request and log collectors, which each had their own
 * copy of this walk.
 */
```

## Note 055

Source: [bags/telemetry/src/framework/pages.ts](../../bags/telemetry/src/framework/pages.ts)

Declare pages centrally so navigation and routes agree.

Original rationale:

```text
/**
 * The dashboard's pages, in one list.
 *
 * Every page was previously three things kept in sync by hand: an HTML file, a
 * near-identical route block in `server.ts`, and a `<nav>` copy inside all nine
 * HTML files. Adding a page meant touching eleven places; adding one from
 * ANOTHER bag was impossible, because the nav lived in this bag's markup.
 *
 * The drift that produces is already visible: `index.html`'s nav is the one
 * that differs from the other eight, missing the time-window control they all
 * carry. Nobody decided that — it is what nine hand-maintained copies do.
 *
 * So the nav is generated from this list at serve time, and the route blocks
 * are a loop over it. The list is the only place a page is declared, which is
 * what makes a contributed page possible later: a bag adds an entry, not an
 * edit to nine files.
 *
 * `file` is resolved against `web/` and never against the request path —
 * `server.ts` documents why a `join(HERE, "..", "web", url.pathname)` would be
 * directory traversal, and "not reachable today is not a security boundary".
 */
```

## Note 056

Source: [bags/telemetry/src/framework/pages.ts](../../bags/telemetry/src/framework/pages.ts)

Persist the time window in navigation so reloads and shared URLs retain it.

Original rationale:

```text
/**
   * Render the time-window selector in this page's nav.
   *
   * Seven pages carry it and `/` does not, which reads like drift and is not:
   * the control is driven by `$("windows")` in catalog.js and jobs.js, and the
   * infrastructure page has no windowed view to drive. An empty div there
   * would be markup for a control nothing populates.
   */
```

## Note 057

Source: [bags/telemetry/src/framework/pages.ts](../../bags/telemetry/src/framework/pages.ts)

Contributed panels occupy declared host slots rather than arbitrary HTML locations.

Original rationale:

```text
/**
 * Where contributed panels land in a host page.
 *
 * A page may name the spot with this marker. A page that does not — which is
 * all nine today — gets them appended just inside `</main>`, below its own
 * content. That default is what makes the mechanism work with **no edit to
 * this repo's markup**: a bag contributes a panel and it appears, rather than
 * a bag contributing a panel and then needing a pull request here to add a
 * placeholder comment to the page it wants to appear on.
 *
 * Below rather than above deliberately: the host's own panels are what the
 * reader opened the page for, and a contributor should not be able to push
 * them below the fold by registering first.
 */
```

## Note 058

Source: [bags/telemetry/src/framework/pages.ts](../../bags/telemetry/src/framework/pages.ts)

Substitute contribution markers without allowing a contributor to rewrite the host document.

Original rationale:

```text
/**
 * Substitute contributed-panel markup into a page.
 *
 * `html` is trusted (it is this repo's own file); `panelsHtml` is host-rendered
 * markup built from escaped contributor text — see `renderPanelShells`. A page
 * with neither the marker nor a `</main>` is returned unchanged rather than
 * rejected, for the same reason `withNav` is forgiving: an exception here would
 * take down a working dashboard over a markup detail.
 */
```

## Note 059

Source: [bags/telemetry/src/framework/panel.ts](../../bags/telemetry/src/framework/panel.ts)

A panel returns either measured data or an explicit unavailable reason.

Original rationale:

```text
/**
 * The result type every read model returns.
 *
 * It lives in `framework/` rather than in `usage/` because the distinction it
 * encodes — "the source is down" against "there was no activity" — is the one
 * this bag gets wrong most often, and it applies to a SQLite read model, a
 * scraped endpoint and a contributed panel exactly as much as to a SQL query.
 * Keeping it here is what lets a Tier-2 contributor return a panel at all
 * without importing the query layer just to get the type.
 *
 * `runPanel` deliberately stays in `usage/` — it takes an `Sql` and classifies
 * driver errors, so it is genuinely query-layer-bound. A contributor that reads
 * from somewhere else builds the union directly.
 */
```

## Note 060

Source: [bags/telemetry/src/framework/panel.ts](../../bags/telemetry/src/framework/panel.ts)

Unavailable, empty and zero are distinct panel states.

Original rationale:

```text
/**
 * A panel's data, or a specific reason there is none.
 *
 * The four states exist because "the source is down" and "there was no activity"
 * must not render the same way. An empty chart drawn for an unreachable database
 * is the exact failure this repo forbids: broken looks identical to healthy, and
 * a zero is read as a fact.
 *
 * Modelled as a union rather than `{data, error?}` so a caller cannot forget to
 * check — there is no `.data` to render until the state has been narrowed.
 */
```

## Note 061

Source: [bags/telemetry/src/framework/registry.ts](../../bags/telemetry/src/framework/registry.ts)

Validate extension contracts and reject collisions at the registry boundary.

Original rationale:

```text
/**
 * What another bag may contribute, and how collisions are caught.
 *
 * Every extension point in this bag was a hardcoded list: `METRICS` in
 * schema.ts, the collector array literal in `sample()`, `DEFAULT_RULES`, and
 * until Phase 1 the pages. A second bag could not add to any of them without a
 * pull request here.
 *
 * ## Collisions are rejected at registration, never at collect
 *
 * This is the one design rule worth stating up front, and it is Prometheus's:
 * a duplicate metric name discovered while collecting is a bug that surfaces as
 * confusing data at 3am. The same duplicate discovered at registration is a
 * startup error naming both claimants. `register()` therefore throws, and the
 * caller decides whether that is fatal.
 *
 * ## Contributions are namespaced by bag, and cannot be anonymous
 *
 * Every registered thing carries the bag that supplied it. Without that, a
 * misbehaving contributor is unattributable — which is the state `collect.ts`
 * was already in when a leaked MCP transport could not be traced to a session.
 *
 * ## A contributor that fails costs only itself
 *
 * `sample()` already runs collectors under `Promise.allSettled` so a rejected
 * one costs its own metrics and nothing else. The same rule applies here: a
 * contributed collector that throws must not take down the tick, and a
 * contributed panel whose bag is unreachable renders `unavailable` rather than
 * blanking the dashboard.
 */
```

## Note 062

Source: [bags/telemetry/src/framework/registry.ts](../../bags/telemetry/src/framework/registry.ts)

One live registry supplies every extension point; duplicated registries would hide contributions.

Original rationale:

```text
/**
 * The live set of contributions.
 *
 * Deliberately a class rather than module state: tests need a fresh one, and a
 * global that accumulates across a test run is how a registry starts passing
 * for reasons nobody can reproduce.
 */
```

## Note 063

Source: [bags/telemetry/src/framework/registry.ts](../../bags/telemetry/src/framework/registry.ts)

Isolate contributed collector failures so one bag cannot prevent other readings.

Original rationale:

```text
/**
   * Run every contributed collector, isolating failures.
   *
   * Mirrors `sample()`'s `Promise.allSettled`: a rejected collector costs its
   * own metrics and nothing else. The bag is named in the rejection so a
   * contributor that breaks is attributable rather than anonymous.
   */
```

## Note 064

Source: [bags/telemetry/src/framework/store.test.ts](../../bags/telemetry/src/framework/store.test.ts)

Preserve each store’s deliberate lock timeout; metrics collection must not stall on contention.

Original rationale:

```text
/**
   * `busy_timeout` reads as the one deliberate difference between these stores —
   * three set it to 5000 and metrics.db pointedly does not.
   *
   * It never was one. **better-sqlite3 defaults busy_timeout to 5000**, so the
   * three explicit calls were always no-ops and metrics.db has had a 5s timeout
   * for its whole life, despite comments reasoning about why it should not.
   * Asserted here so the fact is pinned: if a future better-sqlite3 changes that
   * default, this fails rather than silently altering the locking behaviour of
   * every store in the bag.
   *
   * The option is kept because it makes the intent explicit at each call site,
   * and because a store that genuinely wants a different value now has a way to
   * say so.
   */
```

## Note 065

Source: [bags/telemetry/src/framework/store.ts](../../bags/telemetry/src/framework/store.ts)

Share local SQLite opening policy while keeping telemetry reads independent of API availability.

Original rationale:

```text
/**
 * Opening a local SQLite store, once.
 *
 * Four stores in this bag repeated the same seven lines — mkdir, open, three
 * pragmas, `CREATE TABLE IF NOT EXISTS`, return — and the repetition was not
 * uniform: `metrics.db` omits `busy_timeout` while the other three set it, and
 * every copy carried a slightly different subset of the reasoning in its
 * comments. A reader had to diff them to learn which differences were
 * deliberate.
 *
 * They all are, and they are now named rather than implied:
 *
 * - **WAL** everywhere: a concurrent reader (the web app) and writer (a job)
 *   must not contend for a lock.
 * - **`synchronous = NORMAL`** everywhere: this is telemetry, not a ledger.
 *   Losing the last sample to a power cut is acceptable and FULL costs an
 *   fsync per write, on paths that run every tick or every tool call.
 * - **`busy_timeout`** *reads* as the one real difference — three stores set it
 *   to 5000 and `metrics.db` pointedly does not, with comments reasoning about
 *   why a single-writer store should not have one. **It never was a difference.**
 *   better-sqlite3 defaults `busy_timeout` to 5000, so those three calls were
 *   always no-ops and `metrics.db` has had a 5s timeout for its whole life.
 *   `src/framework/store.test.ts` pins that default so a future version of the
 *   driver cannot change the locking behaviour of every store here silently.
 *
 *   The option is kept for two reasons: it states intent at the call site, and
 *   a store that genuinely wants a different value now has a way to ask. The
 *   single-writer rule itself still stands and is enforced elsewhere —
 *   `collect-ollama.ts:20` documents why a second writer to `metrics.db` would
 *   lose points to SQLITE_BUSY, which charts as a gap, which is
 *   indistinguishable from idle.
 *
 * UNITS: every time column in every store here is UNIX SECONDS, never
 * milliseconds. Stated at the door because the failure is silent — a
 * millisecond bound matches no rows and reads as "no data" rather than as an
 * error. This has already cost one debugging session and put points ~56,000
 * years in the future.
 */
```

## Note 066

Source: [bags/telemetry/src/framework/store.ts](../../bags/telemetry/src/framework/store.ts)

A bounded busy timeout tolerates a concurrent writer without blocking indefinitely.

Original rationale:

```text
/**
   * Milliseconds to wait for a lock before failing.
   *
   * Set this when more than one PROCESS writes the store. Leave it undefined
   * for a single-writer store, where a timeout would hide contention that is
   * meant to be impossible rather than surface it.
   */
```

## Note 067

Source: [bags/telemetry/src/framework/tail.ts](../../bags/telemetry/src/framework/tail.ts)

Resume by byte offset and preserve incomplete trailing lines for the next ingest.

Original rationale:

```text
/**
 * Tailing a growing log file into a local store.
 *
 * `usage/errors.ts` and `usage/requests.ts` both ingest pino output from each
 * service's `<bag>/<service>.out.log` before the supervisor rotates it away
 * past 10MB. They share seven function NAMES, which reads as one
 * program written twice.
 *
 * It is not. Measured rather than assumed: only `logSizeMb` and
 * `defaultLogSources` were identical. `watermark` differed by table name,
 * `coverage` returned different shapes, and `ingestLog` differed structurally —
 * 39 lines against 72 — because **requests tracked byte offsets and errors did
 * not**. So `ingest-errors` re-read 5.9MB across 20 files every 300s while
 * `ingest-requests` read only the new bytes.
 *
 * What lives here is therefore the BETTER half, not the common half: the offset
 * machinery, so a second ingester cannot be written without it. The parsing,
 * the schema and the read models stay with each store, because those genuinely
 * differ and collapsing them would mean a parameter for every difference.
 *
 * Both stores keep offsets in the same table shape:
 *
 *     CREATE TABLE IF NOT EXISTS file_offset (
 *       file   TEXT PRIMARY KEY,
 *       offset INTEGER NOT NULL
 *     );
 */
```

## Note 068

Source: [bags/telemetry/src/framework/tail.ts](../../bags/telemetry/src/framework/tail.ts)

Report both inspected and inserted rows so deduplication differs from an idle ingest.

Original rationale:

```text
/**
 * What one ingest pass did, as two numbers rather than one.
 *
 * `read` is rows parsed out of the file; `inserted` is rows that were actually
 * new. They diverge legitimately and routinely: `INSERT OR IGNORE` with a
 * deterministic id means a re-read stores nothing, and a re-read is the NORMAL
 * consequence of log truncation resetting the byte offset.
 *
 * Both are reported because each answers a question the other cannot. A pass
 * reporting `inserted` alone would print 0 after every truncation — healthy,
 * but indistinguishable from a collector whose log path went stale and read
 * nothing at all, which is the failure this bag exists to catch. A pass
 * reporting `read` alone was the original bug: it counted rows OFFERED and so
 * overstated what had been stored.
 */
```

## Note 069

Source: [bags/telemetry/src/framework/tail.ts](../../bags/telemetry/src/framework/tail.ts)

A saved offset belongs to the file generation; truncation requires restarting it.

Original rationale:

```text
/**
 * The byte offset to resume reading `file` from.
 *
 * A stored offset is only trustworthy if it could still point INTO the file:
 * `stat.size` is the file's current size, and any of these mean the file was
 * rotated or truncated out from under the stored offset, or the stored value
 * was never valid to begin with —
 *
 * - `stored > size` — the classic rotation case: a fresh, shorter file exists
 *   at the same path. Seeking to the old offset would either land past EOF
 *   (silently reading nothing, ever again) or, for a file that later grows
 *   past the old byte count, land mid-way into content that was never seen
 *   from this offset and skip everything before it.
 * - `stored < 0`, non-finite, or not an integer — a corrupt value, whatever
 *   produced it. Negative-control coverage exists for exactly this: reading
 *   garbage from `file_offset` must never crash the ingester or seek to a
 *   nonsense position, it must behave exactly like "never ingested".
 *
 * Either way the safe answer is the same: reset to 0 and re-read the file
 * from the start. The watermark filter in `ingestLog` is what keeps that
 * full re-read from producing duplicate rows.
 */
```

## Note 070

Source: [bags/telemetry/src/framework/telemetry.test.ts](../../bags/telemetry/src/framework/telemetry.test.ts)

Test live registry wiring separately from individual extension mechanisms.

Original rationale:

```text
/**
 * The wiring, not the mechanism.
 *
 * `registry.test.ts` already proves the registry's own behaviour. These tests
 * prove the four seams it was plugged into actually consult it: the catalog,
 * the collect path, the rule list, and the isolation of a bad contributor.
 *
 * Every test loads a FRESH module graph via `vi.resetModules()` and dynamic
 * import. The live registry is deliberately process-wide singleton state with
 * no `unregister` -- registration is meant to be a startup act, not something
 * undone at runtime -- so the only honest way to test it is a new module
 * instance per case. A shared one would accumulate contributions across tests
 * and start passing for reasons nobody can reproduce.
 */
```

## Note 071

Source: [bags/telemetry/src/framework/telemetry.ts](../../bags/telemetry/src/framework/telemetry.ts)

All extension points read the same live registry so registrations remain observable.

Original rationale:

```text
/**
 * The one live registry, and the seam every extension point now reads.
 *
 * `registry.ts` defines the mechanism; this module owns the single instance the
 * running bag actually consults. They are separate files because the class is
 * deliberately instantiable — tests need a fresh one, and a global that
 * accumulates across a test run is how a registry starts passing for reasons
 * nobody can reproduce. This module is the exception that a process needs
 * exactly one of.
 *
 * ## Why the built-ins are seeded here
 *
 * `METRICS` is seeded under this bag's own name at module load, so a
 * contributor that claims `barry.service.up` collides AT REGISTRATION with a
 * message naming both bags — rather than at collect, where the conflict would
 * only ever surface as two series fighting over one name at 3am. Seeding lazily
 * or at first use would reopen exactly that window.
 *
 * ## Why rules are NOT seeded
 *
 * `DEFAULT_RULES` stays the array it always was, and `rules()` returns only
 * what contributors added; callers concatenate. Seeding them would mean the
 * shipped rules could be evaluated twice — once from the constant every call
 * site already holds, once from the registry — and a rule that fires twice
 * spends its alert-state key on itself.
 */
```

## Note 072

Source: [bags/telemetry/src/framework/telemetry.ts](../../bags/telemetry/src/framework/telemetry.ts)

Keep one process-wide registry rather than independently initializing extension consumers.

Original rationale:

```text
/**
 * The process-wide registry.
 *
 * Seeded at module load rather than on first read: a contribution registered
 * before the seed would not collide with the built-ins, which is the entire
 * failure this seeding exists to prevent.
 */
```

## Note 073

Source: [bags/telemetry/src/logs.ts](../../bags/telemetry/src/logs.ts)

Store all log levels with retention suited to their volume, separately from request telemetry.

Original rationale:

```text
/**
 * All log levels, in a store built for the volume.
 *
 * `errors.db` keeps `level >= 40` and answers "what broke". This answers "what
 * happened" -- the question the `logs` namespace was created for, against a
 * vendor (Axiom) since removed from core. Its ten-tool interface is the spec;
 * this is the local backend it lost.
 *
 * ## The volume is the design constraint, and it was measured
 *
 * Sampling 20,000 live lines:
 *
 *     level 30   19,498 lines  (99.6%)   4.01 MB
 *     level 40       19 lines  ( 0.1%)
 *     level 50       55 lines  ( 0.3%)
 *
 * So all-levels is ~270x what `errors.db` ingests. At the measured 691 events
 * per day above level 40, that is ~186,000 rows/day and ~1.3M over a 7-day
 * window -- real, but bounded.
 *
 * ## Retention is per level, because the levels answer different questions
 *
 * A uniform horizon would either discard errors while they are still being
 * investigated, or keep a week of debug chatter to do it. Info is a firehose
 * whose value decays in hours; an error matters until someone has looked at it.
 *
 * The numbers live in RETENTION_DAYS and `prune` takes them as data, so tuning
 * the store is a constant to change rather than a migration.
 *
 * ## Why a second store rather than a widened errors.db
 *
 * `errors.db` is 1.6MB and answers incident questions fast. Mixing a 270x
 * firehose into it would make every "what broke" query pay for the chatter, and
 * would force a single retention decision onto rows that need different ones.
 * One shape per question -- the same reason `requests.db` exists separately.
 *
 * ## What moved to the `logs` SUB-BAG, and what stayed here
 *
 * The FORMAT (`LEVEL`, `LogRow`, `parseLine`, redaction) and the STORE
 * (schema, `RETENTION_DAYS`, `prune`) now live in `bags/telemetry/logs`,
 * because everything that EMITS a log line needs them and nothing that emits
 * should depend on a collector to do it.
 *
 * COLLECTION stayed here: `defaultLogSources`, `ingestLog`, and the read
 * models below. This file imports the sub-bag — parent -> child, the
 * sanctioned direction. Do not invert it.
 *
 * ## Offsets, unlike errors.db
 *
 * This ingests through `framework/tail.ts`, so a pass costs the NEW bytes.
 * `errors.ts` re-reads whole files every 300s because it never had that
 * machinery, a gap documented in its own `ingestLog`. At 270x the volume,
 * re-reading was never an option here.
 */
```

## Note 074

Source: [bags/telemetry/src/logs.ts](../../bags/telemetry/src/logs.ts)

Advance offsets only through complete lines; failed parsing must not lose future writes.

Original rationale:

```text
/**
 * Ingest new bytes from one file.
 *
 * Only lines confirmed to end in a newline advance the stored offset. A
 * trailing partial line is left for the next pass -- advancing past it would
 * mean the rest of that record, once written, is never seen.
 */
```

## Note 075

Source: [bags/telemetry/src/notify.test.ts](../../bags/telemetry/src/notify.test.ts)

Verify delivery outcomes without sending real notifications from the test suite.

Original rationale:

```text
/**
 * Alert delivery.
 *
 * These exist because delivery was the one part of the alerting path with no
 * test and no metric: `notify()` returned a per-channel result that both call
 * sites discarded, so a measured 121-of-449 (28%) loss on this host was
 * reconstructible only by grepping stderr. The loss was load-correlated — one
 * Slack send took 5.2s idle and 53.4s at peak against a 30s timeout — so the
 * channel failed precisely when it had something to report.
 */
```

## Note 076

Source: [bags/telemetry/src/notify.ts](../../bags/telemetry/src/notify.ts)

Resolve notifier credentials through the bound identity CLI so channels share its policy.

Original rationale:

```text
/**
 * Alert delivery, through the bound identity CLI: it resolves the barry's notifier and
 * credentials, handles the Slack/SMS split, and records the event.
 *
 * Run as the installation's identity-aware CLI rather than through another bag's shell helpers: those sourced the
 * checkout's .env wholesale to find a token, which no process does any more.
 */
```

## Note 077

Source: [bags/telemetry/src/notify.ts](../../bags/telemetry/src/notify.ts)

Bound each channel send so one unavailable provider cannot hang the sampler.

Original rationale:

```text
/**
 * How long a single channel send may take.
 *
 * 120s, not the original 30s. The 30s budget was not merely tight, it failed
 * SELECTIVELY: measured on this host, one Slack send took 5.2s idle, 17-23s
 * under load, and 53.4s at peak — while `swap-exhausted` was actively firing.
 * So the channel worked whenever there was nothing to say and timed out
 * exactly when there was, discarding 121 of 449 alerts (28%) including the
 * critical SMS that exists to wake someone.
 *
 * A timeout still has to exist — an unbounded send would hang the sampler —
 * but it must be sized for the sick host, not the healthy one, because the
 * sick host is the only one that ever sends.
 */
```

## Note 078

Source: [bags/telemetry/src/notify.ts](../../bags/telemetry/src/notify.ts)

Record delivery attempts separately from firing state so failed sends remain diagnosable.

Original rationale:

```text
/**
 * Send an alert.
 *
 * Failure to notify is logged, never thrown: a broken Slack token must not
 * take down the sampler, because the sampler is also what records that
 * something is wrong. The caller gets a per-channel result so the failure is
 * RECORDED rather than merely logged — see `barry.notify.ok`. Previously this
 * returned a single boolean that both call sites discarded, so a 28% delivery
 * loss was reconstructible only by grepping stderr by hand.
 *
 * Channels run CONCURRENTLY and are independently timed. They used to share
 * one 30s budget in a single `bash -c` with SMS sequenced after Slack — which
 * put the highest-severity channel last, so SMS was the first thing lost when
 * the host slowed down. Escalation must not be downstream of the channel it
 * escalates past.
 */
```

## Note 079

Source: [bags/telemetry/src/rules.test.ts](../../bags/telemetry/src/rules.test.ts)

A rule without hysteresis still needs a clearing threshold to resolve its firing state.

Original rationale:

```text
/**
     * REGRESSION — a rule with no `clearLimit` could never resolve once firing.
     *
     * `clears` was a second strict comparison against `limit`, so a value landing
     * exactly ON the limit neither breached nor cleared. For a boolean 0/1 metric
     * that dead band is the whole healthy state: `service-down`, `port-squatted`
     * and `collector-broken` all use limit 1 / direction "below", so recovery
     * (value 1) asked whether `1 > 1` and stayed firing forever.
     *
     * Found live: one `collector-broken` series had been firing since
     * 2026-08-26, including two days after the underlying fault was fixed.
     */
```

## Note 080

Source: [bags/telemetry/src/rules.test.ts](../../bags/telemetry/src/rules.test.ts)

Sparse samples during host sleep cannot prove a continuously breaching interval.

Original rationale:

```text
/**
   * Known limit, found by replaying the real 2026-08-21..23 window: while the
   * host is asleep the collector ticks roughly hourly, and BOTH the threshold
   * branch's staleness guard and `sustained()`'s lookback window are sized for
   * a 60s tick. Samples 93 minutes apart are rejected as stale, so this rule
   * does not fire for an outage that happens while the machine is mostly
   * asleep — which is exactly when that outage went unnoticed for three days.
   *
   * Fixing it means changing staleness semantics for every rule kind (the
   * bound is hardcoded in four places), which is a larger change than adding
   * one rule. This rule still catches a wedge on an awake machine, which is
   * the common case.
   */
```

## Note 081

Source: [bags/telemetry/src/rules.test.ts](../../bags/telemetry/src/rules.test.ts)

Persist hysteresis in notification selection; stateless evaluation alone cannot suppress repeated crossings.

Original rationale:

```text
/**
     * Hysteresis lives in selectNotifications, which persists the firing state —
     * evaluateRule alone is stateless. Wired memory drifts by a point or two
     * between samples, so without the 42/35 band a drift across 42 would notify
     * on every upward crossing, which is how swap-exhausted once produced ~40
     * criticals in a day.
     */
```

## Note 082

Source: [bags/telemetry/src/rules.test.ts](../../bags/telemetry/src/rules.test.ts)

Resolve alerts from current eligible samples rather than retaining an exited process forever.

Original rationale:

```text
/**
     * REGRESSION — the alert latched on 2026-09-01 and could not clear for over
     * a week.
     *
     * `name` was part of the label set, so rank 1 was not one series but one per
     * process name. A process that spikes, takes rank 1, then falls back stops
     * emitting points ENTIRELY rather than reporting a low value, so its own
     * series can never reach `clearLimit`: the alert stays armed on a value
     * measured hours ago while a different, healthy process is actually rank 1.
     *
     * llama-server (an Ollama child, respawned per request) did exactly this
     * against a VM helper process. The rule's own comment claimed rank scoping made it
     * "exactly one alert on a series that is always present" — true only once
     * `name` is off the key.
     */
```

## Note 083

Source: [bags/telemetry/src/rules.test.ts](../../bags/telemetry/src/rules.test.ts)

A vnode allocation ratio fixed at one is not evidence of memory pressure.

Original rationale:

```text
/**
   * A rule on this ratio was written, shipped, and removed. It fired
   * continuously and could never clear, because `num == max` is how macOS sizes
   * the vnode table rather than evidence of pressure against it: 111 samples
   * held exactly ONE distinct value, and wired memory moved 3.5GB across a
   * window in which the vnode count did not change by a single unit.
   *
   * This test exists so the same rule is not re-derived from the same
   * plausible-looking reading. If you are about to add one, read the comment on
   * `hostVnodes` in schema.ts first.
   */
```

## Note 084

Source: [bags/telemetry/src/rules.test.ts](../../bags/telemetry/src/rules.test.ts)

A series with no recorded point is unavailable, rather than a previously active series going silent.

Original rationale:

```text
/**
   * A series that never existed is NOT silence.
   *
   * Absence-of-a-signal and absence-of-a-configuration look identical in an
   * empty table, and conflating them fires forever for a service that was
   * intentionally removed. This kind detects a signal that STOPPED, which is
   * why it reads the age of a real last row rather than a list of expected
   * identities.
   */
```

## Note 085

Source: [bags/telemetry/src/rules.test.ts](../../bags/telemetry/src/rules.test.ts)

No-data rules measure sample age, independently of the sample value.

Original rationale:

```text
/**
   * The VALUE is irrelevant to this kind — only the age is read.
   *
   * A collector reporting failure is loudly alive, and `collector-broken`
   * already covers it. Firing both would double-alert one fault and teach
   * the reader to mute the pair.
   */
```

## Note 086

Source: [bags/telemetry/src/rules.test.ts](../../bags/telemetry/src/rules.test.ts)

An unavailable evaluation must not be reported as a successful absence of silence.

Original rationale:

```text
/**
   * "Couldn't tell" must not read as "not silent".
   *
   * A no-data rule with no window has no basis to answer, and returning "not
   * silent" would be a rule that cannot fire — the exact defect this kind was
   * added to remove. evaluateAll catches the throw, so the cost is this rule's
   * own evaluation rather than the whole pass.
   */
```

## Note 087

Source: [bags/telemetry/src/rules.test.ts](../../bags/telemetry/src/rules.test.ts)

Identify collector health by tool so collecting-job provenance does not split one health series.

Original rationale:

```text
/**
   * The `job` provenance label split every collector into one series per job
   * that runs it -- {tool:"du"} became {tool:"du",job:"sample"} and
   * {tool:"du",job:"footprint"}. Without narrowing identity to the tool, a
   * collector reporting healthily every 61s via `sample` fired as silent
   * because its `footprint` variant, written five times less often, looked
   * stale on its own. All ten collectors fired at once.
   *
   * "Has this collector gone quiet" is a question about the TOOL.
   */
```

## Note 088

Source: [bags/telemetry/src/rules.test.ts](../../bags/telemetry/src/rules.test.ts)

Scale staleness to observed cadence so a slow scheduled collector is not treated as failed.

Original rationale:

```text
/**
   * A flat threshold treats every series as if it ticked at the same rate.
   * They do not: collectorOk{tool:"ps"} is written every 61s by `sample`, while
   * {tool:"ollama"} is written every 299s by `footprint`. Against one 15-minute
   * bound the sparse one sits three ticks from the edge where the fast one sits
   * fifteen, so any hiccup trips it first -- which shipped, and fired during a
   * four-minute maintenance gap while only 3.1 minutes stale.
   */
```

## Note 089

Source: [bags/telemetry/src/rules.ts](../../bags/telemetry/src/rules.ts)

Alert rules describe measured failure conditions and their clearing behavior.

Original rationale:

```text
/**
 * Declarative alert rules.
 *
 * Rules are data, not code, so the set of things Barry watches is reviewable
 * in one place instead of scattered through a script.
 *
 * Two design choices, both learned from the incidents this bag exists to catch:
 *
 * 1. Most rules are about CHANGE, not level. A transport count of 300 is fine
 *    on its own and alarming if it was 100 an hour ago. `delta` and `ratio`
 *    rules exist because every past incident was a slope that a threshold
 *    would have missed until far too late.
 * 2. Firing is edge-triggered. The existing health-check job alerts on
 *    transition for the same reason: an alert that repeats every tick is an
 *    alert you learn to ignore, and these run every minute.
 */
```

## Note 090

Source: [bags/telemetry/src/rules.ts](../../bags/telemetry/src/rules.ts)

A separate clear limit adds hysteresis before rearming a threshold alert.

Original rationale:

```text
/**
   * threshold: the value the metric must return to before the alert re-arms.
   *
   * Without this, a metric sitting near its limit resolves and re-fires on
   * every sample, and because firing is edge-triggered each crossing is a NEW
   * notification. The swap rule sent dozens of criticals a day this way.
   * Defaults to `limit` (no hysteresis). For an "above" rule this must be
   * BELOW `limit`; for a "below" rule, above it.
   */
```

## Note 091

Source: [bags/telemetry/src/rules.ts](../../bags/telemetry/src/rules.ts)

Require consecutive breaches to avoid notifying on an isolated spike.

Original rationale:

```text
/**
   * threshold: consecutive breaching samples required before firing.
   *
   * A dwell gate. One spiky sample should not escalate to SMS, but a condition
   * that persists for N samples is real. Default 1 (fire on the first sample),
   * which stays correct for metrics that cannot spike spuriously.
   */
```

## Note 092

Source: [bags/telemetry/src/rules.ts](../../bags/telemetry/src/rules.ts)

A companion metric must breach for the same label set before notifying.

Original rationale:

```text
/**
   * A second metric that must ALSO breach before this rule fires.
   *
   * Some signals are only meaningful in combination. A restart count cannot
   * tell a crash loop from a redeploy — but a crash exits non-zero and a clean
   * restart exits 0, so pairing the count with the exit code separates them
   * where neither metric could alone.
   */
```

## Note 093

Source: [bags/telemetry/src/rules.ts](../../bags/telemetry/src/rules.ts)

Limit eligible label sets before evaluation rather than filtering already-fired alerts.

Original rationale:

```text
/**
   * Restrict the rule to label sets whose value is in the given list.
   *
   * Needed because one metric legitimately covers both leak-prone and
   * perfectly normal populations: process age is a leak signal for a spawned
   * browser and meaningless for a caffeinate that is supposed to live all day.
   */
```

## Note 094

Source: [bags/telemetry/src/rules.ts](../../bags/telemetry/src/rules.ts)

Use configured identity labels for series, staleness and persisted state; other labels remain provenance.

Original rationale:

```text
/**
   * Which labels form this rule's IDENTITY — its series, staleness window and
   * `alert_state` key. Defaults to every label on the point.
   *
   * Needed when a label is descriptive rather than identifying. A top-N metric
   * labels each point `{name, rank}`, but the thing being watched is "whatever
   * is rank 1", not any one process: with `name` in the key, rank 1 becomes one
   * series PER PROCESS NAME. A process that spikes, takes rank 1, then falls
   * back stops emitting points entirely rather than reporting a low value, so
   * its series can never reach `clearLimit` and its alert latches on a value
   * measured hours ago — while a different, healthy process is really rank 1.
   * That is not hypothetical: `process-footprint-outsized` sat firing on a
   * long-exited llama-server from 2026-09-01 for over a week.
   *
   * Labels left out still reach `message` — they are display, not identity.
   */
```

## Note 095

Source: [bags/telemetry/src/rules.ts](../../bags/telemetry/src/rules.ts)

No-data rules require an explicit silence horizon; threshold rules do not use it.

Original rationale:

```text
/**
   * no-data: how long a series may go without a point before it counts as
   * silent. Required for `no-data`; meaningless for every other kind.
   *
   * Must be comfortably longer than the metric's sampling interval, or a single
   * missed tick reads as an outage. `service_silent` used 15 minutes against a
   * 1-minute bin, which is the ratio to copy.
   */
```

## Note 096

Source: [bags/telemetry/src/rules.ts](../../bags/telemetry/src/rules.ts)

Project point labels to the rule’s identity so provenance cannot fork alert state.

Original rationale:

```text
/**
 * The subset of `labels` that identifies a rule's series.
 *
 * One helper rather than inline filtering because identity must be computed
 * IDENTICALLY for the series lookup, the staleness check and the alert-state
 * key. Three copies that could drift are how an alert ends up unable to see its
 * own state.
 */
```

## Note 097

Source: [bags/telemetry/src/rules.ts](../../bags/telemetry/src/rules.ts)

Keep default rules tied to observable failure modes, with a clearing path.

Original rationale:

```text
/**
 * The default rule set: one per proven failure mode.
 *
 * Deliberately small. Every rule here corresponds to something that has
 * actually happened on this machine, because a rule that has never fired for a
 * real cause is indistinguishable from a rule that never will.
 */
```

## Note 098

Source: [bags/telemetry/src/rules.ts](../../bags/telemetry/src/rules.ts)

Use the same rule-and-label identity for evaluation and persisted firing state.

Original rationale:

```text
/**
 * The `alert_state` key for a rule + label set.
 *
 * Must match `selectNotifications` exactly — hysteresis reads the same row that
 * notification writes, and a key that disagreed would make an alert permanently
 * unable to see its own state.
 */
```

## Note 099

Source: [bags/telemetry/src/rules.ts](../../bags/telemetry/src/rules.ts)

Look up companion readings for the evaluated series, rather than mixing unrelated labels.

Original rationale:

```text
/**
 * Does the rule's companion metric also breach, for this same label set?
 *
 * True when no companion is configured, so rules without one are unaffected.
 * A companion that has not reported for this label set does NOT hold: firing
 * on a missing corroborating signal is how the false positive got here.
 */
```

## Note 100

Source: [bags/telemetry/src/rules.ts](../../bags/telemetry/src/rules.ts)

Reject stale readings before evaluating a current fault.

Original rationale:

```text
/**
 * Is this point too old to act on?
 *
 * Scaled to how often the series is ACTUALLY sampled, not a fixed window. The
 * collector ticks every 60s while the host is awake and roughly hourly while it
 * sleeps, and one bound cannot serve both. A flat 15 minutes rejected the real
 * 2026-08-21..23 API outage — 40 of 40 probes failed across three days, but the
 * host was mostly asleep, so the newest failing sample was 93 minutes old and
 * every rule dismissed it as stale. A dwell gate that evaporates exactly when
 * the machine is struggling is worse than no gate, because the rule reads as
 * armed.
 *
 * Allowing three observed intervals tolerates a slow tick without tolerating a
 * dead one. The ceiling stops a series that has always sampled slowly from
 * being treated as live forever; the floor keeps the fast case strict.
 */
```

## Note 101

Source: [bags/telemetry/src/rules.ts](../../bags/telemetry/src/rules.ts)

Estimate cadence from recent gaps so scheduled collectors tolerate their real interval.

Original rationale:

```text
/**
 * The widest gap between the last few points of a series, in seconds.
 *
 * How often a series ACTUALLY reports, measured rather than declared. Widest
 * gap rather than the mean: one long gap is what a host sleeping looks like,
 * and averaging it against short ticks understates the real cadence.
 *
 * `until` bounds the window to the point being judged rather than to now, so a
 * gap AFTER that point (the machine waking up) cannot widen the tolerance that
 * decides whether the point counts.
 *
 * Returns undefined when there are fewer than two points to compare — the
 * caller must decide what to do with "cannot tell", and must not read it as
 * "fine".
 */
```

## Note 102

Source: [bags/telemetry/src/rules.ts](../../bags/telemetry/src/rules.ts)

Sustained breaches require eligible recent samples, not any matching points in history.

Original rationale:

```text
/**
 * Have the last `forSamples` points for this series all breached?
 *
 * Requires that many points to exist: a rule with a dwell gate should stay
 * quiet right after a restart rather than fire on a single sample, which is the
 * spike it was added to suppress.
 */
```

## Note 103

Source: [bags/telemetry/src/rules.ts](../../bags/telemetry/src/rules.ts)

Evaluate per label set and distinguish unavailable evidence from a non-breach.

Original rationale:

```text
/**
 * Evaluate one rule against the store, returning one result per label set.
 *
 * Per label set rather than aggregated: "some service is restarting" is not
 * actionable, and collapsing them would let a healthy majority mask one bad
 * service.
 */
```

## Note 104

Source: [bags/telemetry/src/rules.ts](../../bags/telemetry/src/rules.ts)

Persist firing and recovery state before selecting notifications so repeated ticks do not resend.

Original rationale:

```text
/**
 * Reduce evaluations to the ones that should actually notify, updating state.
 *
 * Edge-triggered: a rule already firing stays quiet until it clears and fires
 * again. `alert_state` also records `last_seen`, so a rule that stops
 * evaluating (its metric vanished) resolves rather than latching forever.
 */
```
