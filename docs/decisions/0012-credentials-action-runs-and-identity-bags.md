# ADR 0012: explicit credentials, cross-store action evidence, and identity bag resolution

Status: accepted

## Context

Session adapters must authenticate through declared identity sources. Action runs
refer to a separate session database, so a missing row cannot prove a run stopped.
Every identity writer must resolve composed bags consistently. The historical source
comments below explain the tradeoffs and regressions that motivated these rules;
their observations are retained as history rather than fresh measurements.

## Decision

Keep the controlling invariant beside each implementation and preserve the
historical explanation here. Require declared Claude API keys without recording
or redirecting vendor credentials. Close action runs only from positive session
termination evidence, preserving cancellation/completion precedence. Centralize
bag composition expansion in the identities bag; keep metadata
writes and service ownership outside that resolver. Preserve legacy identity filenames on reads.

## Consequences

Cross-store absence remains unknown; detached action runs are not falsely failed.
Legacy files remain readable while new writes converge on identity.yaml. Credential
rules do not silently expand to ambient vendor login. This comment move changes no executable behavior.

## Historical rationale

### adapters/sessions/claude/src/credential.ts

```typescript
/**
 * Which credential a claude session runs on: the identity's ANTHROPIC_API_KEY,
 * declared. Nothing else.
 *
 * This file used to carry three answers — an API key, a recorded opt-in to run
 * hosted sessions on the barry's own subscription, and the TUI's vendor login
 *. Two of those authenticate outside the identity's declared
 * sources, which is exactly what Barry no longer permits: the opt-in let a
 * distributed Barry drift into the one contested cell in Anthropic's terms,
 * and the vendor login was how the TUI modes used to run. Every mode now
 * states a key or does not start — the session gate refuses before the adapter
 * is reached, and this check is the adapter-side floor.
 *
 * Invariant I10 still holds and is asserted by a test: Barry never STORES or
 * redirects a vendor credential — no token files, no `CLAUDE_CONFIG_DIR`
 * redirection (which also breaks keychain login, verified E8), no
 * `setup-token`.
 */
```

### adapters/sessions/claude/src/credential.ts

```typescript
/**
 * Decide what a session runs on, or refuse.
 *
 * Refusing is the point. The previous behaviour — fall back to subscription
 * OAuth whenever no key was present, then a recorded opt-in, then the TUI's
 * login — each made the session authenticate with something nobody declared.
 */
```

### bags/actions/src/action-runs.ts

```typescript
/**
 * A NOTE ON `session_id`, measured after the migration landed.
 *
 * It is a soft reference to the SQLite session store, by design: migration 040
 * dropped the foreign key because `sessions` is no longer in this database.
 * The consequence showed up within the hour.
 *
 * All 198 sessions named by the 295 migrated rows resolve. Of the rows written
 * SINCE, 14 name a session that has never existed in either store -- detached
 * `do_action` runs, summarised "Executed detached via do_action". The foreign
 * key used to make that impossible; nothing does now.
 *
 * That is accepted rather than overlooked. The one consumer that acts on this
 * column is the abandoned-run sweep (`orphaned-runs.ts`), and it treats
 * an unresolvable session as NO EVIDENCE rather than as an ended one -- so a
 * dangling id leaves the run alone instead of failing it. Re-adding
 * enforcement would mean resolving across two SQLite files on every insert,
 * which buys less than that rule already does.
 *
 * If you add a consumer, read absence as "unknown", never as "gone".
 */
```

### bags/actions/src/action-runs.ts

```typescript
/**
 * Close an agent run that ended without a result — its agent failed, or it
 * outlived its timeout — with the reason as its summary.
 *
 * Such a run used to stay `started` until the session sweep closed it as
 * "the session ended without calling complete_action": the wrong cause, with
 * the real one (a model the harness could not find, a schema the output never
 * met) left in the API's log. Unlike `finishExecutedRun` it writes no process
 * columns, since an agent run had no process of its own.
 *
 * Guarded on `status = 'started'` like cancel: a cancel that landed first
 * keeps its reason, and a late failure cannot overwrite a finished run.
 */
```

### bags/actions/src/orphaned-runs.ts

```typescript
/**
 * Closing runs whose session ended without ever calling `complete_action`.
 *
 * A run its session started can never be completed once that session is
 * over: the agent that would call `complete_action` is gone. Nothing used to
 * close these, so they stayed `started` forever (six had been open since
 * August), and a backlog of dead rows makes the open-run listing
 * (`list-action-runs`) unable to do the one job it exists for: telling a
 * genuinely stuck run from noise.
 *
 * It runs where open runs are read, listing them and checking one, rather
 * than when a session ends: this bag asks the sessions subject, and the
 * sessions bag must not depend on this one.
 *
 * Reading "the store has no such session" as "the session ended" is wrong in
 * the DANGEROUS direction: it fails a run that is still working. So a session
 * the store cannot vouch for is never treated as over.
 *
 * The evidence is the SESSION, not a clock: a run whose session is over
 * cannot still be working, while a long run in a live session is healthy.
 */
```

### bags/identities/src/store/identity-files.ts

```typescript
/**
 * Pre-rename filename. Identity directories used to be Barry directories, and
 * nothing rewrites a user's files for them, so an existing directory keeps
 * working: reads accept either name, writes always produce `identity.yaml`.
 */
```
